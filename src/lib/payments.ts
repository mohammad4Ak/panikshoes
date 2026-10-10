import { prisma } from '@/lib/prisma'
import { PAYMENT_WINDOW_MS, MAX_RECEIPT_BYTES, isValidCardNumber } from '@/lib/payment-contract'
import { isSameOriginRequest } from '@/lib/request-origin'

export { PAYMENT_WINDOW_MS } from '@/lib/payment-contract'
export const privatePaymentHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export const receiptMetadataSelect = {
  id: true, orderId: true, mimeType: true, payerCardLast4: true,
  transferReference: true, isLate: true, status: true, reviewNote: true,
  reviewerId: true, reviewedAt: true, createdAt: true,
} as const

export class PaymentError extends Error {
  constructor(message: string, readonly status = 409, readonly code?: string) { super(message) }
}

export function requireSameOrigin(request: Request): void {
  if (!isSameOriginRequest(request)) throw new PaymentError('درخواست از مبدأ نامعتبر ارسال شده است.', 403)
}

export function paymentDeadline(now = new Date()): Date {
  return new Date(now.getTime() + PAYMENT_WINDOW_MS)
}

export function nextOrderVersion(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1))
}

export function paymentQuantities(items: { productId: string; quantity: number }[]) {
  const totals = new Map<string, number>()
  for (const item of items) totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity)
  return [...totals].sort(([left], [right]) => left.localeCompare(right))
}

export function methodAvailability(method: { id: string; cardNumber: string | null; cardholderName: string | null }) {
  const available = method.id === 'bank_transfer' && isValidCardNumber(method.cardNumber ?? '') && Boolean(method.cardholderName?.trim())
  return {
    available,
    unavailableReason: available ? null : method.id === 'zarinpal'
      ? 'اتصال زرین‌پال هنوز تکمیل نشده است.' : 'شماره کارت و نام صاحب کارت را ثبت کنید.',
  }
}

// Every mutation claims the order version before changing stock. Expiration,
// upload, cancellation and review therefore cannot release/reserve it twice.
export async function expireUnpaidOrders(now = new Date(), orderId?: string): Promise<number> {
  const candidates = await prisma.order.findMany({
    where: { ...(orderId ? { id: orderId } : {}), paymentMethod: 'bank_transfer', status: 'PENDING', verified: false,
      paymentStatus: { in: ['AWAITING_RECEIPT', 'REJECTED'] }, paymentExpiresAt: { lte: now } },
    select: { id: true }, orderBy: { paymentExpiresAt: 'asc' }, take: 100,
  })
  let expired = 0
  for (const candidate of candidates) {
    expired += await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: candidate.id }, include: { items: true } })
      if (!order || order.status !== 'PENDING' || order.verified ||
          !['AWAITING_RECEIPT', 'REJECTED'].includes(order.paymentStatus) ||
          !order.paymentExpiresAt || order.paymentExpiresAt > now) return 0
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING', verified: false, paymentStatus: order.paymentStatus,
          updatedAt: order.updatedAt, paymentExpiresAt: { lte: now } },
        data: { status: 'CANCELLED', paymentStatus: 'EXPIRED', paymentExpiresAt: null, updatedAt: nextOrderVersion(order.updatedAt) },
      })
      if (claimed.count !== 1) return 0
      for (const [productId, quantity] of paymentQuantities(order.items)) {
        await tx.product.update({ where: { id: productId }, data: { stock: { increment: quantity } } })
      }
      return 1
    })
  }
  return expired
}

function cancellationDetails(order: {
  id: string; status: string; verified: boolean; paymentStatus: string;
  paymentExpiresAt: Date | null; updatedAt: Date;
}) {
  return {
    id: order.id, status: order.status, verified: order.verified,
    paymentStatus: order.paymentStatus, paymentExpiresAt: order.paymentExpiresAt,
    updatedAt: order.updatedAt,
  }
}

// A cancelled order remains in the customer's history. Receipt review has its
// own workflow because submitted evidence may represent a real bank transfer.
export async function cancelUnpaidOrder(orderId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId }, include: { items: true, invoice: { select: { id: true } } },
    })
    if (!order || order.userId !== userId) throw new PaymentError('سفارش یافت نشد.', 404)
    const alreadyCancelled = (candidate: typeof order) =>
      candidate.paymentMethod === 'bank_transfer' && !candidate.verified && !candidate.invoice &&
      candidate.status === 'CANCELLED' && ['UNPAID', 'EXPIRED', 'REJECTED'].includes(candidate.paymentStatus)

    if (alreadyCancelled(order)) return cancellationDetails(order)
    if (order.paymentStatus === 'AWAITING_REVIEW') {
      throw new PaymentError('رسید پرداخت در انتظار بررسی است؛ برای انصراف با پشتیبانی تماس بگیرید.', 409, 'PAYMENT_AWAITING_REVIEW')
    }
    if (order.paymentMethod !== 'bank_transfer' || order.verified || order.invoice ||
        order.status !== 'PENDING' || !order.paymentExpiresAt ||
        !['AWAITING_RECEIPT', 'REJECTED'].includes(order.paymentStatus)) {
      throw new PaymentError('امکان انصراف از پرداخت برای این وضعیت سفارش وجود ندارد.', 409, 'PAYMENT_CANNOT_CANCEL')
    }

    const updatedAt = nextOrderVersion(order.updatedAt)
    const claimed = await tx.order.updateMany({
      where: { id: order.id, userId, paymentMethod: 'bank_transfer', status: 'PENDING',
        verified: false, paymentStatus: order.paymentStatus, updatedAt: order.updatedAt },
      data: { status: 'CANCELLED', paymentStatus: 'UNPAID', paymentExpiresAt: null, updatedAt },
    })
    if (claimed.count !== 1) {
      // A repeated click or a deadline sweep may have released the same
      // reservation while this request waited for the order's row lock.
      const latest = await tx.order.findUnique({
        where: { id: order.id }, include: { items: true, invoice: { select: { id: true } } },
      })
      if (latest?.userId === userId && alreadyCancelled(latest)) return cancellationDetails(latest)
      throw new PaymentError('وضعیت پرداخت هم‌زمان تغییر کرده است. صفحه را تازه کنید.', 409, 'PAYMENT_STATE_CHANGED')
    }
    for (const [productId, quantity] of paymentQuantities(order.items)) {
      await tx.product.update({ where: { id: productId }, data: { stock: { increment: quantity } } })
    }
    return cancellationDetails({ ...order, status: 'CANCELLED', paymentStatus: 'UNPAID', paymentExpiresAt: null, updatedAt })
  })
}

export function receiptMimeType(data: Uint8Array): string | null {
  if (data.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte) &&
      String.fromCharCode(...data.slice(12, 16)) === 'IHDR') return 'image/png'
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (data.length >= 16 && String.fromCharCode(...data.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...data.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

export async function boundedReceiptForm(request: Request): Promise<FormData> {
  const limit = MAX_RECEIPT_BYTES + 1024 * 1024
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new PaymentError('رسید را به‌صورت فایل تصویر ارسال کنید.', 400)
  }
  const contentLength = Number(request.headers.get('content-length'))
  if (contentLength > limit) throw new PaymentError('حجم فایل رسید نباید بیشتر از ۵ مگابایت باشد.', 413)
  if (!request.body) throw new PaymentError('فایل رسید ارسال نشده است.', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new PaymentError('حجم فایل رسید نباید بیشتر از ۵ مگابایت باشد.', 413)
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const buffer = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length }
  try {
    return await new Response(buffer, { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData()
  } catch { throw new PaymentError('فایل رسید قابل خواندن نیست.', 400) }
}
