import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Prisma, PrismaClient, ProductPriceChange } from '@prisma/client'
import { ApiInputError, integerField, textField } from '@/lib/api-input'
import { PRODUCT_PRICE_BULK_LIMIT, type ProductPriceBulkPreview, type ProductPriceBulkResult, type ProductPriceBulkSettings, type ProductPriceSnapshot } from '@/lib/product-price-bulk-contract'

const MAX_PRICE = 2_147_483_647
const PREVIEW_TTL = 10 * 60 * 1000
const MAX_TOKEN_CHARS = 256 * 1024
const MAX_BODY_BYTES = 384 * 1024
const productSelect = {
  id: true, code: true, name: true, price: true, salePrice: true,
  saleStartsAt: true, saleEndsAt: true, pricingVersion: true,
} satisfies Prisma.ProductSelect

type PriceProduct = Prisma.ProductGetPayload<{ select: typeof productSelect }>
type Actor = { id: string; name?: string | null }
type SignedRow = { id: string; code: string; name: string; before: ProductPriceSnapshot; after: ProductPriceSnapshot }
type Claims = {
  version: 1; actorId: string; actorName: string; batchId: string; expiresAt: number
  settings: ProductPriceBulkSettings; reason: string; products: SignedRow[]
}

export async function readProductPriceBulkJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new ApiInputError('درخواست بیش از حد بزرگ است.', 413)
  if (!request.body) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new ApiInputError('درخواست بیش از حد بزرگ است.', 413)
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  return body as Record<string, unknown>
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(value)
}

export function parseProductPriceBulkSettings(value: unknown): ProductPriceBulkSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiInputError('تنظیمات تغییر قیمت نامعتبر است.')
  const settings = value as Record<string, unknown>
  if (settings.operation !== 'increase' && settings.operation !== 'decrease') throw new ApiInputError('افزایش یا کاهش قیمت را انتخاب کنید.')
  if (settings.unit !== 'amount' && settings.unit !== 'percent') throw new ApiInputError('مبلغ تومان یا درصد را انتخاب کنید.')
  // The public API accepts actual integers, never coerced strings or fractions.
  if (typeof settings.value !== 'number') throw new ApiInputError('مقدار تغییر باید عدد صحیح و مثبت باشد.')
  const amount = integerField(settings.value, 'مقدار تغییر', 1)
  if (settings.unit === 'percent' && settings.operation === 'decrease' && amount > 99) throw new ApiInputError('درصد کاهش باید بین ۱ تا ۹۹ باشد.')
  if (typeof settings.includeSalePrice !== 'boolean') throw new ApiInputError('گزینهٔ تغییر قیمت تخفیفی نامعتبر است.')
  return { operation: settings.operation, unit: settings.unit, value: amount, includeSalePrice: settings.includeSalePrice }
}

/** Exact integer arithmetic; a half toman always rounds up to the next toman. */
export function calculateProductPrice(price: number, settings: ProductPriceBulkSettings): number {
  if (!Number.isInteger(price) || price < 1 || price > MAX_PRICE) throw new ApiInputError('قیمت فعلی محصول نامعتبر است.')
  const checked = parseProductPriceBulkSettings(settings)
  const direction = checked.operation === 'increase' ? BigInt(1) : BigInt(-1)
  const amount = BigInt(checked.value)
  const result = checked.unit === 'amount'
    ? BigInt(price) + direction * amount
    : (BigInt(price) * (BigInt(100) + direction * amount) + BigInt(50)) / BigInt(100)
  if (result < BigInt(1) || result > BigInt(MAX_PRICE)) throw new ApiInputError('قیمت جدید باید بین ۱ و ۲٬۱۴۷٬۴۸۳٬۶۴۷ تومان باشد.')
  return Number(result)
}

