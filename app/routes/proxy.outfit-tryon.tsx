// Signed app-proxy endpoint: storefront -> /apps/tryonai/outfit-tryon. Renders a
// full-OUTFIT try-on. The shopper uploads only their selfie; the AI-selected
// garment images (Shopify CDN URLs from /apps/tryonai/outfit) are fetched
// server-side. mode="combined" composites all pieces in one generation (default);
// mode="layered" dresses piece-by-piece for higher fidelity ("Refine fit").
//
// Reuses the shared generation gate (rate limit + trial/cap/cost-ceiling) and logs
// ONE UsageLog row with kind="tryon" whose costUsd is the sum of all passes, so an
// outfit render counts as exactly one generation against the merchant cap.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { enforceGenerationGate } from "../lib/tryonGate.server";
import { decrement as rateLimitDecrement, hashUserId } from "../lib/rateLimit.server";
import { outfitBackendEnabled } from "../lib/outfitFlags.server";
import { verifyProxySignature } from "../lib/proxy.server";
import {
  computeCostUsd,
  generateOutfitLayered,
  generateTryOn,
  OPENAI_TRYON_MODEL,
  TryOnSafetyRejectionError,
  type GarmentInput,
} from "../lib/openai.server";
import {
  cacheActive,
  computeTryOnCacheKey,
  getCachedTryOn,
  putCachedTryOn,
  TRYON_CACHE_PROMPT_VERSION,
} from "../lib/tryonCache.server";

// Default "combined" mode is ONE generation — runs about as long as a normal
// try-on, which already ships fine. "layered" refine does multiple passes and can
// run longer. 60s is the Hobby-plan ceiling (Vercel fails the build if maxDuration
// exceeds the plan max), so we cap here to stay plan-independent; the client
// degrades gracefully if a layered refine is cut off. On Vercel Pro you can safely
// raise this to 120–300 for extra layered-refine headroom.
export const config = { maxDuration: 60 };

const MAX_SELFIE_BYTES = 8 * 1024 * 1024;
const MAX_GARMENT_BYTES = 10 * 1024 * 1024;
const GARMENT_FETCH_TIMEOUT_MS = 8_000;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUPPORTED_SIZES = new Set(["1024x1536", "1536x1024"]);
type OutfitSize = "1024x1536" | "1536x1024";
const DEFAULT_SIZE: OutfitSize = "1024x1536";

