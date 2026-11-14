import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Prisma, type StockMovement } from '@prisma/client'
import { ApiInputError, integerField, textField } from './api-input'
import { InventoryError, inventoryKey } from './inventory'
import { toAsciiDigits } from './localized-input'
import { normalizeProductCode, productCodeField } from './product-code'
import { readShipmentJson, shipmentCell, validateShipmentZip } from './shipment-import'
import {
  MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS, MAX_WAREHOUSE_IMPORT_ROWS, MAX_WAREHOUSE_IMPORT_TOKEN_CHARS,
  type WarehouseImportConfirmation, type WarehouseImportMode, type WarehouseImportPreview,
  type WarehouseImportPreviewRow, type WarehouseImportProduct, type WarehouseImportSheet,
} from './warehouse-import-contract'

const MAX = 2_147_483_647
const TOKEN_LIFETIME = 10 * 60 * 1000
const TOKEN_SCOPE = 'warehouse-import-v1'
export const MAX_WAREHOUSE_IMPORT_JSON_BYTES = 900_000
export const MAX_WAREHOUSE_IMPORT_CONFIRM_BYTES = 950_000
const MAX_PREVIEW_BYTES = 2_500_000
const MAX_VARIANT_CANDIDATES = 5000
type SignedRow = {
  rowNumber: number; productId: string; variantId: string; inventoryVersion: number
  quantity: number; stockBefore: number; stockAfter: number; damaged: number; isActive: boolean
}
export type WarehouseImportClaims = {
  scope: typeof TOKEN_SCOPE; actorId: string; expiresAt: number; batchId: string
  mode: WarehouseImportMode; note: string; rows: SignedRow[]
}
export const readWarehouseImportJson = readShipmentJson

/** The shared workbook reader validates ZIP inflation/coordinates before ExcelJS. */
export async function parseWarehouseImportWorkbook(buffer: Buffer): Promise<WarehouseImportSheet[]> {
  validateShipmentZip(buffer)
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  try { await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]) }
  catch { throw new ApiInputError('فایل اکسل خوانده نشد؛ یک فایل سالم با پسوند xlsx انتخاب کنید.') }
  if (!workbook.worksheets.length || workbook.worksheets.length > 10) throw new ApiInputError('فایل باید بین ۱ تا ۱۰ برگه داشته باشد.')
  let total = 0
  const sheets = workbook.worksheets.map(sheet => {
    if (sheet.rowCount > MAX_WAREHOUSE_IMPORT_ROWS + 20 || sheet.columnCount > 100) throw new ApiInputError('هر برگه حداکثر ۱۰۰۰ ردیف داده و ۱۰۰ ستون داشته باشد.')
    const rows: WarehouseImportSheet['rows'] = []
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells = Array.from({ length: sheet.columnCount }, (_, index) => {
        const cell = row.getCell(index + 1)
        return { ...shipmentCell(cell.value, cell.text), ...(typeof cell.value === 'number' ? { numeric: true } : {}) }
      })
      if (cells.some(cell => cell.text || cell.error)) rows.push({ rowNumber: row.number, cells })
    })
    total += rows.length
    if (total > 3000) throw new ApiInputError('فایل بیش از حد ردیف دارد؛ فقط برگه‌های مورد نیاز را نگه دارید.')
    return { name: sheet.name, columnCount: sheet.columnCount, rows }
  })
  if (Buffer.byteLength(JSON.stringify({ sheets }), 'utf8') > MAX_PREVIEW_BYTES) throw new ApiInputError('محتوای قابل نمایش فایل زیاد است؛ فایل یا تعداد ستون‌های آن را کوچک‌تر کنید.', 413)
  return sheets
}

export function normalizeWarehouseImportColor(value: string) {
  return toAsciiDigits(value.normalize('NFKC')).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\s\u200c]+/g, ' ').trim()
}

function plainObject(input: unknown, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new ApiInputError('فیلدهای درخواست ورود موجودی نامعتبر است.')
  return input as Record<string, unknown>
}

function cellText(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length > 250 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiInputError(`${label} باید متن ساده و کوتاه باشد.`)
  return value.trim()
}

