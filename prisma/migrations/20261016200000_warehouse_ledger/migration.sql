ALTER TABLE "ProductVariant"
  ADD COLUMN "damagedStock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lowStockThreshold" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_warehouse_values_valid"
  CHECK ("damagedStock" >= 0 AND "lowStockThreshold" >= 0);

CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'RECEIPT', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'SALE', 'RETURN_SELLABLE', 'RETURN_DAMAGED', 'DAMAGE', 'REPAIR', 'DISPOSAL', 'VARIANT_STATUS', 'SHIPMENT');
CREATE TABLE "StockMovement" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "variantId" TEXT,
  "size" INTEGER,
  "color" TEXT,
  "type" "StockMovementType" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "stockBefore" INTEGER NOT NULL,
  "stockAfter" INTEGER NOT NULL,
  "damagedBefore" INTEGER NOT NULL DEFAULT 0,
  "damagedAfter" INTEGER NOT NULL DEFAULT 0,
  "activeBefore" BOOLEAN NOT NULL DEFAULT true,
  "activeAfter" BOOLEAN NOT NULL DEFAULT true,
  "actorId" TEXT,
  "actorName" TEXT NOT NULL,
  "orderId" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "requestKey" TEXT,
  "fingerprint" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockMovement_balances_valid" CHECK ("quantity" >= 0 AND "stockBefore" >= 0 AND "stockAfter" >= 0 AND "damagedBefore" >= 0 AND "damagedAfter" >= 0 AND ("size" IS NULL OR "size" >= 1))
);
CREATE UNIQUE INDEX "StockMovement_requestKey_key" ON "StockMovement"("requestKey");
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");
CREATE INDEX "StockMovement_variantId_createdAt_idx" ON "StockMovement"("variantId", "createdAt");
CREATE INDEX "StockMovement_orderId_idx" ON "StockMovement"("orderId");
CREATE INDEX "StockMovement_type_createdAt_idx" ON "StockMovement"("type", "createdAt");
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Opening balances describe the start of this ledger, not invented past activity.
-- No stock, reservations, order state, or inventory versions are changed.
INSERT INTO "StockMovement" ("id", "productId", "productName", "variantId", "size", "color", "type", "quantity", "stockBefore", "stockAfter", "activeBefore", "activeAfter", "actorName", "note")
SELECT 'opening-variant:' || v."id", p."id", p."name", v."id", v."size", v."color", 'OPENING', v."stock", 0, v."stock", false, v."isActive", 'سیستم', 'ماندهٔ اولیه در شروع ثبت تاریخچه؛ موجودی تغییر نکرده است.'
FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId";
INSERT INTO "StockMovement" ("id", "productId", "productName", "type", "quantity", "stockBefore", "stockAfter", "activeBefore", "activeAfter", "actorName", "note")
SELECT 'opening-legacy:' || p."id", p."id", p."name", 'OPENING', p."stock", 0, p."stock", false, false, 'سیستم', 'ماندهٔ قدیمی تخصیص‌نیافته؛ تا تعیین رنگ و سایز قابل فروش نیست.'
FROM "Product" p WHERE NOT p."inventoryConfigured" AND p."stock" > 0;