function snapshot(product: PriceProduct): ProductPriceSnapshot {
  return {
    price: product.price, salePrice: product.salePrice,
    saleStartsAt: product.saleStartsAt?.toISOString() ?? null,
    saleEndsAt: product.saleEndsAt?.toISOString() ?? null,
    pricingVersion: product.pricingVersion,
  }
}

function validSnapshot(value: ProductPriceSnapshot): boolean {
  const priceValid = (price: number) => Number.isInteger(price) && price > 0 && price <= MAX_PRICE
  const dateValid = (date: string | null) => date === null || typeof date === 'string' && Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date
  return !!value && priceValid(value.price) && (value.salePrice === null || priceValid(value.salePrice) && value.salePrice < value.price) &&
    Number.isInteger(value.pricingVersion) && value.pricingVersion >= 0 && value.pricingVersion <= MAX_PRICE &&
    dateValid(value.saleStartsAt) && dateValid(value.saleEndsAt) &&
    (value.salePrice !== null || value.saleStartsAt === null && value.saleEndsAt === null) &&
    (!value.saleStartsAt || !value.saleEndsAt || Date.parse(value.saleStartsAt) < Date.parse(value.saleEndsAt))
}

function nextSnapshot(before: ProductPriceSnapshot, settings: ProductPriceBulkSettings): ProductPriceSnapshot {
  // Check every stored sale, including future and expired campaigns. Bulk price
  // editing must never repair, create, clear, or reschedule a campaign implicitly.
  if (!validSnapshot(before)) throw new ApiInputError('قیمت یا تخفیف ذخیره‌شدهٔ محصول نامعتبر است؛ ابتدا آن را در فرم محصول اصلاح کنید.')
  if (before.pricingVersion === MAX_PRICE) throw new ApiInputError('نسخهٔ قیمت به سقف مجاز رسیده است.')
  const after = { ...before, price: calculateProductPrice(before.price, settings), pricingVersion: before.pricingVersion + 1 }
  if (settings.includeSalePrice && before.salePrice !== null) after.salePrice = calculateProductPrice(before.salePrice, settings)
  if (!validSnapshot(after)) throw new ApiInputError('قیمت تخفیفی باید از قیمت اصلی جدید کمتر باشد؛ این محصول قابل اعمال نیست.')
  if (after.price === before.price && after.salePrice === before.salePrice) throw new ApiInputError('پس از گرد کردن به تومان، قیمت این محصول تغییری نمی‌کند.')
  return after
}

function sign(payload: string) {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
  if (!secret || secret.length < 16) throw new Error('Bulk product price updates require AUTH_SECRET')
  return createHmac('sha256', secret).update('admin-product-price-bulk:v1.').update(payload).digest('base64url')
}

function signPreview(claims: Claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  if (payload.length + 44 > MAX_TOKEN_CHARS) throw new ApiInputError('پیش‌نمایش بزرگ است؛ تعداد محصولات را کاهش دهید.', 413)
  return `${payload}.${sign(payload)}`
}

function verifyPreview(token: unknown, actorId: string): { claims: Claims; fingerprint: string } {
  const invalid = () => new ApiInputError('پیش‌نمایش نامعتبر است؛ دوباره پیش‌نمایش بگیرید.')
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) throw invalid()
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw invalid()
  if (!timingSafeEqual(Buffer.from(parts[1], 'ascii'), Buffer.from(sign(parts[0]), 'ascii'))) throw invalid()
  let claims: Claims
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) }
  catch { throw invalid() }
  if (!claims || claims.version !== 1 || !validId(claims.actorId) || !validId(claims.batchId) ||
      typeof claims.actorName !== 'string' || claims.actorName.length > 300 ||
      !Number.isSafeInteger(claims.expiresAt) || typeof claims.reason !== 'string' || !claims.reason.trim() || claims.reason.length > 500 ||
      !Array.isArray(claims.products) || !claims.products.length || claims.products.length > PRODUCT_PRICE_BULK_LIMIT ||
      new Set(claims.products.map(row => row?.id)).size !== claims.products.length) throw invalid()
  try {
    parseProductPriceBulkSettings(claims.settings)
    for (const row of claims.products) {
      if (!row || !validId(row.id) || typeof row.code !== 'string' || typeof row.name !== 'string' ||
          !validSnapshot(row.before) || !validSnapshot(row.after) || JSON.stringify(nextSnapshot(row.before, claims.settings)) !== JSON.stringify(row.after)) throw invalid()
    }
  } catch { throw invalid() }
  if (claims.actorId !== actorId) throw new ApiInputError('این پیش‌نمایش به حساب دیگری تعلق دارد؛ دوباره پیش‌نمایش بگیرید.', 403)
  // Expiration is intentionally checked only after durable replay lookup.
  return { claims, fingerprint: createHash('sha256').update(token).digest('hex') }
}

