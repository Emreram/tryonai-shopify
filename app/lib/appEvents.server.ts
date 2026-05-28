import { PLAN_LINE_ITEM_TAGS } from "./plans";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

export interface AppEventResult {
  status: "accepted" | "skipped_config" | "failed";
  eventId: string;
  error?: string;
}

function hasAppEventsConfig(): boolean {
  return Boolean(
    process.env.SHOPIFY_APP_EVENTS_CLIENT_ID &&
      process.env.SHOPIFY_APP_EVENTS_CLIENT_SECRET,
  );
}

async function appEventsAccessToken(): Promise<string | null> {
  if (!hasAppEventsConfig()) return null;
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken;
  }

  const response = await fetch("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_APP_EVENTS_CLIENT_ID,
      client_secret: process.env.SHOPIFY_APP_EVENTS_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const json = await response.json();
  if (!response.ok || !json?.access_token) {
    throw new Error(
      `App Events token request failed (${response.status}): ${JSON.stringify(
        json,
      )}`,
    );
  }

  cachedToken = {
    accessToken: String(json.access_token),
    expiresAt: now + Number(json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTryOnUsageEvent(args: {
  shopGid: string | null | undefined;
  requestId: string;
  timestamp?: Date;
}): Promise<AppEventResult> {
  const eventId = args.requestId.slice(0, 64);
  if (!args.shopGid || !hasAppEventsConfig()) {
    return { status: "skipped_config", eventId };
  }

  const token = await appEventsAccessToken();
  if (!token) return { status: "skipped_config", eventId };

  const version = process.env.SHOPIFY_APP_EVENTS_API_VERSION || "unstable";
  const endpoint = `https://api.shopify.com/app/${encodeURIComponent(
    version,
  )}/events`;
  const payload = {
    shop_id: args.shopGid,
    event_handle: PLAN_LINE_ITEM_TAGS.usage,
    timestamp: (args.timestamp ?? new Date()).toISOString(),
    idempotency_key: eventId,
    attributes: { value: 1 },
  };

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 202) {
      return { status: "accepted", eventId };
    }

    lastError = `${response.status}: ${await response.text()}`;
    if (!retryable(response.status) || attempt === 2) break;
    await delay(250 * Math.pow(2, attempt));
  }

  return { status: "failed", eventId, error: lastError };
}
