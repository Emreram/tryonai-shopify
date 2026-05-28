import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  PAID_PLAN_KEYS,
  PLAN_KEYS,
  PLANS,
  TRIAL_TRYONS,
  computeCap,
  isPlanKey,
  planFromName,
  type PlanKey,
} from "./plans";
import {
  fetchActiveSubscription,
  hasPartnerApiConfig,
  type ActiveSubscription,
} from "./partnerApi.server";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function storeHandle(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

export function hostedPlanPageUrl(shopDomain: string): string {
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "tryonai";
  return `https://admin.shopify.com/store/${encodeURIComponent(
    storeHandle(shopDomain),
  )}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

function planFromHandle(value: string | null | undefined): PlanKey | null {
  if (!value) return null;
  if (isPlanKey(value)) return value;
  const inferred = planFromName(value);
  return inferred === "trial" && !value.toLowerCase().includes("trial")
    ? null
    : inferred;
}

function recurringAmount(active: ActiveSubscription): number | null {
  for (const item of active.items ?? []) {
    const price = item.price;
    if (price?.__typename !== "FlatRatePrice") continue;
    if (price.active === false) continue;
    const amount = Number(price.amount);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function planFromSubscription(
  active: ActiveSubscription,
  planHandle: string | null,
  existingPlan: string | null | undefined,
): PlanKey {
  const hinted = planFromHandle(planHandle);
  if (hinted) return hinted;

  const text = (active.items ?? [])
    .flatMap((item) => [item.handle, item.description])
    .filter(Boolean)
    .join(" ");
  const named = planFromHandle(text);
  if (named) return named;

  const amount = recurringAmount(active);
  const byPrice = PAID_PLAN_KEYS.find((key) => PLANS[key].price === amount);
  if (byPrice) return byPrice;
  return isPlanKey(existingPlan) ? existingPlan : "trial";
}

async function fetchShopGid(
  shop: string,
  admin?: AdminClient,
): Promise<string | null> {
  const existing = await db.shop.findUnique({
    where: { domain: shop },
    select: { shopGid: true },
  });
  if (existing?.shopGid) return existing.shopGid;

  let client = admin;
  if (!client) {
    const unauth = await unauthenticated.admin(shop);
    client = unauth.admin;
  }

  const response = await client.graphql(
    `#graphql
      query TryonaiShopGid {
        shop {
          id
          myshopifyDomain
        }
      }`,
  );
  const json = await response.json();
  const shopGid = json?.data?.shop?.id;
  if (typeof shopGid !== "string" || !shopGid) return null;

  await db.shop.update({
    where: { domain: shop },
    data: { shopGid },
  });
  return shopGid;
}

export async function refreshBillingState(args: {
  shop: string;
  admin?: AdminClient;
  planHandle?: string | null;
}) {
  await db.shop.upsert({
    where: { domain: args.shop },
    create: { domain: args.shop },
    update: {},
  });
  const existing = await db.billingState.upsert({
    where: { shop: args.shop },
    create: { shop: args.shop },
    update: {},
  });

  let shopGid: string | null = null;
  try {
    shopGid = await fetchShopGid(args.shop, args.admin);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "shop_gid_sync_failed",
        shop: args.shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  if (!shopGid || !hasPartnerApiConfig()) {
    if (existing.status === "uninstalled") {
      return db.billingState.update({
        where: { shop: args.shop },
        data: { status: "inactive" },
      });
    }
    return existing;
  }

  let active: ActiveSubscription | null = null;
  try {
    active = await fetchActiveSubscription(shopGid);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "partner_active_subscription_failed",
        shop: args.shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    if (existing.status === "uninstalled") {
      return db.billingState.update({
        where: { shop: args.shop },
        data: { status: "inactive" },
      });
    }
    return existing;
  }

  if (!active) {
    return db.billingState.update({
      where: { shop: args.shop },
      data: {
        plan: "trial",
        status: "inactive",
        subscriptionId: null,
        paidPlanStartedAt: null,
        currentCycleStart: null,
        currentCycleEnd: null,
        trialEndsAt: null,
        monthlyCap: TRIAL_TRYONS,
      },
    });
  }

  const plan = planFromSubscription(
    active,
    args.planHandle ?? null,
    existing.plan,
  );
  const cycleStart =
    parseDate(active.currentBillingCycle?.startTime) ??
    existing.currentCycleStart ??
    new Date();
  const cycleEnd = parseDate(active.currentBillingCycle?.endTime);
  const trialEndsAt = parseDate(active.trialEndsAt);
  const monthlyCap = computeCap(plan, null);
  const paidPlanStartedAt =
    plan !== "trial"
      ? existing.paidPlanStartedAt ?? cycleStart
      : existing.paidPlanStartedAt;

  if (!PLAN_KEYS.includes(plan)) {
    return existing;
  }

  return db.billingState.update({
    where: { shop: args.shop },
    data: {
      plan,
      status: "active",
      subscriptionId: null,
      paidPlanStartedAt,
      currentCycleStart: cycleStart,
      currentCycleEnd: cycleEnd,
      trialEndsAt,
      monthlyCap,
    },
  });
}
