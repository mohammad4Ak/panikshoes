import { Prisma } from '@prisma/client'
import { ApiInputError } from './api-input'
import { catalogSearchCondition } from './catalog-search'
import { parseIntegerInput, toAsciiDigits } from './localized-input'
import { prisma } from './prisma'

const PAGE_SIZE = 24
const MAX_PRODUCT_PRICE = 2_147_483_647
const sortColumns = {
  newest: Prisma.empty,
  cheap: Prisma.sql`r."effectivePrice" ASC,`,
  expensive: Prisma.sql`r."effectivePrice" DESC,`,
  popular: Prisma.sql`r."ratingAverage" DESC, r."ratingCount" DESC,`,
  views: Prisma.sql`r."viewCount" DESC, r."ratingAverage" DESC, r."ratingCount" DESC,`,
}

type CatalogRow = { total: bigint; nextPriceChangeAt: Date | null } & ({
  id: null
} | {
  id: string
  name: string
  slug: string
  price: number
  salePrice: number | null
  saleStartsAt: Date | null
  saleEndsAt: Date | null
  image: string | null
  stock: number
  inventoryConfigured: boolean
  categoryId: string
  categoryName: string
  ratingAverage: number
  ratingCount: bigint
  viewCount: number
})

function priceBound(value: string | null): number | null {
  // Missing or incomplete input leaves that side of the range open.
  if (!value || value.length > 64) return null
  const parsed = parseIntegerInput(value)
  if (!parsed) return null
  // One above the database's maximum is enough to represent any larger bound.
  return Math.min(Number(parsed), MAX_PRODUCT_PRICE + 1)
}

function approvedRatings(productId: Prisma.Sql) {
  return Prisma.sql`LEFT JOIN LATERAL (
    SELECT COALESCE(AVG(review."rating"), 0)::double precision AS "ratingAverage",
      COUNT(*) AS "ratingCount"
    FROM "ProductReview" review
    WHERE review."productId" = ${productId} AND review."status" = 'APPROVED'
  ) ratings ON TRUE`
}

export async function readPublicCatalog(params: URLSearchParams, now = new Date(), db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma) {
  const pageInput = toAsciiDigits(params.get('page') ?? '1')
  if (!/^[1-9][0-9]{0,5}$/.test(pageInput)) throw new ApiInputError('شمارهٔ صفحه نامعتبر است.')
  const page = Number(pageInput)

  const category = params.get('cat')?.trim()
  if (category && (category.length > 128 || category.includes('\0'))) {
    throw new ApiInputError('دسته‌بندی نامعتبر است.')
  }
  const search = catalogSearchCondition(params.get('q') ?? '')
  const min = priceBound(params.get('min'))
  const max = priceBound(params.get('max'))
  const sort = params.get('sort') ?? 'newest'
  const order = Prisma.sql`${Object.hasOwn(sortColumns, sort) ? sortColumns[sort as keyof typeof sortColumns] : Prisma.empty}
    r."createdAt" DESC, r."id" ASC`
  const rankByRatings = sort === 'popular' || sort === 'views'

  // Sort on the catalog's effective price at one instant, using the same
  // inclusive start and exclusive end as productPricing in the card/checkout.
  // The deadline includes price-filtered-out rows: a sale can bring them in.
  // Only hydrate card fields after selecting the requested page of IDs.
  const rows = await db.$queryRaw<CatalogRow[]>(Prisma.sql`
    WITH clock AS (
      SELECT ${now}::timestamptz AT TIME ZONE 'UTC' AS "at"
    ), candidates AS (
      SELECT p."id", p."createdAt", p."viewCount", p."saleStartsAt", p."saleEndsAt",
        sale.valid AS "validSale",
        CASE WHEN sale.valid
          AND (p."saleStartsAt" IS NULL OR p."saleStartsAt" <= clock."at")
          AND (p."saleEndsAt" IS NULL OR p."saleEndsAt" > clock."at")
          THEN p."salePrice" ELSE p."price" END AS "effectivePrice"
      FROM "Product" p CROSS JOIN clock
      CROSS JOIN LATERAL (
        SELECT p."salePrice" >= 1 AND p."salePrice" < p."price"
          AND (p."saleStartsAt" IS NULL OR p."saleEndsAt" IS NULL OR p."saleStartsAt" < p."saleEndsAt") AS valid
      ) sale
      WHERE ${search}
        ${category && category !== 'ALL' ? Prisma.sql`AND p."categoryId" = ${category}` : Prisma.empty}
        ${params.get('stock') === '1' ? Prisma.sql`AND p."inventoryConfigured" = TRUE AND p."stock" > 0` : Prisma.empty}
    ), matching AS (
      SELECT c.* FROM candidates c WHERE TRUE
        ${min === null ? Prisma.empty : Prisma.sql`AND c."effectivePrice" >= ${min}`}
        ${max === null ? Prisma.empty : Prisma.sql`AND c."effectivePrice" <= ${max}`}
    ), ranked AS (
      SELECT m.* ${rankByRatings ? Prisma.sql`, ratings."ratingAverage", ratings."ratingCount"` : Prisma.empty}
      FROM matching m ${rankByRatings ? approvedRatings(Prisma.sql`m."id"`) : Prisma.empty}
    ), selected AS (
      SELECT r.* FROM ranked r
      ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
    ), stats AS (
      SELECT (SELECT COUNT(*) FROM matching) AS total,
        (SELECT MIN(LEAST(
          CASE WHEN c."saleStartsAt" > clock."at" THEN c."saleStartsAt" END,
          CASE WHEN c."saleEndsAt" > clock."at" THEN c."saleEndsAt" END
        )) FROM candidates c CROSS JOIN clock WHERE c."validSale") AS "nextPriceChangeAt"
    )
    SELECT stats.*, p."id", p."name", p."slug", p."price", p."salePrice", p."saleStartsAt", p."saleEndsAt",
      NULLIF(btrim(p."images"[1]), '') AS image, p."inventoryConfigured",
      CASE WHEN p."inventoryConfigured" THEN p."stock" ELSE 0 END AS stock,
      p."categoryId", category."name" AS "categoryName", p."viewCount",
      ${rankByRatings ? Prisma.sql`r."ratingAverage", r."ratingCount"` : Prisma.sql`ratings."ratingAverage", ratings."ratingCount"`}
    FROM stats LEFT JOIN selected r ON TRUE
    LEFT JOIN "Product" p ON p."id" = r."id"
    LEFT JOIN "Category" category ON category."id" = p."categoryId"
    ${rankByRatings ? Prisma.empty : approvedRatings(Prisma.sql`r."id"`)}
    ORDER BY ${order}
  `)

  const total = Number(rows[0]?.total ?? 0)
  const items = rows.flatMap(row => row.id === null ? [] : [{
    id: row.id, name: row.name, slug: row.slug,
    price: row.price, salePrice: row.salePrice,
    saleStartsAt: row.saleStartsAt?.toISOString() ?? null,
    saleEndsAt: row.saleEndsAt?.toISOString() ?? null,
    images: row.image ? [row.image] : [],
    stock: row.stock, inventoryConfigured: row.inventoryConfigured,
    categoryId: row.categoryId, category: { name: row.categoryName },
    ratingAverage: row.ratingAverage, ratingCount: Number(row.ratingCount), viewCount: row.viewCount,
  }])
  return {
    items, total, page, hasMore: page * PAGE_SIZE < total,
    nextPriceChangeAt: rows[0]?.nextPriceChangeAt?.toISOString() ?? null,
    pricedAt: now.toISOString(),
  }
}