export function parseWarehouseImportPreviewInput(body: Record<string, unknown>) {
  plainObject(body, ['mode', 'note', 'rows'])
  if (body.mode !== 'RECEIPT' && body.mode !== 'ADJUSTMENT') throw new ApiInputError('روش ورود موجودی را انتخاب کنید.')
  const mode: WarehouseImportMode = body.mode
  const note = textField(body.note, 'دلیل یا توضیح عملیات', 500)
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(note)) throw new ApiInputError('توضیح عملیات نامعتبر است.')
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_WAREHOUSE_IMPORT_ROWS) throw new ApiInputError('بین ۱ تا ۱۰۰۰ ردیف داده انتخاب کنید.')
  const numbers = new Set<number>()
  const rows = body.rows.map(input => {
    const data = plainObject(input, ['rowNumber', 'code', 'size', 'color', 'quantity', 'sourceError'])
    if (!Number.isSafeInteger(data.rowNumber) || (data.rowNumber as number) < 1 || (data.rowNumber as number) > MAX_WAREHOUSE_IMPORT_ROWS + 20 || numbers.has(data.rowNumber as number)) throw new ApiInputError('شمارهٔ ردیف‌ها نامعتبر یا تکراری است.')
    numbers.add(data.rowNumber as number)
    const row: WarehouseImportPreviewRow = { rowNumber: data.rowNumber as number, code: '', size: null, color: '', quantity: null }
    const errors: string[] = []
    const field = (work: () => void) => { try { work() } catch (error) { errors.push(error instanceof Error ? error.message : 'اطلاعات سلول نامعتبر است.') } }
    field(() => { row.code = productCodeField(cellText(data.code, 'کد محصول')) })
    field(() => { row.size = integerField(toAsciiDigits(cellText(data.size, 'سایز')), 'سایز', 1) })
    field(() => {
      row.color = normalizeWarehouseImportColor(cellText(data.color, 'رنگ'))
      if (!row.color || row.color.length > 100) throw new ApiInputError('رنگ نامعتبر است؛ برای محصول بدون رنگ، «-» وارد کنید.')
    })
    field(() => { row.quantity = integerField(toAsciiDigits(cellText(data.quantity, 'تعداد')), mode === 'ADJUSTMENT' ? 'موجودی قابل فروش جدید' : 'تعداد ورودی', mode === 'ADJUSTMENT' ? 0 : 1) })
    if (data.sourceError !== undefined) field(() => { const error = cellText(data.sourceError, 'خطای سلول'); if (error) errors.push(error) })
    if (errors.length) row.error = [...new Set(errors)].join(' ')
    return row
  })
  return { mode, note, rows }
}

function signingKey() {
  const key = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
  if (!key || key.length < 16) throw new Error('Warehouse import requires AUTH_SECRET')
  return key
}
function signature(payload: string) { return createHmac('sha256', signingKey()).update(`${TOKEN_SCOPE}.${payload}`).digest() }
function sign(claims: WarehouseImportClaims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const token = `${payload}.${signature(payload).toString('base64url')}`
  if (token.length > MAX_WAREHOUSE_IMPORT_TOKEN_CHARS) throw new ApiInputError('حجم پیش‌نمایش زیاد است؛ فایل را کوچک‌تر کنید.', 413)
  return token
}
export function verifyWarehouseImportPreview(token: unknown, actorId: string, options: { allowExpired?: boolean } = {}): WarehouseImportClaims {
  const invalid = () => new ApiInputError('پیش‌نمایش ورود موجودی نامعتبر است؛ دوباره بررسی کنید.')
  if (typeof token !== 'string' || token.length > MAX_WAREHOUSE_IMPORT_TOKEN_CHARS) throw invalid()
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw invalid()
  const actual = Buffer.from(parts[1], 'base64url'), expected = signature(parts[0])
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid()
  let claims: WarehouseImportClaims
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch { throw invalid() }
  if (!claims || claims.scope !== TOKEN_SCOPE || claims.actorId !== actorId || !Number.isSafeInteger(claims.expiresAt)
    || !/^[a-f0-9]{32}$/.test(claims.batchId) || !['RECEIPT', 'ADJUSTMENT'].includes(claims.mode)
    || typeof claims.note !== 'string' || !claims.note || claims.note.length > 500 || !Array.isArray(claims.rows) || claims.rows.length > MAX_WAREHOUSE_IMPORT_ROWS) throw invalid()
  const numbers = new Set<number>(), variants = new Set<string>()
  for (const row of claims.rows) {
    if (!row || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 1 || numbers.has(row.rowNumber)
      || typeof row.productId !== 'string' || row.productId.length > 128 || !row.productId || typeof row.variantId !== 'string' || row.variantId.length > 128 || !row.variantId || variants.has(row.variantId)
      || ![row.inventoryVersion, row.quantity, row.stockBefore, row.stockAfter, row.damaged].every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX)
      || typeof row.isActive !== 'boolean' || (claims.mode === 'RECEIPT' && row.quantity < 1)
      || row.stockAfter !== (claims.mode === 'RECEIPT' ? row.stockBefore + row.quantity : row.quantity)) throw invalid()
    numbers.add(row.rowNumber); variants.add(row.variantId)
  }
  if (!options.allowExpired && claims.expiresAt <= Date.now()) throw new ApiInputError('مهلت پیش‌نمایش تمام شده است؛ دوباره بررسی کنید.', 409)
  return claims
}