const SSE_OPEN_PADDING = " ".repeat(64 * 1024);
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Content-Encoding": "identity",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  return json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Feature pre-check (cheap) before the full gate, so a disabled shop never even
  // rate-limits. Uses the same signature the gate will re-verify.
  let shopForFlag: string;
  try {
    ({ shop: shopForFlag } = verifyProxySignature(request));
  } catch (err) {
    if (err instanceof Response) return err;
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const settingsRow = await db.merchantSettings.findUnique({
    where: { shop: shopForFlag },
  });
  if (!outfitBackendEnabled(settingsRow)) {
    return json({ error: "feature_disabled" }, { status: 404 });
  }

  const gate = await enforceGenerationGate(request);
  if (!gate.ok) return gate.response;
  const { shop, customerId, plan, cycleStart, settings, rateLimitKey, reqId, used, cap } = gate;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ error: "Invalid form data" }, { status: 400 });
  }

  const selfie = formData.get("selfie");
  if (!(selfie instanceof File) || selfie.size === 0) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ error: "Missing selfie file" }, { status: 400 });
  }
  if (selfie.size > MAX_SELFIE_BYTES) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ error: "Selfie exceeds 8MB" }, { status: 413 });
  }
  const selfieMime = normalizeMime(selfie.type);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(selfieMime)) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ error: "Selfie must be a JPEG, PNG, or WebP image" }, { status: 400 });
  }

  const mode = formData.get("mode") === "layered" ? "layered" : "combined";
  const sizeRaw = formData.get("size");
  const size: OutfitSize =
    typeof sizeRaw === "string" && SUPPORTED_SIZES.has(sizeRaw)
      ? (sizeRaw as OutfitSize)
      : DEFAULT_SIZE;
  const outfitRequestId =
    typeof formData.get("outfit_request_id") === "string"
      ? String(formData.get("outfit_request_id")).slice(0, 128)
      : null;

  const garmentRefs = parseGarments(formData.get("garments"), shop);
  if (garmentRefs.length === 0) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ error: "No valid garments to try on" }, { status: 400 });
  }

  // Fetch the AI-selected garment images server-side (host-guarded above).
  const fetched = await Promise.all(garmentRefs.map((g) => fetchGarment(g.url)));
  const garments: GarmentInput[] = [];
  garmentRefs.forEach((ref, i) => {
    const f = fetched[i];
    if (f) garments.push({ buffer: f.buffer, mimeType: f.mimeType, label: ref.label });
  });
  if (garments.length === 0) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ error: "Could not load the outfit images" }, { status: 502 });
  }

  // Margin guard: a layered ("Refine fit") render runs ONE OpenAI image pass per
  // garment (generateOutfitLayered), so it costs ~N× a normal try-on. Charge it N
  // cap units (combined mode stays 1) so a merchant's quota — and our COGS — can
  // never be out-run by the multi-pass path. Block if there isn't room for all N,
  // reusing the cap_reached response the widget already handles gracefully.
  const capUnits = mode === "layered" ? Math.max(1, garments.length) : 1;
  if (capUnits > 1 && used + capUnits > cap) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json(
      { error: "cap_reached", used, cap, upgradeUrl: "/app/billing" },
      { status: 429 },
    );
  }

  const selfieBuf = Buffer.from(await selfie.arrayBuffer());
  const user = hashUserId(shop, customerId) || undefined;

  // Combined-mode result cache (layered "refine" is intentionally not cached).
  const cacheOn = mode === "combined" && cacheActive(settings?.cacheEnabled);
  let cacheKey: string | null = null;
  if (cacheOn) {
    const identity =
      "outfit:" + garmentRefs.map((g) => g.url).sort().join("|");
    cacheKey = computeTryOnCacheKey({
      shop,
      selfie: selfieBuf,
      garmentIdentity: identity,
      size,
      quality: "medium",
      promptVer: TRYON_CACHE_PROMPT_VERSION + ":outfit",
      model: OPENAI_TRYON_MODEL,
    });
    const cached = await getCachedTryOn(cacheKey);
    if (cached) {
      if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
      await logUsage({ shop, reqId, plan, cycleStart, costUsd: 0, status: "cache_hit" });
      return cacheHitResponse(cached.b64, reqId);
    }
  }

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let cancelled = false;
  let completed = false;
  const onAbort = () => {
    cancelled = true;
    abortController.abort();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      controller.enqueue(encoder.encode(`: tryonai stream open ${SSE_OPEN_PADDING}\n\n`));
      send({ kind: "meta", requestId: reqId, mode });

      let finalB64: string | null = null;
      let costUsd = 0;

      try {
        if (mode === "layered") {
          for await (const ev of generateOutfitLayered({
            selfie: selfieBuf,
            selfieMimeType: selfieMime,
            garments,
            size,
            signal: abortController.signal,
            user,
          })) {
            if (cancelled) break;
            if (ev.kind === "layer") {
              send({ kind: "partial", index: ev.index, b64: ev.b64 });
            } else if (ev.kind === "completed") {
              finalB64 = ev.b64;
              send({ kind: "completed", b64: ev.b64 });
            } else if (ev.kind === "usage") {
              costUsd = ev.usages.reduce((acc, u) => acc + computeCostUsd(u), 0);
              completed = true;
            } else if (ev.kind === "error") {
              throw ev.error;
            }
          }
        } else {
          for await (const ev of generateTryOn({
            selfie: selfieBuf,
            selfieMimeType: selfieMime,
            garment: garments[0].buffer,
            garmentMimeType: garments[0].mimeType,
            additionalGarments: garments.slice(1),
            garmentLabels: garments.map((g) => g.label ?? "garment"),
            size,
            signal: abortController.signal,
            user,
          })) {
            if (cancelled) break;
            if (ev.kind === "timing") {
              costUsd =
                computeCostUsd(ev.openai.medium.usage) +
                computeCostUsd(ev.openai.low.usage);
              completed = true;
              send({ kind: "timing", requestId: reqId, cost_usd: costUsd });
            } else {
              if (ev.kind === "completed") finalB64 = ev.b64;
              send(ev);
            }
          }
        }

        await logUsage({ shop, reqId, plan, cycleStart, costUsd, status: "ok" });
        // A multi-pass layered render consumes capUnits cap slots: the real cost
        // is logged once (above); the remaining slots are zero-cost marker rows
        // that share the cap/trial counting rule (kind:"tryon", status:"ok") so
        // the merchant's quota tracks true OpenAI cost. Best-effort — a failed
        // marker only under-counts the cap, never blocks the result.
        if (capUnits > 1) {
          await writeCapUnitMarkers({ shop, baseReqId: reqId, plan, cycleStart, count: capUnits - 1 });
        }

        if (cacheKey && finalB64) {
          await putCachedTryOn({
            cacheKey,
            b64: finalB64,
            shop,
            size,
            promptVer: TRYON_CACHE_PROMPT_VERSION + ":outfit",
            model: OPENAI_TRYON_MODEL,
          });
        }

        console.log(
          JSON.stringify({
            event: "outfit_tryon_complete",
            shop,
            request_id: reqId,
            outfit_request_id: outfitRequestId,
            mode,
            pieces: garments.length,
            cost_usd: costUsd,
          }),
        );
      } catch (err) {
        if (!completed && rateLimitKey) await rateLimitDecrement(rateLimitKey);
        if (cancelled || isAbortError(err)) return;
        const safety = err instanceof TryOnSafetyRejectionError ? err : null;
        await logUsage({ shop, reqId, plan, cycleStart, costUsd: 0, status: "error" });
        console.error(
          JSON.stringify({
            event: "outfit_tryon_error",
            shop,
            request_id: reqId,
            error: err instanceof Error ? err.message : String(err),
            error_code: safety ? "safety_rejected" : null,
          }),
        );
        if (safety) {
          send({
            kind: "error",
            code: "safety_rejected",
            error:
              "We couldn't create the outfit try-on from that photo. For best results, " +
              "upload a clear, well-lit photo of just you, facing the camera.",
          });
        } else {
          send({ kind: "error", error: "Outfit try-on failed. Please try again." });
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      onAbort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function cacheHitResponse(b64: string, reqId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (p: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
      controller.enqueue(encoder.encode(`: tryonai stream open ${SSE_OPEN_PADDING}\n\n`));
      send({ kind: "meta", requestId: reqId, mode: "combined" });
      send({ kind: "completed", b64 });
      send({ kind: "timing", requestId: reqId, cached: true });
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

async function logUsage(args: {
  shop: string;
  reqId: string;
  plan: string;
  cycleStart: Date;
  costUsd: number;
  status: string;
}) {
  try {
    await db.usageLog.create({
      data: {
        shop: args.shop,
        requestId: args.reqId,
        openaiRequestId: null,
        plan: args.plan,
        kind: "tryon",
        costUsd: args.costUsd,
        status: args.status,
        size: "outfit",
        cycleStart: args.cycleStart,
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "usage_log_write_failed",
        sub_event: "outfit_tryon",
        error: err instanceof Error ? err.message : String(err),
        shop: args.shop,
        request_id: args.reqId,
      }),
    );
  }
}

// Extra cap-unit markers for a layered render (see the success path). Each is a
// zero-cost kind:"tryon" row with a distinct requestId so it counts toward the
// cap exactly like a generation; size:"outfit-unit" tags them as quota markers
// (not separate images) for anyone reading the logs/metrics.
async function writeCapUnitMarkers(args: {
  shop: string;
  baseReqId: string;
  plan: string;
  cycleStart: Date;
  count: number;
}) {
  for (let i = 1; i <= args.count; i++) {
    try {
      await db.usageLog.create({
        data: {
          shop: args.shop,
          requestId: `${args.baseReqId}-u${i}`,
          openaiRequestId: null,
          plan: args.plan,
          kind: "tryon",
          costUsd: 0,
          status: "ok",
          size: "outfit-unit",
          cycleStart: args.cycleStart,
        },
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "usage_log_write_failed",
          sub_event: "outfit_cap_unit",
          error: err instanceof Error ? err.message : String(err),
          shop: args.shop,
          request_id: `${args.baseReqId}-u${i}`,
        }),
      );
    }
  }
}

// ---- garment parsing + fetch -----------------------------------------------

interface GarmentRef {
  url: string;
  label: string;
}

function maxPieces(): number {
  const raw = process.env.OUTFIT_MAX_PIECES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 2 && n <= 5 ? n : 4;
}

// Only fetch from Shopify-controlled image hosts (anti-SSRF).
function isAllowedImageHost(host: string, shop: string): boolean {
  const h = host.toLowerCase();
  return (
    h === shop.toLowerCase() ||
    h.endsWith(".shopify.com") ||
    h.endsWith(".shopifycdn.com") ||
    h.endsWith(".myshopify.com")
  );
}

function parseGarments(raw: FormDataEntryValue | null, shop: string): GarmentRef[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GarmentRef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const url = (item as Record<string, unknown>).url;
    const label = (item as Record<string, unknown>).label;
    if (typeof url !== "string") continue;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" || !isAllowedImageHost(u.host, shop)) continue;
      out.push({
        url,
        label: typeof label === "string" ? label.slice(0, 40) : "garment",
      });
    } catch {
      // skip invalid URL
    }
    if (out.length >= maxPieces()) break;
  }
  return out;
}

async function fetchGarment(
  url: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GARMENT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return null;
    const mimeType = normalizeMime(res.headers.get("content-type"));
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_GARMENT_BYTES) return null;
    return { buffer: buf, mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMime(mime: string | null | undefined): string {
  return mime?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isAbortError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}
