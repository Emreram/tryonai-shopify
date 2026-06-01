import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // Try-on INPUTS are never persisted. Generated try-on images may be briefly
  // cached, but those entries are content-hashed, shop-scoped, NOT linked to any
  // customer identity, and auto-expire within the cache TTL — so there are no
  // customer-identified records to delete here. Log the event for audit and ACK.
  console.log(
    JSON.stringify({ event: "gdpr_webhook", topic, shop, payload }),
  );

  return new Response();
};
