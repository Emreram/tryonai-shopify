import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  PLAN_DISPLAY,
  PLANS,
  TRIAL_DAYS,
  TRIAL_TRYONS,
  computeCap,
  isPlanKey,
  statusLabel,
  type PlanKey,
} from "../lib/plans";
import { hostedPlanPageUrl, refreshBillingState } from "../lib/billingSync.server";

interface RecentTryOn {
  id: string;
  requestId: string;
  createdAtLabel: string;
  status: string;
  size: string;
  costUsd: number;
}

interface LoaderData {
  shop: string;
  plan: PlanKey;
  status: string;
  onTrial: boolean;
  trialDaysRemaining: number;
  trialTryOnsUsed: number;
  themeEditorUrl: string;
  cycle: {
    used: number;
    cap: number;
    pctUsed: number;
  };
  recentTryOns: RecentTryOn[];
  planPageUrl: string;
}

// Deep-link handle = the app block's Liquid filename
// (extensions/tryon-button/blocks/tryon_button.liquid) — note underscores, and
// distinct from the "tryon-button" extension directory name.
const TRYON_BLOCK_HANDLE = "tryon_button";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Format on the server with an explicit locale + timeZone so SSR and client
// hydration produce byte-identical text (a bare toLocaleString() differs
// between Vercel/UTC and the merchant's browser TZ -> React hydration #418/#423).
const TRYON_TIMESTAMP_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  hour12: false,
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const billing = await refreshBillingState({ shop, admin });
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
    where: { shop, kind: "tryon", cycleStart, status: "ok" },
  });

  const trialAgeDays = Math.floor(
    (Date.now() - billing.trialStartedAt.getTime()) / 86_400_000,
  );
  const trialTryOnsUsed =
    plan === "trial"
      ? await db.usageLog.count({
          where: {
            shop,
            kind: "tryon",
            createdAt: { gte: billing.trialStartedAt },
            status: "ok",
          },
        })
      : 0;

  const recentTryOnsRaw = await db.usageLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      requestId: true,
      createdAt: true,
      status: true,
      size: true,
      costUsd: true,
    },
  });

  // The Try-On widget is an app BLOCK (its schema targets "section"), not an app
  // embed. The embed-activation form (`context=apps&activateAppId=...`) makes the
  // theme editor hunt for an app embed that doesn't exist -> "App embed does not
  // exist" toast. App blocks use `addAppBlockId={api_key}/{handle}` where api_key
  // is the app's client_id (== SHOPIFY_API_KEY, guaranteed present by the parent
  // app.tsx loader) and handle is the block's Liquid filename. `mainSection` drops
  // the block straight into the product template's main section (by Add to cart).
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  const themeEditorUrl =
    `https://${shop}/admin/themes/current/editor` +
    `?template=product&addAppBlockId=${apiKey}/${TRYON_BLOCK_HANDLE}&target=mainSection`;

  const data: LoaderData = {
    shop,
    plan,
    status: billing.status,
    onTrial: plan === "trial",
    trialDaysRemaining: Math.max(0, TRIAL_DAYS - trialAgeDays),
    trialTryOnsUsed,
    themeEditorUrl,
    cycle: {
      used,
      cap,
      pctUsed: cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0,
    },
    recentTryOns: recentTryOnsRaw.map((r) => ({
      id: r.id,
      requestId: r.requestId,
      createdAtLabel: `${TRYON_TIMESTAMP_FMT.format(r.createdAt)} UTC`,
      status: r.status,
      size: r.size,
      costUsd: round2(r.costUsd),
    })),
    planPageUrl: hostedPlanPageUrl({ shop }),
  };
  return data;
};

