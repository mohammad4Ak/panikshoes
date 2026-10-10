import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { expireUnpaidOrders, privatePaymentHeaders, receiptMetadataSelect } from '@/lib/payments'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  const { id } = await params
  try {
    const owner = await prisma.order.findFirst({ where: { id, ...(session.user.role === 'ADMIN' ? {} : { userId: session.user.id }) }, select: { id: true } })
    if (!owner) return NextResponse.json({ error: 'سفارش یافت نشد.' }, { status: 404 })
    await expireUnpaidOrders(new Date(), id)
    const order = await prisma.order.findUnique({ where: { id }, include: {
      invoice: { select: { id: true, issuedAt: true } },
      items: { include: { product: { select: { name: true, images: true } } } },
      receipts: { select: receiptMetadataSelect, orderBy: { createdAt: 'desc' } },
    } })
    if (!order) return NextResponse.json({ error: 'سفارش یافت نشد.' }, { status: 404 })
    const { receipts, ...details } = order
    return NextResponse.json({ order: details, receipts, serverTime: new Date().toISOString() }, { headers: privatePaymentHeaders })
  } catch { return NextResponse.json({ error: 'خطا در دریافت اطلاعات پرداخت' }, { status: 500 }) }
}
