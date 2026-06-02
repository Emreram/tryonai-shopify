// Backend gate for the AI Outfit Stylist. Ships dark: OUTFIT_FEATURE_ENABLED is
// the master switch (default off). When on, a shop is served only if it is
// explicitly enabled (MerchantSettings.outfitEnabled) OR OUTFIT_FEATURE_ALL_SHOPS
// is set for a global rollout. The storefront button additionally requires the
// merchant to turn on the theme block setting, so this is the second of three
// independent gates.

export interface OutfitFlagSettings {
  outfitEnabled?: boolean | null;
  sizeEnabled?: boolean | null;
}

export function outfitBackendEnabled(
  settings: OutfitFlagSettings | null | undefined,
): boolean {
  if (process.env.OUTFIT_FEATURE_ENABLED !== "true") return false;
  if (process.env.OUTFIT_FEATURE_ALL_SHOPS === "true") return true;
  return settings?.outfitEnabled === true;
}

// Same gating shape for the Size Recommender (independent master switch).
export function sizeBackendEnabled(
  settings: OutfitFlagSettings | null | undefined,
): boolean {
  if (process.env.SIZE_FEATURE_ENABLED !== "true") return false;
  if (process.env.SIZE_FEATURE_ALL_SHOPS === "true") return true;
  return settings?.sizeEnabled === true;
}
