-- Keep existing customers/orders valid; completing account contact is enforced
-- at checkout. Old delivery snapshots must never be inferred from current data.
BEGIN;
ALTER TABLE "User"
  ADD COLUMN "postalCode" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Address" ADD COLUMN "postalCode" TEXT;
ALTER TABLE "Order"
  ADD COLUMN "postalCode" TEXT,
  ADD COLUMN "trackingCode" TEXT,
  ADD COLUMN "trackingRecordedAt" TIMESTAMP(3);

CREATE INDEX "Order_phone_idx" ON "Order"("phone");
CREATE INDEX "Order_postalCode_idx" ON "Order"("postalCode");
COMMIT;
