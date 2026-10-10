ALTER TABLE "SiteSettings"
  ADD COLUMN "homeHeroProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "homeHeroIntervalSeconds" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "SiteSettings"
  ADD CONSTRAINT "SiteSettings_homeHeroProductIds_count_check" CHECK (cardinality("homeHeroProductIds") <= 10),
  ADD CONSTRAINT "SiteSettings_homeHeroIntervalSeconds_range_check" CHECK ("homeHeroIntervalSeconds" BETWEEN 5 AND 120);
