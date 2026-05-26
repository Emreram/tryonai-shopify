import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  loginErrorMessage(await login(request));
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  loginErrorMessage(await login(request));
  return null;
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Install TryOn AI">
          <s-paragraph>
            Install this app from the Shopify App Store. After installation,
            Shopify will redirect you to the embedded app inside your store
            admin.
          </s-paragraph>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
