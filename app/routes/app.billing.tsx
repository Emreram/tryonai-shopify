import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  PAID_PLAN_KEYS,
  PLAN_DISCLOSURE_COPY,
  PLAN_DISPLAY,
  PLANS,
  TRIAL_DAYS,
  TRIAL_TRYONS,
  computeCap,
  isPlanKey,
  statusLabel,
  type PlanKey,
} from "../lib/plans";
import {
  hostedPlanPageUrl,
  refreshBillingState,
} from "../lib/billingSync.server";

interface CycleStats {
  used: number;
  included: number;
  cap: number;
  pctUsed: number;
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
  cycle: CycleStats;
  confirmed: boolean;
  errorMessage: string | null;
  planPageUrl: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const planHandle = url.searchParams.get("plan_handle");

  const billing = await refreshBillingState({
    shop,
    admin,
    planHandle,
  });
  const settings = await db.merchantSettings.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  const plan: PlanKey = isPlanKey(billing.plan) ? billing.plan : "trial";
  const cap = computeCap(plan, settings.capOverride ?? null);
  const cycleStart =
    plan === "trial"
      ? billing.trialStartedAt
      : billing.currentCycleStart ?? billing.trialStartedAt ?? new Date(0);
  const used = await db.usageLog.count({
    where: { shop, cycleStart, status: "ok" },
  });

  const planDef = PLANS[plan];
  const overageUnits = Math.max(0, used - planDef.included);
  const overageCost =
    planDef.overage !== null ? overageUnits * planDef.overage : 0;
  const projectedNextBill = planDef.price + overageCost;

  const trialAgeDays = Math.floor(
    (Date.now() - billing.trialStartedAt.getTime()) / 86_400_000,
  );
  const trialCount =
    plan === "trial"
      ? await db.usageLog.count({
          where: {
            shop,
            createdAt: { gte: billing.trialStartedAt },
            status: "ok",
          },
        })
      : 0;

  const recentlyActivated = Boolean(
    billing.paidPlanStartedAt &&
      Date.now() - billing.paidPlanStartedAt.getTime() < 5 * 60_000,
  );

  const data: LoaderData = {
    shop,
    plan,
    status: billing.status,
    subscriptionId: billing.subscriptionId,
    trialDaysRemaining: Math.max(0, TRIAL_DAYS - trialAgeDays),
    trialTryOnsRemaining: Math.max(0, TRIAL_TRYONS - trialCount),
    paidPlanStartedAt: billing.paidPlanStartedAt?.toISOString() ?? null,
    cycle: {
      used,
      included: planDef.included,
      cap,
      pctUsed: cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0,
      projectedNextBillUsd: round2(projectedNextBill),
    },
    confirmed:
      (Boolean(planHandle) || recentlyActivated) && billing.status === "active",
    errorMessage: url.searchParams.get("error"),
    planPageUrl: hostedPlanPageUrl(shop),
  };
  return data;
};

export default function BillingPage() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const onTrial = data.plan === "trial";
  const capBanner =
    data.cycle.pctUsed >= 100
      ? {
          tone: "critical" as const,
          text: "You've reached your monthly try-on cap. Upgrade to keep generating.",
        }
      : data.cycle.pctUsed >= 80
        ? {
            tone: "warning" as const,
            text: `You've used ${data.cycle.pctUsed}% of your monthly try-on allowance.`,
          }
        : null;

  return (
    <s-page heading="Billing & Plan">
      {data.confirmed && (
        <s-banner tone="success" heading="Plan confirmed">
          Your Shopify App Pricing plan is active.
        </s-banner>
      )}
      {data.errorMessage && (
        <s-banner tone="critical" heading="We couldn't refresh billing">
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
                {data.trialDaysRemaining} day
                {data.trialDaysRemaining === 1 ? "" : "s"} remaining -{" "}
                {TRIAL_TRYONS - data.trialTryOnsRemaining}/{TRIAL_TRYONS} try-ons used
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
                Status: {statusLabel(data.status)} - Try-ons this cycle: {data.cycle.used}/
                {data.cycle.included} included (cap: {data.cycle.cap})
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                Estimated current bill: ${data.cycle.projectedNextBillUsd.toFixed(2)}
              </s-text>
            </s-paragraph>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Plans">
        <s-stack direction="block" gap="base">
          {PAID_PLAN_KEYS.map((key) => {
            const def = PLANS[key];
            const isCurrent = data.plan === key;
            const label = isCurrent ? "Current plan" : `Choose ${PLAN_DISPLAY[key]}`;
            return (
              <s-box
                key={key}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-heading>
                    {PLAN_DISPLAY[key]} - ${def.price}/mo
                  </s-heading>
                  <s-paragraph>
                    <s-text>
                      {def.included.toLocaleString()} try-ons included - $
                      {(def.overage ?? 0).toFixed(2)}/try-on over allowance
                    </s-text>
                  </s-paragraph>
                  <s-button
                    href={data.planPageUrl}
                    target="_top"
                    variant={isCurrent ? "tertiary" : "primary"}
                    {...(isCurrent ? { disabled: true } : {})}
                  >
                    {label}
                  </s-button>
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
              Monthly subscription, included try-ons, and overage rates are
              billed through Shopify App Pricing.
            </s-text>
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
            Estimated bill: ${data.cycle.projectedNextBillUsd.toFixed(2)}
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
