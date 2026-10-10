ALTER TABLE "Order" ADD COLUMN "checkoutKey" TEXT;
ALTER TABLE "Order" ADD COLUMN "checkoutFingerprint" TEXT;
CREATE UNIQUE INDEX "Order_checkoutKey_key" ON "Order"("checkoutKey");
