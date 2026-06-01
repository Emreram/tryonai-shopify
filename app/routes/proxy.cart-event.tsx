// Signed app-proxy beacon: storefront -> /apps/tryonai/cart-event. The try-on
// widget POSTs this (keepalive, best-effort) right after /cart/add.js succeeds,
// so we can count tool-driven add-to-carts and the cart value they drove. Auth
// is the App Proxy HMAC (verifyProxySignature) over the query params Shopify
// appends — identical to proxy.tryon.tsx; the JSON body is not part of the HMAC.
//
// The write is refused unless the requestId matches a real served try-on for the
// same shop (see recordCartEvent), so a forged beacon can't inflate the numbers.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { verifyProxySignature } from "../lib/proxy.server";
import { recordCartEvent } from "../lib/cartEvents.server";

const MAX_HANDLE_LEN = 255;
const MAX_REQUEST_ID_LEN = 128;
// $1,000,000 per unit, in cents. Above this we treat the price as unknown rather
// than letting a spoofed value poison the attributed-value sum.
const MAX_PRICE_CENTS = 100_000_000;

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  return json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let shop: string;
  try {
    ({ shop } = verifyProxySignature(request));
  } catch (err) {
    if (err instanceof Response) return err;
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (payload ?? {}) as Record<string, unknown>;

  const requestId = asNonEmptyString(body.requestId, MAX_REQUEST_ID_LEN);
  if (!requestId) {
    return json({ error: "Missing requestId" }, { status: 400 });
  }

  const productHandle = asNonEmptyString(body.productHandle, MAX_HANDLE_LEN);
  const variantId = asVariantId(body.variantId);
  const quantity = clampQuantity(body.quantity);
  const currency = asCurrency(body.currency);
  const unitPrice = centsToMajor(body.priceCents);
  // Prefer an explicit line total from the client; otherwise derive it.
  const lineValue =
    centsToMajor(body.lineValueCents) ??
    (unitPrice != null ? round2(unitPrice * quantity) : null);

  try {
    const result = await recordCartEvent({
      shop,
      requestId,
      productHandle,
      variantId,
      quantity,
      unitPrice,
      lineValue,
      currency,
    });
    console.log(
      JSON.stringify({
        event: "cart_event_beacon",
        shop,
        request_id: requestId,
        result: result.status,
        variant_id: variantId,
        line_value: lineValue,
        currency,
      }),
    );
    // Always ACK with 204; the beacon is fire-and-forget and we don't leak which
    // requestIds verified (an "unverified" result still returns 204).
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "cart_event_beacon_failed",
        shop,
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // Don't surface internals; the storefront ignores the response anyway.
    return new Response(null, { status: 204 });
  }
}

function asNonEmptyString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.slice(0, maxLen);
}

function asVariantId(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d{1,32}$/.test(s) ? s : null;
}

function clampQuantity(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(999, Math.max(1, Math.round(n)));
}

function asCurrency(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

// Accepts an integer count of currency subunits (cents) and returns major units,
// or null when absent/implausible. Negative and absurd values become null.
function centsToMajor(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE_CENTS) return null;
  return round2(n / 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
