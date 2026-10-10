BEGIN;

CREATE TABLE "ShippingMethod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseCost" INTEGER NOT NULL DEFAULT 0,
    "additionalItemCost" INTEGER NOT NULL DEFAULT 0,
    "freeShippingThreshold" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShippingMethod_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShippingMethod_rates_check" CHECK (
        "baseCost" >= 0 AND "additionalItemCost" >= 0
        AND ("freeShippingThreshold" IS NULL OR "freeShippingThreshold" >= 0)
        AND "sortOrder" >= 0
    )
);

CREATE UNIQUE INDEX "ShippingMethod_name_key" ON "ShippingMethod"("name");
CREATE INDEX "ShippingMethod_isActive_sortOrder_idx" ON "ShippingMethod"("isActive", "sortOrder");

-- Old orders keep their existing totals; future orders retain the chosen method and price.
ALTER TABLE "Order"
    ADD COLUMN "shippingMethodId" TEXT,
    ADD COLUMN "shippingMethodName" TEXT,
    ADD COLUMN "shippingCost" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Order_shippingMethodId_idx" ON "Order"("shippingMethodId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_shippingMethodId_fkey"
    FOREIGN KEY ("shippingMethodId") REFERENCES "ShippingMethod"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- No carrier rates are assumed. The admin sets prices and activates these methods.
INSERT INTO "ShippingMethod" ("id", "name", "sortOrder", "updatedAt") VALUES
    ('shipping-post-express', 'پست پیشتاز', 10, CURRENT_TIMESTAMP),
    ('shipping-post-standard', 'پست معمولی', 20, CURRENT_TIMESTAMP),
    ('shipping-tipax', 'تیپاکس', 30, CURRENT_TIMESTAMP),
    ('shipping-mahex', 'ماهکس', 40, CURRENT_TIMESTAMP);

COMMIT;
