-- CreateTable: tool-driven add-to-cart attribution. One row per try-on result a
-- shopper added to cart from the widget, written by a signed app-proxy beacon
-- only when a matching UsageLog row exists (prevents inflation). No customer PII.
CREATE TABLE "CartEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "productHandle" TEXT,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION,
    "lineValue" DOUBLE PRECISION,
    "currency" TEXT,
    "cycleStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotency — a result added to cart twice counts once.
CREATE UNIQUE INDEX "CartEvent_shop_requestId_key" ON "CartEvent"("shop", "requestId");

-- CreateIndex
CREATE INDEX "CartEvent_shop_createdAt_idx" ON "CartEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "CartEvent_createdAt_idx" ON "CartEvent"("createdAt");
