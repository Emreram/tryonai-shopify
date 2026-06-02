-- AI Outfit Stylist support.

-- UsageLog.kind: distinguishes image generations ("tryon", counts toward the
-- merchant cap) from cheap gpt-5.4-mini outfit-selection calls ("outfit", logged
-- for COGS + cart attribution but EXCLUDED from the cap). Existing rows backfill
-- to 'tryon' via the default.
ALTER TABLE "UsageLog" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'tryon';

-- Keeps the kind-filtered cap/trial counts fast.
CREATE INDEX "UsageLog_shop_kind_status_cycleStart_idx" ON "UsageLog"("shop", "kind", "status", "cycleStart");

-- MerchantSettings.outfitEnabled: per-shop kill switch for the stylist (ships dark).
ALTER TABLE "MerchantSettings" ADD COLUMN "outfitEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CartEvent uniqueness now includes variantId so one outfit (a single requestId
-- shared across its pieces) records one row PER PIECE, still idempotent per piece.
DROP INDEX "CartEvent_shop_requestId_key";
CREATE UNIQUE INDEX "CartEvent_shop_requestId_variantId_key" ON "CartEvent"("shop", "requestId", "variantId");

-- ShopCatalog: per-shop normalized product index built from PUBLIC storefront data
-- (no Admin API scope). One row per shop, TTL'd via expiresAt. No customer data.
CREATE TABLE "ShopCatalog" (
    "shop" TEXT NOT NULL,
    "feedMode" TEXT NOT NULL DEFAULT 'full',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopCatalog_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE INDEX "ShopCatalog_expiresAt_idx" ON "ShopCatalog"("expiresAt");
