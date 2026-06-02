// Size Recommender engine. Given a shopper's biometrics and a few product
// handles, it fetches each product's PUBLIC /products/{handle}.js (no scopes),
// extracts the size chart from the description, and recommends an in-stock size
// per product: shoes deterministically (US/EU/UK conversion), clothing via
// gpt-5.4-mini grounded in the chart when present, with a deterministic fallback.
// Every product returns a typed status — this function never throws.

import {
  clampBiometrics,
  estimateClothingLabel,
  extractSizeChart,
  isShoeSizeOption,
  nearestAvailable,
  recommendShoe,
  type Biometrics,
  type SizeCandidate,
} from "./sizeChart";
import { runStructured, computeTextCostUsd } from "./openaiText.server";

export interface SizeProductRequest {
  handle: string;
  /** Already-chosen color (outfit flow) so we resolve the matching variant. */
  colorHint?: string | null;
}

export type SizeStatus =
  | "ok"
  | "substituted"
  | "out_of_stock"
  | "no_size_option"
  | "uncertain";

export interface SizeProductResult {
  handle: string;
  status: SizeStatus;
  size: string | null;
  variantId: string | null;
  note: string | null;
}

export interface RecommendSizesResult {
  results: SizeProductResult[];
  costUsd: number;
}

const FETCH_TIMEOUT_MS = 6_000;

interface ParsedProduct {
  handle: string;
  optionNames: string[];
  sizeIdx: number; // -1 if none
  colorIdx: number; // -1 if none
  variants: Array<{ id: string; options: string[]; available: boolean }>;
  candidates: SizeCandidate[];
  isShoe: boolean;
  sizeChart: string | null;
}

export async function recommendSizes(
  shop: string,
  bioRaw: Biometrics,
  products: SizeProductRequest[],
): Promise<RecommendSizesResult> {
  const bio = clampBiometrics(bioRaw);
  const unique = dedupeByHandle(products).slice(0, 8);

  const parsed = await Promise.all(
    unique.map((p) => fetchAndParse(shop, p.handle)),
  );

  const results: SizeProductResult[] = [];
  const clothing: Array<{ req: SizeProductRequest; product: ParsedProduct }> = [];

  unique.forEach((req, i) => {
    const product = parsed[i];
    if (!product) {
      results.push(uncertain(req.handle));
      return;
    }
    if (product.sizeIdx < 0 || product.candidates.length === 0) {
      // No size axis → just use an available variant.
      const v = firstAvailable(product);
      results.push({
        handle: req.handle,
        status: "no_size_option",
        size: null,
        variantId: v,
        note: null,
      });
      return;
    }
    if (product.isShoe) {
      results.push(resolveShoe(req, product, bio));
    } else {
      clothing.push({ req, product }); // batched below
    }
  });

  let costUsd = 0;
  if (clothing.length > 0) {
    const { labels, cost } = await pickClothingLabels(
      bio,
      clothing.map((c) => c.product),
    );
    costUsd += cost;
    for (const { req, product } of clothing) {
      const aiLabel = labels.get(product.handle);
      results.push(resolveClothing(req, product, bio, aiLabel));
    }
  }

  // Preserve the caller's product order.
  const order = new Map(unique.map((p, i) => [p.handle, i]));
  results.sort((a, b) => (order.get(a.handle)! - order.get(b.handle)!));
  return { results, costUsd };
}

// ---- per-product resolution ------------------------------------------------

function resolveShoe(
  req: SizeProductRequest,
  product: ParsedProduct,
  bio: Biometrics,
): SizeProductResult {
  const near = recommendShoe(bio, product.candidates);
  if (!near) {
    // No shoe size entered, or nothing in stock.
    const anyAvailable = product.candidates.some((c) => c.available);
    if (!anyAvailable) return outOfStock(req.handle);
    return uncertain(req.handle); // e.g. shopper left shoe size blank
  }
  return finalize(req, product, near.label, near.substituted);
}

function resolveClothing(
  req: SizeProductRequest,
  product: ParsedProduct,
  bio: Biometrics,
  aiLabel: string | undefined,
): SizeProductResult {
  // Use the AI label only if it's a real candidate; else deterministic estimate.
  const validAi =
    aiLabel &&
    product.candidates.some(
      (c) => c.label.trim().toLowerCase() === aiLabel.trim().toLowerCase(),
    )
      ? aiLabel
      : null;
  const target = validAi ?? estimateClothingLabel(bio);
  const near = nearestAvailable(target, product.candidates, { preferUp: true });
  if (!near) return outOfStock(req.handle);
  return finalize(req, product, near.label, near.substituted);
}

function finalize(
  req: SizeProductRequest,
  product: ParsedProduct,
  label: string,
  substituted: boolean,
): SizeProductResult {
  const variantId = pickVariantForLabel(product, label, req.colorHint ?? null);
  if (!variantId) return outOfStock(req.handle);
  return {
    handle: req.handle,
    status: substituted ? "substituted" : "ok",
    size: label,
    variantId,
    note: substituted ? `Closest in-stock size: ${label}` : null,
  };
}

function pickVariantForLabel(
  product: ParsedProduct,
  label: string,
  colorHint: string | null,
): string | null {
  const want = label.trim().toLowerCase();
  const matches = product.variants.filter(
    (v) =>
      v.available &&
      (v.options[product.sizeIdx] ?? "").trim().toLowerCase() === want,
  );
  if (matches.length === 0) {
    const anyAvail = product.variants.find((v) => v.available);
    return anyAvail ? anyAvail.id : null;
  }
  if (colorHint && product.colorIdx >= 0) {
    const c = colorHint.trim().toLowerCase();
    const byColor = matches.find(
      (v) => (v.options[product.colorIdx] ?? "").trim().toLowerCase() === c,
    );
    if (byColor) return byColor.id;
  }
  return matches[0].id;
}

