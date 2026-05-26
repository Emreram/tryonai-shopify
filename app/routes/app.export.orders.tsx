import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { toCsv } from "../lib/csv.server";
import { authenticate } from "../shopify.server";

const HEADERS = [
  "created_at",
  "order_id",
  "request_id",
  "subtotal_usd",
  "commission_rate",
  "commission_usd",
  "refunded_at",
  "refunded_subtotal_usd",
  "commission_credit_usd",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const attributedOrders = await db.attributedOrder.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  const csv = toCsv(
    HEADERS,
    attributedOrders.map((row) => [
      row.createdAt.toISOString(),
      row.orderId,
      row.requestId,
      row.subtotalUsd,
      row.commissionRate,
      row.commissionUsd,
      row.refundedAt?.toISOString() ?? null,
      row.refundedSubtotalUsd,
      row.commissionCreditUsd,
    ]),
  );

  const today = new Date().toISOString().slice(0, 10);
  const filename = `tryonai-orders-${shop}-${today}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
