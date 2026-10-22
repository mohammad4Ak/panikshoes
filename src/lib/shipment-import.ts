import { createHmac, timingSafeEqual } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { Prisma } from '@prisma/client'
import { ApiInputError } from '@/lib/api-input'
import { isValidCustomerPhone, isValidPostalCode, normalizePhone, normalizePostalCode } from '@/lib/customer-contact'
import { recordOrderInventoryEvent } from '@/lib/inventory'
import { nextOrderVersion } from '@/lib/payments'

export const MAX_SHIPMENT_FILE_BYTES = 4 * 1024 * 1024
export const MAX_SHIPMENT_ROWS = 1000
export const MAX_SHIPMENT_PREVIEW_TOKEN_CHARS = 1_500_000
export const MAX_SHIPMENT_PREVIEW_RESPONSE_BYTES = 3_000_000
const MAX_COLUMNS = 100
const MAX_CONFIRM_ROWS = 25
// Matches the bounded reader in the confirmation route, with no reliance on
// current CUID lengths when estimating the largest possible choice batch.
const MAX_CONFIRM_BODY_BYTES = 1_600_000
const TOKEN_LIFETIME = 10 * 60 * 1000
type MatchBy = 'phone' | 'postalCode'
export type ShipmentCell = { text: string; error?: string }
export type ShipmentSheet = { name: string; rows: { rowNumber: number; cells: ShipmentCell[] }[]; columnCount: number }
export type ShipmentSourceRow = { rowNumber: number; matchValue: string; trackingCode: string; orderReference?: string }
type Candidate = {
  id: string; recipientName: string; phone: string; postalCode: string | null; status: string;
  trackingCode: string | null; updatedAt: string; createdAt: string; shippingMethodName: string | null; total: number;
}
export type ShipmentPreviewRow = ShipmentSourceRow & { candidates: Candidate[]; error?: string }
type SignedRow = { rowNumber: number; matchValue: string; trackingCode: string; candidates: { id: string; updatedAt: string; trackingCode: string | null; status: string }[] }
type Claims = { actorId: string; expiresAt: number; matchBy: MatchBy; markShipped: boolean; rows: SignedRow[] }

export async function readShipmentJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > limit || !request.body) throw new ApiInputError('اطلاعات درخواست نامعتبر یا بیش از حد بزرگ است.', 413)
  const reader = request.body.getReader(), chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new ApiInputError('اطلاعات درخواست بیش از حد بزرگ است.', 413) }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiInputError('اطلاعات درخواست باید JSON معتبر باشد.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  return body as Record<string, unknown>
}

function digits(value: string) {
  return value.replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632))
}

// A numeric Excel phone cell loses the national prefix zero. Restoring that
// unambiguous Iranian prefix is safe; tracking/postal identifiers are not guessed.
export function normalizeShipmentPhone(value: string) {
  let phone = normalizePhone(value)
  if (/^98\d{10}$/.test(phone)) phone = '0' + phone.slice(2)
  if (/^[1-9]\d{9}$/.test(phone)) phone = '0' + phone
  return phone
}

export function normalizeTrackingCode(value: unknown): string {
  if (typeof value !== 'string') throw new ApiInputError('کد رهگیری باید متن باشد؛ ستون اکسل را روی Text بگذارید.')
  const result = digits(value).trim().replace(/[\s\u200c\u200e\u200f-]/g, '').toUpperCase()
  if (!/^[A-Z0-9]{6,40}$/.test(result)) throw new ApiInputError('کد رهگیری باید بین ۶ تا ۴۰ رقم یا حرف انگلیسی باشد.')
  return result
}

function matchValue(value: unknown, matchBy: MatchBy) {
  if (typeof value !== 'string' || value.length > 100) throw new ApiInputError('شماره تلفن یا کدپستی نامعتبر است.')
  const result = matchBy === 'phone' ? normalizeShipmentPhone(value) : normalizePostalCode(value)
  if (!(matchBy === 'phone' ? isValidCustomerPhone(result) : isValidPostalCode(result))) throw new ApiInputError(matchBy === 'phone' ? 'شماره تلفن باید ۱۱ رقمی و با صفر باشد.' : 'کدپستی باید ۱۰ رقمی و معتبر باشد.')
  return result
}

