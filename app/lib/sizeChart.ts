// Deterministic sizing math for the Size Recommender.
//
// This is the error-proof FLOOR beneath the AI: it always returns *something*
// usable from a shopper's biometrics and a product's real, in-stock size labels,
// so the feature degrades gracefully and never throws. The AI (size.server.ts)
// produces the primary clothing recommendation; this module:
//   - converts shoe sizes US/EU/UK (deterministic, reliable),
//   - estimates a clothing band from biometrics (fallback only),
//   - maps any target label to the nearest IN-STOCK candidate,
//   - extracts a size chart / fit notes from a product description.
// Pure, no I/O, no deps.

export type Gender = "mens" | "womens" | "unisex";
export type Build = "slim" | "average" | "broad";
export type FitPref = "fitted" | "relaxed" | "oversized";
export type ShoeSystem = "US" | "EU" | "UK";

export interface Biometrics {
  heightCm: number;
  weightKg: number;
  build: Build;
  gender: Gender;
  fit?: FitPref;
  shoeSizeRaw?: number;
  shoeSystem?: ShoeSystem;
}

export interface SizeCandidate {
  label: string;
  available: boolean;
}

export const ALPHA_SCALE = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"] as const;

// ---- input hygiene ---------------------------------------------------------

export function clampBiometrics(b: Biometrics): Biometrics {
  const clamp = (n: number, lo: number, hi: number, dflt: number) =>
    Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  return {
    ...b,
    heightCm: clamp(b.heightCm, 120, 230, 170),
    weightKg: clamp(b.weightKg, 30, 250, 70),
    build: b.build === "slim" || b.build === "broad" ? b.build : "average",
    gender:
      b.gender === "mens" || b.gender === "womens" ? b.gender : "unisex",
    shoeSizeRaw:
      typeof b.shoeSizeRaw === "number" && b.shoeSizeRaw > 0 && b.shoeSizeRaw < 60
        ? b.shoeSizeRaw
        : undefined,
  };
}

// ---- clothing band estimate (fallback) -------------------------------------

// Weight-driven alpha bands at average height, per gender. Approximate by design
// — this is the fallback when the AI / size chart can't decide. Index into
// ALPHA_SCALE.
function baseBandIndex(b: Biometrics): number {
  const w = b.weightKg;
  const womens = b.gender === "womens";
  const thresholds = womens
    ? [52, 60, 70, 82, 95, 108] // XS|S|M|L|XL|XXL boundaries (womens)
    : [60, 68, 80, 92, 104, 116]; // mens / unisex
  let idx = 0;
  for (const t of thresholds) {
    if (w >= t) idx++;
    else break;
  }
  return idx; // 0..6
}

/** Estimate an alpha clothing size purely from biometrics. Always returns a label. */
export function estimateClothingLabel(bio: Biometrics): string {
  const b = clampBiometrics(bio);
  let idx = baseBandIndex(b);
  if (b.build === "slim") idx -= 1;
  if (b.build === "broad") idx += 1;
  if (b.fit === "oversized") idx += 1;
  if (b.fit === "fitted") idx -= 1;
  // Tall + heavier leans up a touch for length/coverage.
  if (b.heightCm >= 190 && b.weightKg >= 85) idx += 1;
  idx = Math.max(0, Math.min(ALPHA_SCALE.length - 1, idx));
  return ALPHA_SCALE[idx];
}

// ---- shoe conversion -------------------------------------------------------

// Common men's shoe sizes (rows aligned): US, UK, EU.
const SHOE_MEN: Array<[us: number, uk: number, eu: number]> = [
  [6, 5.5, 39], [6.5, 6, 39], [7, 6.5, 40], [7.5, 7, 40.5], [8, 7.5, 41],
  [8.5, 8, 41.5], [9, 8.5, 42], [9.5, 9, 42.5], [10, 9.5, 43], [10.5, 10, 43.5],
  [11, 10.5, 44], [11.5, 11, 44.5], [12, 11.5, 45], [13, 12.5, 46], [14, 13.5, 47],
];
const SHOE_WOMEN: Array<[us: number, uk: number, eu: number]> = [
  [5, 3, 35], [5.5, 3.5, 35.5], [6, 4, 36], [6.5, 4.5, 37], [7, 5, 37.5],
  [7.5, 5.5, 38], [8, 6, 38.5], [8.5, 6.5, 39], [9, 7, 40], [9.5, 7.5, 40.5],
  [10, 8, 41], [11, 9, 42],
];

