import { createHmac, timingSafeEqual } from 'node:crypto'
import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client'
import { ApiInputError } from '@/lib/api-input'
import { adminOrdersWhere, parseAdminOrdersFilters } from '@/lib/admin-orders'
import { ADMIN_ORDER_BULK_BATCH_SIZE, ADMIN_ORDER_BULK_LIMIT, type AdminOrderBulkPreviewRow, type AdminOrderBulkResult } from '@/lib/admin-order-bulk-contract'
import { CouponError } from '@/lib/coupons'
import { InventoryError } from '@/lib/inventory'
import { evaluateOrderStatusTransition, isOrderStatus, StatusError, updateOrderStatus } from '@/lib/order-status-transition'

const MAX_BODY_BYTES = 64 * 1024
const MAX_TOKEN_CHARS = 48 * 1024
const PREVIEW_TTL = 10 * 60 * 1000
const CONFIRM_BUDGET = 45_000
const FILTER_KEYS = new Set(['q', 'status', 'payment', 'range', 'from', 'to'])
const previewSelect = {
  id: true, status: true, paymentMethod: true, paymentStatus: true, verified: true, updatedAt: true,
  invoice: { select: { id: true } },
} satisfies Prisma.OrderSelect

type Version = { id: string; status: OrderStatus; updatedAt: number }
type Claims = { actorId: string; expiresAt: number; status: OrderStatus; orders: Version[] }

export async function readBulkOrderJson(request: Request): Promise<Record<string, unknown>> {
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

function selectedIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(validId) || new Set(value).size !== value.length) {
    throw new ApiInputError('شناسه‌های سفارش خالی، تکراری یا نامعتبرند.')
  }
  if (value.length > limit) throw new ApiInputError(`در هر درخواست حداکثر ${limit.toLocaleString('fa-IR')} سفارش انتخاب کنید.`)
  return value
}

function sign(payload: string) {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
  if (!secret || secret.length < 16) throw new Error('Bulk order updates require AUTH_SECRET')
  // Use a separate signing context from other previews issued by this shop.
  return createHmac('sha256', secret).update('admin-order-status-bulk:v1.').update(payload).digest('base64url')
}

function signPreview(claims: Claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  if (payload.length + 44 > MAX_TOKEN_CHARS) throw new ApiInputError('پیش‌نمایش بیش از حد بزرگ است؛ تعداد سفارش‌ها را کم کنید.', 413)
  return `${payload}.${sign(payload)}`
}

function verifyPreview(token: unknown, actorId: string): Claims {
  const invalid = () => new ApiInputError('پیش‌نمایش نامعتبر است؛ دوباره پیش‌نمایش بگیرید.')
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) throw invalid()
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw invalid()
  if (!timingSafeEqual(Buffer.from(parts[1], 'ascii'), Buffer.from(sign(parts[0]), 'ascii'))) throw invalid()
  let claims: Claims
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) }
  catch { throw invalid() }
  if (!claims || !isOrderStatus(claims.status) || !Number.isSafeInteger(claims.expiresAt) || !Array.isArray(claims.orders) ||
    claims.orders.length === 0 || claims.orders.length > ADMIN_ORDER_BULK_LIMIT || claims.orders.some(row =>
      !row || !validId(row.id) || !isOrderStatus(row.status) || row.status === claims.status || !Number.isSafeInteger(row.updatedAt))) throw invalid()
  if (claims.actorId !== actorId || claims.expiresAt <= Date.now()) {
    throw new ApiInputError('مهلت پیش‌نمایش تمام شده است یا به حساب دیگری تعلق دارد؛ دوباره پیش‌نمایش بگیرید.', 409)
  }
  return claims
}

