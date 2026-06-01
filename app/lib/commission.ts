// Commission rate applied to tool-attributed cart value to produce the
// "estimated commission income" figure on the owner dashboard (/metrics).
//
// This is deliberately a WHAT-IF number: the base is tool-driven add-to-carts,
// which overstate real revenue because carts get abandoned. So the default rate
// is set conservatively relative to fashion-affiliate norms (which apply to
// CONFIRMED sales, not cart-adds). The figure is labeled "estimated" everywhere
// it is shown. See app/lib/ownerMetrics.server.ts for how it is applied.
//
// Override at runtime (no redeploy) by setting TRYON_COMMISSION_PCT in the
// environment to a percentage, e.g. "8" for 8%. Values outside [0, 100] are
// ignored and the default below is used.

// Default commission percentage, chosen from market research.
//
// Why 5%: fashion/apparel affiliate programs pay ~8–15%, but ONLY on CONFIRMED
// sales that survive the return window. Our base is cart-adds, and ~70% of carts
// are abandoned, so a raw cart-add is worth roughly 30% of a completed sale —
// mapping a ~10% affiliate rate onto gross cart-add value lands near ~3%. Live
// performance-priced ecommerce conversion tools cluster at ~0.75–5% of
// attributed revenue. 5% sits at the top of that band and the bottom of the
// affiliate band: a round, conservative, defensible "what-if" figure for a
// cart-add base. Raise it only if the base ever becomes confirmed paid orders.
// Tunable at runtime via TRYON_COMMISSION_PCT.
export const DEFAULT_COMMISSION_PCT = 5;

/** Resolved commission as a PERCENTAGE (e.g. 8 means 8%). */
export function commissionPct(): number {
  const raw = process.env.TRYON_COMMISSION_PCT;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return DEFAULT_COMMISSION_PCT;
}

/** Resolved commission as a FRACTION (e.g. 0.08). */
export function commissionRate(): number {
  return commissionPct() / 100;
}

/** Estimated commission income for a given attributed cart value. */
export function estimateCommission(attributedValue: number): number {
  return attributedValue * commissionRate();
}
