// Fetches a shop's catalog from its PUBLIC storefront endpoints — no Admin API
// scope, no merchant re-consent (the app stays scopeless). Server-to-server, so
// there is no CORS concern and we can paginate.
//
// Primary source: GET https://{shop}/products.json?limit=250&page=N  (public on
// most stores; a merchant CAN disable it, and password-protected stores return
// HTML/401 — both are detected and reported as a degraded feedMode).
// Anchor helper: GET https://{shop}/recommendations/products.json?product_id=..
// &intent=complementary — Shopify's own "complete the look" set, which works even
// when /products.json is disabled.

export type FeedMode = "full" | "recommendations-only" | "unavailable";

export interface CatalogVariant {
  id: string;
  title: string;
  /** option values in order, e.g. ["Red", "M"]. */
  options: string[];
  price: number; // major units (e.g. 29.99); 0 when unparseable
  available: boolean;
}

export interface CatalogProductOption {
  name: string; // e.g. "Color", "Size"
  values: string[];
}

export interface CatalogProduct {
  id: string;
  handle: string;
  title: string;
  productType: string;
  tags: string[];
  vendor: string;
  image: string | null; // primary image URL (CDN), upgraded to a usable width
  options: CatalogProductOption[];
  variants: CatalogVariant[];
  priceMin: number; // major units across available variants
}

const PER_PAGE = 250;
const FETCH_TIMEOUT_MS = 8_000;

function maxPages(): number {
  const raw = process.env.OUTFIT_CATALOG_MAX_PAGES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8; // 8 * 250 = 2000 products
}

function storefrontBase(shop: string): string {
  // `shop` is the validated *.myshopify.com domain from the proxy signature.
  return `https://${shop}`;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    // Password-protected storefronts answer 200 with an HTML login page; guard
    // against parsing that as a catalog.
    if (!contentType.includes("json")) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch and lightly normalize the shop's public catalog. Never throws — on a
 * disabled/blocked feed it returns `{ feedMode: "unavailable", products: [] }`
 * and the caller falls back to recommendations or hides the feature.
 */
export async function fetchPublicCatalog(
  shop: string,
): Promise<{ feedMode: FeedMode; products: CatalogProduct[] }> {
  const base = storefrontBase(shop);
  const products: CatalogProduct[] = [];
  const limit = maxPages();
  let page = 1;
  let firstPageParsed = false;

  while (page <= limit) {
    const url = `${base}/products.json?limit=${PER_PAGE}&page=${page}`;
    const payload = await fetchJson(url);
    const raw = payload && typeof payload === "object"
      ? (payload as { products?: unknown }).products
      : null;
    if (!Array.isArray(raw)) {
      // First page failed → feed disabled/blocked. Later page failed → just stop.
      break;
    }
    firstPageParsed = true;
    if (raw.length === 0) break;
    for (const item of raw) {
      const product = normalizeProduct(item);
      if (product) products.push(product);
    }
    if (raw.length < PER_PAGE) break;
    page++;
  }

  if (!firstPageParsed) return { feedMode: "unavailable", products: [] };
  return { feedMode: "full", products };
}

/**
 * Shopify's native complementary recommendations for a product. Public; works
 * even when /products.json is disabled. Returns [] on any failure.
 */
export async function fetchComplementary(
  shop: string,
  productId: string,
  limit = 10,
): Promise<CatalogProduct[]> {
  const base = storefrontBase(shop);
  const url =
    `${base}/recommendations/products.json?product_id=${encodeURIComponent(productId)}` +
    `&intent=complementary&limit=${limit}`;
  const payload = await fetchJson(url);
  const raw = payload && typeof payload === "object"
    ? (payload as { products?: unknown }).products
    : null;
  if (!Array.isArray(raw)) return [];
  const out: CatalogProduct[] = [];
  for (const item of raw) {
    const product = normalizeProduct(item);
    if (product) out.push(product);
  }
  return out;
}

// ---- normalization ---------------------------------------------------------

function normalizeProduct(item: unknown): CatalogProduct | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const id = stringifyId(o.id);
  const handle = asString(o.handle);
  const title = asString(o.title);
  if (!handle || !title) return null;

  const variants = Array.isArray(o.variants)
    ? o.variants.map(normalizeVariant).filter((v): v is CatalogVariant => v != null)
    : [];
  const options = Array.isArray(o.options)
    ? o.options.map(normalizeOption).filter((v): v is CatalogProductOption => v != null)
    : [];
  const images = Array.isArray(o.images) ? o.images.map(extractImageSrc).filter(Boolean) : [];
  const featured = extractImageSrc(o.featured_image) || (images[0] ?? null);

  const availablePrices = variants
    .filter((v) => v.available)
    .map((v) => v.price)
    .filter((p) => p > 0);
  const priceMin = availablePrices.length
    ? Math.min(...availablePrices)
    : Math.min(...variants.map((v) => v.price).filter((p) => p > 0), 0);

  return {
    id: id || handle,
    handle,
    title,
    productType: asString(o.product_type),
    tags: normalizeTags(o.tags),
    vendor: asString(o.vendor),
    image: featured ? upgradeImageWidth(featured) : null,
    options,
    variants,
    priceMin: Number.isFinite(priceMin) ? priceMin : 0,
  };
}

function normalizeVariant(item: unknown): CatalogVariant | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const id = stringifyId(o.id);
  if (!id) return null;
  const options = [o.option1, o.option2, o.option3]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
  return {
    id,
    title: asString(o.title),
    options,
    price: parsePrice(o.price),
    // /products.json includes `available`; default to true if absent so we don't
    // wrongly hide a whole catalog that omits the field.
    available: o.available === undefined ? true : o.available === true,
  };
}

function normalizeOption(item: unknown): CatalogProductOption | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const name = asString(o.name);
  if (!name) return null;
  const values = Array.isArray(o.values)
    ? o.values.map((v) => (typeof v === "string" ? v : String(v))).filter(Boolean)
    : [];
  return { name, values };
}

function normalizeTags(tags: unknown): string[] {
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function extractImageSrc(img: unknown): string {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (typeof img === "object") {
    const src = (img as Record<string, unknown>).src;
    if (typeof src === "string") return src;
  }
  return "";
}

// Shopify CDN images accept a ?width= query (or a `_NNNx` suffix). The Stylist
// shows thumbnails and feeds the try-on a usable resolution; request ~1024.
function upgradeImageWidth(src: string): string {
  try {
    const u = new URL(src);
    u.searchParams.set("width", "1024");
    return u.toString();
  } catch {
    return src;
  }
}

function parsePrice(v: unknown): number {
  if (typeof v === "number") return v > 1000 ? v / 100 : v; // cents guard
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function stringifyId(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim();
  return "";
}
