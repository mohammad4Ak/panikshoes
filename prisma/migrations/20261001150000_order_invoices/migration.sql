BEGIN;

-- Preserve the checkout product name for new invoices and existing order lines.
ALTER TABLE "OrderItem" ADD COLUMN "productName" TEXT;
UPDATE "OrderItem" AS item
SET "productName" = product."name"
FROM "Product" AS product
WHERE product."id" = item."productId";

CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing approved orders receive a frozen invoice at the migration's actual
-- issue time. Their placement date remains a separate field in the document.
-- There is no approval history to infer issuance for pending/cancelled orders.
INSERT INTO "Invoice" ("orderId", "snapshot")
SELECT orders."id", jsonb_build_object(
    'schemaVersion', 1,
    'seller', jsonb_build_object('name', 'کفش لند'),
    'buyer', jsonb_build_object('name', buyer."name", 'email', buyer."email"),
    'recipient', jsonb_build_object(
        'name', COALESCE(orders."recipientName", buyer."name"),
        'address', orders."address", 'phone', orders."phone"
    ),
    'orderId', orders."id",
    'orderCreatedAt', to_char(orders."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'items', COALESCE(lines.items, '[]'::jsonb),
    'subtotal', COALESCE(lines.subtotal, 0),
    'shippingMethodName', orders."shippingMethodName",
    'shippingCost', orders."shippingCost",
    'total', orders."total",
    'currency', 'تومان'
)
FROM "Order" AS orders
JOIN "User" AS buyer ON buyer."id" = orders."userId"
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
        'productId', item."productId",
        'productName', COALESCE(item."productName", product."name"),
        'quantity', item."quantity", 'size', item."size", 'color', item."color",
        'unitPrice', item."price",
        'lineTotal', item."price"::bigint * item."quantity"
    ) ORDER BY item."id") AS items,
    SUM(item."price"::bigint * item."quantity") AS subtotal
    FROM "OrderItem" AS item
    JOIN "Product" AS product ON product."id" = item."productId"
    WHERE item."orderId" = orders."id"
) AS lines ON true
WHERE orders."status" IN ('PROCESSING', 'SHIPPED', 'DELIVERED')
ORDER BY orders."createdAt", orders."id";

COMMIT;
