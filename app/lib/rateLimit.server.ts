import crypto from "node:crypto";
import db from "../db.server";

type Tier = "short" | "hour";

interface TierConfig {
  count: number;
  ms: number;
}

const TIERS: Record<Tier, TierConfig> = {
  short: {
    count: parseIntEnv("RATE_LIMIT_SHORT_COUNT", 20),
    ms: parseIntEnv("RATE_LIMIT_SHORT_MS", 15 * 60 * 1000),
  },
  hour: {
    count: parseIntEnv("RATE_LIMIT_HOUR_COUNT", 60),
    ms: parseIntEnv("RATE_LIMIT_HOUR_MS", 60 * 60 * 1000),
  },
};

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function hashIp(ip: string): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET is required to hash IPs");
  }
  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
}

export function buildKey(
  shop: string,
  customerId: string | null,
  firstXff: string | null,
): string {
  if (customerId && customerId.length > 0) {
    return `${shop}:c:${customerId}`;
  }
  if (firstXff && firstXff.length > 0) {
    return `${shop}:ip:${hashIp(firstXff)}`;
  }
  throw new Error("rate_limit_unkeyable: missing customer id and ip");
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; tier: Tier; retryAfter: number };

interface UpsertRow {
  count: number;
  expiresAt: Date;
}

async function upsertTier(key: string, tier: Tier): Promise<UpsertRow> {
  const cfg = TIERS[tier];
  const rows = await db.$queryRaw<UpsertRow[]>`
    INSERT INTO "RateLimitBucket" ("key", "tier", "count", "windowStart", "expiresAt")
    VALUES (
      ${key},
      ${tier},
      1,
      NOW(),
      NOW() + make_interval(secs => ${cfg.ms}::float / 1000.0)
    )
    ON CONFLICT ("key", "tier") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."expiresAt" < NOW() THEN 1
        ELSE "RateLimitBucket"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "RateLimitBucket"."expiresAt" < NOW() THEN NOW()
        ELSE "RateLimitBucket"."windowStart"
      END,
      "expiresAt" = CASE
        WHEN "RateLimitBucket"."expiresAt" < NOW()
          THEN NOW() + make_interval(secs => ${cfg.ms}::float / 1000.0)
        ELSE "RateLimitBucket"."expiresAt"
      END
    RETURNING "count", "expiresAt";
  `;
  return rows[0]!;
}

export async function checkAndIncrement(key: string): Promise<RateLimitResult> {
  // Each tier's upsert is atomic at the row level (INSERT ... ON CONFLICT).
  // We increment short first; if it's over, the hour tier is left untouched
  // because no work happens on this request anyway.
  const short = await upsertTier(key, "short");
  if (short.count > TIERS.short.count) {
    return {
      ok: false,
      tier: "short",
      retryAfter: secondsUntil(short.expiresAt),
    };
  }
  const hour = await upsertTier(key, "hour");
  if (hour.count > TIERS.hour.count) {
    return {
      ok: false,
      tier: "hour",
      retryAfter: secondsUntil(hour.expiresAt),
    };
  }
  return { ok: true };
}

export async function decrement(key: string): Promise<void> {
  try {
    await db.$executeRaw`
      UPDATE "RateLimitBucket"
      SET "count" = "count" - 1
      WHERE "key" = ${key} AND "count" > 0 AND "expiresAt" > NOW();
    `;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "rate_limit_decrement_failed",
        key,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function secondsUntil(date: Date): number {
  const ms = date.getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 1000));
}
