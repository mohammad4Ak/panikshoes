import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import type { OrderStatus } from '@prisma/client'
import { isSameOriginRequest } from '@/lib/request-origin'
import { CouponError, releaseCouponReservation } from '@/lib/coupons'
import { InventoryError, releaseInventory } from '@/lib/inventory'
import { isOrderStatus, StatusError, updateOrderStatus } from '@/lib/order-status-transition'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر ارسال شده است' }, { status: 403 })

  const { id } = await params
  let nextStatus: OrderStatus
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || !('status' in body) || !isOrderStatus(body.status)) throw new Error()
    nextStatus = body.status
  } catch {
    return NextResponse.json({ error: 'وضعیت نامعتبر است' }, { status: 400 })
  }

  try {
    const actor = { id: session.user.id, name: session.user.name }
    const order = await prisma.$transaction(tx => updateOrderStatus(tx, id, nextStatus, actor))

    return NextResponse.json(order)
  } catch (error) {
    if (error instanceof StatusError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof InventoryError) return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status })
    if (error instanceof CouponError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    return NextResponse.json({ error: 'خطا در تغییر وضعیت' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر ارسال شده است' }, { status: 403 })

  const { id } = await params

  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id }, include: { items: true, invoice: { select: { id: true } }, _count: { select: { receipts: true } } },
      })
      if (!order) throw new StatusError('سفارش یافت نشد', 404)
      if (order.invoice) throw new StatusError('سفارش دارای فاکتور قابل حذف نیست؛ برای توقف سفارش وضعیت لغوشده را انتخاب کنید')
      if (order._count?.receipts) throw new StatusError('سفارش دارای رسید پرداخت قابل حذف نیست؛ سوابق واریز باید حفظ شوند')
      if (order.verified || order.status === 'SHIPPED' || order.status === 'DELIVERED') {
        throw new StatusError('سوابق سفارش پرداخت‌شده، ارسال‌شده یا تحویل‌شده قابل حذف نیست')
      }

      const claimed = await tx.order.updateMany({
        where: { id, status: order.status, updatedAt: order.updatedAt, verified: false, invoice: { is: null } },
        data: { status: 'CANCELLED', updatedAt: new Date(Math.max(Date.now(), order.updatedAt.getTime() + 1)) },
      })
      if (claimed.count !== 1) throw new StatusError('وضعیت سفارش هم‌زمان تغییر کرده است؛ صفحه را تازه کنید')

      if (order.status !== 'CANCELLED') {
        await releaseInventory(tx, order.items, { orderId: id, actorId: session.user.id, actorName: session.user.name || undefined, note: 'آزادسازی رزرو هنگام حذف سفارش پرداخت‌نشده' })
      }

      if (order.couponId) await releaseCouponReservation(tx, id, new Date())
      await tx.orderItem.deleteMany({ where: { orderId: id } })
      await tx.order.delete({ where: { id } })
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof StatusError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (error instanceof InventoryError) return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status })
    if (error instanceof CouponError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    return NextResponse.json({ error: 'خطا در حذف سفارش' }, { status: 500 })
  }
}
