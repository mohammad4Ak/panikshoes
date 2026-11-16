import type { Prisma, PrismaClient } from '@prisma/client'
import { ApiInputError } from '@/lib/api-input'
import { adminOrdersWhere, parseAdminOrdersFilters } from '@/lib/admin-orders'
import { isValidCustomerPhone, isValidPostalCode, normalizePhone, normalizePostalCode } from '@/lib/customer-contact'
import { formatInvoiceNumber, type InvoiceSnapshot } from '@/lib/invoice'
import { ADMIN_ORDER_DOCUMENT_KINDS, ADMIN_ORDER_PRINT_LIMIT, type AdminOrderDocumentKind, type AdminOrderPrintResponse, type AdminOrderPrintRow } from '@/lib/admin-order-print-contract'

const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024
const MAX_DOCUMENT_ITEMS = 500
const FILTER_KEYS = new Set(['q', 'status', 'payment', 'range', 'from', 'to'])
const orderSelect = {
  id: true, status: true, verified: true, createdAt: true,
  recipientName: true, address: true, phone: true, postalCode: true,
  shippingMethodName: true, trackingCode: true,
  invoice: { select: { id: true, issuedAt: true, snapshot: true } },
  items: { select: { id: true, productId: true, productName: true, quantity: true, size: true, color: true }, orderBy: { id: 'asc' }, take: MAX_DOCUMENT_ITEMS + 1 },
} satisfies Prisma.OrderSelect

type PrintOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>
export type OrderDocumentSeller = { name: string; phone: string; address: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(value)
const text = (value: unknown, maximum = 1000, required = true): value is string => typeof value === 'string' && value.length <= maximum && (!required || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const dateString = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const optionalMoney = (value: unknown) => value === undefined || integer(value)

export async function readOrderDocumentJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new ApiInputError('درخواست بیش از حد بزرگ است.', 413)
  if (!request.body) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ApiInputError('درخواست بیش از حد بزرگ است.', 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.') }
  if (!record(value)) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  return value
}

/** Validate and project only known fields; never reconstruct an issued invoice. */
export function storedInvoiceSnapshot(value: unknown, orderId: string): InvoiceSnapshot | null {
  if (!record(value) || value.schemaVersion !== 1 || value.currency !== 'تومان' || value.orderId !== orderId || !dateString(value.orderCreatedAt) ||
      !record(value.seller) || !text(value.seller.name, 300) || !record(value.buyer) || !text(value.buyer.name, 300) || !text(value.buyer.email, 254, false) ||
      !record(value.recipient) || !text(value.recipient.name, 300) || !text(value.recipient.address, 4000) || !text(value.recipient.phone, 100) ||
      !(value.shippingMethodName === null || text(value.shippingMethodName, 300)) || !integer(value.shippingCost) || !integer(value.subtotal) || !integer(value.total) ||
      !optionalMoney(value.productDiscount) || !optionalMoney(value.couponDiscount) || !optionalMoney(value.merchandiseTotal) ||
      !(value.couponCode === undefined || value.couponCode === null || text(value.couponCode, 200)) ||
      !Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_DOCUMENT_ITEMS) return null
  const items: InvoiceSnapshot['items'] = []
  let subtotal = 0, productDiscount = 0, couponDiscount = 0, merchandiseTotal = 0
  for (const item of value.items) {
    if (!record(item) || !validId(item.productId) || !text(item.productName, 1000) || !integer(item.quantity, 1) || !integer(item.size, 1) || !text(item.color, 100) ||
        !integer(item.unitPrice, 1) || !integer(item.lineTotal) || !optionalMoney(item.originalUnitPrice) || !optionalMoney(item.productDiscount) || !optionalMoney(item.couponDiscount)) return null
    const original = item.originalUnitPrice ?? item.unitPrice
    if (typeof original !== 'number' || original < item.unitPrice) return null
    const gross = original * item.quantity
    const saleTotal = item.unitPrice * item.quantity
    const directDiscount = gross - saleTotal
    const allocatedCoupon = item.couponDiscount ?? 0
    if (typeof allocatedCoupon !== 'number' || !integer(gross) || !integer(saleTotal) || allocatedCoupon > saleTotal ||
        item.lineTotal !== saleTotal - allocatedCoupon || (item.productDiscount !== undefined && item.productDiscount !== directDiscount)) return null
    subtotal += gross; productDiscount += directDiscount; couponDiscount += allocatedCoupon; merchandiseTotal += item.lineTotal
    if (![subtotal, productDiscount, couponDiscount, merchandiseTotal].every(amount => integer(amount))) return null
    items.push({ productId: item.productId, productName: item.productName, quantity: item.quantity, size: item.size, color: item.color, unitPrice: item.unitPrice, lineTotal: item.lineTotal,
      ...(item.originalUnitPrice !== undefined ? { originalUnitPrice: item.originalUnitPrice as number } : {}),
      ...(item.productDiscount !== undefined ? { productDiscount: item.productDiscount as number } : {}),
      ...(item.couponDiscount !== undefined ? { couponDiscount: item.couponDiscount as number } : {}),
    })
  }
  if (value.subtotal !== subtotal || (value.productDiscount ?? 0) !== productDiscount || (value.couponDiscount ?? 0) !== couponDiscount ||
      (value.merchandiseTotal !== undefined && value.merchandiseTotal !== merchandiseTotal) || value.total !== merchandiseTotal + value.shippingCost || !integer(merchandiseTotal + value.shippingCost)) return null
  return {
    schemaVersion: 1, currency: 'تومان', orderId, orderCreatedAt: value.orderCreatedAt,
    seller: { name: value.seller.name }, buyer: { name: value.buyer.name, email: value.buyer.email },
    recipient: { name: value.recipient.name, address: value.recipient.address, phone: value.recipient.phone },
    items, subtotal: value.subtotal, shippingMethodName: value.shippingMethodName, shippingCost: value.shippingCost, total: value.total,
    ...(value.productDiscount !== undefined ? { productDiscount: value.productDiscount as number } : {}),
    ...(value.couponDiscount !== undefined ? { couponDiscount: value.couponDiscount as number } : {}),
    ...(value.couponCode !== undefined ? { couponCode: value.couponCode as string | null } : {}),
    ...(value.merchandiseTotal !== undefined ? { merchandiseTotal: value.merchandiseTotal as number } : {}),
  }
}

export function parseOrderDocumentScope(body: Record<string, unknown>, now = new Date()) {
  if (Object.keys(body).some(key => !['kind', 'mode', 'ids', 'filters'].includes(key))) throw new ApiInputError('اطلاعات درخواست معتبر نیست.')
  if (typeof body.kind !== 'string' || !ADMIN_ORDER_DOCUMENT_KINDS.includes(body.kind as AdminOrderDocumentKind)) throw new ApiInputError('نوع مدرک معتبر نیست.')
  const kind = body.kind as AdminOrderDocumentKind
  if (body.mode === 'selected') {
    if (body.filters !== undefined || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > ADMIN_ORDER_PRINT_LIMIT || !body.ids.every(validId) || new Set(body.ids).size !== body.ids.length) throw new ApiInputError('بین ۱ تا ۱۰۰ سفارش با شناسه‌های یکتا انتخاب کنید.')
    const ids = body.ids as string[]
    return { kind, ids, where: { id: { in: ids } } satisfies Prisma.OrderWhereInput }
  }
  if (body.mode !== 'filtered' || body.ids !== undefined || typeof body.filters !== 'string' || body.filters.length > 4096) throw new ApiInputError('محدوده یا فیلتر سفارش‌ها معتبر نیست.')
  const params = new URLSearchParams(body.filters)
  if (Array.from(params.keys()).some(key => !FILTER_KEYS.has(key))) throw new ApiInputError('فیلتر سفارش‌ها معتبر نیست.')
  const filters = parseAdminOrdersFilters(params, now)
  if (!filters.q && filters.status === 'all' && filters.payment === 'all' && filters.range === 'all') throw new ApiInputError('برای چاپ نتایج، ابتدا فیلتر یا بازهٔ زمانی را مشخص کنید.')
  return { kind, ids: undefined, where: adminOrdersWhere(filters) }
}

function documentRow(order: PrintOrder, kind: AdminOrderDocumentKind, seller: OrderDocumentSeller): AdminOrderPrintRow {
  const warnings: string[] = []
  const skipped = (reason: string): AdminOrderPrintRow => ({ id: order.id, status: order.status, eligible: false, reason, warnings, document: null })
  const snapshot = order.invoice ? storedInvoiceSnapshot(order.invoice.snapshot, order.id) : null
  if (kind === 'invoice') {
    if (!order.invoice) return skipped('هنوز فاکتوری برای این سفارش صادر نشده است.')
    if (!snapshot || !integer(order.invoice.id, 1) || !Number.isFinite(order.invoice.issuedAt.getTime())) return skipped('فاکتور ذخیره‌شده ناقص یا نامعتبر است؛ نیاز به بررسی دارد.')
    if (order.status === 'CANCELLED') warnings.push('سفارش لغو شده است؛ فاکتور صرفاً برای حفظ سابقه چاپ می‌شود.')
    if (order.status === 'PENDING') warnings.push('این فاکتور مربوط به تأیید قبلی سفارش است؛ سفارش اکنون در انتظار تأیید است.')
    return { id: order.id, status: order.status, eligible: true, warnings, document: { kind, orderId: order.id, status: order.status, invoice: { id: order.invoice.id, issuedAt: order.invoice.issuedAt.toISOString(), number: formatInvoiceNumber(order.invoice), snapshot } } }
  }
  if (!order.verified || !['PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) return skipped('برگهٔ آماده‌سازی و ارسال فقط برای سفارش پرداخت‌شده و غیرلغوشده آماده می‌شود.')
  if (!Number.isFinite(order.createdAt.getTime())) return skipped('تاریخ ثبت سفارش نامعتبر است.')
  const recipientName = text(order.recipientName, 300) ? order.recipientName : snapshot?.recipient.name ?? 'گیرنده ثبت نشده'
  if (!text(order.recipientName, 300) && !snapshot?.recipient.name) {
    if (kind === 'shipping-label') return skipped('نام گیرنده در سابقهٔ سفارش ذخیره نشده است؛ برچسب ارسال آماده نمی‌شود.')
    warnings.push('نام گیرنده در سفارش ذخیره نشده است؛ پیش از ارسال بررسی کنید.')
  }
  if (!text(order.address, 4000) || !text(order.phone, 100)) return skipped('نشانی یا تلفن گیرنده در سفارش ناقص است.')
  const postalCode = isValidPostalCode(order.postalCode) ? normalizePostalCode(order.postalCode) : null
  if (!postalCode) {
    if (kind === 'shipping-label') return skipped('کدپستی معتبر در این سفارش ذخیره نشده است؛ برچسب ارسال آماده نمی‌شود.')
    warnings.push('کدپستی معتبر در این سفارش ذخیره نشده است.')
  }
  const phoneValid = isValidCustomerPhone(order.phone)
  if (!phoneValid) {
    if (kind === 'shipping-label') return skipped('تلفن گیرنده در این سفارش معتبر نیست؛ پیش از ارسال اصلاح کنید.')
    warnings.push('تلفن گیرنده نیاز به بررسی دارد.')
  }
  if (!text(seller.name, 300)) warnings.push('نام فروشگاه در تنظیمات ثبت نشده است.')
  if (!text(seller.phone, 100)) warnings.push('تلفن فرستنده در تنظیمات فروشگاه ثبت نشده است.')
  if (!text(seller.address, 4000)) warnings.push('نشانی فرستنده در تنظیمات فروشگاه ثبت نشده است.')
  const items: { productName: string; quantity: number; size: number; color: string }[] = []
  if (kind === 'packing') {
    if (!order.items.length || order.items.length > MAX_DOCUMENT_ITEMS) return skipped('فهرست کالاهای سفارش خالی یا بیش از حد بزرگ است؛ نیاز به بررسی دارد.')
    for (const item of order.items) {
      if (!integer(item.quantity, 1) || !integer(item.size, 1) || !text(item.color, 100)) return skipped('تعداد، سایز یا رنگ ذخیره‌شدهٔ کالا نامعتبر است.')
      const savedName = snapshot?.items.find(line => line.productId === item.productId && line.size === item.size && line.color === item.color)?.productName
      const productName = text(item.productName, 1000) ? item.productName : savedName ?? 'کالای ثبت‌شده'
      if (!text(item.productName, 1000) && !savedName && !warnings.includes('نام برخی کالاها در سابقهٔ سفارش ذخیره نشده است؛ قبل از بسته‌بندی تطبیق دهید.')) warnings.push('نام برخی کالاها در سابقهٔ سفارش ذخیره نشده است؛ قبل از بسته‌بندی تطبیق دهید.')
      items.push({ productName, quantity: item.quantity, size: item.size, color: item.color })
    }
  }
  return { id: order.id, status: order.status, eligible: true, warnings, document: {
    kind, orderId: order.id, status: order.status, createdAt: order.createdAt.toISOString(),
    seller: { name: text(seller.name, 300) ? seller.name : 'فروشگاه', phone: text(seller.phone, 100) ? seller.phone : '', address: text(seller.address, 4000) ? seller.address : '' },
    recipient: { name: recipientName, address: order.address, phone: phoneValid ? normalizePhone(order.phone) : order.phone, postalCode },
    shippingMethodName: text(order.shippingMethodName, 300) ? order.shippingMethodName : null,
    trackingCode: text(order.trackingCode, 200) ? order.trackingCode : null, items,
  } }
}

/** Read-only: preparing documents cannot issue invoices, expire orders or reserve stock. */
export async function prepareOrderDocuments(db: Pick<PrismaClient, 'order'>, body: Record<string, unknown>, seller: OrderDocumentSeller, now = new Date()): Promise<AdminOrderPrintResponse> {
  const scope = parseOrderDocumentScope(body, now)
  const orders = await db.order.findMany({ where: scope.where, select: orderSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ADMIN_ORDER_PRINT_LIMIT + 1 })
  if (orders.length > ADMIN_ORDER_PRINT_LIMIT) throw new ApiInputError('بیش از ۱۰۰ سفارش مطابق است؛ فیلتر یا بازهٔ زمانی را محدودتر کنید.', 422)
  const found = new Map(orders.map(order => [order.id, order]))
  const rows = (scope.ids ?? orders.map(order => order.id)).map(id => {
    const order = found.get(id)
    return order ? documentRow(order, scope.kind, seller) : { id, status: null, eligible: false, reason: 'سفارش یافت نشد.', warnings: [], document: null }
  })
  const result: AdminOrderPrintResponse = { kind: scope.kind, generatedAt: now.toISOString(), limit: ADMIN_ORDER_PRINT_LIMIT, rows }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) throw new ApiInputError('حجم مدارک بیش از حد مجاز است؛ تعداد سفارش‌ها یا بازهٔ فیلتر را کمتر کنید.', 413)
  return result
}
