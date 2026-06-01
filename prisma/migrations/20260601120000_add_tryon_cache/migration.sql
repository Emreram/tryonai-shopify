-- AlterTable: per-shop opt-out for the try-on result cache (default on)
ALTER TABLE "MerchantSettings" ADD COLUMN "cacheEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable: index for the try-on result cache. Image bytes live in Supabase
-- Storage (private bucket); this table holds only the key + pointer + TTL.
CREATE TABLE "TryOnCache" (
    "cacheKey" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "promptVer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TryOnCache_pkey" PRIMARY KEY ("cacheKey")
);

-- CreateIndex
CREATE INDEX "TryOnCache_shop_idx" ON "TryOnCache"("shop");

-- CreateIndex
CREATE INDEX "TryOnCache_expiresAt_idx" ON "TryOnCache"("expiresAt");
