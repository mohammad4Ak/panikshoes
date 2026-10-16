CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'FIXED');

ALTER TABLE "Product" ADD COLUMN "salePrice" INTEGER,
  ADD COLUMN "saleStartsAt" TIMESTAMP(3), ADD COLUMN "saleEndsAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD CONSTRAINT "Product_sale_valid" CHECK (
  ("salePrice" IS NULL OR ("salePrice" >= 1 AND "salePrice" < "price")) AND
  ("saleStartsAt" IS NULL OR "saleEndsAt" IS NULL OR "saleStartsAt" < "saleEndsAt")
);

CREATE TABLE "Coupon" (
  "id" TEXT NOT NULL, "code" TEXT NOT NULL, "name" TEXT NOT NULL,
  "type" "CouponType" NOT NULL, "value" INTEGER NOT NULL,
  "maxDiscount" INTEGER, "minSubtotal" INTEGER NOT NULL DEFAULT 0,
  "maxUses" INTEGER, "perUserLimit" INTEGER NOT NULL DEFAULT 1,
  "startsAt" TIMESTAMP(3), "endsAt" TIMESTAMP(3), "isActive" BOOLEAN NOT NULL DEFAULT true,
  "usedCount" INTEGER NOT NULL DEFAULT 0, "version" INTEGER NOT NULL DEFAULT 1,
  "deletedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Coupon_values_valid" CHECK (
    "code" ~ '^[A-Z0-9_-]{3,32}$' AND length("name") BETWEEN 1 AND 120 AND
    "value" >= 1 AND "minSubtotal" >= 0 AND "usedCount" >= 0 AND "version" >= 1 AND
    ("maxUses" IS NULL OR "maxUses" >= 1) AND "perUserLimit" >= 1 AND
    ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt") AND
    (("type" = 'PERCENT' AND "value" <= 99 AND ("maxDiscount" IS NULL OR "maxDiscount" >= 1)) OR
     ("type" = 'FIXED' AND "maxDiscount" IS NULL AND "minSubtotal" > "value"))
  )
);
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");
CREATE INDEX "Coupon_deletedAt_isActive_createdAt_idx" ON "Coupon"("deletedAt", "isActive", "createdAt");

ALTER TABLE "Order" ADD COLUMN "subtotal" INTEGER,
  ADD COLUMN "productDiscount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "couponDiscount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "couponId" TEXT, ADD COLUMN "couponCode" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "originalPrice" INTEGER,
  ADD COLUMN "couponDiscount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD CONSTRAINT "Order_discounts_nonnegative" CHECK (
  "productDiscount" >= 0 AND "couponDiscount" >= 0 AND ("subtotal" IS NULL OR "subtotal" >= 0)
);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_discounts_nonnegative" CHECK (
  "couponDiscount" >= 0 AND ("originalPrice" IS NULL OR "originalPrice" >= "price")
);
CREATE INDEX "Order_couponId_idx" ON "Order"("couponId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CouponRedemption" (
  "id" TEXT NOT NULL, "couponId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL, "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "CouponRedemption"("orderId");
CREATE INDEX "CouponRedemption_couponId_userId_releasedAt_idx" ON "CouponRedemption"("couponId", "userId", "releasedAt");
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
