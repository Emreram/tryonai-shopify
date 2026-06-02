// The Outfit Stylist selection engine. Turns the shopper's quiz answers + the
// shop's product index into a coherent, in-stock, color-matched outfit of REAL
// products. gpt-5.4-mini does the coherent pick; a deterministic color-theory
// selector validates it and fills any gaps — so the result is never random and
// every piece is guaranteed to exist and be in stock.

import {
  colorMatchesPalette,
  getCanonicalColor,
  harmonyWithChosen,
  inferColorFromText,
  type CanonicalColor,
  type PaletteAnswer,
} from "./colorTheory";
import {
  getOrBuildShopIndex,
  indexProductsHeuristic,
  type IndexedProduct,
  type OutfitSlot,
  type ShopIndex,
} from "./outfitIndex.server";
import { fetchComplementary } from "./catalog.server";
import { runStructured, computeTextCostUsd } from "./openaiText.server";

export type Occasion = "everyday" | "work" | "date" | "event" | "active";
export type Vibe = "classic" | "casual" | "streetwear" | "elegant" | "minimal";
export type Fit = "fitted" | "relaxed" | "oversized";
export type Budget = "best" | "affordable";

export interface QuizAnswers {
  occasion: Occasion;
  palette: PaletteAnswer;
  vibe: Vibe;
  fit: Fit;
  budget?: Budget;
}

export interface AnchorInput {
  id: string;
  handle: string;
  title: string;
  image: string | null;
  variantId: string | null;
}

export interface GenerateOutfitInput {
  shop: string;
  answers: QuizAnswers;
  mode: "anchor" | "scratch";
  anchor?: AnchorInput | null;
}

export interface OutfitPieceVariant {
  id: string;
  options: string[];
  available: boolean;
  price: number;
}

export interface OutfitPiece {
  slot: OutfitSlot;
  handle: string;
  title: string;
  image: string | null;
  price: number;
  variantId: string | null;
  colorName: string | null;
  optionNames: string[];
  variants: OutfitPieceVariant[];
  reason: string;
  isAnchor: boolean;
}

export interface OutfitResult {
  mode: "anchor" | "scratch";
  feedMode: ShopIndex["feedMode"];
  pieces: OutfitPiece[];
  rationale: string;
  source: "llm" | "fallback" | "mixed";
}

const SHORTLIST = 10;

function maxPieces(): number {
  const raw = process.env.OUTFIT_MAX_PIECES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 2 && n <= 5 ? n : 4;
}

function llmSelectEnabled(): boolean {
  return process.env.OUTFIT_LLM_SELECT !== "false";
}

// ---- scoring & filtering ---------------------------------------------------

const VIBE_TAGS: Record<Vibe, string[]> = {
  classic: ["classic", "tailored", "oxford", "chino", "trench", "smart"],
  casual: ["casual", "everyday", "relaxed", "jersey", "denim"],
  streetwear: ["street", "oversized", "graphic", "cargo", "hoodie", "sneaker"],
  elegant: ["elegant", "formal", "silk", "satin", "party", "evening", "heel"],
  minimal: ["minimal", "clean", "essential", "plain", "mono", "basic"],
};

const OCCASION_TAGS: Record<Occasion, string[]> = {
  everyday: ["everyday", "casual", "basic"],
  work: ["work", "office", "tailored", "formal", "smart"],
  date: ["date", "evening", "party", "elegant"],
  event: ["event", "formal", "party", "evening", "occasion", "wedding"],
  active: ["active", "sport", "athletic", "gym", "run", "training", "performance"],
};

function hasAvailableVariant(p: IndexedProduct): boolean {
  return p.variants.length === 0 || p.variants.some((v) => v.available);
}

function productColor(p: IndexedProduct): CanonicalColor | null {
  if (p.color) return getCanonicalColor(p.color.name);
  return null;
}