// Check the ZIP directory before ExcelJS inflates it. A small uploaded archive
// must not expand into an unbounded workbook in a serverless process.
export function validateShipmentZip(buffer: Buffer) {
  if (buffer.length < 22 || buffer.length > MAX_SHIPMENT_FILE_BYTES || buffer.readUInt32LE(0) !== 0x04034b50) throw new ApiInputError('فایل معتبر xlsx با حداکثر حجم ۴ مگابایت انتخاب کنید.')
  let end = -1
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 65557); position--) {
    if (buffer.readUInt32LE(position) === 0x06054b50) { end = position; break }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new ApiInputError('ساختار فایل اکسل پشتیبانی نمی‌شود.')
  const entries = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16)
  if (!entries || entries > 2000 || start + size !== end || buffer.readUInt16LE(end + 8) !== entries) throw new ApiInputError('ساختار فایل اکسل پشتیبانی نمی‌شود.')
  let position = start, inflated = 0, sheets = 0
  for (let index = 0; index < entries; index++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new ApiInputError('ساختار فایل اکسل نامعتبر است.')
    const flags = buffer.readUInt16LE(position + 8), method = buffer.readUInt16LE(position + 10)
    const compressed = buffer.readUInt32LE(position + 20), uncompressed = buffer.readUInt32LE(position + 24)
    const nameLength = buffer.readUInt16LE(position + 28), extra = buffer.readUInt16LE(position + 30), comment = buffer.readUInt16LE(position + 32), local = buffer.readUInt32LE(position + 42)
    if (flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff) throw new ApiInputError('فایل رمزدار یا این نوع اکسل پشتیبانی نمی‌شود.')
    inflated += uncompressed
    if (inflated > 20 * 1024 * 1024) throw new ApiInputError('محتوای فایل اکسل بیش از حد بزرگ است؛ فایل کوچک‌تری بارگذاری کنید.')
    if (position + 46 + nameLength > end || local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50) throw new ApiInputError('ساختار فایل اکسل نامعتبر است.')
    const fileName = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8')
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    if (dataStart + compressed > start || buffer.readUInt16LE(local + 8) !== method) throw new ApiInputError('ساختار فایل اکسل نامعتبر است.')
    let content: Buffer
    try {
      content = method === 0 ? buffer.subarray(dataStart, dataStart + compressed)
        : inflateRawSync(buffer.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.min(uncompressed + 1, 20 * 1024 * 1024 + 1) })
    } catch { throw new ApiInputError('محتوای فایل اکسل نامعتبر یا بیش از حد بزرگ است.') }
    if (content.length !== uncompressed) throw new ApiInputError('اندازهٔ محتوای فایل اکسل نامعتبر است.')
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(fileName)) {
      if (++sheets > 10) throw new ApiInputError('فایل باید حداکثر ۱۰ برگه داشته باشد.')
      const xml = content.toString('utf8')
      let merges = 0
      for (const match of xml.matchAll(/<(?:\w+:)?row\b[^>]*\br\s*=\s*["']([^"']+)["']/g)) {
        if (!/^\d+$/.test(match[1]) || Number(match[1]) > MAX_SHIPMENT_ROWS + 20) throw new ApiInputError('شمارهٔ ردیف‌های اکسل بیش از حد بزرگ است.')
      }
      for (const match of xml.matchAll(/<(?:\w+:)?(c|mergeCell)\b[^>]*\b(?:r|ref)\s*=\s*["']([^"']+)["']/g)) {
        if (match[1] === 'mergeCell' && ++merges > 100) throw new ApiInputError('تعداد سلول‌های ادغام‌شده بیش از حد است؛ فایل ساده‌تری بسازید.')
        for (const reference of match[2].split(':')) {
          const cell = /^([A-Z]+)(\d+)$/.exec(reference)
          if (!cell) throw new ApiInputError('ساختار سلول‌های اکسل نامعتبر است.')
          const column = Array.from(cell[1]).reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0)
          if (column > MAX_COLUMNS || Number(cell[2]) > MAX_SHIPMENT_ROWS + 20) throw new ApiInputError('هر برگه حداکثر ۱۰۰۰ ردیف داده و ۱۰۰ ستون داشته باشد.')
        }
      }
    }
    position += 46 + nameLength + extra + comment
    if (position > end) throw new ApiInputError('ساختار فایل اکسل نامعتبر است.')
  }
  if (position !== end) throw new ApiInputError('ساختار فایل اکسل نامعتبر است.')
}