function rowError(row: WarehouseImportPreviewRow, message: string) { row.error = row.error ? `${row.error} ${message}` : message }

/** Read-only, run at RepeatableRead so stock, revisions and reservations agree. */
export async function previewWarehouseImport(tx: Prisma.TransactionClient, body: Record<string, unknown>, actorId: string): Promise<WarehouseImportPreview> {
  const { mode, note, rows } = parseWarehouseImportPreviewInput(body)
  const codes = [...new Set(rows.map(row => row.code).filter(Boolean))]
  const products = codes.length ? await tx.product.findMany({ where: { code: { in: codes, mode: 'insensitive' } }, select: { id: true, code: true, name: true, stock: true, inventoryVersion: true, inventoryConfigured: true }, take: MAX_WAREHOUSE_IMPORT_ROWS + 1 }) : []
  if (products.length > MAX_WAREHOUSE_IMPORT_ROWS) throw new ApiInputError('تعداد محصول‌های مطابق بیش از حد است؛ فایل را کوچک‌تر کنید.', 413)
  const pairs = products.flatMap(product => [...new Set(rows.filter(row => row.code === normalizeProductCode(product.code ?? '') && row.size !== null).map(row => row.size!))].map(size => ({ productId: product.id, size })))
  // Only sizes present in the file need color matching. Bound the combined
  // candidate set, rather than loading every variant for 1000 whole products.
  const candidates = pairs.length ? await tx.productVariant.findMany({ where: { OR: pairs }, take: MAX_VARIANT_CANDIDATES + 1, orderBy: { id: 'asc' } }) : []
  if (candidates.length > MAX_VARIANT_CANDIDATES) throw new ApiInputError('تعداد رنگ و سایزهای قابل بررسی زیاد است؛ فایل را به بخش‌های کوچک‌تر تقسیم کنید.', 413)
  const sums = products.length ? await tx.productVariant.groupBy({ by: ['productId'], where: { productId: { in: products.map(product => product.id) }, isActive: true }, _sum: { stock: true } }) : []
  const activeSums = new Map(sums.map(row => [row.productId, row._sum.stock ?? 0]))
  const reservations = products.length ? await tx.orderItem.groupBy({ by: ['productId', 'size', 'color'], where: { productId: { in: products.map(product => product.id) }, order: { status: { in: ['PENDING', 'PROCESSING'] } } }, _sum: { quantity: true } }) : []
  const reserved = new Map(reservations.map(row => [inventoryKey(row.productId, row.size, row.color), row._sum.quantity ?? 0]))
  for (const row of rows) {
    if (!row.code || row.size === null || !row.color) continue
    const matches = products.filter(product => product.code && normalizeProductCode(product.code) === row.code)
    if (matches.length !== 1) { rowError(row, matches.length ? 'کد محصول مبهم است؛ کدهای محصولات را اصلاح کنید.' : 'محصولی با این کد پیدا نشد.'); continue }
    const product = matches[0]
    row.productId = product.id; row.productName = product.name; row.inventoryVersion = product.inventoryVersion
    if (!product.inventoryConfigured) { rowError(row, 'ابتدا موجودی رنگ و سایز این محصول را در بخش محصولات تنظیم کنید.'); continue }
    const variants = candidates.filter(variant => variant.productId === product.id && variant.size === row.size && normalizeWarehouseImportColor(variant.color) === row.color)
    if (variants.length !== 1) { rowError(row, variants.length ? 'چند رنگ پس از یکسان‌سازی با این رنگ برابرند؛ نام رنگ‌ها را اصلاح کنید.' : 'ترکیب رنگ و سایز موجود نیست؛ این ورود ترکیب جدید ایجاد نمی‌کند.'); continue }
    const variant = variants[0]
    row.variantId = variant.id; row.color = variant.color; row.stockBefore = variant.stock; row.damaged = variant.damagedStock; row.isActive = variant.isActive
    row.reserved = reserved.get(inventoryKey(product.id, variant.size, variant.color)) ?? 0
    if (!variant.isActive) row.warning = 'این ترکیب غیرفعال می‌ماند و موجودی آن قابل فروش نخواهد بود.'
    if (row.quantity !== null) {
      row.stockAfter = mode === 'RECEIPT' ? variant.stock + row.quantity : row.quantity
      if (!Number.isSafeInteger(row.stockAfter) || row.stockAfter < 0 || row.stockAfter > MAX) rowError(row, 'موجودی پس از ثبت از سقف مجاز بیشتر است.')
    }
  }
  // Invalidate every occurrence, including a first row or a malformed quantity.
  const counts = new Map<string, number>()
  for (const row of rows) if (row.variantId) counts.set(row.variantId, (counts.get(row.variantId) ?? 0) + 1)
  for (const row of rows) if (row.variantId && counts.get(row.variantId)! > 1) rowError(row, 'این ترکیب رنگ و سایز در چند ردیف تکرار شده است؛ همهٔ ردیف‌های تکراری را اصلاح کنید.')
  for (const product of products) {
    const valid = rows.filter(row => row.productId === product.id && !row.error)
    if (!valid.length) continue
    const sum = activeSums.get(product.id) ?? 0
    const after = sum + valid.reduce((total, row) => total + (row.isActive ? row.stockAfter! - row.stockBefore! : 0), 0)
    const error = valid.length > MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS ? 'هر محصول حداکثر ۵۰۰ ردیف در یک پیش‌نمایش داشته باشد.'
      : sum !== product.stock ? 'مجموع موجودی محصول با رنگ و سایزها هماهنگ نیست؛ ابتدا آن را بررسی کنید.'
      : product.inventoryVersion >= MAX ? 'نسخهٔ موجودی از سقف مجاز گذشته است.'
      : !Number.isSafeInteger(after) || after < 0 || after > MAX ? 'مجموع موجودی محصول پس از ثبت از سقف مجاز بیشتر است.' : null
    if (error) for (const row of valid) rowError(row, error)
  }
  const valid = rows.filter(row => !row.error && row.variantId)
  const groups = new Map<string, WarehouseImportProduct>()
  for (const row of valid) {
    const group = groups.get(row.productId!) ?? { productId: row.productId!, productName: row.productName!, code: row.code, inventoryVersion: row.inventoryVersion!, rowNumbers: [] }
    group.rowNumbers.push(row.rowNumber); groups.set(group.productId, group)
  }
  const claims: WarehouseImportClaims = { scope: TOKEN_SCOPE, actorId, batchId: randomBytes(16).toString('hex'), expiresAt: Date.now() + TOKEN_LIFETIME, mode, note,
    rows: valid.map(row => ({ rowNumber: row.rowNumber, productId: row.productId!, variantId: row.variantId!, inventoryVersion: row.inventoryVersion!, quantity: row.quantity!, stockBefore: row.stockBefore!, stockAfter: row.stockAfter!, damaged: row.damaged!, isActive: row.isActive! })) }
  const result: WarehouseImportPreview = { token: sign(claims), expiresAt: claims.expiresAt, rows, products: [...groups.values()], summary: { total: rows.length, valid: valid.length, invalid: rows.length - valid.length, products: groups.size } }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PREVIEW_BYTES) throw new ApiInputError('حجم پیش‌نمایش زیاد است؛ فایل را کوچک‌تر کنید.', 413)
  return result
}

