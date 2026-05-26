import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  COMMISSION_GRACE_DAYS,
  PAID_PLAN_KEYS,
  PLAN_DISCLOSURE_COPY,
  PLAN_DISPLAY,
  PLANS,
  TRIAL_DAYS,
  TRIAL_TRYONS,
  computeCap,
  isPlanKey,
  type PlanKey,
} from "../lib/plans";

interface CycleStats {
  used: number;
  included: number;
  cap: number;
  pctUsed: number;
  commissionAccruedUsd: number;
  projectedNextBillUsd: number;
}

interface LoaderData {
  shop: string;
  plan: PlanKey;
  status: string;
  subscriptionId: string | null;
  trialDaysRemaining: number;
  trialTryOnsRemaining: number;
  paidPlanStartedAt: string | null;
  commissionGraceEndsAt: string | null;
  cycle: CycleStats;
  confirmed: boolean;
  declined: boolean;
  errorMessage: string | null;
}

function appUrl(): string {
  const raw = process.env.SHOPIFY_APP_URL ?? "";
  return raw.replace(/\/$/, "");
}

interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
}

// Reconciles BillingState.status against ground truth in Shopify. Called only
// when the merchant has just returned from the approval page (?confirmed=1).
// Shopify redirects to returnUrl regardless of accept/decline, so we have to
// ask Shopify which one happened. Returns the outcome so the loader can pick
// the right banner without re-querying.
async function reconcileSubscription(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  shop: string,
): Promise<"active" | "declined" | "indeterminate"> {
  let active: ActiveSubscription[] = [];
  try {
    const resp = await admin.graphql(
      `#graphql
        query TryonaiCurrentAppSubscriptions {
          currentAppInstallation {
            activeSubscriptions { id name status }
          }
        }`,
    );
    const json = await resp.json();
    active =
      (json?.data?.currentAppInstallation?.activeSubscriptions as
        | ActiveSubscription[]
        | undefined) ?? [];
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "reconcileSubscription_query_failed",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return "indeterminate";
  }

  const liveActive = active.find((s) => s.status?.toUpperCase() === "ACTIVE");
  if (liveActive) {
    await db.billingState.update({
      where: { shop },
      data: { status: "active", subscriptionId: liveActive.id },
    });
    return "active";
  }

  // No active subscription found — if we were mid-flight (status="pending"),
  // the merchant declined or the approval timed out. Move to "declined" so the
  // UI surfaces it; the app_subscriptions/update webhook will overwrite this
  // once Shopify catches up if the merchant actually approved.
  const current = await db.billingState.findUnique({ where: { shop } });
  if (current?.status === "pending") {
    await db.billingState.update({
      where: { shop },
      data: { status: "declined" },
    });
    return "declined";
  }
  return "indeterminate";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  await db.shop.upsert({
    where: { domain: shop },
    create: { domain: shop },
    update: {},
  });
  await db.billingState.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  const url = new URL(request.url);
  const justConfirmed = url.searchParams.get("confirmed") === "1";
  let reconcileOutcome: "active" | "declined" | "indeterminate" =
    "indeterminate";
  if (justConfirmed) {
    reconcileOutcome = await reconcileSubscription(admin, shop);
  }

  // Re-read after reconcile so plan/status reflect the freshly-reconciled state.
  const billing = await db.billingState.findUniqueOrThrow({ where: { shop } });
  const settings = await db.merchantSettings.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  const plan: PlanKey = isPlanKey(billing.plan) ? billing.plan : "trial";
  const cap = computeCap(plan, settings.capOverride ?? null);

  const cycleStart =
    billing.currentCycleStart ?? billing.trialStartedAt ?? new Date(0);
  const used = await db.usageLog.count({ where: { shop, cycleStart } });

  const commissionAgg = await db.attributedOrder.aggregate({
    _sum: { commissionUsd: true },
    where: { shop, createdAt: { gte: cycleStart }, refundedAt: null },
  });
  const commissionAccrued = Number(commissionAgg._sum.commissionUsd ?? 0);

  const planDef = PLANS[plan];
  const overageUnits = Math.max(0, used - planDef.included);
  const overageCost =
    planDef.overage !== null ? overageUnits * planDef.overage : 0;
  const projectedNextBill =
    planDef.price + overageCost + Math.max(0, commissionAccrued - Number(settings.pendingCredit ?? 0));

  const trialAgeDays = Math.floor(
    (Date.now() - billing.trialStartedAt.getTime()) / 86_400_000,
  );
  const trialCount =
    plan === "trial"
      ? await db.usageLog.count({
          where: { shop, createdAt: { gte: billing.trialStartedAt } },
        })
      : 0;

  const data: LoaderData = {
    shop,
    plan,
    status: billing.status,
    subscriptionId: billing.subscriptionId,
    trialDaysRemaining: Math.max(0, TRIAL_DAYS - trialAgeDays),
    trialTryOnsRemaining: Math.max(0, TRIAL_TRYONS - trialCount),
    paidPlanStartedAt: billing.paidPlanStartedAt?.toISOString() ?? null,
    commissionGraceEndsAt: billing.paidPlanStartedAt
      ? new Date(
          billing.paidPlanStartedAt.getTime() +
            COMMISSION_GRACE_DAYS * 86_400_000,
        ).toISOString()
      : null,
    cycle: {
      used,
      included: planDef.included,
      cap,
      pctUsed: cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0,
      commissionAccruedUsd: round2(commissionAccrued),
      projectedNextBillUsd: round2(projectedNextBill),
    },
    confirmed: justConfirmed && reconcileOutcome === "active",
    declined: justConfirmed && reconcileOutcome === "declined",
    errorMessage: url.searchParams.get("error"),
  };
  return data;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "select_plan") {
    return redirect("/app/billing?error=unknown_intent");
  }

  const planRaw = String(form.get("plan") ?? "");
  if (!isPlanKey(planRaw) || !PAID_PLAN_KEYS.includes(planRaw)) {
    return redirect("/app/billing?error=invalid_plan");
  }
  const plan: PlanKey = planRaw;
  const def = PLANS[plan];
  const overage = def.overage ?? 0;

  const returnUrl = `${appUrl()}/app/billing?confirmed=1`;
  const test = process.env.NODE_ENV !== "production";

  const response = await admin.graphql(
    `#graphql
      mutation tryonaiSubscriptionCreate(
        $name: String!
        $returnUrl: URL!
        $test: Boolean
        $lineItems: [AppSubscriptionLineItemInput!]!
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          lineItems: $lineItems
          trialDays: 0
        ) {
          confirmationUrl
          appSubscription { id status }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        name: `tryonai ${PLAN_DISPLAY[plan]}`,
        returnUrl,
        test,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: def.price, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
          {
            plan: {
              appUsagePricingDetails: {
                terms: `$${overage.toFixed(2)} per try-on over your monthly allowance (included: ${def.included}).`,
                cappedAmount: { amount: 999, currencyCode: "USD" },
              },
            },
          },
          {
            plan: {
              appUsagePricingDetails: {
                terms: `${(def.commission * 100).toFixed(1)}% commission on orders attributed to a try-on. No commission in the first ${COMMISSION_GRACE_DAYS} days of a paid plan.`,
                cappedAmount: { amount: 999, currencyCode: "USD" },
              },
            },
          },
        ],
      },
    },
  );

  const result = await response.json();
  const payload = result?.data?.appSubscriptionCreate;
  const userErrors: Array<{ field?: string[]; message: string }> =
    payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error(
      JSON.stringify({
        event: "appSubscriptionCreate_user_errors",
        shop: session.shop,
        plan,
        userErrors,
      }),
    );
    const msg = encodeURIComponent(userErrors.map((e) => e.message).join("; "));
    return redirect(`/app/billing?error=${msg}`);
  }
  const confirmationUrl: string | undefined = payload?.confirmationUrl;
  if (!confirmationUrl) {
    return redirect("/app/billing?error=no_confirmation_url");
  }

  await db.billingState.update({
    where: { shop: session.shop },
    data: { status: "pending" },
  });

  return redirect(confirmationUrl);
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function BillingPage() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const fetcher = useFetcher<typeof action>();
  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const submittingPlan =
    isSubmitting && fetcher.formData
      ? String(fetcher.formData.get("plan") ?? "")
      : null;

  const onTrial = data.plan === "trial";
  const capBanner =
    data.cycle.pctUsed >= 100
      ? { tone: "critical" as const, text: "You've reached your monthly try-on cap. Upgrade to keep generating." }
      : data.cycle.pctUsed >= 80
        ? { tone: "warning" as const, text: `You've used ${data.cycle.pctUsed}% of your monthly try-on allowance.` }
        : null;

  return (
    <s-page heading="Billing & Plan">
      {data.confirmed && (
        <s-banner tone="success" heading="Subscription confirmed">
          Your plan is active. Usage will start counting toward your monthly allowance.
        </s-banner>
      )}
      {data.declined && (
        <s-banner tone="critical" heading="Subscription not started">
          Shopify didn&apos;t record an active subscription for this app. If you
          declined or closed the approval page, pick a plan below to try again.
        </s-banner>
      )}
      {data.errorMessage && (
        <s-banner tone="critical" heading="We couldn't start that plan">
          {decodeURIComponent(data.errorMessage)}
        </s-banner>
      )}
      {capBanner && (
        <s-banner tone={capBanner.tone} heading="Try-on cap">
          {capBanner.text}
        </s-banner>
      )}

      <s-section heading={onTrial ? "Trial" : `Current plan: ${PLAN_DISPLAY[data.plan]}`}>
        {onTrial ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text>
                {data.trialDaysRemaining} day{data.trialDaysRemaining === 1 ? "" : "s"} remaining
                · {TRIAL_TRYONS - data.trialTryOnsRemaining}/{TRIAL_TRYONS} try-ons used
              </s-text>
            </s-paragraph>
            <s-paragraph>
              Choose a plan to keep generating after your trial ends.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text>
                Status: {data.status} · Try-ons this cycle: {data.cycle.used}/{data.cycle.included}
                {" "}included (cap: {data.cycle.cap})
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                Commission accrued this cycle: ${data.cycle.commissionAccruedUsd.toFixed(2)}
                {" · "}Projected next bill: ${data.cycle.projectedNextBillUsd.toFixed(2)}
              </s-text>
            </s-paragraph>
            {data.commissionGraceEndsAt && new Date(data.commissionGraceEndsAt) > new Date() && (
              <s-paragraph>
                <s-text>
                  Commission grace period ends on{" "}
                  {new Date(data.commissionGraceEndsAt).toLocaleDateString()}.
                </s-text>
              </s-paragraph>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Plans">
        <s-stack direction="block" gap="base">
          {PAID_PLAN_KEYS.map((key) => {
            const def = PLANS[key];
            const isCurrent = data.plan === key;
            const submittingThis = submittingPlan === key;
            const label = isCurrent ? "Current plan" : submittingThis ? "Redirecting…" : `Choose ${PLAN_DISPLAY[key]}`;
            return (
              <s-box
                key={key}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-heading>{PLAN_DISPLAY[key]} — ${def.price}/mo</s-heading>
                  <s-paragraph>
                    <s-text>
                      {def.included.toLocaleString()} try-ons included · $
                      {(def.overage ?? 0).toFixed(2)}/try-on over allowance ·{" "}
                      {(def.commission * 100).toFixed(1)}% commission on attributed orders
                    </s-text>
                  </s-paragraph>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="select_plan" />
                    <input type="hidden" name="plan" value={key} />
                    <s-button
                      type="submit"
                      variant={isCurrent ? "tertiary" : "primary"}
                      {...(isCurrent || submittingThis ? { disabled: true } : {})}
                      {...(submittingThis ? { loading: true } : {})}
                    >
                      {label}
                    </s-button>
                  </fetcher.Form>
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="Pricing disclosure">
        <s-unordered-list>
          <s-list-item>
            <s-text>
              Monthly subscription, included try-ons, and overage rates are listed per plan above.
            </s-text>
          </s-list-item>
          <s-list-item>
            <s-text>{PLAN_DISCLOSURE_COPY.noCommissionGrace}</s-text>
          </s-list-item>
          <s-list-item>
            <s-text>{PLAN_DISCLOSURE_COPY.attributedOnly}</s-text>
          </s-list-item>
          <s-list-item>
            <s-text>{PLAN_DISCLOSURE_COPY.selfEnforcedCap}</s-text>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="This cycle at a glance">
        <s-paragraph>
          <s-text>Try-ons used: {data.cycle.used} / {data.cycle.cap}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Commission accrued: ${data.cycle.commissionAccruedUsd.toFixed(2)}
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Projected next bill: ${data.cycle.projectedNextBillUsd.toFixed(2)}
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
