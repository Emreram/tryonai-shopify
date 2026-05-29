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

  // Mark billing state as uninstalled but preserve trialStartedAt so the
  // 14-day trial clock keeps running across uninstall/reinstall — reviewers
  // flag trial-reset-on-reinstall as a way to game free usage.
  await db.billingState.updateMany({
    where: { shop },
    data: {
      status: "uninstalled",
      subscriptionId: null,
      paidPlanStartedAt: null,
      currentCycleStart: null,
      currentCycleEnd: null,
    },
  });

  return new Response();
};
