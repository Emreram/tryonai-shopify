import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // We never persist shopper data — try-on inputs live only in process memory
  // for the duration of the generation request. Log the event for audit and ACK.
  console.log(
    JSON.stringify({ event: "gdpr_webhook", topic, shop, payload }),
  );

  return new Response();
};
