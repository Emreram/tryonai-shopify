import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  COMMISSION_GRACE_DAYS,
  PLAN_DISPLAY,
  PLANS,
  TRIAL_DAYS,
  TRIAL_TRYONS,
  computeCap,
  isPlanKey,
  type PlanKey,
} from "../lib/plans";

interface RecentTryOn {
  id: string;
  createdAt: string;
  status: string;
  size: string;
  costUsd: number;
}

interface RecentOrder {
  id: string;
  orderId: string;
  createdAt: string;
  subtotalUsd: number;
  commissionUsd: number;
  refunded: boolean;
}

interface LoaderData {
  shop: string;
  plan: PlanKey;
  status: string;
  onTrial: boolean;
  trialDaysRemaining: number;
  trialTryOnsUsed: number;
  commissionGraceActive: boolean;
  cycle: {
    used: number;
    cap: number;
    pctUsed: number;
    attributedOrders: number;
    attributedRevenueUsd: number;
    commissionAccruedUsd: number;
  };
  recentTryOns: RecentTryOn[];
  recentOrders: RecentOrder[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await db.shop.upsert({
    where: { domain: shop },
    create: { domain: shop },
    update: {},
  });
  const billing = await db.billingState.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
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

  const ordersAgg = await db.attributedOrder.aggregate({
    _sum: { subtotalUsd: true, commissionUsd: true },
    _count: { _all: true },
    where: { shop, createdAt: { gte: cycleStart }, refundedAt: null },
  });

  const trialAgeDays = Math.floor(
    (Date.now() - billing.trialStartedAt.getTime()) / 86_400_000,
  );
  const trialTryOnsUsed =
    plan === "trial"
      ? await db.usageLog.count({
          where: { shop, createdAt: { gte: billing.trialStartedAt } },
        })
      : 0;

  const [recentTryOnsRaw, recentOrdersRaw] = await Promise.all([
    db.usageLog.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        createdAt: true,
        status: true,
        size: true,
        costUsd: true,
      },
    }),
    db.attributedOrder.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        orderId: true,
        createdAt: true,
        subtotalUsd: true,
        commissionUsd: true,
        refundedAt: true,
      },
    }),
  ]);

  const commissionGraceEndsAt = billing.paidPlanStartedAt
    ? new Date(
        billing.paidPlanStartedAt.getTime() +
          COMMISSION_GRACE_DAYS * 86_400_000,
      )
    : null;

  const data: LoaderData = {
    shop,
    plan,
    status: billing.status,
    onTrial: plan === "trial",
    trialDaysRemaining: Math.max(0, TRIAL_DAYS - trialAgeDays),
    trialTryOnsUsed,
    commissionGraceActive:
      !!commissionGraceEndsAt && commissionGraceEndsAt > new Date(),
    cycle: {
      used,
      cap,
      pctUsed: cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0,
      attributedOrders: ordersAgg._count._all,
      attributedRevenueUsd: round2(Number(ordersAgg._sum.subtotalUsd ?? 0)),
      commissionAccruedUsd: round2(Number(ordersAgg._sum.commissionUsd ?? 0)),
    },
    recentTryOns: recentTryOnsRaw.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
      size: r.size,
      costUsd: round2(r.costUsd),
    })),
    recentOrders: recentOrdersRaw.map((o) => ({
      id: o.id,
      orderId: o.orderId,
      createdAt: o.createdAt.toISOString(),
      subtotalUsd: round2(o.subtotalUsd),
      commissionUsd: round2(o.commissionUsd),
      refunded: !!o.refundedAt,
    })),
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
          {data.trialDaysRemaining === 1 ? "" : "s"} remaining ·{" "}
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

      <s-section heading="This billing cycle">
        <s-stack direction="inline" gap="base">
          <StatCard
            label="Try-ons used"
            value={`${data.cycle.used} / ${data.cycle.cap}`}
            sub={`${data.cycle.pctUsed}% of cap`}
          />
          <StatCard
            label="Attributed orders"
            value={String(data.cycle.attributedOrders)}
          />
          <StatCard
            label="Attributed revenue"
            value={`$${data.cycle.attributedRevenueUsd.toFixed(2)}`}
          />
          <StatCard
            label="Commission accrued"
            value={`$${data.cycle.commissionAccruedUsd.toFixed(2)}`}
            sub={
              data.commissionGraceActive
                ? "Grace period — not charged"
                : undefined
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Recent try-ons">
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
                left={new Date(r.createdAt).toLocaleString()}
                mid={`${r.size} · ${r.status}`}
                right={`$${r.costUsd.toFixed(4)}`}
              />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Recent attributed orders">
        {data.recentOrders.length === 0 ? (
          <s-paragraph>
            No attributed orders yet. Orders placed by a shopper after a try-on
            will show here.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {data.recentOrders.map((o) => (
              <Row
                key={o.id}
                left={new Date(o.createdAt).toLocaleDateString()}
                mid={`Order ${o.orderId}${o.refunded ? " · refunded" : ""}`}
                right={`$${o.subtotalUsd.toFixed(2)} · commission $${o.commissionUsd.toFixed(2)}`}
              />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Plan">
        <s-paragraph>
          {PLAN_DISPLAY[data.plan]} · {data.status}
        </s-paragraph>
        <s-paragraph>
          {PLANS[data.plan].included.toLocaleString()} try-ons / month included
        </s-paragraph>
        <s-link href="/app/billing">Manage plan</s-link>
      </s-section>

      <s-section slot="aside" heading="Get started">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/billing">Pick a paid plan</s-link>
          </s-list-item>
          <s-list-item>
            Add the Try-On theme app block to your product pages.
          </s-list-item>
          <s-list-item>
            Run a test try-on from a product page on your storefront.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Support">
        <s-paragraph>
          Questions or issues? Email{" "}
          <s-link href="mailto:support@tryonai.app">support@tryonai.app</s-link>
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
