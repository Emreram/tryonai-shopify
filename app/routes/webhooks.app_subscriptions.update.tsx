import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  COMMISSION_GRACE_DAYS,
  PLAN_LINE_ITEM_TAGS,
  PLANS,
  computeCap,
  planFromName,
} from "../lib/plans";

interface AppSubscriptionLineItem {
  id?: string;
  admin_graphql_api_id?: string;
  plan?: {
    pricing_details?: {
      __typename?: string;
      terms?: string | null;
      price?: { amount?: string; currency_code?: string };
      capped_amount?: { amount?: string; currency_code?: string };
      interval?: string;
    } | null;
  } | null;
}

interface AppSubscriptionPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  status?: string;
  current_period_end?: string | null;
  trial_ends_on?: string | null;
  line_items?: AppSubscriptionLineItem[];
}

function findLineItemGid(
  items: AppSubscriptionLineItem[] | undefined,
  tag: string,
): string | null {
  if (!items?.length) return null;
  const lowered = tag.toLowerCase();
  for (const item of items) {
    const terms = item.plan?.pricing_details?.terms?.toLowerCase() ?? "";
    if (terms.includes(lowered)) {
      return item.admin_graphql_api_id ?? item.id?.toString() ?? null;
    }
  }
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as { app_subscription?: AppSubscriptionPayload } | undefined;
  const sub = body?.app_subscription;

  if (!sub) {
    console.warn(
      JSON.stringify({
        event: "subscription_webhook_no_payload",
        topic,
        shop,
      }),
    );
    return new Response();
  }

  if (topic === "APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT") {
    console.log(
      JSON.stringify({
        event: "subscription_approaching_capped_amount",
        shop,
        subscriptionId: sub.admin_graphql_api_id,
      }),
    );
    return new Response();
  }

  const plan = planFromName(sub.name);
  const status = (sub.status ?? "ACTIVE").toLowerCase();
  const isActive = status === "active";

  // Mirror the uninstall reset: when Shopify reports a cancelled subscription
  // (uninstall, merchant-initiated cancel, billing failure, etc.) clear the
  // live billing fields so a reinstall or fresh subscription starts clean.
  if (status === "cancelled" || status === "frozen" || status === "expired") {
    await db.shop.upsert({
      where: { domain: shop },
      create: { domain: shop },
      update: {},
    });
    await db.billingState.updateMany({
      where: { shop },
      data: {
        plan: "trial",
        status,
        subscriptionId: null,
        paidPlanStartedAt: null,
        currentCycleStart: null,
        currentCycleEnd: null,
        overageLineItemId: null,
        commissionLineItemId: null,
      },
    });
    console.log(
      JSON.stringify({
        event: "subscription_webhook_cleared",
        shop,
        topic,
        status,
        subscriptionId: sub.admin_graphql_api_id,
      }),
    );
    return new Response();
  }
  const cycleEnd = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const cycleStart =
    cycleEnd && !Number.isNaN(cycleEnd.getTime())
      ? new Date(cycleEnd.getTime() - 30 * 86_400_000)
      : null;

  const existing = await db.billingState.findUnique({ where: { shop } });

  await db.shop.upsert({
    where: { domain: shop },
    create: { domain: shop },
    update: {},
  });

  const cap = computeCap(plan, null);
  const overageLineItemId = findLineItemGid(
    sub.line_items,
    PLAN_LINE_ITEM_TAGS.overage,
  );
  const commissionLineItemId = findLineItemGid(
    sub.line_items,
    PLAN_LINE_ITEM_TAGS.commission,
  );

  const paidPlanStartedAt =
    isActive && plan !== "trial" && !existing?.paidPlanStartedAt
      ? new Date()
      : existing?.paidPlanStartedAt ?? null;

  await db.billingState.upsert({
    where: { shop },
    create: {
      shop,
      plan,
      status,
      subscriptionId: sub.admin_graphql_api_id ?? null,
      currentCycleStart: cycleStart,
      currentCycleEnd: cycleEnd,
      paidPlanStartedAt,
      overageLineItemId,
      commissionLineItemId,
      monthlyCap: cap,
    },
    update: {
      plan,
      status,
      subscriptionId: sub.admin_graphql_api_id ?? existing?.subscriptionId ?? null,
      currentCycleStart: cycleStart ?? existing?.currentCycleStart ?? null,
      currentCycleEnd: cycleEnd ?? existing?.currentCycleEnd ?? null,
      paidPlanStartedAt,
      overageLineItemId: overageLineItemId ?? existing?.overageLineItemId ?? null,
      commissionLineItemId:
        commissionLineItemId ?? existing?.commissionLineItemId ?? null,
      monthlyCap: cap,
    },
  });

  console.log(
    JSON.stringify({
      event: "subscription_webhook_processed",
      shop,
      topic,
      plan,
      status,
      cap,
      commissionGraceEndsAt:
        paidPlanStartedAt
          ? new Date(
              paidPlanStartedAt.getTime() +
                COMMISSION_GRACE_DAYS * 86_400_000,
            ).toISOString()
          : null,
      // Reference PLANS to ensure constant import is preserved.
      planPrice: PLANS[plan].price,
    }),
  );

  return new Response();
};