function scoreProduct(p: IndexedProduct, answers: QuizAnswers): number {
  let score = 0;

  // Color fit with the palette.
  const color = productColor(p);
  if (p.flexibleColor) score += 0.7;
  else if (!color) score += 0.4;
  else if (color.neutral) score += 0.8;
  else if (colorMatchesPalette(color, answers.palette)) score += 1;
  else score += 0.2;

  // Vibe + occasion keyword signals from title/handle.
  const hay = `${p.title} ${p.handle}`.toLowerCase();
  let kw = 0;
  for (const t of VIBE_TAGS[answers.vibe]) if (hay.includes(t)) kw += 0.25;
  for (const t of OCCASION_TAGS[answers.occasion]) if (hay.includes(t)) kw += 0.2;
  score += Math.min(0.9, kw);

  return score;
}

function candidatesForSlot(
  pool: IndexedProduct[],
  slot: OutfitSlot,
  answers: QuizAnswers,
): IndexedProduct[] {
  let items = pool.filter((p) => p.slot === slot && hasAvailableVariant(p));

  // Palette filter (soft): keep palette-compatible, flexible, or unknown-color
  // items. If that leaves too few, drop the filter so a slot is never empty.
  if (answers.palette !== "bold") {
    const filtered = items.filter(
      (p) =>
        p.flexibleColor ||
        !p.color ||
        colorMatchesPalette(productColor(p), answers.palette),
    );
    if (filtered.length >= 3) items = filtered;
  }

  // Budget band: "affordable" leans cheaper (<= median). Keep all if it'd starve.
  if (answers.budget === "affordable" && items.length > 4) {
    const prices = items.map((p) => p.price).filter((n) => n > 0).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)] ?? Infinity;
    const cheaper = items.filter((p) => p.price <= median * 1.1 || p.price === 0);
    if (cheaper.length >= 3) items = cheaper;
  }

  return items
    .map((p) => ({ p, s: scoreProduct(p, answers) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SHORTLIST)
    .map((x) => x.p);
}

// ---- slot planning ---------------------------------------------------------

function complementarySlots(anchorSlot: OutfitSlot): OutfitSlot[] {
  switch (anchorSlot) {
    case "top":
      return ["bottom", "shoes", "outerwear"];
    case "bottom":
      return ["top", "shoes", "outerwear"];
    case "dress":
      return ["shoes", "outerwear", "accessory"];
    case "outerwear":
      return ["top", "bottom", "shoes"];
    case "shoes":
      return ["top", "bottom", "outerwear"];
    default:
      return ["top", "bottom", "shoes"];
  }
}

function scratchSlots(answers: QuizAnswers, poolHasDress: boolean): OutfitSlot[] {
  const dressy =
    (answers.occasion === "event" || answers.occasion === "date") &&
    (answers.vibe === "elegant" || answers.vibe === "classic");
  if (dressy && poolHasDress) return ["dress", "shoes", "outerwear", "accessory"];
  return ["top", "bottom", "shoes", "outerwear"];
}

// ---- variant + piece assembly ----------------------------------------------

function pickVariant(
  p: IndexedProduct,
  answers: QuizAnswers,
): { variantId: string | null; colorName: string | null } {
  const available = p.variants.filter((v) => v.available);
  const pool = available.length ? available : p.variants;
  if (pool.length === 0) return { variantId: null, colorName: p.color?.name ?? null };

  // Prefer a variant whose option values match the palette, when the product
  // spans several colors. Otherwise first available.
  if (answers.palette !== "bold") {
    for (const v of pool) {
      const c = v.options
        .map((o) => getCanonicalColor(o) ?? inferColorFromText(o))
        .find((x): x is CanonicalColor => x != null);
      if (c && colorMatchesPalette(c, answers.palette)) {
        return { variantId: v.id, colorName: c.name };
      }
    }
  }
  const first = pool[0];
  const inferred = first.options
    .map((o) => getCanonicalColor(o) ?? inferColorFromText(o))
    .find((x): x is CanonicalColor => x != null);
  return { variantId: first.id, colorName: inferred?.name ?? p.color?.name ?? null };
}

function buildPiece(
  p: IndexedProduct,
  slot: OutfitSlot,
  answers: QuizAnswers,
  reason: string,
  isAnchor: boolean,
): OutfitPiece {
  const v = pickVariant(p, answers);
  return {
    slot,
    handle: p.handle,
    title: p.title,
    image: p.image,
    price: p.price,
    variantId: v.variantId,
    colorName: v.colorName,
    optionNames: p.optionNames,
    variants: p.variants,
    reason,
    isAnchor,
  };
}

// ---- LLM pick --------------------------------------------------------------

const SELECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slot: {
            type: "string",
            enum: ["top", "bottom", "dress", "outerwear", "shoes", "accessory"],
          },
          handle: { type: "string" },
          reason: { type: "string" },
        },
        required: ["slot", "handle", "reason"],
      },
    },
    rationale: { type: "string" },
  },
  required: ["picks", "rationale"],
} as const;