function shoeTable(gender: Gender) {
  return gender === "womens" ? SHOE_WOMEN : SHOE_MEN;
}

function colFor(system: ShoeSystem): 0 | 1 | 2 {
  return system === "US" ? 0 : system === "UK" ? 1 : 2;
}

/** Convert a shoe size between systems for a gender. Returns null if unmappable. */
export function convertShoe(
  size: number,
  from: ShoeSystem,
  to: ShoeSystem,
  gender: Gender,
): number | null {
  if (!Number.isFinite(size)) return null;
  if (from === to) return size;
  const table = shoeTable(gender);
  const fc = colFor(from);
  const tc = colFor(to);
  // Nearest row by the source column, then read the target column.
  let best: (typeof table)[number] | null = null;
  let bestD = Infinity;
  for (const row of table) {
    const d = Math.abs(row[fc] - size);
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  if (!best || bestD > 1.5) return null; // too far from any known row
  return best[tc];
}

// ---- label scales + nearest-available --------------------------------------

const ALPHA_NORMAL: Record<string, string> = {
  xxs: "XS", "xx-small": "XS", "extra extra small": "XS",
  xs: "XS", "x-small": "XS", "extra small": "XS",
  s: "S", sm: "S", small: "S",
  m: "M", med: "M", medium: "M",
  l: "L", lg: "L", large: "L",
  xl: "XL", "x-large": "XL", "extra large": "XL",
  xxl: "XXL", "2xl": "XXL", "xx-large": "XXL",
  xxxl: "XXXL", "3xl": "XXXL", "xxx-large": "XXXL",
};

function normalizeAlpha(label: string): string | null {
  const k = label.trim().toLowerCase().replace(/\s+/g, " ");
  if (ALPHA_NORMAL[k]) return ALPHA_NORMAL[k];
  const compact = k.replace(/[\s-]/g, "");
  if (ALPHA_NORMAL[compact]) return ALPHA_NORMAL[compact];
  return null;
}

function parseNumeric(label: string): number | null {
  const m = label.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

type Scale =
  | { type: "alpha"; pos: (label: string) => number | null }
  | { type: "numeric"; pos: (label: string) => number | null }
  | { type: "unknown"; pos: () => null };

/** Decide whether a set of labels is an alpha (S/M/L) or numeric scale. */
export function detectScale(labels: string[]): Scale {
  const alphaHits = labels.filter((l) => normalizeAlpha(l) != null).length;
  const numHits = labels.filter((l) => parseNumeric(l) != null).length;
  if (alphaHits >= numHits && alphaHits > 0) {
    return {
      type: "alpha",
      pos: (l) => {
        const a = normalizeAlpha(l);
        return a ? ALPHA_SCALE.indexOf(a as (typeof ALPHA_SCALE)[number]) : null;
      },
    };
  }
  if (numHits > 0) {
    return { type: "numeric", pos: (l) => parseNumeric(l) };
  }
  return { type: "unknown", pos: () => null };
}

export interface NearestResult {
  label: string;
  substituted: boolean;
}

/**
 * Map a target size label to the nearest IN-STOCK candidate. Exact in-stock match
 * → that label (substituted=false). Otherwise the closest available label
 * (substituted=true); ties resolve UP for clothing. Returns null only when NO
 * candidate is available (the genuine out-of-stock case).
 */
export function nearestAvailable(
  target: string,
  candidates: SizeCandidate[],
  opts: { preferUp?: boolean } = {},
): NearestResult | null {
  const available = candidates.filter((c) => c.available);
  if (available.length === 0) return null;

  const scale = detectScale(candidates.map((c) => c.label));
  const targetPos = scale.type === "unknown" ? null : scale.pos(target);

  // Exact (case-insensitive) in-stock match first.
  const exact = available.find(
    (c) => c.label.trim().toLowerCase() === target.trim().toLowerCase(),
  );
  if (exact) return { label: exact.label, substituted: false };

  if (targetPos == null) {
    // Can't place the target on the scale → first available, flagged substituted.
    return { label: available[0].label, substituted: true };
  }

  const preferUp = opts.preferUp !== false;
  let best: SizeCandidate | null = null;
  let bestD = Infinity;
  let bestPos = 0;
  for (const c of available) {
    const p = scale.pos(c.label);
    if (p == null) continue;
    const d = Math.abs(p - targetPos);
    if (d < bestD || (d === bestD && preferUp && p > bestPos)) {
      bestD = d;
      best = c;
      bestPos = p;
    }
  }
  if (!best) return { label: available[0].label, substituted: true };
  return { label: best.label, substituted: true };
}

/** Recommend a shoe label from biometrics, matched to in-stock candidates. */
export function recommendShoe(
  bio: Biometrics,
  candidates: SizeCandidate[],
): NearestResult | null {
  const b = clampBiometrics(bio);
  if (b.shoeSizeRaw == null) return null;
  const labels = candidates.map((c) => c.label);
  // Detect the candidates' system: EU shoe numbers cluster 35-50.
  const nums = labels.map(parseNumeric).filter((n): n is number => n != null);
  const maxNum = nums.length ? Math.max(...nums) : 0;
  const candSystem: ShoeSystem =
    maxNum >= 35 ? "EU" : "US"; // UK/US overlap; default US for small numbers
  const from = b.shoeSystem ?? "US";
  const converted =
    candSystem === from ? b.shoeSizeRaw : convertShoe(b.shoeSizeRaw, from, candSystem, b.gender);
  if (converted == null) return null;
  return nearestAvailable(String(converted), candidates, { preferUp: false });
}

// ---- size-chart extraction from a product description ----------------------

const CHART_KEYWORDS =
  /(size\s*(chart|guide)|size\s*&?\s*fit|measurements?|\bchest\b|\bbust\b|\bwaist\b|\bhips?\b|\binseam\b|\bsleeve\b|true to size|runs (small|large)|fits? (small|large|true)|model (is|wears)|size up|size down|\bcm\b|\binches\b|\bin\.|\b")/i;

/**
 * Pull a size chart / fit notes out of a product description (HTML). Returns a
 * compact plain-text snippet for the model, or null if nothing sizing-relevant
 * is found. Never reveals to the shopper whether this returned content.
 */
export function extractSizeChart(html: string | null | undefined): string | null {
  if (!html || typeof html !== "string") return null;
  // Keep table structure as " | " separated text so a chart stays legible.
  const text = html
    .replace(/<\s*(td|th)[^>]*>/gi, " | ")
    .replace(/<\s*tr[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!CHART_KEYWORDS.test(text)) return null;
  const first = text.search(CHART_KEYWORDS);
  const start = Math.max(0, first - 120);
  return text.slice(start, start + 1200).trim();
}

/** Whether a size option / its labels look like footwear sizes. */
export function isShoeSizeOption(optionName: string, labels: string[]): boolean {
  if (/shoe|foot|sneaker|boot/i.test(optionName)) return true;
  const nums = labels.map(parseNumeric).filter((n): n is number => n != null);
  if (nums.length < 2) return false;
  // Mostly numeric in the footwear range and NOT alpha sizes.
  const alpha = labels.filter((l) => normalizeAlpha(l) != null).length;
  const inShoeRange = nums.filter((n) => n >= 3 && n <= 50).length;
  return alpha === 0 && inShoeRange >= Math.ceil(labels.length * 0.6);
}