export default function Index() {
  const data = useLoaderData<typeof loader>() as LoaderData;

  const capTone: "critical" | "warning" | null =
    data.cycle.pctUsed >= 100
      ? "critical"
      : data.cycle.pctUsed >= 80
        ? "warning"
        : null;

  return (
    <s-page heading="TryOnAI">
      {data.onTrial && (
        <s-banner tone="info" heading="You're on the Trial">
          {data.trialDaysRemaining} day
          {data.trialDaysRemaining === 1 ? "" : "s"} remaining -{" "}
          {data.trialTryOnsUsed}/{TRIAL_TRYONS} try-ons used.{" "}
          <s-link href="/app/billing">Choose a plan</s-link>
        </s-banner>
      )}

      {capTone && (
        <s-banner
          tone={capTone}
          heading={
            capTone === "critical" ? "Try-on cap reached" : "Approaching cap"
          }
        >
          {capTone === "critical"
            ? "You've reached your monthly try-on cap. Upgrade your plan to keep generating."
            : `You've used ${data.cycle.pctUsed}% of your monthly try-on allowance.`}
        </s-banner>
      )}

      {data.recentTryOns.length === 0 && (
        <s-section heading="Set up the Try-On button">
          <s-paragraph>
            Follow these four steps to get the AI Try-On button live on your
            storefront. The first successful try-on will replace this guide with
            usage stats.
          </s-paragraph>
          <ol style={{ paddingLeft: "1.25rem", marginTop: "0.75rem" }}>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong>Add the Try-On block to your theme.</strong> Open your
              active theme in the editor, navigate to a product template, drag
              the <em>AI Try-On Button</em> app block into the section where
              you want it to appear (most stores place it directly under the
              Add to Cart button), then click <strong>Save</strong>.
              <div style={{ marginTop: "0.5rem" }}>
                <s-button
                  variant="primary"
                  href={data.themeEditorUrl}
                  target="_top"
                >
                  Open theme editor
                </s-button>
              </div>
            </li>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong>Verify the block is live on a product page.</strong> Open
              any product page on your storefront in a new tab - you should see
              the &ldquo;Try it on&rdquo; button rendered where you added the
              block.
            </li>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong>Run a test try-on.</strong> Click the button on your
              storefront, upload a selfie, confirm the consent checkbox, and
              wait ~15 seconds for the try-on to render. The result will appear
              in the <em>Recent try-ons</em> list on this page.
            </li>
            <li>
              <strong>Pick a paid plan when you&apos;re ready.</strong> The
              trial covers {TRIAL_TRYONS} try-ons over {TRIAL_DAYS} days.
              Upgrade from the{" "}
              <s-link href="/app/billing">Billing tab</s-link> before either
              limit is reached to keep generating.
            </li>
          </ol>
        </s-section>
      )}

      <s-section heading="This billing cycle">
        <s-stack direction="inline" gap="base">
          <StatCard
            label="Try-ons used"
            value={`${data.cycle.used} / ${data.cycle.cap}`}
            sub={`${data.cycle.pctUsed}% of cap`}
          />
          <StatCard
            label="Plan allowance"
            value={PLANS[data.plan].included.toLocaleString("en-US")}
            sub="included try-ons"
          />
        </s-stack>
      </s-section>

      <s-section accessibilityLabel="Recent try-ons">
        <s-stack direction="inline" gap="base">
          <s-heading>Recent try-ons</s-heading>
          <s-button href="/app/export/usage" download="">
            Download CSV
          </s-button>
        </s-stack>
        {data.recentTryOns.length === 0 ? (
          <s-paragraph>
            No try-ons yet. Once a shopper taps the Try-On button on your
            storefront, the requests will appear here.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {data.recentTryOns.map((r) => (
              <Row
                key={r.id}
                left={r.createdAtLabel}
                mid={`${r.requestId} | ${r.size} | ${r.status}`}
                right={`$${r.costUsd.toFixed(4)}`}
              />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Plan">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {/*
              On the trial the merchant has no paid subscription, so the raw
              billing status is "inactive" — showing "Trial - Inactive" next to
              a "13 days remaining" banner reads as broken. Reflect the trial's
              own state instead; paid plans keep the live subscription status.
            */}
            {PLAN_DISPLAY[data.plan]} -{" "}
            {data.onTrial
              ? data.trialDaysRemaining > 0
                ? "Active"
                : "Expired"
              : statusLabel(data.status)}
          </s-paragraph>
          <s-paragraph>
            {PLANS[data.plan].included.toLocaleString("en-US")} try-ons / month
            included
          </s-paragraph>
          {/*
            Breaks out of the embedded iframe (target="_top") straight to
            Shopify's hosted Managed Pricing page so the merchant can
            upgrade/downgrade in one click from the home screen.
          */}
          <s-button href={data.planPageUrl} target="_top" variant="primary">
            {data.onTrial ? "View plans" : "Change plan"}
          </s-button>
          <s-link href="/app/billing">Manage plan</s-link>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Get started">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/billing">Pick a paid plan</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href={data.themeEditorUrl} target="_top">
              Open theme editor and add the Try-On block
            </s-link>
          </s-list-item>
          <s-list-item>
            Run a test try-on from a product page on your storefront.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Data access">
        <s-paragraph>
          Merchants can review persisted try-on usage records in this dashboard
          or export them as CSV from the Recent try-ons section.
        </s-paragraph>
        <s-paragraph>
          Shopper photos and generated try-on images are processed only for the
          live preview and are not stored by TryOnAI, so they are not included
          in merchant exports.
        </s-paragraph>
        <s-link href="/privacy">Privacy policy</s-link>
      </s-section>

      <s-section slot="aside" heading="Support">
        <s-paragraph>
          Questions or issues? Email{" "}
          <s-link href="mailto:emergenceit1@gmail.com">emergenceit1@gmail.com</s-link>
          .
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small">
        <s-text>{label}</s-text>
        <s-heading>{value}</s-heading>
        {sub ? <s-text>{sub}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

function Row({
  left,
  mid,
  right,
}: {
  left: string;
  mid: string;
  right: string;
}) {
  return (
    <s-box padding="small-200" borderWidth="base" borderRadius="base">
      <s-stack direction="inline" gap="base">
        <s-text>{left}</s-text>
        <s-text>{mid}</s-text>
        <s-text>{right}</s-text>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
