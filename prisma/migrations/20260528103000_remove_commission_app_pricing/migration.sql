-- Remove order-attributed commission billing and prepare for Shopify App Pricing events.
ALTER TABLE "Shop" ADD COLUMN "shopGid" TEXT;
CREATE UNIQUE INDEX "Shop_shopGid_key" ON "Shop"("shopGid");

ALTER TABLE "MerchantSettings"
  DROP COLUMN "pendingCredit",
  DROP COLUMN "commissionRate";

ALTER TABLE "BillingState"
  DROP COLUMN "overageLineItemId",
  DROP COLUMN "commissionLineItemId",
  DROP COLUMN "currentCycleCommission";

ALTER TABLE "UsageLog"
  ADD COLUMN "billingEventId" TEXT,
  ADD COLUMN "billingEventStatus" TEXT,
  ADD COLUMN "billingEventError" TEXT,
  DROP COLUMN "overageChargeId",
  DROP COLUMN "overageUsd";

DROP TABLE "AttributedOrder";
