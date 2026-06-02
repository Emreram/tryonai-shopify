// Deterministic color reasoning for the AI Outfit Stylist.
//
// This module is the GUARANTEE that an assembled outfit is color-coherent even
// when the LLM is unavailable or returns junk: the selection engine always has a
// rules-based stylist underneath it (see outfit.server.ts). It is intentionally
// pure (no I/O, no deps) and conservative — it errs toward neutral-anchored,
// same-family combinations that look intentional, never random.

export type ColorFamily = "warm" | "cool" | "neutral";

/** The shopper's "Palette" quiz answer. */
export type PaletteAnswer = "warm" | "cool" | "neutral" | "bold";

export interface CanonicalColor {
  /** Canonical name, e.g. "navy". */
  name: string;
  family: ColorFamily;
  /** Neutrals pair with anything (black, white, denim, etc.). */
  neutral: boolean;
}

// The canonical palette the rest of the engine reasons over. Keep names lowercase.
const COLORS: Record<string, CanonicalColor> = {
  black: { name: "black", family: "neutral", neutral: true },
  white: { name: "white", family: "neutral", neutral: true },
  gray: { name: "gray", family: "neutral", neutral: true },
  charcoal: { name: "charcoal", family: "neutral", neutral: true },
  silver: { name: "silver", family: "neutral", neutral: true },
  beige: { name: "beige", family: "neutral", neutral: true },
  cream: { name: "cream", family: "neutral", neutral: true },
  ivory: { name: "ivory", family: "neutral", neutral: true },
  tan: { name: "tan", family: "neutral", neutral: true },
  khaki: { name: "khaki", family: "neutral", neutral: true },
  brown: { name: "brown", family: "neutral", neutral: true },
  taupe: { name: "taupe", family: "neutral", neutral: true },
  navy: { name: "navy", family: "neutral", neutral: true },
  denim: { name: "denim", family: "neutral", neutral: true },

  red: { name: "red", family: "warm", neutral: false },
  burgundy: { name: "burgundy", family: "warm", neutral: false },
  maroon: { name: "maroon", family: "warm", neutral: false },
  orange: { name: "orange", family: "warm", neutral: false },
  rust: { name: "rust", family: "warm", neutral: false },
  terracotta: { name: "terracotta", family: "warm", neutral: false },
  coral: { name: "coral", family: "warm", neutral: false },
  peach: { name: "peach", family: "warm", neutral: false },
  yellow: { name: "yellow", family: "warm", neutral: false },
  mustard: { name: "mustard", family: "warm", neutral: false },
  gold: { name: "gold", family: "warm", neutral: false },
  pink: { name: "pink", family: "warm", neutral: false },

  blue: { name: "blue", family: "cool", neutral: false },
  teal: { name: "teal", family: "cool", neutral: false },
  turquoise: { name: "turquoise", family: "cool", neutral: false },
  green: { name: "green", family: "cool", neutral: false },
  olive: { name: "olive", family: "cool", neutral: false },
  mint: { name: "mint", family: "cool", neutral: false },
  purple: { name: "purple", family: "cool", neutral: false },
  lavender: { name: "lavender", family: "cool", neutral: false },
  indigo: { name: "indigo", family: "cool", neutral: false },
};

// Synonyms / multi-word forms mapped to a canonical color. Ordered longest-first
// at match time so "navy blue" wins over "blue", "olive green" over "green".
const SYNONYMS: Record<string, string> = {
  "navy blue": "navy",
  "midnight blue": "navy",
  "olive green": "olive",
  "army green": "olive",
  "forest green": "green",
  "hot pink": "pink",
  "blush": "pink",
  "rose": "pink",
  "wine": "burgundy",
  "camel": "tan",
  "sand": "beige",
  "stone": "beige",
  "off white": "cream",
  "offwhite": "cream",
  "ecru": "cream",
  "grey": "gray",
  "slate": "gray",
  "graphite": "charcoal",
  "chocolate": "brown",
  "mocha": "brown",
  "espresso": "brown",
  "cobalt": "blue",
  "sky blue": "blue",
  "baby blue": "blue",
  "emerald": "green",
  "sage": "olive",
  "lilac": "lavender",
  "violet": "purple",
  "plum": "purple",
  "magenta": "pink",
  "fuchsia": "pink",
  "salmon": "coral",
  "apricot": "peach",
  "lemon": "yellow",
  "amber": "gold",
  "scarlet": "red",
  "crimson": "red",
};

