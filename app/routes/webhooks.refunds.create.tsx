import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

interface RefundLineItem {
  subtotal?: string | number;
  subtotal_set?: {
    shop_money?: { amount?: string };
    presentment_money?: { amount?: string };
  };
  total_tax?: string | number;
  quantity?: number;
}

interface RefundsCreatePayload {
  id?: number | string;
  order_id?: number | string;
  admin_graphql_api_id?: string;
  refund_line_items?: RefundLineItem[];
  transactions?: Array<{
    amount?: string | number;
    kind?: string;
    status?: string;
  }>;
}

function lineItemSubtotal(item: RefundLineItem): number {
  const raw =
    item.subtotal_set?.shop_money?.amount ??
    item.subtotal_set?.presentment_money?.amount ??
    item.subtotal;
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const refund = payload as RefundsCreatePayload;
  if (!refund?.order_id) return new Response();

  const orderGid = `gid://shopify/Order/${refund.order_id}`;
  const attributed = await db.attributedOrder.findUnique({
    where: { orderId: orderGid },
  });
  if (!attributed || attributed.refundedAt) {
    return new Response();
  }

  const refundedSubtotal = (refund.refund_line_items ?? []).reduce(
    (sum, li) => sum + lineItemSubtotal(li),
    0,
  );
  if (refundedSubtotal <= 0) {
    return new Response();
  }

  const credit = round2(refundedSubtotal * Number(attributed.commissionRate));
  if (credit <= 0) {
    return new Response();
  }

  await db.$transaction([
    db.attributedOrder.update({
      where: { id: attributed.id },
      data: {
        refundedAt: new Date(),
        refundedSubtotalUsd: refundedSubtotal,
        commissionCreditUsd: credit,
      },
    }),
    db.merchantSettings.upsert({
      where: { shop },
      create: { shop, pendingCredit: credit },
      update: { pendingCredit: { increment: credit } },
    }),
  ]);

  console.log(
    JSON.stringify({
      event: "refund_credit_recorded",
      shop,
      orderId: orderGid,
      refundedSubtotal,
      credit,
    }),
  );

  return new Response();
};
