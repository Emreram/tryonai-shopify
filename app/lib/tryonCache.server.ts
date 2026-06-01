import { createHash } from "node:crypto";
import db from "../db.server";

/**
 * Result cache for try-on generations (masterplan A3).
 *
 * The generated image is CUSTOMER LIKENESS, so this module is built around a
 * privacy-minimizing design:
 *   - Cache keys are a content hash, NEVER a customer id (no identity linkage).
 *   - Entries are scoped by shop (purgeable on uninstall / shop redact).
 *   - Image bytes live in a PRIVATE Supabase Storage bucket (EU, same region as
 *     the DB) accessed over the Storage REST API — no SDK dependency, and the
 *     bytes never touch the 500 MB Postgres DB (only a small index row does).
 *   - Every entry has a TTL (default 14 days) swept by a daily cron + lazily on
 *     read.
 *
 * Everything here is BEST-EFFORT: any failure (missing env, missing table,
 * storage error, timeout) degrades to "no cache" and must never break a
 * generation. Callers can treat getCachedTryOn() returning null as a miss and
 * putCachedTryOn() as fire-and-forget.
 */

export const TRYON_CACHE_PROMPT_VERSION = "v1";

const BUCKET = process.env.TRYON_CACHE_BUCKET || "tryon-cache";
const STORAGE_FETCH_TIMEOUT_MS = 5_000;

