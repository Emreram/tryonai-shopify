// Records a tool-driven add-to-cart, reported by the storefront widget's signed
// app-proxy beacon after /cart/add.js succeeds. The write is gated on a matching
// UsageLog row (same shop + a successful/served try-on with this requestId): this
// both prevents arbitrary inflation of the owner's numbers and gives us the
// try-on's billing cycle + plan for free. Idempotent on (shop, requestId), so a
// result added to cart twice is counted once.

import db from "../db.server";

export interface CartEventInput {
  shop: string;
  requestId: string;
  productHandle: string | null;
  variantId: string | null;
  quantity: number;
  unitPrice: number | null; // shop-currency major units
  lineValue: number | null; // shop-currency major units
  currency: string | null;
}

export type RecordResult =
  | { status: "recorded" }
  | { status: "duplicate" } // already counted (idempotent re-beacon)
  | { status: "unverified" }; // no matching try-on — refused, not counted

export async function recordCartEvent(
  input: CartEventInput,
): Promise<RecordResult> {
  // Integrity gate: the cart-add must reference a real try-on for THIS shop that
  // was actually served (status "ok" = generated, "cache_hit" = re-served). This
  // is the anti-inflation check — requestIds are unguessable, so a third party
  // can't fabricate cart-adds for someone else's shop. It also yields the
  // try-on's cycleStart + plan so the dashboard can bucket by billing cycle.
  const tryOn = await db.usageLog.findUnique({
    where: { requestId: input.requestId },
    select: { shop: true, status: true, cycleStart: true, plan: true },
  });

  if (
    !tryOn ||
    tryOn.shop !== input.shop ||
    !(tryOn.status === "ok" || tryOn.status === "cache_hit")
  ) {
    return { status: "unverified" };
  }

  // The unique key is (shop, requestId, variantId) so each piece of an outfit
  // (which shares one requestId) counts once. Postgres treats NULLs as distinct,
  // so a null variantId can't rely on the constraint — guard it explicitly.
  if (input.variantId === null) {
    const existing = await db.cartEvent.findFirst({
      where: { shop: input.shop, requestId: input.requestId, variantId: null },
      select: { id: true },
    });
    if (existing) return { status: "duplicate" };
  }

  try {
    await db.cartEvent.create({
      data: {
        shop: input.shop,
        requestId: input.requestId,
        plan: tryOn.plan,
        productHandle: input.productHandle,
        variantId: input.variantId,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        lineValue: input.lineValue,
        currency: input.currency,
        cycleStart: tryOn.cycleStart,
      },
    });
    return { status: "recorded" };
  } catch (err) {
    // Unique violation on (shop, requestId) => the shopper added the same try-on
    // result to cart more than once. That's a no-op: count it once.
    if (isUniqueViolation(err)) return { status: "duplicate" };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  // Prisma P2002 = unique constraint failed. Avoid importing Prisma error
  // classes here; duck-type the code field instead.
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
