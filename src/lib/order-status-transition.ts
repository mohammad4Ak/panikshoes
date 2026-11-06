import type { OrderStatus, Prisma } from '@prisma/client'
import { buildInvoiceSnapshot, isInvoiceEligibleStatus } from '@/lib/invoice'
import { readSiteSettings } from '@/lib/site-settings'
import { reacquireCouponReservation, releaseCouponReservation } from '@/lib/coupons'
import { recordOrderInventoryEvent, releaseInventory, reserveInventory } from '@/lib/inventory'

const validStatuses = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const satisfies readonly OrderStatus[]
const orderDetails = {
  user: { select: { name: true, email: true } },
  items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
  invoice: { select: { id: true, issuedAt: true } },
  _count: { select: { receipts: true } },
} as const satisfies Prisma.OrderInclude

export class StatusError extends Error {
  constructor(message: string, readonly status = 409) { super(message) }
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && validStatuses.includes(value as OrderStatus)
}

type TransitionOrder = Pick<Prisma.OrderGetPayload<{ include: typeof orderDetails }>, 'status' | 'paymentMethod' | 'paymentStatus' | 'verified'> & {
  invoice: { id: number } | null
}

/** Shared preflight. Inventory and coupon availability must still be checked in the write transaction. */
export function evaluateOrderStatusTransition(existing: TransitionOrder, nextStatus: OrderStatus) {
  if (existing.paymentMethod === 'bank_transfer' && !existing.verified) {
    if (isInvoiceEligibleStatus(nextStatus)) {
      throw new StatusError('ابتدا واریز این سفارش را در بخش بررسی پرداخت‌ها تأیید کنید')
    }
    if (existing.status === 'CANCELLED' && nextStatus !== 'CANCELLED') {
      throw new StatusError('بازگشایی این سفارش فقط پس از بررسی رسید و تأیید پرداخت امکان‌پذیر است')
    }
    if (existing.paymentStatus === 'AWAITING_REVIEW' && nextStatus === 'CANCELLED') {
      throw new StatusError('این سفارش رسید در انتظار بررسی دارد؛ ابتدا پرداخت را تعیین تکلیف کنید')
    }
  }
  const issueInvoice = isInvoiceEligibleStatus(nextStatus) && !existing.invoice
  if (existing.status === nextStatus && !issueInvoice) return { changed: false, issueInvoice: false }

  // A cancellation is not a return: shipped goods cannot be put back into stock.
  if (existing.status !== nextStatus && (existing.status === 'DELIVERED' ||
      (existing.status === 'SHIPPED' && nextStatus !== 'DELIVERED'))) {
    throw new StatusError('سفارش ارسال‌شده یا تحویل‌شده قابل بازگشت به وضعیت قبلی یا لغو نیست؛ مرجوعی باید جداگانه بررسی شود')
  }
  if (existing.status === 'CANCELLED' && nextStatus !== 'PENDING' && nextStatus !== 'PROCESSING') {
    throw new StatusError('برای بازگشایی سفارش لغوشده ابتدا وضعیت انتظار یا پردازش را انتخاب کنید')
  }
  return { changed: true, issueInvoice }
}

type OrderVersion = { status: OrderStatus; updatedAt: number }
const staleOrderMessage = 'وضعیت سفارش هم‌زمان تغییر کرده است؛ صفحه را تازه کنید'

/** Run inside a transaction to make the status, stock, coupon and invoice changes atomic. */
export async function updateOrderStatus(
  tx: Prisma.TransactionClient,
  id: string,
  nextStatus: OrderStatus,
  actor: { id: string; name?: string | null },
  expected?: OrderVersion,
) {
  const existing = await tx.order.findUnique({ where: { id }, include: orderDetails })
  if (!existing) throw new StatusError('سفارش یافت نشد', 404)
  if (expected && (existing.status !== expected.status || existing.updatedAt.getTime() !== expected.updatedAt)) {
    throw new StatusError('سفارش پس از پیش‌نمایش تغییر کرده است؛ دوباره پیش‌نمایش بگیرید')
  }
  const plan = evaluateOrderStatusTransition(existing, nextStatus)
  if (!plan.changed) return existing

  // Claim before side effects so concurrent requests cannot release or reserve twice.
  const changed = await tx.order.updateMany({
    where: { id, status: existing.status, updatedAt: existing.updatedAt },
    data: {
      status: nextStatus, updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)),
      ...(existing.paymentMethod === 'bank_transfer' && !existing.verified && nextStatus === 'CANCELLED'
        ? { paymentStatus: 'EXPIRED' as const, paymentExpiresAt: null } : {}),
    },
  })
  if (changed.count !== 1) throw new StatusError(staleOrderMessage)

  const context = { orderId: id, actorId: actor.id, actorName: actor.name || undefined }
  if (nextStatus === 'CANCELLED') {
    await releaseInventory(tx, existing.items, { ...context, note: 'لغو سفارش توسط مدیر' })
    if (existing.couponId && !existing.verified) await releaseCouponReservation(tx, id, new Date())
  } else if (existing.status === 'CANCELLED') {
    await reserveInventory(tx, existing.items, { allowLegacy: true, context: { ...context, note: 'رزرو مجدد پس از بازگشایی سفارش' } })
    if (existing.couponId && !existing.verified) await reacquireCouponReservation(tx, id, existing.userId, new Date())
  }

  if (plan.issueInvoice) {
    const settings = await readSiteSettings(tx)
    await tx.invoice.create({ data: { orderId: id, snapshot: { ...buildInvoiceSnapshot(existing, settings.storeName) } } })
    await recordOrderInventoryEvent(tx, existing.items, 'SALE', { ...context, note: 'تأیید سفارش و صدور اولین فاکتور' })
  }
  if (['SHIPPED', 'DELIVERED'].includes(nextStatus) && !['SHIPPED', 'DELIVERED'].includes(existing.status)) {
    await recordOrderInventoryEvent(tx, existing.items, 'SHIPMENT', { ...context, note: 'خروج سفارش برای ارسال' })
  }

  return tx.order.findUnique({ where: { id }, include: orderDetails })
}
