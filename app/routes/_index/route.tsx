import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";

import styles from "./styles.module.css";

// Only accept App Store listing URLs on the canonical apps.shopify.com host.
// Anything else (typo, staging URL, accidental marketing redirect) is dropped
// so the landing falls back to a no-link "install from the App Store" message
// — reviewers must never see an "install" button that points off-Shopify.
function parseAppStoreUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.host !== "apps.shopify.com") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { appStoreUrl: parseAppStoreUrl(process.env.APP_STORE_LISTING_URL) };
};

export default function Index() {
  const { appStoreUrl } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>TryOn AI for Shopify</h1>
        <p className={styles.text}>
          An AI-powered try-on widget for fashion storefronts. Shoppers upload a
          selfie, pick a product, and see themselves wearing the item in
          seconds.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Lift conversion on PDPs.</strong> A familiar &ldquo;Try it
            on&rdquo; button on every product page.
          </li>
          <li>
            <strong>No shopper data stored.</strong> Selfies are processed in
            memory and never written to disk.
          </li>
          <li>
            <strong>Predictable Shopify billing.</strong> Monthly plans include
            a usage allowance, with simple per-try-on overages after that.
          </li>
        </ul>
        {appStoreUrl ? (
          <p className={styles.text}>
            <a className={styles.button} href={appStoreUrl}>
              Install on Shopify
            </a>
          </p>
        ) : (
          <p className={styles.text}>
            Install TryOn AI from the Shopify App Store to get started.
          </p>
        )}
      </div>
    </div>
  );
}
