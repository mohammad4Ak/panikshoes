import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { buildSalesReport, parseSalesRange, salesOrderSelect, SalesReportValidationError } from '@/lib/sales-report'

const headers = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید' }, { status: 401, headers })
    }
    if (session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
    }

    const now = new Date()
    const range = parseSalesRange(new URL(request.url).searchParams, now)
    const [orders, products, users] = await Promise.all([
      prisma.order.findMany({
        where: { createdAt: { gte: range.previousStart, lt: range.end } },
        select: salesOrderSelect,
      }),
      prisma.product.count(),
      prisma.user.count(),
    ])

    return NextResponse.json(buildSalesReport(orders, range, { products, users }, now), { headers })
  } catch (error) {
    if (error instanceof SalesReportValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers })
    }
    return NextResponse.json({ error: 'دریافت گزارش فروش ناموفق بود؛ دوباره تلاش کنید' }, { status: 500, headers })
  }
}
