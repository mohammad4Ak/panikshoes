import { Prisma } from '@prisma/client'
import { ApiInputError } from './api-input'
import { toAsciiDigits } from './localized-input'

const PAGE_SIZE = 20
const MAX_VARIANTS = 500
const MAX_RESPONSE_BYTES = 2_500_000
type LookupClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'product'>

/** Read-only chooser; the signed import preview remains the authority for stock. */
export async function readWarehouseImportProducts(client: LookupClient, query = new URLSearchParams()) {
  if ([...query.keys()].some(key => !['q', 'page'].includes(key)) || query.getAll('q').length > 1 || query.getAll('page').length > 1) {
    throw new ApiInputError('پارامتر جستجوی محصول نامعتبر است.')
  }
  const input = query.get('q') ?? ''
  if (input.length > 120) throw new ApiInputError('عبارت جستجو بیش از حد طولانی است.')
  const pageInput = toAsciiDigits(query.get('page') ?? '1')
  if (!/^\d{1,7}$/.test(pageInput) || Number(pageInput) < 1) throw new ApiInputError('شمارهٔ صفحه نامعتبر است.')
  const q = toAsciiDigits(input.trim()).replace(/ك/g, 'ک').replace(/ي/g, 'ی')
  // Escape PostgreSQL LIKE metacharacters before adding our substring markers.
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`
  // Normalize stored text too, including mixed digit scripts in a single code.
  // All user input is bound through Prisma.sql; SQL identifiers are fixed.
  const where = Prisma.sql`p."inventoryConfigured" = true
    AND EXISTS (SELECT 1 FROM "ProductVariant" v WHERE v."productId" = p."id")
    ${q ? Prisma.sql`AND (
      translate(p."name", '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩كي', '01234567890123456789کی') ILIKE ${pattern}
      OR translate(p."code", '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩كي', '01234567890123456789کی') ILIKE ${pattern}
    )` : Prisma.empty}`
  const [count] = await client.$queryRaw<{ total: bigint }[]>(Prisma.sql`SELECT count(*) AS total FROM "Product" p WHERE ${where}`)
  const total = Number(count?.total ?? 0)
  if (!Number.isSafeInteger(total) || total < 0) throw new ApiInputError('تعداد محصولات قابل نمایش بیش از حد است.', 413)
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(Number(pageInput), pages)
  const ids = total ? await client.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p."id" FROM "Product" p WHERE ${where}
    ORDER BY p."createdAt" DESC, p."id" ASC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `) : []
  const products = ids.length ? await client.product.findMany({
    where: { id: { in: ids.map(row => row.id) }, inventoryConfigured: true, variants: { some: {} } },
    select: {
      id: true, code: true, name: true,
      variants: {
        select: { id: true, size: true, color: true, stock: true, isActive: true },
        // Active inventory is limited to 500 at configuration; retired rows may
        // accumulate, so fetch one sentinel without rejecting the whole product.
        orderBy: [{ isActive: 'desc' }, { size: 'asc' }, { color: 'asc' }, { id: 'asc' }],
        take: MAX_VARIANTS + 1,
      },
    },
    take: PAGE_SIZE,
  }) : []
  const byId = new Map(products.map(product => [product.id, product]))
  const result = {
    products: ids.flatMap(({ id }) => {
      const product = byId.get(id)
      return product ? [{ ...product, variants: product.variants.slice(0, MAX_VARIANTS), variantsTruncated: product.variants.length > MAX_VARIANTS }] : []
    }),
    pagination: { page, pages, total, pageSize: PAGE_SIZE },
  }
  // Also bound bytes if malformed legacy data contains unusually long strings.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ApiInputError('اطلاعات محصولات بیش از حد بزرگ است؛ جستجوی دقیق‌تری وارد کنید.', 413)
  }
  return result
}