export function shipmentCell(value: unknown, formattedText?: string): ShipmentCell {
  if (value === null || value === undefined) return { text: '' }
  if (typeof value === 'string') return value.length > 250 ? { text: value.slice(0, 250), error: 'متن سلول بیش از حد بلند است.' } : { text: value.trim() }
  if (typeof value === 'number') {
    // Excel stores only 15 significant decimal digits. Never accept a rounded
    // postal tracking number, even when JavaScript considers it a safe integer.
    if (!Number.isSafeInteger(value) || value < 0 || String(value).length > 15) return { text: String(value), error: 'عدد طولانی در اکسل ممکن است گرد شده باشد؛ کد صحیح را به صورت متن وارد کنید.' }
    const formatted = formattedText?.trim()
    return { text: formatted && /^\d+$/.test(formatted) ? formatted : String(value) }
  }
  if (typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return shipmentCell(value.richText.map(part => typeof part?.text === 'string' ? part.text : '').join(''))
  }
  return { text: '', error: 'فرمول، تاریخ و سلول غیرمتنی را به متن ساده تبدیل کنید.' }
}

export async function parseShipmentWorkbook(buffer: Buffer): Promise<ShipmentSheet[]> {
  validateShipmentZip(buffer)
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  try { await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]) }
  catch { throw new ApiInputError('فایل اکسل خوانده نشد؛ یک فایل سالم با پسوند xlsx انتخاب کنید.') }
  if (!workbook.worksheets.length || workbook.worksheets.length > 10) throw new ApiInputError('فایل باید بین ۱ تا ۱۰ برگه داشته باشد.')
  let allRows = 0
  return workbook.worksheets.map(sheet => {
    if (sheet.rowCount > MAX_SHIPMENT_ROWS + 20 || sheet.columnCount > MAX_COLUMNS) throw new ApiInputError('هر برگه حداکثر ۱۰۰۰ ردیف داده و ۱۰۰ ستون داشته باشد؛ ردیف‌ها و ستون‌های خالی اضافی را حذف کنید.')
    const rows: ShipmentSheet['rows'] = []
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells = Array.from({ length: sheet.columnCount }, (_, index) => {
        const cell = row.getCell(index + 1)
        return shipmentCell(cell.value, cell.text)
      })
      if (cells.some(cell => cell.text || cell.error)) rows.push({ rowNumber: row.number, cells })
    })
    allRows += rows.length
    if (allRows > 3000) throw new ApiInputError('فایل بیش از حد ردیف دارد؛ فقط برگه‌های مورد نیاز را نگه دارید.')
    return { name: sheet.name, columnCount: sheet.columnCount, rows }
  })
}

function signingKey() {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
  if (!secret || secret.length < 16) throw new Error('Shipment import requires AUTH_SECRET')
  return secret
}

function signClaims(claims: Claims) {
  const encoded = Buffer.from(JSON.stringify(claims))
  // An unpadded base64url payload needs ceil(4n/3) characters, followed by
  // the separator and 43-character SHA-256 signature. Keep successful previews
  // within both the verifier limit and the confirmation request's byte budget.
  const tokenLength = Math.ceil(encoded.length * 4 / 3) + 44
  if (tokenLength > MAX_SHIPMENT_PREVIEW_TOKEN_CHARS) throw previewTooLarge()
  const choiceSizes = claims.rows.map(row => Math.max(0, ...row.candidates.map(candidate => Buffer.byteLength(JSON.stringify({ rowNumber: row.rowNumber, orderId: candidate.id, overwrite: false }), 'utf8'))))
    .sort((left, right) => right - left).slice(0, MAX_CONFIRM_ROWS)
  const confirmationBytes = Buffer.byteLength('{"token":"","choices":[]}', 'utf8') + tokenLength + choiceSizes.reduce((total, size) => total + size, 0) + Math.max(0, choiceSizes.length - 1)
  if (confirmationBytes > MAX_CONFIRM_BODY_BYTES) throw previewTooLarge()
  const payload = encoded.toString('base64url')
  return payload + '.' + createHmac('sha256', signingKey()).update(payload).digest('base64url')
}

