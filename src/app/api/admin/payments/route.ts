import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { paymentStatusLabels, type PaymentStatus } from '@/lib/payment-contract'
import { expireUnpaidOrders, privatePaymentHeaders, receiptMetadataSelect } from '@/lib/payments'

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
  const status = new URL(request.url).searchParams.get('status')
  if (status && !Object.hasOwn(paymentStatusLabels, status)) return NextResponse.json({ error: 'فیلتر وضعیت معتبر نیست.' }, { status: 400 })
  try {
    await expireUnpaidOrders()
    const orders = await prisma.order.findMany({ where: {
      paymentMethod: 'bank_transfer', ...(status ? { paymentStatus: status as PaymentStatus } : {}),
    }, include: {
      user: { select: { name: true, email: true } },
      items: { include: { product: { select: { name: true } } } },
      invoice: { select: { id: true, issuedAt: true } },
      receipts: { select: receiptMetadataSelect, orderBy: { createdAt: 'desc' } },
    }, orderBy: { updatedAt: 'desc' } })
    return NextResponse.json(orders, { headers: privatePaymentHeaders })
  } catch { return NextResponse.json({ error: 'دریافت پرداخت‌ها انجام نشد.' }, { status: 500 }) }
}
