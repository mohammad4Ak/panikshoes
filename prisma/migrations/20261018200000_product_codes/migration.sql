-- Existing products receive stable, editable codes without changing their IDs,
-- slugs, inventory, order references, or historical invoice snapshots.
BEGIN;

ALTER TABLE "Product" ADD COLUMN "code" TEXT;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS position
  FROM "Product"
)
UPDATE "Product" AS product
SET "code" = 'AUTO-' || LPAD(numbered.position::TEXT, GREATEST(6, LENGTH(numbered.position::TEXT)), '0')
FROM numbered
WHERE product."id" = numbered."id";

ALTER TABLE "Product" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "Product" ADD CONSTRAINT "Product_code_format_check"
  CHECK (LENGTH("code") BETWEEN 1 AND 64 AND "code" ~ '^[A-Za-z0-9._-]+$');

CREATE UNIQUE INDEX "Product_code_key" ON "Product"("code");
-- Prisma's field index handles ordinary writes; this also protects mixed-case
-- codes supplied by imports or concurrent writers that bypass API normalization.
CREATE UNIQUE INDEX "Product_code_upper_key" ON "Product"(UPPER("code"));

COMMIT;
