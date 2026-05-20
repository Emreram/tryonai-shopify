import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(JSON.stringify({ event: "gdpr_webhook", topic, shop }));

  await db.$transaction([
    db.merchantSettings.deleteMany({ where: { shop } }),
    db.billingState.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { domain: shop } }),
  ]);

  return new Response();
};
