import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import {
  COMMISSION_GRACE_DAYS,
  PLANS,
  isPlanKey,
} from "../lib/plans.server";

interface NoteAttribute {
  name?: string;
  value?: string;
}

interface MoneySet {
  shop_money?: { amount?: string; currency_code?: string };
  presentment_money?: { amount?: string; currency_code?: string };
}

interface OrdersPaidPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  note_attributes?: NoteAttribute[];
  subtotal_price_set?: MoneySet;
  current_subtotal_price_set?: MoneySet;
  test?: boolean;
  financial_status?: string;
}

function parseMoney(set: MoneySet | undefined): number {
  const raw = set?.shop_money?.amount ?? set?.presentment_money?.amount;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as OrdersPaidPayload;

  const attr = (order.note_attributes ?? []).find(
    (a) => a?.name === "_tryonai_request_id" && typeof a.value === "string",
  );
  if (!attr?.value) {
    return new Response();
  }

  const orderGid =
    order.admin_graphql_api_id ??
    (order.id ? `gid://shopify/Order/${order.id}` : null);
  if (!orderGid) {
    console.warn(
      JSON.stringify({ event: "orders_paid_missing_order_id", shop }),
    );
    return new Response();
  }

  // Idempotency
  const existing = await db.attributedOrder.findUnique({
    where: { orderId: orderGid },
  });
  if (existing) {
    return new Response();
  }

  const billing = await db.billingState.findUnique({ where: { shop } });
  if (!billing) {
    console.warn(
      JSON.stringify({
        event: "orders_paid_no_billing_state",
        shop,
        orderId: orderGid,
      }),
    );
    return new Response();
  }

  const plan = isPlanKey(billing.plan) ? billing.plan : "trial";
  if (plan === "trial" || !billing.paidPlanStartedAt) {
    // No commission while on trial.
    return new Response();
  }
  const graceEnds = new Date(
    billing.paidPlanStartedAt.getTime() + COMMISSION_GRACE_DAYS * 86_400_000,
  );
  if (new Date() < graceEnds) {
    // Within the 30-day no-commission grace window.
    return new Response();
  }

  const subtotalUsd =
    parseMoney(order.subtotal_price_set) ||
    parseMoney(order.current_subtotal_price_set);
  if (subtotalUsd <= 0) {
    return new Response();
  }

  const commissionRate = PLANS[plan].commission;
  const commissionUsd = round2(subtotalUsd * commissionRate);

  // Apply any pending refund credit first.
  const settings = await db.merchantSettings.findUnique({ where: { shop } });
  const credit = Number(settings?.pendingCredit ?? 0);
  const netCommission = Math.max(0, round2(commissionUsd - credit));
  const remainingCredit = Math.max(0, round2(credit - commissionUsd));

  let usageChargeId: string | null = null;
  if (netCommission > 0 && billing.commissionLineItemId) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const resp = await admin.graphql(
        `#graphql
          mutation tryonaiCommissionCharge(
            $id: ID!
            $price: MoneyInput!
            $description: String!
          ) {
            appUsageRecordCreate(
              subscriptionLineItemId: $id
              price: $price
              description: $description
            ) {
              appUsageRecord { id }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            id: billing.commissionLineItemId,
            price: { amount: netCommission, currencyCode: "USD" },
            description: `Commission for order ${order.name ?? orderGid} (request ${attr.value})`,
          },
        },
      );
      const result = await resp.json();
      const errors = result?.data?.appUsageRecordCreate?.userErrors;
      if (errors?.length) {
        console.error(
          JSON.stringify({
            event: "appUsageRecordCreate_user_errors",
            shop,
            orderId: orderGid,
            errors,
          }),
        );
      }
      usageChargeId =
        result?.data?.appUsageRecordCreate?.appUsageRecord?.id ?? null;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "appUsageRecordCreate_threw",
          shop,
          orderId: orderGid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  await db.$transaction([
    db.attributedOrder.create({
      data: {
        shop,
        orderId: orderGid,
        requestId: attr.value,
        subtotalUsd,
        commissionUsd,
        commissionRate,
        usageChargeId,
      },
    }),
    db.merchantSettings.upsert({
      where: { shop },
      create: { shop, pendingCredit: remainingCredit },
      update: { pendingCredit: remainingCredit },
    }),
  ]);

  console.log(
    JSON.stringify({
      event: "order_attributed",
      shop,
      orderId: orderGid,
      requestId: attr.value,
      subtotalUsd,
      commissionUsd,
      netCommission,
      creditApplied: round2(credit - remainingCredit),
      usageChargeId,
    }),
  );

  return new Response();
};
