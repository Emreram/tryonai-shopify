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

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/**
 * Active subscription as returned by the Admin GraphQL
 * `currentAppInstallation.activeSubscriptions` query. Only subscriptions in
 * the ACTIVE state appear in this list, so the mere presence of an entry means
 * the merchant has an approved, billable plan.
 */
interface AdminActiveSubscription {
  id: string;
  name: string;
  status: string;
  test: boolean;
  currentPeriodEnd: string | null;
  createdAt: string | null;
  trialDays: number | null;
  lineItems: Array<{
    plan?: {
      pricingDetails?: {
        __typename?: string;
        price?: { amount?: string | number | null } | null;
        interval?: string | null;
      } | null;
    } | null;
  }> | null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function storeHandle(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

function appHandle(): string {
  return process.env.SHOPIFY_APP_HANDLE || "tryonaishopfy";
}

/**
 * Build the Shopify-hosted Managed Pricing ("Shopify App Pricing") plan page.
 *
 * Per Shopify's docs the URL is
 * `https://admin.shopify.com/store/{storeHandle}/charges/{appHandle}/pricing_plans`,
 * where `storeHandle` is the shop's myshopify subdomain. We derive it from
 * `session.shop` (always available in admin loaders) rather than the embedded
 * `host` param: `host` is ABSENT on React Router `.data` revalidation requests,
 * so a host-derived URL flipped to a fallback on every poll — the confirmed
 * source of the `hosted_plan_url_host_fallback` churn and the "loops on the
 * selection" symptom. Deriving from `shop` makes the URL byte-identical on the
 * first load and on every revalidation, and matches the documented pattern
 * (`redirect(url, { target: "_top" })`).
 */
export function hostedPlanPageUrl(args: { shop: string }): string {
  const handle = encodeURIComponent(appHandle());
  const store = encodeURIComponent(storeHandle(args.shop));
  return `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`;
}

function planFromHandle(value: string | null | undefined): PlanKey | null {
  if (!value) return null;
  if (isPlanKey(value)) return value;
  const inferred = planFromName(value);
  return inferred === "trial" && !value.toLowerCase().includes("trial")
    ? null
    : inferred;
}

function recurringAmount(sub: AdminActiveSubscription): number | null {
  for (const item of sub.lineItems ?? []) {
    const details = item.plan?.pricingDetails;
    if (details?.__typename !== "AppRecurringPricing") continue;
    const amount = Number(details.price?.amount);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function intervalDays(sub: AdminActiveSubscription): number {
  for (const item of sub.lineItems ?? []) {
    const details = item.plan?.pricingDetails;
    if (details?.__typename === "AppRecurringPricing") {
      return details.interval === "ANNUAL" ? 365 : 30;
    }
  }
  return 30;
}

function planFromSubscription(
  sub: AdminActiveSubscription,
  planHandle: string | null,
  existingPlan: string | null | undefined,
): PlanKey {
  // 1. The `plan_handle` Shopify appends to the return URL after selection is
  //    the authoritative signal: our Managed Pricing handles are exactly the
  //    PlanKeys ("starter"/"growth"/"scale"), so this is an exact match.
  const hinted = planFromHandle(planHandle);
  if (hinted) return hinted;

  // 2. Exact recurring price. Managed Pricing reports the configured plan price
  //    ($49/$129/$349) verbatim, so it's an exact, deterministic match — more
  //    reliable than the name, which can be renamed or localized.
  const amount = recurringAmount(sub);
  const byPrice = PAID_PLAN_KEYS.find((key) => PLANS[key].price === amount);
  if (byPrice) return byPrice;

  // 3. Last resort: the subscription name (fuzzy substring match).
  const named = planFromHandle(sub.name);
  if (named) return named;

  // 4. Keep the last-known plan rather than silently dropping to trial when an
  //    active subscription exists but matched none of the above.
  return isPlanKey(existingPlan) ? existingPlan : "trial";
}

function logWarn(event: string, shop: string, err: unknown): void {
  console.warn(
    JSON.stringify({
      event,
      shop,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * Cache the shop's GID on the Shop row. Not needed for billing itself, but the
 * usage-metering path (App Events API) reads `Shop.shopGid`, so keep it fresh.
 */
async function cacheShopGid(shop: string, admin: AdminClient): Promise<void> {
  const existing = await db.shop.findUnique({
    where: { domain: shop },
    select: { shopGid: true },
  });
  if (existing?.shopGid) return;

  const response = await admin.graphql(
    `#graphql
      query TryonaiShopGid {
        shop {
          id
        }
      }`,
  );
  const json = await response.json();
  const shopGid = json?.data?.shop?.id;
  if (typeof shopGid === "string" && shopGid) {
    await db.shop.update({ where: { domain: shop }, data: { shopGid } });
  }
}

/**
 * Read the app's own active subscription via the merchant Admin API. Works with
 * both the online session client (from admin loaders) and the offline client
 * (`unauthenticated.admin`, used by the storefront app-proxy path). Requires no
 * extra access scope — an app may always read its own installation.
 */
async function fetchActiveSubscription(
  admin: AdminClient,
): Promise<AdminActiveSubscription | null> {
  const response = await admin.graphql(
    `#graphql
      query TryonaiActiveSubscriptions {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            currentPeriodEnd
            createdAt
            trialDays
            lineItems {
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    price {
                      amount
                    }
                    interval
                  }
                }
              }
            }
          }
        }
      }`,
  );

  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(JSON.stringify(json.errors));
  }

  const subs = json?.data?.currentAppInstallation?.activeSubscriptions;
  if (!Array.isArray(subs) || subs.length === 0) return null;
  const active =
    subs.find((s) => String(s?.status).toUpperCase() === "ACTIVE") ?? subs[0];
  return (active as AdminActiveSubscription) ?? null;
}

/**
 * Reconcile local BillingState with Shopify's live subscription truth. Shopify
 * (Managed Pricing) is authoritative; the local row is a cache that gates the
 * high-frequency storefront try-on path and tracks the app's own free trial.
 */
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

  // Admin page loaders pass an `admin` client and always refresh so the
  // merchant sees live status. The storefront app-proxy path passes no client
  // and runs on every try-on, so throttle those background refreshes to avoid
  // hitting the Admin API on each request. A returning approval (`planHandle`)
  // or an uninstalled row always forces a fresh read.
  if (
    !args.admin &&
    !args.planHandle &&
    existing.status !== "uninstalled" &&
    Date.now() - existing.updatedAt.getTime() < 5 * 60_000
  ) {
    return existing;
  }

  // Resolve an admin client. Loaders pass the online session client; the
  // app-proxy path passes nothing, so fall back to the offline token.
  let admin = args.admin;
  if (!admin) {
    try {
      const unauth = await unauthenticated.admin(args.shop);
      admin = unauth.admin;
    } catch (err) {
      logWarn("billing_admin_unauth_failed", args.shop, err);
      return existing; // Can't reach Shopify — keep last-known state.
    }
  }

  // Best-effort GID cache for usage metering; never block billing on it.
  try {
    await cacheShopGid(args.shop, admin);
  } catch (err) {
    logWarn("shop_gid_sync_failed", args.shop, err);
  }

  let subscription: AdminActiveSubscription | null = null;
  try {
    subscription = await fetchActiveSubscription(admin);
  } catch (err) {
    logWarn("active_subscription_admin_failed", args.shop, err);
    if (existing.status === "uninstalled") {
      return db.billingState.update({
        where: { shop: args.shop },
        data: { status: "inactive" },
      });
    }
    return existing;
  }

  if (!subscription) {
    // No ACTIVE subscription: on trial, declined, expired, or post-reinstall
    // (the prior subscription is CANCELLED and no longer listed). Reset to the
    // trial baseline so the UI prompts the merchant to choose a plan.
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
    subscription,
    args.planHandle ?? null,
    existing.plan,
  );
  if (!PLAN_KEYS.includes(plan)) {
    return existing;
  }

  const cycleEnd = parseDate(subscription.currentPeriodEnd);
  const cycleStart = cycleEnd
    ? new Date(cycleEnd.getTime() - intervalDays(subscription) * 86_400_000)
    : existing.currentCycleStart ?? new Date();
  const created = parseDate(subscription.createdAt);
  const trialEndsAt =
    created && subscription.trialDays && subscription.trialDays > 0
      ? new Date(created.getTime() + subscription.trialDays * 86_400_000)
      : null;
  const monthlyCap = computeCap(plan, null);
  const paidPlanStartedAt =
    plan !== "trial"
      ? existing.paidPlanStartedAt ?? cycleStart
      : existing.paidPlanStartedAt;

  return db.billingState.update({
    where: { shop: args.shop },
    data: {
      plan,
      status: "active",
      subscriptionId: subscription.id,
      paidPlanStartedAt,
      currentCycleStart: cycleStart,
      currentCycleEnd: cycleEnd,
      trialEndsAt,
      monthlyCap,
    },
  });
}
