-- Additive only: price history remains independent of historical sales records.
ALTER TABLE "Product" ADD COLUMN "pricingVersion" INTEGER NOT NULL DEFAULT 0;

-- No foreign keys: audit snapshots and idempotent retry records survive deletion.
CREATE TABLE "ProductPriceChange" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "includeSalePrice" BOOLEAN NOT NULL,
    "beforePrice" INTEGER NOT NULL,
    "afterPrice" INTEGER NOT NULL,
    "beforeSalePrice" INTEGER,
    "afterSalePrice" INTEGER,
    "beforeSaleStartsAt" TIMESTAMP(3),
    "afterSaleStartsAt" TIMESTAMP(3),
    "beforeSaleEndsAt" TIMESTAMP(3),
    "afterSaleEndsAt" TIMESTAMP(3),
    "beforePricingVersion" INTEGER NOT NULL,
    "afterPricingVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceChange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductPriceChange_batchId_productId_key" ON "ProductPriceChange"("batchId", "productId");
CREATE INDEX "ProductPriceChange_productId_createdAt_idx" ON "ProductPriceChange"("productId", "createdAt");
CREATE INDEX "ProductPriceChange_actorId_createdAt_idx" ON "ProductPriceChange"("actorId", "createdAt");
