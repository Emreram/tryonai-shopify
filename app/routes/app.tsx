import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Idempotently seed Shop + BillingState + MerchantSettings so every
  // downstream route (cap enforcement, billing UI, webhook handlers) can
  // rely on these rows existing.
  await db.shop.upsert({
    where: { domain: session.shop },
    create: { domain: session.shop },
    update: {},
  });
  await db.billingState.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {},
  });
  await db.merchantSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {},
  });

  // App Bridge (and the s-* web components) cannot initialize without the api
  // key. An empty key silently ships an inert embedded app — the exact failure
  // that caused the 1.2.3 rejection — so fail loudly on a misconfigured deploy
  // rather than rendering dead buttons.
  // eslint-disable-next-line no-undef
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) {
    throw new Response("App misconfigured: SHOPIFY_API_KEY is missing", {
      status: 500,
    });
  }
  return { apiKey };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/billing">Billing</s-link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
