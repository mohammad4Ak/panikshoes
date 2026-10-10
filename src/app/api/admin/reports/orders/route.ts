import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import {
  buildSalesLedgerRow, MAX_CSV_ORDERS, parseLedgerFilters, parseSalesRange, publicSalesRange,
  salesLedgerCsv, salesLedgerWhere, salesOrderSelect, SalesReportValidationError,
} from '@/lib/sales-report'
import type { SalesLedgerReport } from '@/lib/sales-report'

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

    const params = new URL(request.url).searchParams
    if (params.getAll('format').length > 1 || (params.has('format') && !['csv', 'json'].includes(params.get('format')!))) {
      throw new SalesReportValidationError('نوع خروجی گزارش معتبر نیست')
    }
    const range = parseSalesRange(params)
    const filters = parseLedgerFilters(params)
    const where = salesLedgerWhere(range, filters)
    const csv = params.get('format') === 'csv'
    const { total, orders } = await prisma.$transaction(async (tx) => {
      const total = await tx.order.count({ where })
      if (csv && total > MAX_CSV_ORDERS) return { total, orders: [] }
      const orders = await tx.order.findMany({
        where, select: { ...salesOrderSelect, user: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: csv ? MAX_CSV_ORDERS + 1 : filters.pageSize,
        ...(csv ? {} : { skip: (filters.page - 1) * filters.pageSize }),
      })
      return { total, orders }
    }, { isolationLevel: 'RepeatableRead' })
    if (csv && (total > MAX_CSV_ORDERS || orders.length > MAX_CSV_ORDERS)) {
      return NextResponse.json({ error: 'خروجی حداکثر ۱۰٬۰۰۰ سفارش را شامل می‌شود؛ بازه یا فیلتر را محدود کنید' }, { status: 422, headers })
    }
    const rows = orders.map(buildSalesLedgerRow)
    if (csv) {
      return new Response(salesLedgerCsv(rows), {
        headers: {
          ...headers,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sales-orders-${range.from}-${range.to}.csv"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }

    const report: SalesLedgerReport = {
      range: publicSalesRange(range), filters: { payment: filters.payment, status: filters.status },
      orders: rows,
      pagination: { page: filters.page, pageSize: filters.pageSize, total, pages: Math.ceil(total / filters.pageSize) },
    }
    return NextResponse.json(report, { headers })
  } catch (error) {
    if (error instanceof SalesReportValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers })
    }
    return NextResponse.json({ error: 'دریافت دفتر سفارش‌ها ناموفق بود؛ دوباره تلاش کنید' }, { status: 500, headers })
  }
}