function ttlDays(): number {
  const raw = process.env.TRYON_CACHE_TTL_DAYS;
  if (!raw) return 14;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function storageEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

/**
 * The cache is live only when explicitly enabled, the storage creds are present,
 * and the merchant hasn't opted out. Triple-gated so it ships dark and can be
 * rolled out per-environment via TRYON_CACHE_ENABLED.
 */
export function cacheActive(shopCacheEnabled: boolean | null | undefined): boolean {
  return (
    process.env.TRYON_CACHE_ENABLED === "true" &&
    storageEnv() !== null &&
    shopCacheEnabled !== false
  );
}

export function computeTryOnCacheKey(args: {
  shop: string;
  selfie: Buffer;
  garmentIdentity: string;
  size: string;
  quality: string;
  promptVer: string;
  model: string;
}): string {
  const selfieHash = createHash("sha256").update(args.selfie).digest("hex");
  return createHash("sha256")
    .update(
      [
        args.promptVer,
        args.model,
        args.size,
        args.quality,
        args.shop,
        selfieHash,
        args.garmentIdentity,
      ].join("|"),
    )
    .digest("hex");
}

function storagePathFor(shop: string, cacheKey: string): string {
  // Shop-prefixed so a shop's objects can be enumerated/purged together.
  return `${shop}/${cacheKey}.jpg`;
}

function logErr(event: string, error: unknown, extra: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      event,
      ...extra,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function storageFetch(
  path: string,
  init: RequestInit & { env: { url: string; key: string } },
): Promise<Response> {
  const { env, ...rest } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORAGE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${env.url}/storage/v1/object/${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.key}`,
        apikey: env.key,
        ...(rest.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Look up a cached final image. Returns null on miss, expiry, missing config, or
 * any error. Expired entries are lazily purged in the background.
 */
export async function getCachedTryOn(
  cacheKey: string,
): Promise<{ b64: string } | null> {
  const env = storageEnv();
  if (!env) return null;
  try {
    const row = await db.tryOnCache.findUnique({ where: { cacheKey } });
    if (!row) return null;

    if (row.expiresAt.getTime() <= Date.now()) {
      // Stale: drop it without blocking the request.
      void deleteEntries([{ cacheKey, storagePath: row.storagePath }], env);
      return null;
    }

    const res = await storageFetch(`${BUCKET}/${row.storagePath}`, {
      method: "GET",
      env,
    });
    if (!res.ok) {
      // Pointer without an object (manual deletion, partial write): treat as a
      // miss and clean up the dangling row.
      void deleteEntries([{ cacheKey, storagePath: row.storagePath }], env);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;

    // Hit accounting is best-effort and must not block the response.
    void db.tryOnCache
      .update({ where: { cacheKey }, data: { hits: { increment: 1 } } })
      .catch(() => {});

    return { b64: buf.toString("base64") };
  } catch (error) {
    logErr("tryon_cache_get_failed", error, { cacheKey });
    return null;
  }
}

/**
 * Persist a final image. Uploads bytes to Storage, then upserts the index row.
 * Best-effort: logs and returns on any failure.
 */
export async function putCachedTryOn(args: {
  cacheKey: string;
  b64: string;
  shop: string;
  size: string;
  promptVer: string;
  model: string;
}): Promise<void> {
  const env = storageEnv();
  if (!env) return;
  try {
    const bytes = Buffer.from(args.b64, "base64");
    if (bytes.length === 0) return;
    const storagePath = storagePathFor(args.shop, args.cacheKey);

    const upload = await storageFetch(`${BUCKET}/${storagePath}`, {
      method: "POST",
      env,
      headers: { "Content-Type": "image/jpeg", "x-upsert": "true" },
      body: new Uint8Array(bytes),
    });
    if (!upload.ok) {
      logErr("tryon_cache_put_upload_failed", `HTTP ${upload.status}`, {
        shop: args.shop,
        cacheKey: args.cacheKey,
      });
      return;
    }

    const expiresAt = new Date(Date.now() + ttlDays() * 86_400_000);
    await db.tryOnCache.upsert({
      where: { cacheKey: args.cacheKey },
      create: {
        cacheKey: args.cacheKey,
        shop: args.shop,
        size: args.size,
        promptVer: args.promptVer,
        model: args.model,
        storagePath,
        bytes: bytes.length,
        expiresAt,
      },
      update: { storagePath, bytes: bytes.length, expiresAt },
    });
  } catch (error) {
    logErr("tryon_cache_put_failed", error, {
      shop: args.shop,
      cacheKey: args.cacheKey,
    });
  }
}

/**
 * Delete a batch of entries (storage objects + index rows). Used by the lazy
 * purge, the cron sweep, and the shop-scoped purges.
 */
async function deleteEntries(
  entries: Array<{ cacheKey: string; storagePath: string }>,
  env: { url: string; key: string },
): Promise<void> {
  if (entries.length === 0) return;
  try {
    // Supabase Storage supports deleting many objects in one call via the
    // `prefixes` body on DELETE of the bucket root.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      STORAGE_FETCH_TIMEOUT_MS,
    );
    try {
      await fetch(`${env.url}/storage/v1/object/${BUCKET}`, {
        method: "DELETE",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${env.key}`,
          apikey: env.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prefixes: entries.map((e) => e.storagePath) }),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    logErr("tryon_cache_storage_delete_failed", error);
  }
  // Always drop the index rows even if the storage delete struggled, so we don't
  // keep serving/returning dangling pointers.
  try {
    await db.tryOnCache.deleteMany({
      where: { cacheKey: { in: entries.map((e) => e.cacheKey) } },
    });
  } catch (error) {
    logErr("tryon_cache_row_delete_failed", error);
  }
}

/** Daily cron sweep: remove all expired entries (objects + rows). */
export async function purgeExpiredTryOnCache(): Promise<{ deleted: number }> {
  const env = storageEnv();
  if (!env) return { deleted: 0 };
  try {
    const expired = await db.tryOnCache.findMany({
      where: { expiresAt: { lte: new Date() } },
      select: { cacheKey: true, storagePath: true },
      take: 1000,
    });
    await deleteEntries(expired, env);
    return { deleted: expired.length };
  } catch (error) {
    logErr("tryon_cache_purge_expired_failed", error);
    return { deleted: 0 };
  }
}

/** Purge an entire shop's cache (uninstall / shop redact). */
export async function purgeShopTryOnCache(shop: string): Promise<void> {
  const env = storageEnv();
  if (!env) return;
  try {
    const rows = await db.tryOnCache.findMany({
      where: { shop },
      select: { cacheKey: true, storagePath: true },
    });
    await deleteEntries(rows, env);
  } catch (error) {
    logErr("tryon_cache_purge_shop_failed", error, { shop });
  }
}