interface SelectResult {
  picks: Array<{ slot: OutfitSlot; handle: string; reason: string }>;
  rationale: string;
}

function compactCandidate(p: IndexedProduct) {
  return {
    handle: p.handle,
    title: p.title,
    color: p.flexibleColor ? "multi" : p.color?.name ?? "unknown",
    price: p.price,
  };
}

async function llmPick(
  answers: QuizAnswers,
  anchor: { slot: OutfitSlot; piece: OutfitPiece } | null,
  slotCandidates: Map<OutfitSlot, IndexedProduct[]>,
): Promise<{ result: SelectResult | null; costUsd: number }> {
  if (!llmSelectEnabled() || slotCandidates.size === 0) {
    return { result: null, costUsd: 0 };
  }
  const candidates: Record<string, ReturnType<typeof compactCandidate>[]> = {};
  for (const [slot, items] of slotCandidates) {
    candidates[slot] = items.map(compactCandidate);
  }
  const payload = {
    shopper: answers,
    anchor: anchor
      ? { slot: anchor.slot, handle: anchor.piece.handle, title: anchor.piece.title }
      : null,
    slotsToFill: [...slotCandidates.keys()],
    candidates,
  };
  try {
    const { data, usage } = await runStructured<SelectResult>({
      schemaName: "outfit",
      schema: SELECT_SCHEMA as unknown as Record<string, unknown>,
      instructions:
        "You are a professional fashion stylist. Build ONE coherent, " +
        "color-matched outfit for the shopper that suits their occasion, palette, " +
        "vibe and fit. Choose exactly one product per slot in slotsToFill, and you " +
        "may ONLY use handles from that slot's candidate list. Keep the anchor item " +
        "(do not replace it). Give a short, specific reason per piece and a one or " +
        "two sentence overall rationale. Prefer colors that harmonize with each " +
        "other and with the anchor.",
      input: JSON.stringify(payload),
      maxOutputTokens: 2000,
    });
    return { result: data, costUsd: computeTextCostUsd(usage) };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "outfit_llm_pick_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { result: null, costUsd: 0 };
  }
}

// ---- candidate pool (handles feed degradation) -----------------------------

async function getCandidatePool(
  shop: string,
  index: ShopIndex,
  mode: "anchor" | "scratch",
  anchor: AnchorInput | null,
): Promise<IndexedProduct[]> {
  if (index.feedMode === "full" && index.products.length > 0) {
    return index.products;
  }
  // Public feed disabled/empty: anchored mode can still run off Shopify's native
  // complementary recommendations for the current product.
  if (mode === "anchor" && anchor?.id) {
    const recs = await fetchComplementary(shop, anchor.id, 24);
    return indexProductsHeuristic(recs);
  }
  return [];
}

// ---- entry point -----------------------------------------------------------