export async function previewBulkOrderStatus(db: Pick<PrismaClient, 'order'>, body: Record<string, unknown>, actorId: string) {
  const status = body.status
  if (!isOrderStatus(status)) throw new ApiInputError('وضعیت مقصد معتبر نیست.')
  let ids: string[] | undefined
  let where: Prisma.OrderWhereInput
  if (body.mode === 'selected') {
    ids = selectedIds(body.ids, ADMIN_ORDER_BULK_LIMIT)
    where = { id: { in: ids } }
  } else if (body.mode === 'filtered') {
    if (typeof body.filters !== 'string' || body.filters.length > 4096) throw new ApiInputError('فیلتر سفارش‌ها معتبر نیست.')
    const params = new URLSearchParams(body.filters)
    if (Array.from(params.keys()).some(key => !FILTER_KEYS.has(key))) throw new ApiInputError('فیلتر سفارش‌ها معتبر نیست.')
    const filters = parseAdminOrdersFilters(params)
    if (!filters.q && filters.status === 'all' && filters.payment === 'all' && filters.range === 'all') {
      throw new ApiInputError('برای تغییر گروهی نتایج، ابتدا یک فیلتر مثل بازهٔ زمانی اعمال کنید.')
    }
    where = adminOrdersWhere(filters)
  } else throw new ApiInputError('محدودهٔ سفارش‌ها معتبر نیست.')

  // The list and this query use the same predicates, with no pagination offset.
  // Read-only: preview never expires orders or updates their reservations.
  const orders = await db.order.findMany({ where, select: previewSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: ADMIN_ORDER_BULK_LIMIT + 1 })
  if (orders.length > ADMIN_ORDER_BULK_LIMIT) {
    throw new ApiInputError(`بیش از ${ADMIN_ORDER_BULK_LIMIT.toLocaleString('fa-IR')} سفارش مطابق است؛ فیلتر یا بازهٔ زمانی را محدودتر کنید.`, 422)
  }
  const found = new Map(orders.map(order => [order.id, order]))
  const versions: Version[] = []
  const rows: AdminOrderBulkPreviewRow[] = (ids ?? orders.map(order => order.id)).map(id => {
    const order = found.get(id)
    if (!order) return { id, status: null, eligible: false, reason: 'سفارش یافت نشد.' }
    if (order.status === status) return { id, status, eligible: false, reason: 'سفارش از قبل در همین وضعیت است.' }
    try { evaluateOrderStatusTransition(order, status) }
    catch (error) {
      if (!(error instanceof StatusError)) throw error
      return { id, status: order.status, eligible: false, reason: error.message }
    }
    versions.push({ id, status: order.status, updatedAt: order.updatedAt.getTime() })
    return { id, status: order.status, eligible: true }
  })
  return { token: versions.length ? signPreview({ actorId, status, orders: versions, expiresAt: Date.now() + PREVIEW_TTL }) : null,
    rows, limit: ADMIN_ORDER_BULK_LIMIT }
}

export async function confirmBulkOrderStatus(db: Pick<PrismaClient, '$transaction'>, body: Record<string, unknown>, actor: { id: string; name?: string | null }) {
  const startedAt = Date.now()
  const claims = verifyPreview(body.token, actor.id)
  const ids = selectedIds(body.ids, ADMIN_ORDER_BULK_BATCH_SIZE)
  const versions = new Map(claims.orders.map(order => [order.id, order]))
  if (ids.some(id => !versions.has(id))) throw new ApiInputError('همهٔ سفارش‌ها باید در همین پیش‌نمایش قابل تغییر باشند.')

  const results: AdminOrderBulkResult[] = []
  for (const id of ids) {
    // Return a result for every row before the serverless request times out.
    if (Date.now() - startedAt >= CONFIRM_BUDGET) {
      results.push({ id, outcome: 'skipped', reason: 'مهلت پردازش این دسته تمام شد؛ دوباره پیش‌نمایش بگیرید.' })
      continue
    }
    try {
      await db.$transaction(tx => updateOrderStatus(tx, id, claims.status, actor, versions.get(id)!), { maxWait: 3000, timeout: 8000 })
      results.push({ id, outcome: 'updated' })
    } catch (error) {
      if (error instanceof StatusError || error instanceof InventoryError || error instanceof CouponError) {
        results.push({ id, outcome: 'skipped', reason: error.message })
      } else {
        results.push({ id, outcome: 'error', reason: 'تغییر وضعیت انجام نشد؛ وضعیت سفارش را بررسی و دوباره پیش‌نمایش بگیرید.' })
      }
    }
  }
  return { results }
}
