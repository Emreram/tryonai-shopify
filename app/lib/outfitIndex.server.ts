// Builds and caches the per-shop product index the Stylist reasons over. Maps
// each product to an outfit SLOT (top/bottom/dress/outerwear/shoes/accessory) and
// a color family, using a cheap heuristic cascade first and gpt-5.4-mini only for
// the leftovers. The result is persisted to ShopCatalog (TTL'd) so only the first
// outfit per shop per window pays the build cost.

import db from "../db.server";
import {
  fetchPublicCatalog,
  type CatalogProduct,
  type FeedMode,
} from "./catalog.server";
import {
  getCanonicalColor,
  inferColorFromText,
  type CanonicalColor,
  type ColorFamily,
} from "./colorTheory";
import { runStructured, computeTextCostUsd } from "./openaiText.server";

export type OutfitSlot =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  | "shoes"
  | "accessory"
  | "other";

export const OUTFIT_SLOTS: OutfitSlot[] = [
  "top",
  "bottom",
  "dress",
  "outerwear",
  "shoes",
  "accessory",
  "other",
];

export interface IndexedVariant {
  id: string;
  options: string[];
  available: boolean;
  price: number;
}

export interface IndexedProduct {
  id: string;
  handle: string;
  title: string;
  slot: OutfitSlot;
  color: { name: string; family: ColorFamily } | null;
  /** Offered in many colors → matches any palette (don't exclude on color). */
  flexibleColor: boolean;
  price: number;
  image: string | null;
  optionNames: string[];
  variants: IndexedVariant[];
}

export interface ShopIndex {
  feedMode: FeedMode;
  products: IndexedProduct[];
}

// Slot rules in priority order: dress/outerwear/shoes resolved before the more
// generic bottom/top so "shirt dress" → dress and "denim jacket" → outerwear.
const SLOT_RULES: Array<{ slot: OutfitSlot; keywords: string[] }> = [
  {
    slot: "dress",
    keywords: ["dress", "gown", "jumpsuit", "romper", "playsuit", "overall"],
  },
  {
    slot: "outerwear",
    keywords: [
      "jacket", "coat", "blazer", "parka", "trench", "overcoat", "windbreaker",
      "puffer", "anorak", "cardigan", "vest", "gilet", "outerwear",
    ],
  },
  {
    slot: "shoes",
    keywords: [
      "shoe", "sneaker", "trainer", "boot", "heel", "sandal", "loafer", "pump",
      "flat", "mule", "espadrille", "slipper", "footwear", "clog", "oxford",
    ],
  },
  {
    slot: "bottom",
    keywords: [
      "jean", "trouser", "pant", "short", "skirt", "legging", "chino", "jogger",
      "slack", "culotte", "cargo", "sweatpant",
    ],
  },
  {
    slot: "top",
    keywords: [
      "shirt", "tee", "t-shirt", "blouse", "top", "sweater", "jumper", "hoodie",
      "sweatshirt", "polo", "tank", "knit", "pullover", "tunic", "camisole",
      "bodysuit", "crop",
    ],
  },
  {
    slot: "accessory",
    keywords: [
      "bag", "belt", "hat", "scarf", "sunglass", "jewel", "necklace", "earring",
      "bracelet", "ring", "watch", "wallet", "beanie", "cap", "glove", "tie",
      "sock", "purse", "clutch", "backpack", "tote",
    ],
  },
];

function matchSlot(text: string): OutfitSlot | null {
  const t = ` ${text.toLowerCase()} `;
  for (const rule of SLOT_RULES) {
    for (const kw of rule.keywords) {
      if (t.includes(kw)) return rule.slot;
    }
  }
  return null;
}

/** Heuristic slot from product_type → tags → title (most specific signal first). */
export function classifySlotHeuristic(p: CatalogProduct): OutfitSlot | null {
  return (
    matchSlot(p.productType) ??
    matchSlot(p.tags.join(" ")) ??
    matchSlot(p.title)
  );
}

function colorOptionValues(p: CatalogProduct): string[] {
  const opt = p.options.find((o) => /colou?r/i.test(o.name));
  return opt ? opt.values : [];
}

/** Representative color + a "flexible" flag for many-color products. */
function resolveColor(p: CatalogProduct): {
  color: { name: string; family: ColorFamily } | null;
  flexibleColor: boolean;
} {
  const values = colorOptionValues(p);
  const mapped = values
    .map((v) => getCanonicalColor(v) ?? inferColorFromText(v))
    .filter((c): c is CanonicalColor => c != null);
  if (mapped.length >= 3) {
    // Offered in several colors → treat as palette-flexible.
    return { color: toCanonicalEntry(mapped[0]), flexibleColor: true };
  }
  const fromOption = mapped[0] ?? null;
  const inferred = fromOption ?? inferColorFromText(`${p.title} ${p.tags.join(" ")}`);
  return { color: toCanonicalEntry(inferred), flexibleColor: false };
}

function toCanonicalEntry(
  c: CanonicalColor | null,
): { name: string; family: ColorFamily } | null {
  return c ? { name: c.name, family: c.family } : null;
}

function toIndexed(p: CatalogProduct, slot: OutfitSlot): IndexedProduct {
  const { color, flexibleColor } = resolveColor(p);
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    slot,
    color,
    flexibleColor,
    price: p.priceMin,
    image: p.image,
    optionNames: p.options.map((o) => o.name),
    variants: p.variants.map((v) => ({
      id: v.id,
      options: v.options,
      available: v.available,
      price: v.price,
    })),
  };
}