export async function previewProductPrices(db: Pick<PrismaClient, 'product'>, body: Record<string, unknown>, actor: Actor, now = Date.now()): Promise<ProductPriceBulkPreview> {
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > PRODUCT_PRICE_BULK_LIMIT ||
      !body.ids.every(validId) || new Set(body.ids).size !== body.ids.length) throw new ApiInputError(`بین ۱ تا ${PRODUCT_PRICE_BULK_LIMIT.toLocaleString('fa-IR')} محصول با شناسه‌های یکتا انتخاب کنید.`)
  const ids = body.ids as string[]
  const settings = parseProductPriceBulkSettings(body.settings)
  const reason = textField(body.reason, 'دلیل تغییر قیمت', 500)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) throw new ApiInputError('دلیل تغییر قیمت نامعتبر است.')
  const products = await db.product.findMany({ where: { id: { in: ids } }, select: productSelect })
  const byId = new Map(products.map(product => [product.id, product]))
  const batchId = randomUUID()
  const expiresAt = now + PREVIEW_TTL
  const signedRows: SignedRow[] = []
  const rows = ids.map(id => {
    const product = byId.get(id)
    if (!product) return { id, code: null, name: null, eligible: false, reason: 'محصول یافت نشد.', before: null, after: null }
    const before = snapshot(product)
    try {
      const after = nextSnapshot(before, settings)
      signedRows.push({ id, code: product.code, name: product.name, before, after })
      return { id, code: product.code, name: product.name, eligible: true, before, after }
    } catch (error) {
      if (!(error instanceof ApiInputError)) throw error
      return { id, code: product.code, name: product.name, eligible: false, reason: error.message, before, after: null }
    }
  })
  const token = signedRows.length ? signPreview({ version: 1, actorId: actor.id, actorName: (actor.name || 'مدیر').slice(0, 300), batchId, expiresAt, settings, reason, products: signedRows }) : null
  return { token, batchId, expiresAt: new Date(expiresAt).toISOString(), settings, reason, rows, limit: PRODUCT_PRICE_BULK_LIMIT }
}

function auditResult(audit: ProductPriceChange, outcome: 'updated' | 'already_applied'): ProductPriceBulkResult {
  return {
    id: audit.productId, outcome, auditId: audit.id,
    before: { price: audit.beforePrice, salePrice: audit.beforeSalePrice, saleStartsAt: audit.beforeSaleStartsAt?.toISOString() ?? null, saleEndsAt: audit.beforeSaleEndsAt?.toISOString() ?? null, pricingVersion: audit.beforePricingVersion },
    after: { price: audit.afterPrice, salePrice: audit.afterSalePrice, saleStartsAt: audit.afterSaleStartsAt?.toISOString() ?? null, saleEndsAt: audit.afterSaleEndsAt?.toISOString() ?? null, pricingVersion: audit.afterPricingVersion },
  }
}

