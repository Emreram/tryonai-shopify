// Shared pre-generation gate for image-generating endpoints. Encapsulates the
// rate-limit + billing + trial/cap/cost-ceiling checks that protect every OpenAI
// image generation. Used by the outfit try-on route (proxy.outfit-tryon).
//
// NOTE: proxy.tryon.tsx still has its own equivalent inline gate (left untouched
// to keep the core money path stable during App Store review). The two should be
// unified onto this helper post-approval. Behaviour here mirrors that gate, and
// — like the new metering — counts only kind:"tryon" rows toward the merchant cap.

import type { MerchantSettings } from "@prisma/client";
import db from "../db.server";
import { verifyProxySignature } from "./proxy.server";
import {
  buildKey as buildRateLimitKey,
  checkAndIncrement as rateLimitCheck,
} from "./rateLimit.server";
import {
  computeCap,
  isPlanKey,
  requestId,
  TRIAL_DAYS,
  TRIAL_TRYONS,
  type PlanKey,
} from "./plans";
import { refreshBillingState } from "./billingSync.server";

export interface GateOk {
  ok: true;
  shop: string;
  customerId: string | null;
  plan: PlanKey;
  cycleStart: Date;
  settings: MerchantSettings | null;
  shopGid: string | null;
  rateLimitKey: string | null;
  reqId: string;
  /** kind:"tryon" rows already consumed this cycle, and the hard cap, so callers
   *  can pre-check multi-unit renders (e.g. a layered outfit) before spending. */
  used: number;
  cap: number;
}

export type GateResult = GateOk | { ok: false; response: Response };

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Global daily-spend kill switch. Reads DAILY_COST_CEILING_USD; when it's set > 0
 * and today's summed UsageLog cost (across ALL shops and kinds — tryon, outfit and
 * size) has reached it, returns exceeded:true. Shared by this generation gate AND
 * the text-only size endpoint so every OpenAI-spending path honors the same fuse.
 * When the ceiling is unset/0 it short-circuits with no DB query.
 */
export async function dailyCostCeiling(): Promise<{
  enabled: boolean;
  spend: number;
  ceiling: number;
  exceeded: boolean;
}> {
  const ceilingRaw = process.env.DAILY_COST_CEILING_USD;
  const ceiling = ceilingRaw ? Number(ceilingRaw) : 0;
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return { enabled: false, spend: 0, ceiling: 0, exceeded: false };
  }
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const agg = await db.usageLog.aggregate({
    _sum: { costUsd: true },
    where: { createdAt: { gte: startOfDay }, status: "ok" },
  });
  const spend = Number(agg._sum.costUsd ?? 0);
  return { enabled: true, spend, ceiling, exceeded: spend >= ceiling };
}

type BlockReason = "trial_expired" | "cap_reached" | "cost_ceiling" | "rate_limited";

/** A block attributable to the merchant's own plan allowance (vs. a transient
 *  rate-limit or the global cost fuse). Shared by the image gate and the
 *  text-tool routes so "tools available" is one consistent concept. */
export type PlanBlockReason = "trial_expired" | "cap_reached";

export interface PlanAccess {
  /** kind:"tryon" rows consumed this cycle. */
  used: number;
  /** Hard cap for the plan (or capOverride). */
  cap: number;
  /** null when the shop may generate; otherwise why it's blocked. */
  blocked: PlanBlockReason | null;
}

/**
 * Side-effect-free trial/cap eligibility check. Counts only kind:"tryon" rows
 * (the metering rule) and applies the same trial-age/trial-count/cap thresholds
 * as the image gate. Used by enforceGenerationGate AND by the text-tool routes
 * (outfit stylist, size chart) so an expired/over-cap shop can't use ANY tool.
 *
 * A null trialStartedAt (no billing row yet — a brand-new shop) is treated as
 * "trial just started" and never trips trial_expired.
 */
export async function checkPlanAccess(args: {
  shop: string;
  plan: PlanKey;
  trialStartedAt: Date | null;
  cycleStart: Date;
  capOverride: number | null;
}): Promise<PlanAccess> {
  const cap = computeCap(args.plan, args.capOverride);

  const [trialCount, used] = await Promise.all([
    args.plan === "trial" && args.trialStartedAt
      ? db.usageLog.count({
          where: {
            shop: args.shop,
            kind: "tryon",
            createdAt: { gte: args.trialStartedAt },
            status: "ok",
          },
        })
      : Promise.resolve(0),
    db.usageLog.count({
      where: { shop: args.shop, kind: "tryon", cycleStart: args.cycleStart, status: "ok" },
    }),
  ]);

  let blocked: PlanBlockReason | null = null;
  if (args.plan === "trial" && args.trialStartedAt) {
    const trialAge = Date.now() - args.trialStartedAt.getTime();
    if (trialAge > TRIAL_DAYS * 86_400_000 || trialCount >= TRIAL_TRYONS) {
      blocked = "trial_expired";
    }
  }
  if (!blocked && used >= cap) blocked = "cap_reached";

  return { used, cap, blocked };
}

