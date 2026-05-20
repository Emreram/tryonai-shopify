import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    JSON.stringify({ event: "gdpr_webhook", topic, shop, payload }),
  );

  return new Response();
};
