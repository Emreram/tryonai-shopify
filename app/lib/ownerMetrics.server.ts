// Owner-only profit metrics: aggregates every shop's try-ons into revenue vs.
// cost. COGS is EXACT (sum of UsageLog.costUsd for status='ok', which now
// includes both OpenAI passes). Revenue is ESTIMATED from each shop's current
// plan config (subscription run-rate + overage above included) — the app does
// not store actual Shopify payouts. See metrics.tsx for the disclaimer shown to
// the owner. Read-only; no schema change.

import db from "../db.server";
import {
  PLANS,
  PAID_PLAN_KEYS,
  PLAN_DISPLAY,
  isPlanKey,
  type PlanKey,
} from "./plans";
import { commissionPct, commissionRate } from "./commission";

// Only "active" subscriptions are recognized as revenue. pending/frozen/etc.
// are NOT collecting reliably, so counting them would overstate profit — we
// stay conservative for an honest floor.
const REVENUE_STATUSES = new Set(["active"]);
const PAID = new Set<string>(PAID_PLAN_KEYS);

export interface ShopRow {
  domain: string;
  plan: string;
  planLabel: string;
  status: string;
  isPaidActive: boolean;
  cycleTryOns: number; // successful try-ons in the shop's current billing cycle
  included: number;
  overageUnits: number;
  subscriptionRev: number;
  overageRev: number;
  revenue: number;
  cogsCycle: number; // exact OpenAI cost this cycle
  profitCycle: number;
  margin: number | null;
  cogsAllTime: number;
  tryOnsAllTime: number;
  blockedAllTime: number; // non-"ok" rows (cap_reached, rate_limited, error, ...)
  cartAdds: number; // tool-driven add-to-carts, all-time
  cartAddsCycle: number; // tool-driven add-to-carts in the shop's current cycle
  attributedValue: number; // summed cart value the tool drove (shop currency)
  cartCurrency: string | null; // dominant currency of this shop's cart events
  cartConversionPct: number | null; // cartAdds / tryOnsAllTime * 100
  category: ShopCategory;
  installedAt: string | null; // ISO date; null if no Shop record exists
}

export type ShopCategory = "Paying" | "Trial" | "Uninstalled" | "Inactive";

export interface CategoryRow {
  category: ShopCategory;
  shops: number;
  tryOnsAllTime: number;
  cogsAllTime: number; // total OpenAI cost this category has ever incurred
  mrr: number; // current run-rate revenue (Paying only)
}

export interface LedgerRow {
  id: string;
  createdAt: Date;
  shop: string;
  plan: string;
  size: string;
  costUsd: number;
  status: string;
  billingEventStatus: string | null;
}

export interface DayPoint {
  day: string; // YYYY-MM-DD (UTC)
  tryons: number;
  ok: number;
  cogs: number;
  cartAdds: number; // tool-driven add-to-carts on this day
}

// Attributed cart value + estimated commission, grouped by currency so the owner
// total is never silently summed across different currencies.
export interface CurrencyValueRow {
  currency: string; // ISO code, or "—" when the beacon couldn't capture one
  count: number;
  value: number;
  commission: number;
}

export interface OwnerMetrics {
  generatedAtUtc: string;
  totals: {
    shopsTotal: number;
    paidActiveByPlan: Record<string, number>;
    trialShops: number;
    mrr: number;
    overageRevCycle: number;
    revenueCycle: number;
    cogsCycle: number;
    profitCycle: number;
    marginCycle: number | null;
    trialCacCycle: number;
  };
  allTime: {
    tryOnsOk: number;
    cogs: number;
    trialCac: number;
  };
  cart: {
    addToCarts: number; // tool-driven add-to-carts, all-time
    addToCartsCycle: number; // tool-driven add-to-carts, current cycle (all shops)
    conversionRatePct: number | null; // add-to-carts / successful try-ons * 100
    commissionPct: number; // the rate applied to attributed value (e.g. 8 = 8%)
    primaryCurrency: string | null; // set only when exactly one currency is present
    attributedValuePrimary: number | null; // total attributed value in that currency
    commissionPrimary: number | null; // estimated commission in that currency
    byCurrency: CurrencyValueRow[]; // always present; the honest per-currency breakdown
  };
  shops: ShopRow[];
  byCategory: CategoryRow[];
  ledger: LedgerRow[];
  trend: DayPoint[];
}

