import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { MAX_RECEIPT_BYTES, normalizePaymentDigits } from '@/lib/payment-contract'
import { boundedReceiptForm, expireUnpaidOrders, nextOrderVersion, PaymentError, privatePaymentHeaders, receiptMetadataSelect, receiptMimeType, requireSameOrigin } from '@/lib/payments'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  const { id } = await params
  try {
    requireSameOrigin(request)
    // Even admins submit only for their own purchases; review has a separate API.
    const owned = await prisma.order.findFirst({ where: { id, userId: session.user.id }, select: { id: true } })
    if (!owned) throw new PaymentError('سفارش یافت نشد.', 404)
    const form = await boundedReceiptForm(request)
    const submissionKey = form.get('submissionKey')
    if (typeof submissionKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionKey)) {
      throw new PaymentError('شناسه ارسال رسید معتبر نیست. صفحه را تازه کنید.', 400)
    }
    const rawLast4 = form.get('payerCardLast4')
    const rawReference = form.get('transferReference')
    if ((rawLast4 !== null && typeof rawLast4 !== 'string') || (rawReference !== null && typeof rawReference !== 'string')) throw new PaymentError('مشخصات واریز معتبر نیست.', 400)
    const payerCardLast4 = normalizePaymentDigits((rawLast4 as string | null)?.trim() ?? '')
    const transferReference = normalizePaymentDigits((rawReference as string | null)?.trim() ?? '')
    if (payerCardLast4 && !/^\d{4}$/.test(payerCardLast4)) throw new PaymentError('چهار رقم آخر کارت واریزکننده را وارد کنید.', 400)
    if (transferReference.length > 100 || /[\u0000-\u001f\u007f]/.test(transferReference)) throw new PaymentError('شماره پیگیری معتبر نیست.', 400)
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) throw new PaymentError('تصویر رسید را انتخاب کنید.', 400)
    if (file.size > MAX_RECEIPT_BYTES) throw new PaymentError('حجم فایل رسید نباید بیشتر از ۵ مگابایت باشد.', 413)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const mimeType = receiptMimeType(bytes)
    if (!mimeType) throw new PaymentError('فقط تصویر PNG، JPEG یا WebP قابل ارسال است.', 400)
    await expireUnpaidOrders(new Date(), id)
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id }, include: { invoice: { select: { id: true } } } })
      if (!order || order.userId !== session.user.id) throw new PaymentError('سفارش یافت نشد.', 404)
      const existing = await tx.paymentReceipt.findUnique({ where: { orderId_submissionKey: { orderId: id, submissionKey } }, select: receiptMetadataSelect })
      if (existing) return { receipt: existing, paymentStatus: order.paymentStatus }
      if (order.paymentMethod !== 'bank_transfer') throw new PaymentError('این سفارش پرداخت کارت به کارت ندارد.')
      if (order.verified || order.paymentStatus === 'PAID' || order.invoice) throw new PaymentError('پرداخت این سفارش قبلاً نهایی شده است.')
      if (order.paymentStatus === 'AWAITING_REVIEW') throw new PaymentError('رسید قبلی در انتظار بررسی است.', 409, 'PAYMENT_AWAITING_REVIEW')
      const isLate = order.status === 'CANCELLED'
      if (isLate && form.get('latePayment') !== 'true') throw new PaymentError('مهلت رزرو تمام شده است؛ از گزینه «واریز کردم، مهلت تمام شد» استفاده کنید.', 409, 'PAYMENT_EXPIRED')
      if (!isLate && (order.status !== 'PENDING' || !['AWAITING_RECEIPT', 'REJECTED'].includes(order.paymentStatus))) throw new PaymentError('امکان ارسال رسید برای این وضعیت سفارش وجود ندارد.')
      if (!isLate && (!order.paymentExpiresAt || order.paymentExpiresAt.getTime() <= Date.now())) throw new PaymentError('مهلت پرداخت تمام شده است. وضعیت سفارش را تازه کنید.', 409, 'PAYMENT_EXPIRED')
      if (await tx.paymentReceipt.count({ where: { orderId: id } }) >= 10) throw new PaymentError('تعداد رسیدهای این سفارش به سقف مجاز رسیده است؛ با پشتیبانی تماس بگیرید.', 400)
      const claimed = await tx.order.updateMany({
        where: { id, userId: session.user.id, status: order.status, paymentStatus: order.paymentStatus, verified: false, updatedAt: order.updatedAt,
          ...(!isLate ? { paymentExpiresAt: { gt: new Date() } } : {}) },
        data: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null, updatedAt: nextOrderVersion(order.updatedAt) },
      })
      if (claimed.count !== 1) throw new PaymentError('وضعیت سفارش هم‌زمان تغییر کرده است. صفحه را تازه کنید.')
      const receipt = await tx.paymentReceipt.create({ data: {
        orderId: id, submissionKey, data: bytes, mimeType, isLate,
        payerCardLast4: payerCardLast4 || null, transferReference: transferReference || null,
      }, select: receiptMetadataSelect })
      return { receipt, paymentStatus: 'AWAITING_REVIEW' }
    })
    return NextResponse.json({ ...result, serverTime: new Date().toISOString() }, { status: 201, headers: privatePaymentHeaders })
  } catch (error) {
    if (error instanceof PaymentError) return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status })
    return NextResponse.json({ error: 'ارسال رسید انجام نشد. دوباره تلاش کنید.' }, { status: 500 })
  }
}
