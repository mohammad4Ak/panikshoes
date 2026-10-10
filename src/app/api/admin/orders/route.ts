import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { expireUnpaidOrders } from '@/lib/payments'
import { SALES_TIME_ZONE } from '@/lib/sales-report'
import {
  adminOrdersDashboardWhere, adminOrdersInclude, adminOrdersWhere,
  AdminOrdersValidationError, parseAdminOrdersFilters,
  type AdminOrdersDashboard, type AdminOrdersPagination,
} from '@/lib/admin-orders'

const headers = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید.' }, { status: 401, headers })
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })

    const now = new Date()
    const filters = parseAdminOrdersFilters(new URL(request.url).searchParams, now)
    const where = adminOrdersWhere(filters)
    const dashboardWhere = adminOrdersDashboardWhere(now)
    await expireUnpaidOrders(now)

    const result = await prisma.$transaction(async (tx) => {
      const [total, todayOrders, todayPaid, awaitingReview, readyToShip] = await Promise.all([
        tx.order.count({ where }),
        tx.order.count({ where: dashboardWhere.todayOrders }),
        tx.order.aggregate({ where: dashboardWhere.todayPaidOrders, _count: { _all: true }, _sum: { total: true } }),
        tx.order.count({ where: dashboardWhere.awaitingReview }),
        tx.order.count({ where: dashboardWhere.readyToShip }),
      ])
      const pages = Math.max(1, Math.ceil(total / filters.pageSize))
      const page = Math.min(filters.page, pages)
      const orders = await tx.order.findMany({
        where, include: adminOrdersInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: filters.pageSize, skip: (page - 1) * filters.pageSize,
      })
      const pagination: AdminOrdersPagination = { page, pageSize: filters.pageSize, total, pages }
      const dashboard: AdminOrdersDashboard = {
        date: dashboardWhere.date, timeZone: SALES_TIME_ZONE,
        todayOrders, todayPaidOrders: todayPaid._count._all, todayPaidTotal: todayPaid._sum.total ?? 0,
        awaitingReview, readyToShip,
      }
      return { orders, pagination, dashboard }
    }, { isolationLevel: 'RepeatableRead' })

    return NextResponse.json({ ...result, generatedAt: now.toISOString() }, { headers })
  } catch (error) {
    if (error instanceof AdminOrdersValidationError) return NextResponse.json({ error: error.message }, { status: 400, headers })
    return NextResponse.json({ error: 'دریافت سفارش‌ها انجام نشد. دوباره تلاش کنید.' }, { status: 500, headers })
  }
}