function previewTooLarge() {
  return new ApiInputError('حجم پیش‌نمایش به‌دلیل تعداد ردیف‌ها یا سفارش‌های مطابق زیاد است؛ فایل را به بخش‌های کوچک‌تر تقسیم کنید یا ستون شمارهٔ سفارش را مشخص کنید.', 413)
}

export function verifyShipmentPreview(token: unknown, actorId: string): Claims {
  if (typeof token !== 'string' || token.length > MAX_SHIPMENT_PREVIEW_TOKEN_CHARS) throw new ApiInputError('پیش‌نمایش نامعتبر است؛ دوباره بررسی کنید.')
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new ApiInputError('پیش‌نمایش نامعتبر است؛ دوباره بررسی کنید.')
  const actual = Buffer.from(parts[1], 'base64url'), expected = createHmac('sha256', signingKey()).update(parts[0]).digest()
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiInputError('پیش‌نمایش نامعتبر است؛ دوباره بررسی کنید.')
  let claims: Claims
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch { throw new ApiInputError('پیش‌نمایش نامعتبر است.') }
  if (claims.actorId !== actorId || !Number.isFinite(claims.expiresAt) || claims.expiresAt <= Date.now() || !Array.isArray(claims.rows) || claims.rows.length > MAX_SHIPMENT_ROWS) throw new ApiInputError('مهلت پیش‌نمایش تمام شده است یا متعلق به حساب دیگری است؛ دوباره بررسی کنید.', 409)
  return claims
}

