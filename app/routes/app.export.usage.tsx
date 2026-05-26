import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { toCsv } from "../lib/csv.server";
import { authenticate } from "../shopify.server";

const HEADERS = [
  "created_at",
  "request_id",
  "plan",
  "status",
  "size",
  "cost_usd",
  "openai_ms",
  "cycle_start",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const usageLogs = await db.usageLog.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  const csv = toCsv(
    HEADERS,
    usageLogs.map((row) => [
      row.createdAt.toISOString(),
      row.requestId,
      row.plan,
      row.status,
      row.size,
      row.costUsd,
      row.openaiMs,
      row.cycleStart.toISOString(),
    ]),
  );

  const today = new Date().toISOString().slice(0, 10);
  const filename = `tryonai-usage-${shop}-${today}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