// All matchable phrases, longest first so the most specific wins.
const MATCH_PHRASES: string[] = [
  ...Object.keys(SYNONYMS),
  ...Object.keys(COLORS),
].sort((a, b) => b.length - a.length);

export function getCanonicalColor(name: string | null | undefined): CanonicalColor | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (COLORS[key]) return COLORS[key];
  const syn = SYNONYMS[key];
  if (syn && COLORS[syn]) return COLORS[syn];
  return null;
}

/**
 * Infer a color from free text (a product title, tag, or variant option value).
 * Returns the most specific match found, or null. Uses word-ish boundaries so
 * "redux" doesn't match "red".
 */
export function inferColorFromText(text: string | null | undefined): CanonicalColor | null {
  if (!text) return null;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z\s]+/g, " ").replace(/\s+/g, " ")} `;
  for (const phrase of MATCH_PHRASES) {
    if (haystack.includes(` ${phrase} `)) {
      const canonicalName = SYNONYMS[phrase] ?? phrase;
      const color = COLORS[canonicalName];
      if (color) return color;
    }
  }
  return null;
}

export function colorFamily(color: CanonicalColor): ColorFamily {
  return color.family;
}

/** Families the shopper's palette answer prefers (used as a soft filter). */
export function palettePreferredFamilies(palette: PaletteAnswer): ColorFamily[] {
  switch (palette) {
    case "warm":
      return ["warm", "neutral"];
    case "cool":
      return ["cool", "neutral"];
    case "neutral":
      return ["neutral"];
    case "bold":
      // Bold & bright: saturated colors, neutrals still allowed as grounding.
      return ["warm", "cool", "neutral"];
    default:
      return ["warm", "cool", "neutral"];
  }
}

/** Whether a color is acceptable for the shopper's palette answer. */
export function colorMatchesPalette(
  color: CanonicalColor | null,
  palette: PaletteAnswer,
): boolean {
  if (!color) return true; // unknown color → don't exclude on color grounds
  if (palette === "bold") return !color.neutral || color.family === "neutral";
  return palettePreferredFamilies(palette).includes(color.family);
}

// Predefined complementary pairs that read as intentional rather than clashing.
const COMPLEMENTARY: Array<[string, string]> = [
  ["navy", "rust"],
  ["navy", "coral"],
  ["olive", "rust"],
  ["olive", "burgundy"],
  ["blue", "orange"],
  ["burgundy", "green"],
  ["teal", "coral"],
  ["purple", "gold"],
];

function isComplementary(a: CanonicalColor, b: CanonicalColor): boolean {
  return COMPLEMENTARY.some(
    ([x, y]) => (a.name === x && b.name === y) || (a.name === y && b.name === x),
  );
}

/**
 * Pairwise harmony in [0,1]. Neutrals pair with anything; same color or same
 * family reads as intentional; known complementary pairs are good; two unrelated
 * saturated colors from different families clash.
 */
export function pairHarmony(a: CanonicalColor | null, b: CanonicalColor | null): number {
  if (!a || !b) return 0.6; // unknown → neutral-ish, don't over-penalize
  if (a.neutral || b.neutral) return 1;
  if (a.name === b.name) return 0.9;
  if (a.family === b.family) return 0.8;
  if (isComplementary(a, b)) return 0.72;
  return 0.3;
}

/**
 * Overall color coherence of an outfit in [0,1]: the mean of all pairwise
 * harmonies. An outfit of all-neutrals or neutral-anchored accents scores high;
 * a pile of clashing saturated colors scores low.
 */
export function outfitHarmony(colors: Array<CanonicalColor | null>): number {
  const known = colors.filter((c): c is CanonicalColor => c != null);
  if (known.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      sum += pairHarmony(known[i], known[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

/**
 * How well a candidate color extends an outfit-in-progress (the colors already
 * chosen). Used by the deterministic fallback to pick the next coherent piece.
 */
export function harmonyWithChosen(
  candidate: CanonicalColor | null,
  chosen: Array<CanonicalColor | null>,
): number {
  const known = chosen.filter((c): c is CanonicalColor => c != null);
  if (!candidate || known.length === 0) return 0.8;
  return known.reduce((acc, c) => acc + pairHarmony(candidate, c), 0) / known.length;
}
