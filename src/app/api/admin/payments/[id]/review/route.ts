import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildInvoiceSnapshot } from '@/lib/invoice'
import { readSiteSettings } from '@/lib/site-settings'
import { CouponError, reacquireCouponReservation } from '@/lib/coupons'
import { nextOrderVersion, paymentDeadline, PaymentError, paymentQuantities, privatePaymentHeaders, receiptMetadataSelect, requireSameOrigin } from '@/lib/payments'

const details = {
  user: { select: { name: true, email: true } },
  items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
  invoice: { select: { id: true, issuedAt: true } },
  receipts: { select: receiptMetadataSelect, orderBy: { createdAt: 'desc' } },
} as const

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
  const { id } = await params
  try {
    requireSameOrigin(request)
    let body: { receiptId: string; action: 'approve' | 'reject'; note?: string }
    try {
      const value = await request.json()
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.receiptId !== 'string' || !value.receiptId.trim() || value.receiptId.length > 100 ||
          !['approve', 'reject'].includes(value.action) || (value.note !== undefined && typeof value.note !== 'string')) throw new Error()
      body = { receiptId: value.receiptId, action: value.action, note: value.note?.trim() }
      if ((body.note?.length ?? 0) > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.note ?? '') || (body.action === 'reject' && !body.note)) throw new Error()
    } catch { throw new PaymentError('اطلاعات بررسی معتبر نیست؛ برای رد رسید دلیل را بنویسید.', 400) }
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id }, include: details })
      if (!order || order.paymentMethod !== 'bank_transfer') throw new PaymentError('سفارش یافت نشد.', 404)
      const receipt = order.receipts.find((candidate) => candidate.id === body.receiptId)
      if (!receipt) throw new PaymentError('رسید یافت نشد.', 404)
      if ((body.action === 'approve' && receipt.status === 'APPROVED' && order.verified) ||
          (body.action === 'reject' && receipt.status === 'REJECTED')) return { order, receipt }
      if (receipt.status !== 'PENDING' || order.paymentStatus !== 'AWAITING_REVIEW' || order.verified ||
          !['PENDING', 'CANCELLED'].includes(order.status)) throw new PaymentError('وضعیت این پرداخت تغییر کرده است؛ صفحه را تازه کنید.')
      const late = order.status === 'CANCELLED'
      if (late && !receipt.isLate) throw new PaymentError('رزرو این سفارش لغو شده است؛ وضعیت را دوباره بررسی کنید.')
      const approved = body.action === 'approve'
      const claimed = await tx.order.updateMany({
        where: { id, status: order.status, paymentStatus: 'AWAITING_REVIEW', verified: false, updatedAt: order.updatedAt },
        data: { verified: approved, paymentStatus: approved ? 'PAID' : 'REJECTED',
          status: approved ? 'PROCESSING' : order.status,
          paymentExpiresAt: approved || late ? null : paymentDeadline(), updatedAt: nextOrderVersion(order.updatedAt) },
      })
      if (claimed.count !== 1) throw new PaymentError('این پرداخت هم‌زمان بررسی شده است؛ صفحه را تازه کنید.')
      if (approved && late) {
        for (const [productId, quantity] of paymentQuantities(order.items)) {
          const reserved = await tx.product.updateMany({ where: { id: productId, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } })
          if (reserved.count !== 1) throw new PaymentError('موجودی برای فعال‌سازی این سفارش کافی نیست؛ با خریدار برای جایگزینی یا بازگشت وجه هماهنگ کنید.', 409, 'INSUFFICIENT_STOCK')
        }
        if (order.couponId) await reacquireCouponReservation(tx, id, order.userId, new Date())
      }
      const reviewedAt = new Date()
      const reviewed = await tx.paymentReceipt.updateMany({ where: { id: receipt.id, orderId: id, status: 'PENDING' }, data: {
        status: approved ? 'APPROVED' : 'REJECTED', reviewNote: body.note || null, reviewerId: session.user.id, reviewedAt,
      } })
      if (reviewed.count !== 1) throw new PaymentError('این رسید هم‌زمان بررسی شده است؛ صفحه را تازه کنید.')
      if (approved && !order.invoice) {
        const settings = await readSiteSettings(tx)
        await tx.invoice.create({ data: { orderId: id, snapshot: { ...buildInvoiceSnapshot(order, settings.storeName) } } })
      }
      const updated = await tx.order.findUnique({ where: { id }, include: details })
      return { order: updated, receipt: updated?.receipts.find((candidate) => candidate.id === receipt.id) }
    })
    return NextResponse.json(result, { headers: privatePaymentHeaders })
  } catch (error) {
    if (error instanceof PaymentError) return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status })
    if (error instanceof CouponError) return NextResponse.json({ error: `ظرفیت کد تخفیف این سفارش قابل رزرو نیست: ${error.message}؛ پیش از تأیید، با خریدار هماهنگ کنید.`, code: error.code }, { status: 409 })
    return NextResponse.json({ error: 'ثبت نتیجه بررسی پرداخت انجام نشد.' }, { status: 500 })
  }
}
