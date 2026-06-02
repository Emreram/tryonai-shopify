// Signed app-proxy endpoint: storefront -> /apps/tryonai/outfit. Takes the
// shopper's quiz answers (+ optional anchor product) and returns a coherent,
// in-stock outfit of REAL products from the shop, plus an `outfitRequestId` that
// the cart beacon uses to attribute every piece's add-to-cart (same 5% owner
// commission as a try-on). Auth is the App Proxy HMAC, identical to proxy.tryon.
//
// Logs one UsageLog row with kind="outfit": it captures the gpt-5.4-mini COGS and
// is the unguessable attribution anchor — but is EXCLUDED from the merchant's
// generation cap (every cap/trial count filters kind:"tryon").

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { verifyProxySignature } from "../lib/proxy.server";
import {
  buildKey as buildRateLimitKey,
  checkAndIncrement as rateLimitCheck,
  decrement as rateLimitDecrement,
} from "../lib/rateLimit.server";
import db from "../db.server";
import { isPlanKey, requestId, type PlanKey } from "../lib/plans";
import { outfitBackendEnabled } from "../lib/outfitFlags.server";
import { dailyCostCeiling } from "../lib/tryonGate.server";
import {
  generateOutfit,
  type AnchorInput,
  type Budget,
  type Fit,
  type Occasion,
  type QuizAnswers,
  type Vibe,
} from "../lib/outfit.server";
import type { PaletteAnswer } from "../lib/colorTheory";

// First-build can paginate the catalog + run a gpt-5.4-mini pass, so allow more
// than the default. >60s requires a Vercel Pro plan; subsequent outfits hit the
// cached index and return in a couple of seconds.
export const config = { maxDuration: 60 };

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

  let shop: string;
  let customerId: string | null;
  try {
    ({ shop, customerId } = verifyProxySignature(request));
  } catch (err) {
    if (err instanceof Response) return err;
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (payload ?? {}) as Record<string, unknown>;

  const mode = body.mode === "scratch" ? "scratch" : "anchor";
  const answers = parseAnswers(body.answers);
  if (!answers) return json({ error: "invalid_answers" }, { status: 400 });

  const anchor = parseAnchor(body.anchor);
  if (mode === "anchor" && !anchor) {
    return json({ error: "missing_anchor" }, { status: 400 });
  }

  // Resolve plan/cycle + settings for the feature gate and the UsageLog row.
  const billing = await db.billingState.findUnique({
    where: { shop },
    include: { shopRef: { include: { settings: true } } },
  });
  let settings = billing?.shopRef?.settings ?? null;
  if (!billing) {
    const installed = await db.shop.findUnique({
      where: { domain: shop },
      include: { settings: true },
    });
    if (!installed) return json({ error: "shop_not_installed" }, { status: 403 });
    settings = installed.settings ?? null;
  }

  if (!outfitBackendEnabled(settings)) {
    return json({ error: "feature_disabled" }, { status: 404 });
  }

  const plan: PlanKey = billing && isPlanKey(billing.plan) ? billing.plan : "trial";
  const cycleStart =
    billing?.currentCycleStart ?? billing?.trialStartedAt ?? new Date();

  // Rate limit (shared with try-on): protects the catalog fetch + model call.
  const firstXff =
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null;
  let rateLimitKey: string | null = null;
  try {
    rateLimitKey = buildRateLimitKey(shop, customerId, firstXff);
  } catch {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const verdict = await rateLimitCheck(rateLimitKey);
  if (!verdict.ok) {
    return json(
      { error: "rate_limited", retryAfter: verdict.retryAfter },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfter) } },
    );
  }

  // Honor the same global daily kill switch as the image + size endpoints (its
  // tally already includes this call's gpt-5.4-mini spend). When the fuse has
  // tripped, skip the outfit build entirely and return the endpoint's normal
  // "no outfit" response — no spend, no scary error — and refund the rate slot.
  const ceiling = await dailyCostCeiling();
  if (ceiling.exceeded) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({ requestId: null, outfit: null });
  }

  try {
    const { outfit, costUsd } = await generateOutfit({ shop, answers, mode, anchor });

    if (!outfit) {
      // Couldn't assemble a full look (mono-category shop, disabled feed, etc.).
      // Refund the rate-limit slot — the shopper got nothing.
      if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
      return json({ requestId: null, outfit: null });
    }

    const reqId = requestId();
    try {
      await db.usageLog.create({
        data: {
          shop,
          requestId: reqId,
          openaiRequestId: null,
          plan,
          kind: "outfit",
          costUsd,
          inputTokens: null,
          outputTokens: null,
          openaiMs: null,
          status: "ok",
          size: "outfit",
          cycleStart,
        },
      });
    } catch (logErr) {
      console.error(
        JSON.stringify({
          event: "usage_log_write_failed",
          sub_event: "outfit",
          error: logErr instanceof Error ? logErr.message : String(logErr),
          shop,
          request_id: reqId,
        }),
      );
    }

    console.log(
      JSON.stringify({
        event: "outfit_generated",
        shop,
        request_id: reqId,
        mode,
        feed_mode: outfit.feedMode,
        source: outfit.source,
        pieces: outfit.pieces.length,
        cost_usd: costUsd,
      }),
    );

    return json({ requestId: reqId, outfit });
  } catch (err) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    console.error(
      JSON.stringify({
        event: "outfit_error",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return json({ error: "outfit_failed" }, { status: 500 });
  }
}

// ---- input parsing ---------------------------------------------------------

const OCCASIONS: Occasion[] = ["everyday", "work", "date", "event", "active"];
const PALETTES: PaletteAnswer[] = ["warm", "cool", "neutral", "bold"];
const VIBES: Vibe[] = ["classic", "casual", "streetwear", "elegant", "minimal"];
const FITS: Fit[] = ["fitted", "relaxed", "oversized"];
const BUDGETS: Budget[] = ["best", "affordable"];

function oneOf<T extends string>(v: unknown, set: T[]): T | null {
  return typeof v === "string" && (set as string[]).includes(v) ? (v as T) : null;
}

function parseAnswers(v: unknown): QuizAnswers | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const occasion = oneOf(o.occasion, OCCASIONS);
  const palette = oneOf(o.palette, PALETTES);
  const vibe = oneOf(o.vibe, VIBES);
  const fit = oneOf(o.fit, FITS);
  if (!occasion || !palette || !vibe || !fit) return null;
  const budget = oneOf(o.budget, BUDGETS) ?? undefined;
  return { occasion, palette, vibe, fit, budget };
}

function parseAnchor(v: unknown): AnchorInput | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const handle = typeof o.handle === "string" ? o.handle.trim().slice(0, 255) : "";
  const id = typeof o.id === "string" || typeof o.id === "number" ? String(o.id) : "";
  if (!handle || !id) return null;
  return {
    id,
    handle,
    title: typeof o.title === "string" ? o.title.slice(0, 255) : handle,
    image: typeof o.image === "string" ? o.image.slice(0, 2048) : null,
    variantId:
      typeof o.variantId === "string" || typeof o.variantId === "number"
        ? String(o.variantId)
        : null,
  };
}
