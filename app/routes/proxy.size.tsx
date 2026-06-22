// Signed app-proxy endpoint: storefront -> /apps/tryonai/size. Takes the shopper's
// biometrics (transient; never stored) + a few product handles and returns the
// recommended in-stock size per product. Auth is the App Proxy HMAC, identical to
// proxy.outfit. Logs one UsageLog kind="size" for COGS only — NO biometrics are
// ever persisted or logged.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { verifyProxySignature } from "../lib/proxy.server";
import {
  buildKey as buildRateLimitKey,
  checkAndIncrement as rateLimitCheck,
  decrement as rateLimitDecrement,
} from "../lib/rateLimit.server";
import db from "../db.server";
import { isPlanKey, requestId, type PlanKey } from "../lib/plans";
import { sizeBackendEnabled } from "../lib/outfitFlags.server";
import { checkPlanAccess, dailyCostCeiling } from "../lib/tryonGate.server";
import { recommendSizes, type SizeProductRequest } from "../lib/size.server";
import type { Biometrics, Build, FitPref, Gender, ShoeSystem } from "../lib/sizeChart";

// Reads a public product JSON per handle + one gpt-5.4-mini call; allow headroom.
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

  const biometrics = parseBiometrics(body.biometrics);
  if (!biometrics) return json({ error: "invalid_biometrics" }, { status: 400 });
  const products = parseProducts(body.products);
  if (products.length === 0) return json({ error: "no_products" }, { status: 400 });

  // Resolve plan/cycle + settings for the feature gate and the (cost-only) log.
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

  if (!sizeBackendEnabled(settings)) {
    return json({ error: "feature_disabled" }, { status: 404 });
  }

  const plan: PlanKey = billing && isPlanKey(billing.plan) ? billing.plan : "trial";
  const cycleStart =
    billing?.currentCycleStart ?? billing?.trialStartedAt ?? new Date();

  // Same trial/cap gate as the image tools: a shop whose trial has ended (or a
  // paid shop over its monthly cap) can't use ANY tool, the size chart included.
  const access = await checkPlanAccess({
    shop,
    plan,
    trialStartedAt: billing?.trialStartedAt ?? null,
    cycleStart,
    capOverride: settings?.capOverride ?? null,
  });
  if (access.blocked === "trial_expired") {
    return json({ error: "trial_expired", upgradeUrl: "/app/billing" }, { status: 402 });
  }
  if (access.blocked === "cap_reached") {
    return json(
      { error: "cap_reached", used: access.used, cap: access.cap, upgradeUrl: "/app/billing" },
      { status: 429 },
    );
  }

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

  // Honor the same global daily kill switch as the image endpoints — its tally
  // already includes this endpoint's spend. When the fuse has tripped, skip the
  // gpt-5.4-mini call entirely and degrade to the manual selector: no spend, no
  // scary error (consistent with this route's never-throw contract), and refund
  // the rate-limit slot since the shopper got no recommendation.
  const ceiling = await dailyCostCeiling();
  if (ceiling.exceeded) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    return json({
      requestId: null,
      results: products.map((p) => ({
        handle: p.handle,
        status: "uncertain",
        size: null,
        variantId: null,
        note: null,
      })),
      disclaimer: true,
    });
  }

  try {
    const { results, costUsd } = await recommendSizes(shop, biometrics, products);
    const reqId = requestId();

    try {
      await db.usageLog.create({
        data: {
          shop,
          requestId: reqId,
          openaiRequestId: null,
          plan,
          kind: "size",
          costUsd,
          status: "ok",
          size: "size",
          cycleStart,
        },
      });
    } catch (logErr) {
      console.error(
        JSON.stringify({
          event: "usage_log_write_failed",
          sub_event: "size",
          error: logErr instanceof Error ? logErr.message : String(logErr),
          shop,
          request_id: reqId,
        }),
      );
    }

    // NOTE: no biometrics in this log line — only non-PII counts.
    console.log(
      JSON.stringify({
        event: "size_recommended",
        shop,
        request_id: reqId,
        products: results.length,
        statuses: countStatuses(results),
        cost_usd: costUsd,
      }),
    );

    return json({ requestId: reqId, results, disclaimer: true });
  } catch (err) {
    if (rateLimitKey) await rateLimitDecrement(rateLimitKey);
    console.error(
      JSON.stringify({
        event: "size_error",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // Even on a hard failure, hand the widget a graceful "uncertain" per product
    // so the storefront falls back to manual selection without an error.
    return json({
      requestId: null,
      results: products.map((p) => ({
        handle: p.handle,
        status: "uncertain",
        size: null,
        variantId: null,
        note: null,
      })),
      disclaimer: true,
    });
  }
}

// ---- input parsing ---------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function oneOf<T extends string>(v: unknown, set: T[], dflt: T): T {
  return typeof v === "string" && (set as string[]).includes(v) ? (v as T) : dflt;
}

function parseBiometrics(v: unknown): Biometrics | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const heightCm = num(o.heightCm);
  const weightKg = num(o.weightKg);
  if (!Number.isFinite(heightCm) || !Number.isFinite(weightKg)) return null;
  const build = oneOf<Build>(o.build, ["slim", "average", "broad"], "average");
  const gender = oneOf<Gender>(o.gender, ["mens", "womens", "unisex"], "unisex");
  const fit = ["fitted", "relaxed", "oversized"].includes(o.fit as string)
    ? (o.fit as FitPref)
    : undefined;
  const shoeRaw = num(o.shoeSizeRaw);
  const shoeSizeRaw = Number.isFinite(shoeRaw) && shoeRaw > 0 ? shoeRaw : undefined;
  const shoeSystem = oneOf<ShoeSystem>(o.shoeSystem, ["US", "EU", "UK"], "US");
  return { heightCm, weightKg, build, gender, fit, shoeSizeRaw, shoeSystem };
}

function parseProducts(v: unknown): SizeProductRequest[] {
  if (!Array.isArray(v)) return [];
  const out: SizeProductRequest[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const handle = (item as Record<string, unknown>).handle;
    if (typeof handle !== "string" || !handle.trim()) continue;
    const colorHint = (item as Record<string, unknown>).colorHint;
    out.push({
      handle: handle.trim().slice(0, 255),
      colorHint: typeof colorHint === "string" ? colorHint.slice(0, 80) : null,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function countStatuses(results: Array<{ status: string }>): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of results) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}
