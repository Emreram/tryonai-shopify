export interface ActiveSubscriptionItem {
  handle?: string | null;
  description?: string | null;
  price?: {
    __typename?: string;
    active?: boolean;
    currency?: string;
    amount?: string | number | null;
    tiersMode?: string | null;
    tiers?: Array<{
      upTo?: number | null;
      amountPerUnit?: string | number | null;
      amount?: string | number | null;
    }>;
  } | null;
  usage?: {
    quantity?: number | null;
    cost?: { amount?: string | number | null; currencyCode?: string | null } | null;
  } | null;
}

export interface ActiveSubscription {
  billingPeriod?: string | null;
  cancelAtEndOfCycle?: boolean | null;
  trialEndsAt?: string | null;
  currentBillingCycle?: {
    startTime?: string | null;
    endTime?: string | null;
  } | null;
  items?: ActiveSubscriptionItem[];
  pendingUpdate?: {
    billingPeriod?: string | null;
    items?: Array<{ handle?: string | null }> | null;
  } | null;
}

export function hasPartnerApiConfig(): boolean {
  return Boolean(
    process.env.SHOPIFY_PARTNER_ORG_ID &&
      process.env.SHOPIFY_PARTNER_ACCESS_TOKEN &&
      process.env.SHOPIFY_PARTNER_APP_ID,
  );
}

export async function fetchActiveSubscription(
  shopGid: string,
): Promise<ActiveSubscription | null> {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID;
  const token = process.env.SHOPIFY_PARTNER_ACCESS_TOKEN;
  const appId = process.env.SHOPIFY_PARTNER_APP_ID;
  if (!orgId || !token || !appId) {
    throw new Error("Partner API env vars are not configured");
  }

  const version = process.env.SHOPIFY_PARTNER_API_VERSION || "2026-07";
  const endpoint = `https://partners.shopify.com/${encodeURIComponent(
    orgId,
  )}/api/${encodeURIComponent(version)}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: `#graphql
        query TryonaiActiveSubscription($appId: ID!, $shopId: ID!) {
          activeSubscription(appId: $appId, shopId: $shopId) {
            billingPeriod
            cancelAtEndOfCycle
            trialEndsAt
            currentBillingCycle {
              startTime
              endTime
            }
            items {
              handle
              description
              price {
                __typename
                active
                currency
                ... on FlatRatePrice {
                  amount
                }
                ... on TieredPrice {
                  tiersMode
                  tiers {
                    upTo
                    amountPerUnit
                    amount
                  }
                }
              }
              usage {
                quantity
                cost {
                  amount
                  currencyCode
                }
              }
            }
            pendingUpdate {
              billingPeriod
              items {
                handle
              }
            }
          }
        }`,
      variables: { appId, shopId: shopGid },
    }),
  });

  const json = await response.json();
  if (!response.ok || json?.errors?.length) {
    throw new Error(
      JSON.stringify({
        status: response.status,
        errors: json?.errors ?? null,
      }),
    );
  }
  return (json?.data?.activeSubscription as ActiveSubscription | null) ?? null;
}