export function parseShipmentPreviewInput(body: Record<string, unknown>) {
  if (body.matchBy !== 'phone' && body.matchBy !== 'postalCode') throw new ApiInputError('روش تطبیق را انتخاب کنید.')
  if (typeof body.markShipped !== 'boolean' || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_SHIPMENT_ROWS) throw new ApiInputError('بین ۱ تا ۱۰۰۰ ردیف وارد کنید.')
  const matchBy: MatchBy = body.matchBy
  const numbers = new Set<number>(), identical = new Set<string>()
  const rows: ShipmentPreviewRow[] = body.rows.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiInputError('ردیف فایل نامعتبر است.')
    const data = input as Record<string, unknown>
    const rowNumber = data.rowNumber
    if (!Number.isSafeInteger(rowNumber) || (rowNumber as number) < 1 || numbers.has(rowNumber as number)) throw new ApiInputError('شمارهٔ ردیف‌ها نامعتبر یا تکراری است.')
    numbers.add(rowNumber as number)
    const row: ShipmentPreviewRow = { rowNumber: rowNumber as number, matchValue: '', trackingCode: '', candidates: [] }
    try {
      row.matchValue = matchValue(data.matchValue, matchBy)
      row.trackingCode = normalizeTrackingCode(data.trackingCode)
      if (data.orderReference !== undefined && data.orderReference !== '') {
        if (typeof data.orderReference !== 'string' || !/^[a-zA-Z0-9_-]{6,80}$/.test(data.orderReference.trim().replace(/^#/, ''))) throw new ApiInputError('شمارهٔ سفارش باید شناسهٔ کامل یا حداقل ۶ نویسهٔ آخر آن باشد.')
        row.orderReference = data.orderReference.trim().replace(/^#/, '').toLowerCase()
      }
      const identity = [row.matchValue, row.trackingCode, row.orderReference ?? ''].join(':')
      if (identical.has(identity)) row.error = 'این ردیف تکرار ردیف قبلی است و ثبت نمی‌شود.'
      identical.add(identity)
    } catch (error) { row.error = error instanceof Error ? error.message : 'اطلاعات ردیف نامعتبر است.' }
    return row
  })
  const trackingCounts = new Map<string, number>()
  for (const row of rows) if (!row.error) trackingCounts.set(row.trackingCode, (trackingCounts.get(row.trackingCode) ?? 0) + 1)
  for (const row of rows) if (!row.error && trackingCounts.get(row.trackingCode)! > 1) row.error = 'این کد رهگیری برای چند ردیف متفاوت آمده است؛ ابتدا فایل را بررسی کنید.'
  return { matchBy, markShipped: body.markShipped, rows }
}

// Normalize the ORDER snapshot in SQL as well, so Persian digits and historic
// +98/0098 formats match without reading every customer's personal information.
async function findCandidates(tx: Prisma.TransactionClient, keys: string[], matchBy: MatchBy, markShipped: boolean) {
  if (!keys.length) return []
  const column = matchBy === 'phone' ? Prisma.sql`"phone"` : Prisma.sql`"postalCode"`
  const rawDigits = Prisma.sql`translate(regexp_replace(COALESCE(${column}, ''), '[^0-9۰-۹٠-٩]', '', 'g'), '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789')`
  const normalized = matchBy === 'postalCode' ? rawDigits : Prisma.sql`CASE WHEN length(${rawDigits}) = 12 AND left(${rawDigits}, 2) = '98' THEN '0' || substring(${rawDigits}, 3) WHEN length(${rawDigits}) = 14 AND left(${rawDigits}, 4) = '0098' THEN '0' || substring(${rawDigits}, 5) WHEN length(${rawDigits}) = 10 THEN '0' || ${rawDigits} ELSE ${rawDigits} END`
  const ids = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "Order" WHERE "verified" = true AND ("status" = 'SHIPPED' OR (${markShipped} AND "status" = 'PROCESSING')) AND ${normalized} IN (${Prisma.join(keys)}) ORDER BY "createdAt" DESC LIMIT 5001`)
  if (ids.length > 5000) throw new ApiInputError('تعداد سفارش‌های مطابق زیاد است؛ فایل را به چند بخش تقسیم کنید.')
  return tx.order.findMany({ where: { id: { in: ids.map(order => order.id) } }, select: {
    id: true, recipientName: true, phone: true, postalCode: true, status: true, verified: true,
    trackingCode: true, updatedAt: true, createdAt: true, shippingMethodName: true, total: true,
    user: { select: { name: true } }, invoice: { select: { id: true } },
  }, orderBy: { createdAt: 'desc' } })
}

export async function previewShipmentImport(tx: Prisma.TransactionClient, body: Record<string, unknown>, actorId: string) {
  const { matchBy, markShipped, rows } = parseShipmentPreviewInput(body)
  const orders = await findCandidates(tx, Array.from(new Set(rows.filter(row => !row.error).map(row => row.matchValue))), matchBy, markShipped)
  for (const row of rows) {
    if (row.error) continue
    const matches = orders.filter(order => {
      if (!order.verified || !['SHIPPED', ...(markShipped ? ['PROCESSING'] : [])].includes(order.status)) return false
      if (order.status === 'PROCESSING' && !order.invoice) return false
      const snapshot = matchBy === 'phone' ? normalizeShipmentPhone(order.phone) : normalizePostalCode(order.postalCode ?? '')
      return snapshot === row.matchValue && (!row.orderReference || order.id.toLowerCase().endsWith(row.orderReference))
    })
    if (matches.length > 20) { row.error = 'بیش از ۲۰ سفارش مطابق وجود دارد؛ ستون شمارهٔ سفارش را نیز مشخص کنید.'; continue }
    row.candidates = matches.map(order => ({
      id: order.id, recipientName: order.recipientName || order.user.name, phone: order.phone, postalCode: order.postalCode,
      status: order.status, trackingCode: order.trackingCode, updatedAt: order.updatedAt.toISOString(),
      createdAt: order.createdAt.toISOString(), shippingMethodName: order.shippingMethodName, total: order.total,
    }))
    if (!matches.length) row.error = 'سفارش پرداخت‌شده و واجد شرایط با این مشخصات پیدا نشد.'
  }
  const claims: Claims = { actorId, expiresAt: Date.now() + TOKEN_LIFETIME, matchBy, markShipped,
    rows: rows.filter(row => !row.error).map(row => ({ rowNumber: row.rowNumber, matchValue: row.matchValue, trackingCode: row.trackingCode,
      candidates: row.candidates.map(({ id, updatedAt, trackingCode, status }) => ({ id, updatedAt, trackingCode, status })) })) }
  const result = { rows, token: signClaims(claims), expiresAt: new Date(claims.expiresAt).toISOString() }
  // Candidate labels contain Persian text, so count actual UTF-8 bytes rather
  // than JS string characters. Never return a preview that the host truncates.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SHIPMENT_PREVIEW_RESPONSE_BYTES) throw previewTooLarge()
  return result
}

export type ShipmentChoice = { rowNumber: number; orderId: string; overwrite: boolean }
export function shipmentChoices(body: Record<string, unknown>, claims: Claims): ShipmentChoice[] {
  if (!Array.isArray(body.choices) || !body.choices.length || body.choices.length > MAX_CONFIRM_ROWS) throw new ApiInputError('در هر درخواست بین ۱ تا ۲۵ ردیف انتخاب کنید.')
  const orders = new Set<string>(), rows = new Set<number>(), tracking = new Set<string>()
  return body.choices.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiInputError('انتخاب سفارش نامعتبر است.')
    const choice = input as ShipmentChoice, source = claims.rows.find(row => row.rowNumber === choice.rowNumber)
    if (!source || typeof choice.orderId !== 'string' || !source.candidates.some(order => order.id === choice.orderId) || typeof choice.overwrite !== 'boolean') throw new ApiInputError('انتخاب سفارش با پیش‌نمایش تطبیق ندارد.')
    if (orders.has(choice.orderId) || rows.has(choice.rowNumber) || tracking.has(source.trackingCode)) throw new ApiInputError('یک سفارش یا کد رهگیری چند بار انتخاب شده است؛ ابتدا ردیف‌های تکراری را اصلاح کنید.')
    orders.add(choice.orderId); rows.add(choice.rowNumber); tracking.add(source.trackingCode)
    return { rowNumber: choice.rowNumber, orderId: choice.orderId, overwrite: choice.overwrite }
  })
}

export async function confirmShipmentRow(tx: Prisma.TransactionClient, claims: Claims, choice: ShipmentChoice, actor: { id: string; name?: string | null }) {
  const source = claims.rows.find(row => row.rowNumber === choice.rowNumber)
  const snapshot = source?.candidates.find(order => order.id === choice.orderId)
  if (!source || !snapshot) throw new ApiInputError('سفارش در پیش‌نمایش وجود ندارد.')
  const order = await tx.order.findUnique({ where: { id: choice.orderId }, include: { items: true, invoice: { select: { id: true } } } })
  if (!order || !order.verified || !['SHIPPED', ...(claims.markShipped ? ['PROCESSING'] : [])].includes(order.status)) throw new ApiInputError('وضعیت سفارش تغییر کرده یا پرداخت تأیید نشده است؛ دوباره پیش‌نمایش بگیرید.', 409)
  if (matchValue(claims.matchBy === 'phone' ? order.phone : order.postalCode ?? '', claims.matchBy) !== source.matchValue) throw new ApiInputError('اطلاعات گیرنده تغییر کرده است؛ دوباره پیش‌نمایش بگیرید.', 409)
  // A retried confirmation after a lost response is a no-op. It cannot produce
  // a second shipment event or change the tracking timestamp.
  if (order.trackingCode === source.trackingCode && order.status === 'SHIPPED') return { rowNumber: source.rowNumber, orderId: order.id, status: 'unchanged' as const }
  if (order.updatedAt.toISOString() !== snapshot.updatedAt || order.trackingCode !== snapshot.trackingCode || order.status !== snapshot.status) throw new ApiInputError('سفارش از زمان پیش‌نمایش تغییر کرده است؛ دوباره بررسی کنید.', 409)
  if (order.trackingCode && order.trackingCode !== source.trackingCode && !choice.overwrite) throw new ApiInputError('سفارش کد رهگیری دیگری دارد؛ جایگزینی باید صریحاً تأیید شود.', 409)
  if (order.status === 'PROCESSING' && !order.invoice) throw new ApiInputError('ابتدا سفارش را تأیید و فاکتور آن را صادر کنید.', 409)
  const nextVersion = nextOrderVersion(order.updatedAt)
  const changed = await tx.order.updateMany({ where: { id: order.id, updatedAt: order.updatedAt, status: order.status, verified: true, trackingCode: order.trackingCode },
    data: { trackingCode: source.trackingCode, trackingRecordedAt: new Date(), status: 'SHIPPED', updatedAt: nextVersion } })
  if (changed.count !== 1) throw new ApiInputError('سفارش هم‌زمان تغییر کرده است؛ دوباره پیش‌نمایش بگیرید.', 409)
  if (order.status === 'PROCESSING') await recordOrderInventoryEvent(tx, order.items, 'SHIPMENT', { orderId: order.id, actorId: actor.id, actorName: actor.name || undefined, note: 'ثبت تحویل مرسوله همراه کد رهگیری توسط مدیر' })
  return { rowNumber: source.rowNumber, orderId: order.id, status: 'saved' as const }
}