export async function buildOwnerMetrics(): Promise<OwnerMetrics> {
  const shops = await db.shop.findMany({
    select: {
      domain: true,
      installedAt: true,
      billing: {
        select: {
          plan: true,
          status: true,
          currentCycleStart: true,
          trialStartedAt: true,
        },
      },
    },
  });

  // Exact all-time COGS + ok-count per shop. Index: [shop, status, cycleStart].
  const allOk = await db.usageLog.groupBy({
    by: ["shop"],
    where: { status: "ok" },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  const allOkByShop = new Map(
    allOk.map((r) => [
      r.shop,
      { cogs: r._sum.costUsd ?? 0, count: r._count._all },
    ]),
  );

  // Non-"ok" volume per shop (blocked / errored try-ons), all-time.
  const nonOk = await db.usageLog.groupBy({
    by: ["shop"],
    where: { status: { not: "ok" } },
    _count: { _all: true },
  });
  const blockedByShop = new Map(nonOk.map((r) => [r.shop, r._count._all]));

  // Per shop + cycle bucket (ok only). We pick, per shop, the bucket whose
  // cycleStart equals that shop's current reference start — exactly how
  // proxy.tryon.tsx wrote the rows, so this matches the live cap counter.
  const byCycle = await db.usageLog.groupBy({
    by: ["shop", "cycleStart"],
    where: { status: "ok" },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  const cycleByShop = new Map<string, Map<number, { count: number; cogs: number }>>();
  for (const r of byCycle) {
    const m = cycleByShop.get(r.shop) ?? new Map<number, { count: number; cogs: number }>();
    m.set(r.cycleStart.getTime(), {
      count: r._count._all,
      cogs: r._sum.costUsd ?? 0,
    });
    cycleByShop.set(r.shop, m);
  }

  // --- Tool-driven add-to-cart attribution (CartEvent) -------------------------
  // Per shop + currency: count + summed cart value. A shop is normally a single
  // currency; keep the breakdown so the owner total is never silently summed
  // across currencies. Also accumulate global per-currency totals here.
  const cartByShopCurrency = await db.cartEvent.groupBy({
    by: ["shop", "currency"],
    _count: { _all: true },
    _sum: { lineValue: true },
  });
  const cartAllByShop = new Map<
    string,
    { count: number; value: number; currencyByCount: Map<string, number> }
  >();
  const currencyTotals = new Map<string, { count: number; value: number }>();
  for (const r of cartByShopCurrency) {
    const cur = r.currency ?? "—";
    const count = r._count._all;
    const value = r._sum.lineValue ?? 0;
    const agg = cartAllByShop.get(r.shop) ?? {
      count: 0,
      value: 0,
      currencyByCount: new Map<string, number>(),
    };
    agg.count += count;
    agg.value += value;
    agg.currencyByCount.set(cur, (agg.currencyByCount.get(cur) ?? 0) + count);
    cartAllByShop.set(r.shop, agg);
    const ct = currencyTotals.get(cur) ?? { count: 0, value: 0 };
    ct.count += count;
    ct.value += value;
    currencyTotals.set(cur, ct);
  }

  // Per shop + cycle bucket (count only), matched to the shop's current cycle
  // exactly like the try-on counter above.
  const cartByCycle = await db.cartEvent.groupBy({
    by: ["shop", "cycleStart"],
    _count: { _all: true },
  });
  const cartCycleByShop = new Map<string, Map<number, number>>();
  for (const r of cartByCycle) {
    const m = cartCycleByShop.get(r.shop) ?? new Map<number, number>();
    m.set(r.cycleStart.getTime(), r._count._all);
    cartCycleByShop.set(r.shop, m);
  }

  // Every shop that ever installed (Shop rows survive uninstall — only status
  // flips to "uninstalled"), unioned with any shop that has UsageLog rows but
  // no Shop record (defensive, e.g. pre-Shop-model data).
  const shopByDomain = new Map(shops.map((s) => [s.domain, s]));
  const domains = new Set<string>(shops.map((s) => s.domain));
  for (const r of allOk) domains.add(r.shop);
  for (const r of nonOk) domains.add(r.shop);
  for (const r of cartByShopCurrency) domains.add(r.shop);

  const rows: ShopRow[] = [...domains].map((domain) => {
    const s = shopByDomain.get(domain) ?? null;
    const b = s?.billing ?? null;
    const plan: PlanKey = isPlanKey(b?.plan) ? (b!.plan as PlanKey) : "trial";
    const def = PLANS[plan];
    const status = b?.status ?? (s ? "inactive" : "unknown");
    // Mirror proxy.tryon.tsx's cycleStart fallback chain exactly.
    const cycleRef =
      b?.currentCycleStart ?? b?.trialStartedAt ?? s?.installedAt ?? null;
    const bucket = cycleRef
      ? cycleByShop.get(domain)?.get(cycleRef.getTime())
      : undefined;
    const cycleTryOns = bucket?.count ?? 0;
    const cogsCycle = bucket?.cogs ?? 0;

    const isPaidActive = PAID.has(plan) && REVENUE_STATUSES.has(status);
    const subscriptionRev = isPaidActive ? def.price : 0;
    const overageUnits = Math.max(0, cycleTryOns - def.included);
    const overageRev =
      isPaidActive && def.overage != null ? overageUnits * def.overage : 0;
    const revenue = subscriptionRev + overageRev;
    const profitCycle = revenue - cogsCycle;
    const margin = revenue > 0 ? (profitCycle / revenue) * 100 : null;
    const allt = allOkByShop.get(domain);

    const cartAll = cartAllByShop.get(domain);
    const cartAdds = cartAll?.count ?? 0;
    const attributedValue = cartAll?.value ?? 0;
    const cartCurrency = cartAll ? dominantCurrency(cartAll.currencyByCount) : null;
    const cartAddsCycle = cycleRef
      ? cartCycleByShop.get(domain)?.get(cycleRef.getTime()) ?? 0
      : 0;
    const tryOnsAll = allt?.count ?? 0;
    const cartConversionPct =
      tryOnsAll > 0 ? (cartAdds / tryOnsAll) * 100 : null;

    let category: ShopCategory;
    if (status === "uninstalled") category = "Uninstalled";
    else if (isPaidActive) category = "Paying";
    else if (plan === "trial" && (status === "active" || status === "pending"))
      category = "Trial";
    else category = "Inactive";

    return {
      domain,
      plan,
      planLabel: PLAN_DISPLAY[plan] ?? plan,
      status,
      isPaidActive,
      cycleTryOns,
      included: def.included,
      overageUnits,
      subscriptionRev,
      overageRev,
      revenue,
      cogsCycle,
      profitCycle,
      margin,
      cogsAllTime: allt?.cogs ?? 0,
      tryOnsAllTime: allt?.count ?? 0,
      blockedAllTime: blockedByShop.get(domain) ?? 0,
      cartAdds,
      cartAddsCycle,
      attributedValue,
      cartCurrency,
      cartConversionPct,
      category,
      installedAt: s?.installedAt ? s.installedAt.toISOString() : null,
    };
  });
  // Most expensive shops first — directly answers "how much does each cost me".
  rows.sort((a, b) => b.cogsAllTime - a.cogsAllTime);

  const paidActiveByPlan: Record<string, number> = {};
  let trialShops = 0;
  let mrr = 0;
  let overageRevCycle = 0;
  let cogsCycle = 0;
  let trialCacCycle = 0;
  for (const r of rows) {
    if (r.isPaidActive) {
      paidActiveByPlan[r.plan] = (paidActiveByPlan[r.plan] ?? 0) + 1;
      mrr += r.subscriptionRev;
      overageRevCycle += r.overageRev;
    }
    if (r.plan === "trial") {
      trialShops += 1;
      trialCacCycle += r.cogsCycle;
    }
    cogsCycle += r.cogsCycle;
  }
  const revenueCycle = mrr + overageRevCycle;
  const profitCycle = revenueCycle - cogsCycle;
  const marginCycle =
    revenueCycle > 0 ? (profitCycle / revenueCycle) * 100 : null;

  // All-time exact totals (direct aggregates so plan attribution uses the plan
  // stored at write time, not the shop's current plan).
  const totalAgg = await db.usageLog.aggregate({
    where: { status: "ok" },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  const trialAgg = await db.usageLog.aggregate({
    where: { status: "ok", plan: "trial" },
    _sum: { costUsd: true },
  });

  const ledgerRows = await db.usageLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      createdAt: true,
      shop: true,
      plan: true,
      size: true,
      costUsd: true,
      status: true,
      billingEventStatus: true,
    },
  });

  // Last 30 days, per UTC day. count(*) returns bigint -> Number().
  const trendRaw = await db.$queryRaw<
    Array<{ day: Date; tryons: bigint; ok: bigint; cogs: number }>
  >`
    SELECT date_trunc('day', "createdAt") AS day,
           count(*) AS tryons,
           count(*) FILTER (WHERE "status" = 'ok') AS ok,
           coalesce(sum(CASE WHEN "status" = 'ok' THEN "costUsd" ELSE 0 END), 0) AS cogs
    FROM "UsageLog"
    WHERE "createdAt" >= now() - interval '30 days'
    GROUP BY 1
    ORDER BY 1`;
  // Tool-driven add-to-carts per UTC day (last 30 days). Joined into the trend
  // below by day string.
  const cartTrendRaw = await db.$queryRaw<Array<{ day: Date; adds: bigint }>>`
    SELECT date_trunc('day', "createdAt") AS day, count(*) AS adds
    FROM "CartEvent"
    WHERE "createdAt" >= now() - interval '30 days'
    GROUP BY 1`;
  const cartAddsByDay = new Map<string, number>();
  for (const r of cartTrendRaw) {
    cartAddsByDay.set(r.day.toISOString().slice(0, 10), Number(r.adds));
  }

  const trendByDay = new Map<string, DayPoint>();
  for (const r of trendRaw) {
    const day = r.day.toISOString().slice(0, 10);
    trendByDay.set(day, {
      day,
      tryons: Number(r.tryons),
      ok: Number(r.ok),
      cogs: Number(r.cogs),
      cartAdds: cartAddsByDay.get(day) ?? 0,
    });
  }
  // A cart-add can land on a day with no new try-on (the shopper generated
  // yesterday, added today), so those days must still appear.
  for (const [day, adds] of cartAddsByDay) {
    if (!trendByDay.has(day)) {
      trendByDay.set(day, { day, tryons: 0, ok: 0, cogs: 0, cartAdds: adds });
    }
  }
  const trend: DayPoint[] = [...trendByDay.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );

  // Group every shop into a category with its total cost.
  const catOrder: ShopCategory[] = ["Paying", "Trial", "Uninstalled", "Inactive"];
  const catMap = new Map<ShopCategory, CategoryRow>(
    catOrder.map((c) => [
      c,
      { category: c, shops: 0, tryOnsAllTime: 0, cogsAllTime: 0, mrr: 0 },
    ]),
  );
  for (const r of rows) {
    const cr = catMap.get(r.category)!;
    cr.shops += 1;
    cr.tryOnsAllTime += r.tryOnsAllTime;
    cr.cogsAllTime += r.cogsAllTime;
    if (r.isPaidActive) cr.mrr += r.subscriptionRev;
  }
  const byCategory = catOrder
    .map((c) => catMap.get(c)!)
    .filter((c) => c.shops > 0);

  // Cart attribution totals + the per-currency value breakdown.
  const cartAddsTotal = [...currencyTotals.values()].reduce(
    (a, c) => a + c.count,
    0,
  );
  let cartAddsCycleTotal = 0;
  for (const r of rows) cartAddsCycleTotal += r.cartAddsCycle;
  const rate = commissionRate();
  const byCurrency: CurrencyValueRow[] = [...currencyTotals.entries()]
    .map(([currency, v]) => ({
      currency,
      count: v.count,
      value: v.value,
      commission: v.value * rate,
    }))
    .sort((a, b) => b.value - a.value);
  // A single headline value is only meaningful with exactly one real currency
  // (the "—" bucket = beacons that couldn't capture one).
  const knownCurrencies = byCurrency.filter(
    (c) => c.currency !== "—" && c.value > 0,
  );
  const primary = knownCurrencies.length === 1 ? knownCurrencies[0] : null;
  const tryOnsOkAllTime = totalAgg._count._all;

  return {
    generatedAtUtc: new Date().toISOString(),
    totals: {
      shopsTotal: rows.length,
      paidActiveByPlan,
      trialShops,
      mrr,
      overageRevCycle,
      revenueCycle,
      cogsCycle,
      profitCycle,
      marginCycle,
      trialCacCycle,
    },
    allTime: {
      tryOnsOk: totalAgg._count._all,
      cogs: totalAgg._sum.costUsd ?? 0,
      trialCac: trialAgg._sum.costUsd ?? 0,
    },
    cart: {
      addToCarts: cartAddsTotal,
      addToCartsCycle: cartAddsCycleTotal,
      conversionRatePct:
        tryOnsOkAllTime > 0 ? (cartAddsTotal / tryOnsOkAllTime) * 100 : null,
      commissionPct: commissionPct(),
      primaryCurrency: primary?.currency ?? null,
      attributedValuePrimary: primary?.value ?? null,
      commissionPrimary: primary?.commission ?? null,
      byCurrency,
    },
    shops: rows,
    byCategory,
    ledger: ledgerRows,
    trend,
  };
}

// Pick the currency a shop's cart events are mostly in (a shop occasionally
// changes currency, so we report the dominant one for the per-shop row).
function dominantCurrency(byCount: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [cur, n] of byCount) {
    if (n > bestN) {
      best = cur;
      bestN = n;
    }
  }
  return best;
}
