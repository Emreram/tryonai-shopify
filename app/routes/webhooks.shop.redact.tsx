import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { purgeShopTryOnCache } from "../lib/tryonCache.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(JSON.stringify({ event: "gdpr_webhook", topic, shop }));

  // Purge cached customer-likeness images BEFORE the DB transaction below, while
  // the index rows still exist (the purge enumerates rows to find storage
  // objects). It touches Storage, not the DB transaction, so isolate failures
  // here and continue with the redaction.
  try {
    await purgeShopTryOnCache(shop);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "tryon_cache_purge_on_shop_redact_failed",
        shop,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  await db.$transaction([
    db.merchantSettings.deleteMany({ where: { shop } }),
    db.billingState.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { domain: shop } }),
  ]);

  return new Response();
};