async function writeBlockedLog(args: {
  shop: string;
  reqId: string;
  plan: PlanKey;
  cycleStart: Date;
  reason: BlockReason;
}) {
  try {
    await db.usageLog.create({
      data: {
        shop: args.shop,
        requestId: args.reqId,
        openaiRequestId: null,
        plan: args.plan,
        kind: "tryon",
        costUsd: 0,
        status: args.reason,
        size: "outfit",
        cycleStart: args.cycleStart,
      },
    });
  } catch {
    // best-effort
  }
}

/**
 * Verify the proxy signature and enforce the generation gate. On success returns
 * the resolved billing context + a fresh reqId + the rate-limit key (so the route
 * can refund the slot if generation aborts before completing). On a block returns
 * a ready-to-send Response.
 */
export async function enforceGenerationGate(request: Request): Promise<GateResult> {
  let shop: string;
  let customerId: string | null;
  try {
    ({ shop, customerId } = verifyProxySignature(request));
  } catch (err) {
    if (err instanceof Response) return { ok: false, response: err };
    return { ok: false, response: json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const firstXff =
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? null;
  let rateLimitKey: string | null = null;
  try {
    rateLimitKey = buildRateLimitKey(shop, customerId, firstXff);
  } catch {
    return { ok: false, response: json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const verdict = await rateLimitCheck(rateLimitKey);
  if (!verdict.ok) {
    await writeBlockedLog({
      shop,
      reqId: requestId(),
      plan: "trial",
      cycleStart: new Date(0),
      reason: "rate_limited",
    });
    return {
      ok: false,
      response: json(
        { error: "rate_limited", retryAfter: verdict.retryAfter },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfter) } },
      ),
    };
  }

  let billing = await db.billingState.findUnique({
    where: { shop },
    include: { shopRef: { include: { settings: true } } },
  });
  if (!billing) {
    const installed = await db.shop.findUnique({ where: { domain: shop } });
    if (!installed) {
      return { ok: false, response: json({ error: "shop_not_installed" }, { status: 403 }) };
    }
    await refreshBillingState({ shop });
    billing = await db.billingState.findUnique({
      where: { shop },
      include: { shopRef: { include: { settings: true } } },
    });
    if (!billing) {
      return { ok: false, response: json({ error: "shop_not_installed" }, { status: 403 }) };
    }
  } else {
    void refreshBillingState({ shop }).catch(() => {});
  }

  const plan: PlanKey = isPlanKey(billing.plan) ? billing.plan : "trial";
  const settings = billing.shopRef?.settings ?? null;
  const cycleStart =
    billing.currentCycleStart ?? billing.trialStartedAt ?? new Date(0);
  const reqId = requestId();

  // Counts mirror the metering rule: only kind:"tryon" rows consume the cap.
  const { used, cap, blocked } = await checkPlanAccess({
    shop,
    plan,
    trialStartedAt: billing.trialStartedAt,
    cycleStart,
    capOverride: settings?.capOverride ?? null,
  });

  if (blocked === "trial_expired") {
    await writeBlockedLog({ shop, reqId, plan, cycleStart, reason: "trial_expired" });
    return {
      ok: false,
      response: json(
        { error: "trial_expired", upgradeUrl: "/app/billing" },
        { status: 402 },
      ),
    };
  }

  if (blocked === "cap_reached") {
    await writeBlockedLog({ shop, reqId, plan, cycleStart, reason: "cap_reached" });
    return {
      ok: false,
      response: json({ error: "cap_reached", used, cap, upgradeUrl: "/app/billing" }, { status: 429 }),
    };
  }

  const ceiling = await dailyCostCeiling();
  if (ceiling.exceeded) {
    await writeBlockedLog({ shop, reqId, plan, cycleStart, reason: "cost_ceiling" });
    return { ok: false, response: json({ error: "service_paused" }, { status: 503 }) };
  }

  return {
    ok: true,
    shop,
    customerId,
    plan,
    cycleStart,
    settings,
    shopGid: billing.shopRef?.shopGid ?? null,
    rateLimitKey,
    reqId,
    used,
    cap,
  };
}