export function warehouseImportProduct(claims: WarehouseImportClaims, productId: unknown): SignedRow[] {
  if (typeof productId !== 'string' || !productId || productId.length > 128) throw new ApiInputError('محصول انتخاب‌شده نامعتبر است.')
  const rows = claims.rows.filter(row => row.productId === productId)
  if (!rows.length || rows.length > MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS || rows.some(row => row.inventoryVersion !== rows[0].inventoryVersion)) throw new ApiInputError('محصول انتخاب‌شده در پیش‌نمایش معتبر نیست.')
  return rows
}
function movementKey(claims: WarehouseImportClaims, row: SignedRow) { return `bulk:${claims.actorId}:${claims.batchId}:${row.rowNumber}` }
function fingerprint(claims: WarehouseImportClaims, row: SignedRow) { return JSON.stringify([row.productId, row.variantId, claims.mode, row.quantity, claims.note, null]) }
function confirmation(productId: string, results: WarehouseImportConfirmation['results']): WarehouseImportConfirmation {
  return { productId, results, totals: { success: results.filter(row => row.status === 'success').length, replayed: results.filter(row => row.status === 'replayed').length, error: results.filter(row => row.status === 'error').length } }
}
export function warehouseImportFailure(claims: WarehouseImportClaims, productId: string, error: string) {
  return confirmation(productId, warehouseImportProduct(claims, productId).map(row => ({ rowNumber: row.rowNumber, productId, variantId: row.variantId, status: 'error', error })))
}
async function replay(tx: Prisma.TransactionClient, claims: WarehouseImportClaims, rows: SignedRow[]): Promise<WarehouseImportConfirmation | null> {
  const previous = await tx.stockMovement.findMany({ where: { requestKey: { in: rows.map(row => movementKey(claims, row)) } } })
  if (!previous.length) return null
  if (previous.length !== rows.length) throw new InventoryError('سوابق این ورود ناقص است؛ پیش از ادامه گردش انبار را بررسی کنید.', 409, 'WAREHOUSE_IMPORT_PARTIAL')
  const byKey = new Map<string | null, StockMovement>(previous.map(movement => [movement.requestKey, movement]))
  return confirmation(rows[0].productId, rows.map(row => {
    const movement = byKey.get(movementKey(claims, row))
    if (!movement || movement.fingerprint !== fingerprint(claims, row)) throw new InventoryError('شناسهٔ این ورود با اطلاعات دیگری ثبت شده است.', 409, 'WAREHOUSE_REQUEST_CONFLICT')
    return { rowNumber: row.rowNumber, productId: row.productId, variantId: row.variantId, status: 'replayed', stockBefore: movement.stockBefore, stockAfter: movement.stockAfter }
  }))
}