function firstAvailable(product: ParsedProduct): string | null {
  const v = product.variants.find((x) => x.available) ?? product.variants[0];
  return v ? v.id : null;
}

const uncertain = (handle: string): SizeProductResult => ({
  handle, status: "uncertain", size: null, variantId: null, note: null,
});
const outOfStock = (handle: string): SizeProductResult => ({
  handle, status: "out_of_stock", size: null, variantId: null, note: null,
});

// ---- gpt-5.4-mini clothing pick (batched) ----------------------------------

const CLOTHING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sizes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          handle: { type: "string" },
          size: { type: "string" },
        },
        required: ["handle", "size"],
      },
    },
  },
  required: ["sizes"],
} as const;

interface ClothingPick {
  sizes: Array<{ handle: string; size: string }>;
}

async function pickClothingLabels(
  bio: Biometrics,
  products: ParsedProduct[],
): Promise<{ labels: Map<string, string>; cost: number }> {
  const labels = new Map<string, string>();
  const payload = {
    shopper: {
      height_cm: bio.heightCm,
      weight_kg: bio.weightKg,
      build: bio.build,
      gender: bio.gender,
      fit_preference: bio.fit ?? "relaxed",
    },
    garments: products.map((p) => ({
      handle: p.handle,
      available_sizes: p.candidates.map((c) => c.label),
      size_chart: p.sizeChart, // may be null
    })),
  };
  try {
    const { data, usage } = await runStructured<ClothingPick>({
      schemaName: "size_picks",
      schema: CLOTHING_SCHEMA as unknown as Record<string, unknown>,
      instructions:
        "You are an apparel fit expert. For each garment choose the single best " +
        "size LABEL for this shopper, chosen ONLY from that garment's " +
        "available_sizes. If a size_chart is provided for a garment, map the " +
        "shopper's height/weight/build to it precisely. If it is null, estimate " +
        "from the shopper's measurements, gender and fit preference. Return exactly " +
        "one entry per handle.",
      input: JSON.stringify(payload),
      maxOutputTokens: 1200,
    });
    for (const item of data.sizes ?? []) {
      if (item && typeof item.handle === "string" && typeof item.size === "string") {
        labels.set(item.handle, item.size);
      }
    }
    return { labels, cost: computeTextCostUsd(usage) };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "size_clothing_pick_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { labels, cost: 0 }; // callers fall back to the deterministic estimate
  }
}

// ---- fetch + parse public product JSON -------------------------------------

async function fetchAndParse(
  shop: string,
  handle: string,
): Promise<ParsedProduct | null> {
  if (!/^[a-z0-9][a-z0-9\-_]*$/i.test(handle)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://${shop}/products/${encodeURIComponent(handle)}.js`,
      { signal: controller.signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
    const p = (await res.json()) as Record<string, unknown>;
    return parseProduct(handle, p);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseProduct(handle: string, p: Record<string, unknown>): ParsedProduct {
  const optionNames = normalizeOptionNames(p.options);
  const variants = Array.isArray(p.variants)
    ? p.variants
        .map(normalizeVariant)
        .filter((v): v is ParsedProduct["variants"][number] => v != null)
    : [];
  const sizeIdx = optionNames.findIndex((n) =>
    /size|größe|grosse|taille|talla|tamaño|maat|taglia/i.test(n),
  );

  const labelSet = new Map<string, boolean>(); // label -> available (any)
  if (sizeIdx >= 0) {
    for (const v of variants) {
      const label = v.options[sizeIdx];
      if (!label) continue;
      labelSet.set(label, (labelSet.get(label) ?? false) || v.available);
    }
  }
  const candidates: SizeCandidate[] = [...labelSet.entries()].map(
    ([label, available]) => ({ label, available }),
  );

  const colorIdx = optionNames.findIndex((n) => /colou?r|farbe|couleur/i.test(n));
  const description =
    typeof p.description === "string"
      ? p.description
      : typeof p.body_html === "string"
        ? p.body_html
        : "";

  return {
    handle,
    optionNames,
    sizeIdx,
    colorIdx,
    variants,
    candidates,
    isShoe: sizeIdx >= 0 && isShoeSizeOption(optionNames[sizeIdx] ?? "", candidates.map((c) => c.label)),
    sizeChart: extractSizeChart(description),
  };
}

function normalizeOptionNames(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.map((o) => {
    if (typeof o === "string") return o;
    if (o && typeof o === "object" && typeof (o as { name?: unknown }).name === "string") {
      return (o as { name: string }).name;
    }
    return "";
  });
}

function normalizeVariant(
  v: unknown,
): { id: string; options: string[]; available: boolean } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id =
    typeof o.id === "number" ? String(o.id) : typeof o.id === "string" ? o.id : "";
  if (!id) return null;
  let options: string[] = [];
  if (Array.isArray(o.options)) {
    options = o.options.map((x) => (typeof x === "string" ? x : String(x ?? "")));
  } else {
    options = [o.option1, o.option2, o.option3]
      .filter((x) => typeof x === "string")
      .map((x) => x as string);
  }
  return { id, options, available: o.available === true };
}

function dedupeByHandle(products: SizeProductRequest[]): SizeProductRequest[] {
  const seen = new Set<string>();
  const out: SizeProductRequest[] = [];
  for (const p of products) {
    if (!p || typeof p.handle !== "string") continue;
    const h = p.handle.trim();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push({ handle: h, colorHint: p.colorHint ?? null });
  }
  return out;
}