export async function confirmProductPrice(db: Pick<PrismaClient, '$transaction'>, body: Record<string, unknown>, actor: Actor, now = Date.now()): Promise<{ result: ProductPriceBulkResult }> {
  const { claims, fingerprint } = verifyPreview(body.token, actor.id)
  if (!validId(body.productId)) throw new ApiInputError('شناسهٔ محصول نامعتبر است.')
  const row = claims.products.find(product => product.id === body.productId)
  if (!row) throw new ApiInputError('محصول باید در همین پیش‌نمایش قابل تغییر باشد.')
  const skipped = (code: string, reason: string): ProductPriceBulkResult => ({ id: row.id, outcome: 'skipped', code, reason })
  const where = { batchId_productId: { batchId: claims.batchId, productId: row.id } }
  const replay = (audit: ProductPriceChange | null) => {
    if (!audit) return null
    if (audit.actorId !== actor.id || audit.fingerprint !== fingerprint) throw new ApiInputError('شناسهٔ عملیات با پیش‌نمایش تطابق ندارد.', 409)
    return auditResult(audit, 'already_applied')
  }
  const result = await db.$transaction(async tx => {
    const previous = replay(await tx.productPriceChange.findUnique({ where }))
    if (previous) return previous
    if (claims.expiresAt <= now) return skipped('PREVIEW_EXPIRED', 'مهلت پیش‌نمایش تمام شده است؛ دوباره پیش‌نمایش بگیرید.')
    const current = await tx.product.findUnique({ where: { id: row.id }, select: productSelect })
    if (!current) return skipped('PRODUCT_NOT_FOUND', 'محصول دیگر وجود ندارد.')
    // Only pricing and the identity shown to the administrator are compared.
    // Stock, inventory versions, page views and updatedAt may change freely.
    const changed = await tx.product.updateMany({
      where: {
        id: row.id, code: row.code, name: row.name, pricingVersion: row.before.pricingVersion,
        price: row.before.price, salePrice: row.before.salePrice,
        saleStartsAt: row.before.saleStartsAt ? new Date(row.before.saleStartsAt) : null,
        saleEndsAt: row.before.saleEndsAt ? new Date(row.before.saleEndsAt) : null,
      },
      data: { price: row.after.price, salePrice: row.after.salePrice, pricingVersion: { increment: 1 } },
    })
    if (changed.count !== 1) {
      // A concurrent retry waits on the CAS and can then recover the committed
      // audit. A genuinely competing edit has no audit for this batch/product.
      const concurrent = replay(await tx.productPriceChange.findUnique({ where }))
      return concurrent ?? skipped('PRODUCT_PRICE_CHANGED', 'قیمت، تخفیف یا مشخصات محصول پس از پیش‌نمایش تغییر کرده است؛ دوباره پیش‌نمایش بگیرید.')
    }
    const audit = await tx.productPriceChange.create({ data: {
      batchId: claims.batchId, productId: row.id, productCode: row.code, productName: row.name,
      actorId: claims.actorId, actorName: claims.actorName, fingerprint, reason: claims.reason,
      operation: claims.settings.operation, unit: claims.settings.unit, value: claims.settings.value, includeSalePrice: claims.settings.includeSalePrice,
      beforePrice: row.before.price, afterPrice: row.after.price,
      beforeSalePrice: row.before.salePrice, afterSalePrice: row.after.salePrice,
      beforeSaleStartsAt: row.before.saleStartsAt ? new Date(row.before.saleStartsAt) : null,
      afterSaleStartsAt: row.after.saleStartsAt ? new Date(row.after.saleStartsAt) : null,
      beforeSaleEndsAt: row.before.saleEndsAt ? new Date(row.before.saleEndsAt) : null,
      afterSaleEndsAt: row.after.saleEndsAt ? new Date(row.after.saleEndsAt) : null,
      beforePricingVersion: row.before.pricingVersion, afterPricingVersion: row.after.pricingVersion,
    } })
    return auditResult(audit, 'updated')
  }, { maxWait: 5000, timeout: 10000 })
  return { result }
}