/** One atomic parent group: bounded writes, no self-conflicts or intermediate totals. */
export async function confirmWarehouseImportProduct(tx: Prisma.TransactionClient, claims: WarehouseImportClaims, productId: string, actor: { id: string; name?: string | null }): Promise<WarehouseImportConfirmation> {
  if (claims.actorId !== actor.id) throw new ApiInputError('پیش‌نمایش متعلق به حساب دیگری است.', 403)
  const rows = warehouseImportProduct(claims, productId)
  const previous = await replay(tx, claims, rows)
  if (previous) return previous
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`
  if (!locked.length) throw new ApiInputError('محصول یافت نشد.', 404)
  const afterLock = await replay(tx, claims, rows)
  if (afterLock) return afterLock
  // Expired tokens can reconcile a lost response, but cannot start new writes.
  if (claims.expiresAt <= Date.now()) throw new ApiInputError('مهلت پیش‌نمایش تمام شده است؛ هیچ ردیفی از این محصول ثبت نشد. دوباره بررسی کنید.', 409)
  const product = await tx.product.findUnique({ where: { id: productId }, include: { variants: { where: { id: { in: rows.map(row => row.variantId) } }, take: MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS } } })
  if (!product || product.inventoryVersion !== rows[0].inventoryVersion || product.inventoryVersion >= MAX) throw new InventoryError('موجودی از زمان پیش‌نمایش تغییر کرده است؛ هیچ ردیفی از این محصول ثبت نشد. دوباره بررسی کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  if (!product.inventoryConfigured) throw new InventoryError('موجودی رنگ و سایز این محصول تنظیم نشده است.', 409, 'INVENTORY_NOT_CONFIGURED')
  const aggregate = await tx.productVariant.aggregate({ where: { productId, isActive: true }, _sum: { stock: true } })
  const activeSum = aggregate._sum.stock ?? 0
  if (activeSum !== product.stock) throw new InventoryError('مجموع موجودی محصول نیاز به بررسی دارد.', 409, 'INVENTORY_CONFLICT')
  const variants = new Map(product.variants.map(variant => [variant.id, variant]))
  for (const row of rows) {
    const variant = variants.get(row.variantId)
    if (!variant || variant.stock !== row.stockBefore || variant.damagedStock !== row.damaged || variant.isActive !== row.isActive) throw new InventoryError('رنگ و سایز از زمان پیش‌نمایش تغییر کرده است؛ دوباره بررسی کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  }
  const stockAfter = activeSum + rows.reduce((sum, row) => sum + (row.isActive ? row.stockAfter - row.stockBefore : 0), 0)
  if (!Number.isSafeInteger(stockAfter) || stockAfter < 0 || stockAfter > MAX) throw new InventoryError('مجموع موجودی محصول پس از ثبت از سقف مجاز بیشتر است.', 409, 'WAREHOUSE_BALANCE_INVALID')
  // All writers use the parent lock. Guarding both old balances and revision
  // also catches an inconsistent variant without leaving partial ledger rows.
  const changed = await tx.product.updateMany({ where: { id: productId, inventoryVersion: rows[0].inventoryVersion }, data: { stock: stockAfter, inventoryVersion: { increment: 1 } } })
  if (changed.count !== 1) throw new InventoryError('موجودی هم‌زمان تغییر کرده است؛ دوباره بررسی کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  const values = Prisma.join(rows.map(row => Prisma.sql`(${row.variantId}, ${row.stockBefore}::integer, ${row.stockAfter}::integer)`))
  const count = await tx.$executeRaw(Prisma.sql`UPDATE "ProductVariant" AS variant SET "stock" = incoming."after" FROM (VALUES ${values}) AS incoming("id", "before", "after") WHERE variant."id" = incoming."id" AND variant."productId" = ${productId} AND variant."stock" = incoming."before"`)
  if (count !== rows.length) throw new InventoryError('موجودی رنگ و سایز هم‌زمان تغییر کرده است؛ دوباره بررسی کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  await tx.stockMovement.createMany({ data: rows.map(row => {
    const variant = variants.get(row.variantId)!
    return { productId, productName: product.name, variantId: variant.id, size: variant.size, color: variant.color, type: claims.mode,
      quantity: claims.mode === 'ADJUSTMENT' ? Math.abs(row.stockAfter - row.stockBefore) : row.quantity,
      stockBefore: row.stockBefore, stockAfter: row.stockAfter, damagedBefore: row.damaged, damagedAfter: row.damaged,
      activeBefore: row.isActive, activeAfter: row.isActive, actorId: actor.id, actorName: actor.name || 'مدیر فروشگاه', note: claims.note,
      requestKey: movementKey(claims, row), fingerprint: fingerprint(claims, row) }
  }) })
  return confirmation(productId, rows.map(row => ({ rowNumber: row.rowNumber, productId, variantId: row.variantId, status: 'success', stockBefore: row.stockBefore, stockAfter: row.stockAfter })))
}
