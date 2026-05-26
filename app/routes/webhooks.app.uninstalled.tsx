import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(JSON.stringify({ event: "webhook_received", topic, shop }));

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Reset BillingState so a reinstall inside the 48h shop/redact window starts
  // fresh: no stale paidPlanStartedAt (commission grace clock would otherwise
  // keep ticking) and no stale subscriptionId (Shopify auto-cancels app
  // subscriptions on uninstall). Historical UsageLog / AttributedOrder rows
  // are preserved for analytics — only the live billing state is reset.
  await db.billingState.updateMany({
    where: { shop },
    data: {
      plan: "trial",
      status: "uninstalled",
      subscriptionId: null,
      paidPlanStartedAt: null,
      currentCycleStart: null,
      currentCycleEnd: null,
      overageLineItemId: null,
      commissionLineItemId: null,
      trialStartedAt: new Date(),
    },
  });

  return new Response();
};