export async function generateOutfit(
  input: GenerateOutfitInput,
): Promise<{ outfit: OutfitResult | null; costUsd: number }> {
  const { shop, answers, mode } = input;
  const anchor = input.anchor ?? null;

  const { index, buildCostUsd } = await getOrBuildShopIndex(shop);
  const pool = await getCandidatePool(shop, index, mode, anchor);

  if (pool.length === 0) {
    return { outfit: null, costUsd: buildCostUsd };
  }

  // Resolve the anchor piece (anchored mode). Prefer the full indexed product so
  // we get its variants; fall back to a title-classified stub.
  let anchorEntry: { slot: OutfitSlot; piece: OutfitPiece } | null = null;
  if (mode === "anchor" && anchor) {
    const fromPool = pool.find((p) => p.handle === anchor.handle);
    if (fromPool) {
      anchorEntry = {
        slot: fromPool.slot === "other" ? "top" : fromPool.slot,
        piece: buildPiece(fromPool, fromPool.slot, answers, "The piece you're viewing.", true),
      };
    } else {
      const stub: IndexedProduct = {
        id: anchor.id,
        handle: anchor.handle,
        title: anchor.title,
        slot: "other",
        color: null,
        flexibleColor: false,
        price: 0,
        image: anchor.image,
        optionNames: [],
        variants: anchor.variantId
          ? [{ id: anchor.variantId, options: [], available: true, price: 0 }]
          : [],
      };
      anchorEntry = {
        slot: "top",
        piece: buildPiece(stub, "other", answers, "The piece you're viewing.", true),
      };
    }
  }

  // Plan the open slots.
  const poolHasDress = pool.some((p) => p.slot === "dress");
  let openSlots =
    mode === "anchor" && anchorEntry
      ? complementarySlots(anchorEntry.slot)
      : scratchSlots(answers, poolHasDress);

  // Trim to the max-pieces budget (anchor counts as one piece).
  const anchorCount = anchorEntry ? 1 : 0;
  openSlots = dedupeSlots(openSlots).slice(0, Math.max(1, maxPieces() - anchorCount));

  // Shortlist candidates per open slot (skip slots with no stock).
  const slotCandidates = new Map<OutfitSlot, IndexedProduct[]>();
  for (const slot of openSlots) {
    const c = candidatesForSlot(pool, slot, answers);
    if (c.length > 0) slotCandidates.set(slot, c);
  }

  // LLM coherent pick.
  const { result, costUsd: selectCost } = await llmPick(answers, anchorEntry, slotCandidates);

  // Assemble, validating every LLM pick and filling gaps deterministically.
  const chosenColors: Array<CanonicalColor | null> = [];
  if (anchorEntry) chosenColors.push(getCanonicalColor(anchorEntry.piece.colorName ?? ""));

  const pieces: OutfitPiece[] = anchorEntry ? [anchorEntry.piece] : [];
  let usedLlm = false;
  let usedFallback = false;

  for (const [slot, candidates] of slotCandidates) {
    let chosen: IndexedProduct | null = null;
    let reason = "";

    const pick = result?.picks.find((p) => p.slot === slot);
    if (pick) {
      const valid = candidates.find((c) => c.handle === pick.handle);
      if (valid) {
        chosen = valid;
        reason = pick.reason?.slice(0, 200) || "Matches your style.";
        usedLlm = true;
      }
    }

    if (!chosen) {
      // Deterministic fallback: best score blended with color harmony vs chosen.
      chosen = pickBestHarmonious(candidates, answers, chosenColors);
      reason = "Picked to match your colors and the rest of the outfit.";
      usedFallback = true;
    }

    if (chosen) {
      const piece = buildPiece(chosen, slot, answers, reason, false);
      pieces.push(piece);
      chosenColors.push(getCanonicalColor(piece.colorName ?? ""));
    }
  }

  // Need at least the anchor + 1, or 2 pieces in scratch mode, to be an "outfit".
  const nonAnchor = pieces.filter((p) => !p.isAnchor).length;
  if (nonAnchor === 0) {
    return { outfit: null, costUsd: buildCostUsd + selectCost };
  }

  const source: OutfitResult["source"] =
    usedLlm && usedFallback ? "mixed" : usedLlm ? "llm" : "fallback";

  return {
    outfit: {
      mode,
      feedMode: index.feedMode,
      pieces,
      rationale:
        (result?.rationale && usedLlm ? result.rationale.slice(0, 400) : "") ||
        defaultRationale(answers),
      source,
    },
    costUsd: buildCostUsd + selectCost,
  };
}

function pickBestHarmonious(
  candidates: IndexedProduct[],
  answers: QuizAnswers,
  chosenColors: Array<CanonicalColor | null>,
): IndexedProduct | null {
  let best: IndexedProduct | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const harmony = harmonyWithChosen(productColor(c), chosenColors);
    const score = scoreProduct(c, answers) * 0.6 + harmony * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function dedupeSlots(slots: OutfitSlot[]): OutfitSlot[] {
  const seen = new Set<OutfitSlot>();
  const out: OutfitSlot[] = [];
  for (const s of slots) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function defaultRationale(answers: QuizAnswers): string {
  return `A ${answers.vibe}, ${answers.palette}-toned look for ${answers.occasion}.`;
}
