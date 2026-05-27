import crypto from "node:crypto";

export interface ProxyAuthResult {
  shop: string;
  customerId: string | null;
}

// Verifies a Shopify App Proxy request: HMAC-SHA256 over the sorted, joined
// querystring (signature param excluded) using the app's API secret.
// See https://shopify.dev/docs/apps/build/online-store/display-dynamic-data#verify-the-signature
export function verifyProxySignature(request: Request): ProxyAuthResult {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Response("server misconfigured", { status: 500 });
  }

  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  const signature = params.get("signature");
  if (!signature) {
    throw new Response("missing signature", { status: 401 });
  }
  params.delete("signature");

  const sorted = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(sorted)
    .digest("hex");

  let ok = false;
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    ok =
      sigBuf.length === expBuf.length &&
      crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Response("invalid signature", { status: 401 });
  }

  const shop = params.get("shop");
  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw new Response("missing or invalid shop", { status: 401 });
  }
  const customerIdRaw = params.get("logged_in_customer_id");
  const customerId =
    customerIdRaw && customerIdRaw.length > 0 ? customerIdRaw : null;
  return { shop, customerId };
}
