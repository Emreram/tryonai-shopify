-- AI Size Recommender: per-shop kill switch (ships dark, mirrors outfitEnabled).
ALTER TABLE "MerchantSettings" ADD COLUMN "sizeEnabled" BOOLEAN NOT NULL DEFAULT false;
