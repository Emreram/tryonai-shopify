import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
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

type ReturnState = "none" | "confirmed" | "pending";

interface LoaderData {
  shop: string;
  plan: PlanKey;
  status: string;
  onTrial: boolean;
  trialDaysRemaining: number;
  trialTryOnsRemaining: number;
  renewalDateLabel: string | null;
  cycle: CycleStats;
  returnState: ReturnState;
  errorMessage: string | null;
  planPageUrl: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Server-side, fixed-locale/timezone formatting so SSR and client hydration
// render identical text (a bare toLocaleDateString() differs by browser TZ and
// triggers React hydration errors #418/#423).
const RENEWAL_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

// Bounded client-side polling while a just-approved plan change propagates on
// Shopify's side. ~6 x 2.5s = 15s of headroom for the new subscription to show
// up in currentAppInstallation.activeSubscriptions, after which we surface a
// terminal state instead of an endless "Finishing..." spinner.
const MAX_REFRESH_ATTEMPTS = 6;
const REFRESH_INTERVAL_MS = 2500;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  // Shopify can append `plan_handle` more than once on return; take the last.
  const planHandles = url.searchParams.getAll("plan_handle");
  const planHandle = planHandles.length
    ? planHandles[planHandles.length - 1]
    : null;

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
  const onTrial = plan === "trial";
  const cap = computeCap(plan, settings.capOverride ?? null);
  const cycleStart = onTrial
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
  const trialCount = onTrial
    ? await db.usageLog.count({
        where: {
          shop,
          createdAt: { gte: billing.trialStartedAt },
          status: "ok",
        },
      })
    : 0;

  const data: LoaderData = {
    shop,
    plan,
    status: billing.status,
    onTrial,
    trialDaysRemaining: Math.max(0, TRIAL_DAYS - trialAgeDays),
    trialTryOnsRemaining: Math.max(0, TRIAL_TRYONS - trialCount),
    renewalDateLabel: billing.currentCycleEnd
      ? `${RENEWAL_FMT.format(billing.currentCycleEnd)} UTC`
      : null,
    cycle: {
      used,
      included: planDef.included,
      cap,
      pctUsed: cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0,
      projectedNextBillUsd: round2(projectedNextBill),
    },
    // After returning from the hosted pricing page Shopify appends
    // `plan_handle`. Only show "confirmed" once the LIVE subscription truly
    // reflects a paid, active plan; while it's still propagating (or was
    // declined / has no payment method) show a neutral "pending" state instead
    // of a misleading success banner over a still-trial body.
    returnState:
      planHandle === null
        ? "none"
        : billing.status === "active" && !onTrial
          ? "confirmed"
          : "pending",
    errorMessage: url.searchParams.get("error"),
    planPageUrl: hostedPlanPageUrl({ shop }),
  };
  return data;
};

export default function BillingPage() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  const revalidator = useRevalidator();
  const refreshAttempts = useRef(0);
  // Once polling is exhausted while still pending, flip to a terminal state so
  // the merchant gets a clear next step instead of an endless spinner.
  const [pollExhausted, setPollExhausted] = useState(false);

  // While a just-approved plan change is still propagating on Shopify's side,
  // re-query the loader a bounded number of times so the new plan reflects
  // automatically without the merchant reloading. Bounded + idle-gated so it
  // can never become the "loops before it reflects" symptom; once the loader
  // reports a confirmed active plan the effect stops on its own.
  useEffect(() => {
    if (data.returnState !== "pending") {
      // Confirmed, or not returning from checkout: reset so a later plan
      // change within the same session can poll again from scratch.
      refreshAttempts.current = 0;
      setPollExhausted(false);
      return;
    }
    if (revalidator.state !== "idle") return;
    if (refreshAttempts.current >= MAX_REFRESH_ATTEMPTS) {
      setPollExhausted(true);
      return;
    }
    const timer = setTimeout(() => {
      refreshAttempts.current += 1;
      revalidator.revalidate();
    }, REFRESH_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [data.returnState, revalidator]);

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

  const ctaLabel = data.onTrial ? "View plans" : "Change plan";

  return (
    <s-page heading="Billing & Plan">
      {data.returnState === "confirmed" && (
        <s-banner tone="success" heading="Plan confirmed">
          Your {PLAN_DISPLAY[data.plan]} plan is active.
        </s-banner>
      )}
      {data.returnState === "pending" && !pollExhausted && (
        <s-banner tone="info" heading="Finishing your plan change">
          <s-paragraph>
            We&apos;re confirming your selection with Shopify - this can take a
            few seconds.
          </s-paragraph>
        </s-banner>
      )}
      {data.returnState === "pending" && pollExhausted && (
        <s-banner tone="warning" heading="We couldn't confirm your plan change">
          <s-stack direction="block" gap="small">
            <s-paragraph>
              If you just approved the charge, it can take another moment - use
              Refresh status. If you declined the charge or still need to add a
              payment method, choose a plan again.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-link href="/app/billing">Refresh status</s-link>
              <s-button href={data.planPageUrl} target="_top" variant="primary">
                Choose a plan
              </s-button>
            </s-stack>
          </s-stack>
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

      <s-section
        heading={
          data.onTrial ? "Trial" : `Current plan: ${PLAN_DISPLAY[data.plan]}`
        }
      >
        {data.onTrial ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text>
                {data.trialDaysRemaining} day
                {data.trialDaysRemaining === 1 ? "" : "s"} remaining -{" "}
                {TRIAL_TRYONS - data.trialTryOnsRemaining}/{TRIAL_TRYONS} try-ons
                used
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
                Status: {statusLabel(data.status)} - Try-ons this cycle:{" "}
                {data.cycle.used}/{data.cycle.included} included (cap:{" "}
                {data.cycle.cap})
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                Estimated current bill: $
                {data.cycle.projectedNextBillUsd.toFixed(2)}
              </s-text>
            </s-paragraph>
            {data.renewalDateLabel && (
              <s-paragraph>
                <s-text>Renews on {data.renewalDateLabel}</s-text>
              </s-paragraph>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Manage your plan">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Plan selection, upgrades, downgrades, and cancellation are handled
            on the secure Shopify plan page. You can accept or decline the
            charge there, and your selection is reflected here automatically.
          </s-paragraph>
          {/*
            Opens Shopify's hosted Managed Pricing page in the top frame
            (target="_top"). The URL is derived from session.shop's store
            handle (see hostedPlanPageUrl) so it's identical on first load and
            on every `.data` revalidation.
          */}
          <s-button href={data.planPageUrl} target="_top" variant="primary">
            {ctaLabel}
          </s-button>
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
          <s-text>
            Try-ons used: {data.cycle.used} / {data.cycle.cap}
          </s-text>
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
