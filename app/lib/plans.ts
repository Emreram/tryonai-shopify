export type PlanKey = "trial" | "starter" | "growth" | "scale";

export interface PlanDefinition {
  price: number;
  included: number;
  overage: number | null;
  commission: number;
  capMultiplier: number;
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  trial:   { price: 0,   included: 30,   overage: null, commission: 0,     capMultiplier: 1   },
  starter: { price: 49,  included: 300,  overage: 0.18, commission: 0.015, capMultiplier: 1.5 },
  growth:  { price: 129, included: 1200, overage: 0.15, commission: 0.015, capMultiplier: 1.5 },
  scale:   { price: 349, included: 3000, overage: 0.15, commission: 0.015, capMultiplier: 1.5 },
};

export const PLAN_KEYS: PlanKey[] = ["trial", "starter", "growth", "scale"];
export const PAID_PLAN_KEYS: PlanKey[] = ["starter", "growth", "scale"];

export const TRIAL_DAYS = 14;
export const TRIAL_TRYONS = 30;
export const COMMISSION_GRACE_DAYS = 30;

export const PLAN_DISPLAY: Record<PlanKey, string> = {
  trial: "Trial",
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
};

export const PLAN_LINE_ITEM_TAGS = {
  recurring: "subscription",
  overage: "try-on overage",
  commission: "attributed-order commission",
} as const;

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && value in PLANS;
}

export function planFromName(name: string | null | undefined): PlanKey {
  if (!name) return "trial";
  const norm = name.toLowerCase().trim();
  for (const key of PLAN_KEYS) {
    if (norm.includes(key)) return key;
  }
  return "trial";
}

export function computeCap(plan: PlanKey, override: number | null | undefined): number {
  if (typeof override === "number" && override > 0) return override;
  const def = PLANS[plan];
  return Math.round(def.included * def.capMultiplier);
}

export function requestId(): string {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

export const PLAN_DISCLOSURE_COPY = {
  noCommissionGrace: "No commission is charged in the first 30 days of any paid plan.",
  attributedOnly:
    "Commission only applies to orders attributed to a try-on. We never charge on the try-on itself.",
  selfEnforcedCap:
    "Try-ons over your included allowance are billed at the per-try-on overage rate, up to a hard cap at 150% of included. Requests above the cap are blocked to prevent runaway charges.",
};