/**
 * Heuristic-only indexing (no LLM) for the recommendations fallback path, where
 * we classify a small ad-hoc set of complementary products on the fly.
 */
export function indexProductsHeuristic(products: CatalogProduct[]): IndexedProduct[] {
  return products.map((p) => toIndexed(p, classifySlotHeuristic(p) ?? "other"));
}

const MAX_CLASSIFY = 300; // cap gpt-5.4-mini leftover classification per build
const CLASSIFY_CHUNK = 100;

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          i: { type: "integer" },
          slot: {
            type: "string",
            enum: ["top", "bottom", "dress", "outerwear", "shoes", "accessory", "other"],
          },
        },
        required: ["i", "slot"],
      },
    },
  },
  required: ["items"],
} as const;

interface ClassifyResult {
  items: Array<{ i: number; slot: OutfitSlot }>;
}

/**
 * Ask gpt-5.4-mini to classify the products the heuristics couldn't. Mutates
 * `indexed[i].slot` in place. Returns the COGS of the classification calls.
 */
async function classifyLeftoversWithLLM(
  indexed: IndexedProduct[],
): Promise<number> {
  const leftoverIdx = indexed
    .map((p, i) => (p.slot === "other" ? i : -1))
    .filter((i) => i >= 0)
    .slice(0, MAX_CLASSIFY);
  if (leftoverIdx.length === 0) return 0;

  let cost = 0;
  for (let start = 0; start < leftoverIdx.length; start += CLASSIFY_CHUNK) {
    const chunk = leftoverIdx.slice(start, start + CLASSIFY_CHUNK);
    const lines = chunk
      .map((idx, k) => `${k}. ${indexed[idx].title}`)
      .join("\n");
    try {
      const { data, usage } = await runStructured<ClassifyResult>({
        schemaName: "slot_classification",
        schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
        instructions:
          "You classify apparel product titles into a single outfit slot. " +
          "Slots: top, bottom, dress (full-body one-pieces), outerwear, shoes, " +
          "accessory, other (non-apparel or unclear). Return one entry per input index.",
        input: `Classify each item by its leading index:\n${lines}`,
        maxOutputTokens: 1500,
      });
      cost += computeTextCostUsd(usage);
      for (const item of data.items ?? []) {
        const localIndex = item.i;
        if (localIndex >= 0 && localIndex < chunk.length) {
          const globalIdx = chunk[localIndex];
          if (OUTFIT_SLOTS.includes(item.slot)) {
            indexed[globalIdx].slot = item.slot;
          }
        }
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "outfit_classify_chunk_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // Leave this chunk as "other"; the engine simply won't use it as a slot.
    }
  }
  return cost;
}

function ttlMs(): number {
  const raw = process.env.OUTFIT_CATALOG_TTL_HOURS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  const hours = Number.isFinite(n) && n > 0 ? n : 24;
  return hours * 3_600_000;
}

function llmClassifyEnabled(): boolean {
  return process.env.OUTFIT_LLM_CLASSIFY !== "false";
}

/** Read the cached index if present and unexpired. */
export async function getCachedShopIndex(shop: string): Promise<ShopIndex | null> {
  try {
    const row = await db.shopCatalog.findUnique({ where: { shop } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const data = row.data as unknown as { products?: IndexedProduct[] };
    return {
      feedMode: row.feedMode as FeedMode,
      products: Array.isArray(data?.products) ? data.products : [],
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "shop_catalog_read_failed",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

async function saveShopIndex(
  shop: string,
  feedMode: FeedMode,
  products: IndexedProduct[],
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs());
  try {
    await db.shopCatalog.upsert({
      where: { shop },
      create: {
        shop,
        feedMode,
        productCount: products.length,
        data: { products } as unknown as object,
        expiresAt,
      },
      update: {
        feedMode,
        productCount: products.length,
        data: { products } as unknown as object,
        builtAt: new Date(),
        expiresAt,
      },
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "shop_catalog_save_failed",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Get the shop's index, building (and caching) it if missing/stale. Returns the
 * index plus the COGS incurred building it (0 on a cache hit) so the caller can
 * fold it into the outfit request's UsageLog.
 */
export async function getOrBuildShopIndex(
  shop: string,
  opts: { force?: boolean } = {},
): Promise<{ index: ShopIndex; buildCostUsd: number }> {
  if (!opts.force) {
    const cached = await getCachedShopIndex(shop);
    if (cached) return { index: cached, buildCostUsd: 0 };
  }

  const { feedMode, products } = await fetchPublicCatalog(shop);
  const indexed = products.map((p) => toIndexed(p, classifySlotHeuristic(p) ?? "other"));

  let buildCostUsd = 0;
  if (feedMode !== "unavailable" && llmClassifyEnabled()) {
    buildCostUsd = await classifyLeftoversWithLLM(indexed);
  }

  const finalFeedMode: FeedMode =
    feedMode === "full" && indexed.length === 0 ? "unavailable" : feedMode;

  await saveShopIndex(shop, finalFeedMode, indexed);
  return { index: { feedMode: finalFeedMode, products: indexed }, buildCostUsd };
}

/** Purge a shop's cached index (uninstall / shop redact). */
export async function purgeShopIndex(shop: string): Promise<void> {
  try {
    await db.shopCatalog.deleteMany({ where: { shop } });
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "shop_catalog_purge_failed",
        shop,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
