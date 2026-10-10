import type { Prisma } from '@prisma/client'
import { normalizePaymentDigits } from '@/lib/payment-contract'
import {
  orderStatusLabels, parseSalesRange, SALES_TIME_ZONE, SalesReportValidationError,
  type SalesOrderStatus,
} from '@/lib/sales-report'

export type AdminOrderPaymentFilter = 'all' | 'paid' | 'unpaid' | 'AWAITING_REVIEW' | 'AWAITING_RECEIPT' | 'REJECTED' | 'EXPIRED'
export type AdminOrderRange = 'all' | 'today' | '7d' | '30d' | 'custom'

export interface AdminOrdersFilters {
  q: string
  status: 'all' | 'active' | SalesOrderStatus
  payment: AdminOrderPaymentFilter
  range: AdminOrderRange
  from: string | null
  to: string | null
  start: Date | null
  end: Date | null
  page: number
  pageSize: 20 | 50
}

export interface AdminOrdersDashboard {
  date: string
  timeZone: typeof SALES_TIME_ZONE
  todayOrders: number
  todayPaidOrders: number
  todayPaidTotal: number
  awaitingReview: number
  readyToShip: number
}

export interface AdminOrdersPagination {
  page: number
  pageSize: 20 | 50
  total: number
  pages: number
}

export class AdminOrdersValidationError extends Error {}

function singleParam(params: URLSearchParams, name: string): string | null {
  if (params.getAll(name).length > 1) throw new AdminOrdersValidationError('فیلتر تکراری معتبر نیست.')
  return params.get(name)
}

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SALES_TIME_ZONE, calendar: 'gregory', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit',
})

export function adminOrdersToday(now = new Date()): string {
  const parts = dayFormatter.formatToParts(now)
  const part = (name: string) => parts.find((entry) => entry.type === name)!.value
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`
}

export function parseAdminOrdersFilters(params: URLSearchParams, now = new Date()): AdminOrdersFilters {
  const rawQuery = singleParam(params, 'q') ?? ''
  if (rawQuery.length > 120 || /[\u0000-\u001f\u007f]/.test(rawQuery)) {
    throw new AdminOrdersValidationError('عبارت جستجو باید حداکثر ۱۲۰ نویسه و بدون نویسهٔ کنترلی باشد.')
  }
  const q = rawQuery.trim()
  const status = singleParam(params, 'status') ?? 'all'
  const payment = singleParam(params, 'payment') ?? 'all'
  const range = singleParam(params, 'range') ?? 'all'
  const page = singleParam(params, 'page') ?? '1'
  const pageSize = singleParam(params, 'pageSize') ?? '20'
  const from = singleParam(params, 'from')
  const to = singleParam(params, 'to')
  if (status !== 'all' && status !== 'active' && !Object.hasOwn(orderStatusLabels, status)) {
    throw new AdminOrdersValidationError('وضعیت سفارش معتبر نیست.')
  }
  if (!['all', 'paid', 'unpaid', 'AWAITING_REVIEW', 'AWAITING_RECEIPT', 'REJECTED', 'EXPIRED'].includes(payment)) {
    throw new AdminOrdersValidationError('وضعیت پرداخت معتبر نیست.')
  }
  if (!['all', 'today', '7d', '30d', 'custom'].includes(range)) {
    throw new AdminOrdersValidationError('بازهٔ سفارش‌ها معتبر نیست.')
  }
  if (!/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 1_000_000) {
    throw new AdminOrdersValidationError('شمارهٔ صفحه معتبر نیست.')
  }
  if (!['20', '50'].includes(pageSize)) throw new AdminOrdersValidationError('اندازهٔ صفحه معتبر نیست.')
  if (range !== 'custom' && (from !== null || to !== null)) {
    throw new AdminOrdersValidationError('تاریخ دلخواه فقط در بازهٔ سفارشی قابل استفاده است.')
  }

  let resolved: { from: string; to: string; start: Date; end: Date } | null = null
  if (range !== 'all') {
    const dates = new URLSearchParams({ range: range === 'today' ? 'custom' : range })
    if (range === 'today') {
      const today = adminOrdersToday(now)
      dates.set('from', today)
      dates.set('to', today)
    } else if (range === 'custom') {
      if (from !== null) dates.set('from', from)
      if (to !== null) dates.set('to', to)
    }
    try { resolved = parseSalesRange(dates, now) }
    catch (error) {
      if (error instanceof SalesReportValidationError) throw new AdminOrdersValidationError(error.message)
      throw error
    }
  }
  return {
    q, status: status as AdminOrdersFilters['status'], payment: payment as AdminOrderPaymentFilter,
    range: range as AdminOrderRange, from: resolved?.from ?? null, to: resolved?.to ?? null,
    start: resolved?.start ?? null, end: resolved?.end ?? null,
    page: Number(page), pageSize: Number(pageSize) as 20 | 50,
  }
}

// Prisma's PostgreSQL contains uses LIKE: escape its pattern characters so
// searching an email underscore or a literal percent does not broaden a query.
function contains(value: string): { contains: string; mode: 'insensitive' } {
  return { contains: value.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' }
}

function searchVariants(query: string): string[] {
  const canonical = normalizePaymentDigits(query).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
  const variants = new Set([query])
  for (const kaf of [canonical, canonical.replace(/ک/g, 'ك')]) {
    for (const text of [kaf, kaf.replace(/ی/g, 'ي'), kaf.replace(/ی/g, 'ى')]) {
      variants.add(text)
      variants.add(text.replace(/\d/g, (digit) => String.fromCharCode(1776 + Number(digit))))
      variants.add(text.replace(/\d/g, (digit) => String.fromCharCode(1632 + Number(digit))))
    }
  }
  return [...variants]
}

export function adminOrdersWhere(filters: AdminOrdersFilters): Prisma.OrderWhereInput {
  const conditions: Prisma.OrderWhereInput[] = []
  if (filters.start && filters.end) conditions.push({ createdAt: { gte: filters.start, lt: filters.end } })
  if (filters.status === 'active') conditions.push({ status: { not: 'CANCELLED' } })
  else if (filters.status !== 'all') conditions.push({ status: filters.status })
  if (filters.payment === 'paid' || filters.payment === 'unpaid') {
    conditions.push({ verified: filters.payment === 'paid' })
  } else if (filters.payment !== 'all') {
    conditions.push({ verified: false, paymentStatus: filters.payment })
  }
  if (filters.q) {
    const alternatives: Prisma.OrderWhereInput[] = []
    for (const value of searchVariants(filters.q)) {
      const text = contains(value)
      alternatives.push(
        { id: contains(value.replace(/^#(?=.)/, '')) },
        { user: { name: text } }, { user: { email: text } },
        { recipientName: text }, { phone: text },
        { items: { some: { productName: text } } },
        { items: { some: { product: { name: text } } } },
      )
    }
    const normalized = normalizePaymentDigits(filters.q)
    if (/^[+\d ()-]+$/.test(normalized)) {
      for (const phone of searchVariants(normalized.replace(/\D/g, ''))) {
        if (phone) alternatives.push({ phone: contains(phone) })
      }
    }
    conditions.push({ OR: alternatives })
  }
  return conditions.length ? { AND: conditions } : {}
}

export function adminOrdersDashboardWhere(now = new Date()) {
  const today = parseAdminOrdersFilters(new URLSearchParams({ range: 'today' }), now)
  const createdAt = { gte: today.start!, lt: today.end! }
  return {
    date: today.from!,
    todayOrders: { createdAt } satisfies Prisma.OrderWhereInput,
    todayPaidOrders: { createdAt, verified: true, status: { not: 'CANCELLED' } } satisfies Prisma.OrderWhereInput,
    // Late receipts on cancelled orders still require review and can recover
    // the order through the existing stock-aware payment review operation.
    awaitingReview: { verified: false, paymentStatus: 'AWAITING_REVIEW' } satisfies Prisma.OrderWhereInput,
    readyToShip: { verified: true, status: 'PROCESSING' } satisfies Prisma.OrderWhereInput,
  }
}

export const adminOrdersInclude = {
  user: { select: { name: true, email: true } },
  items: { include: { product: { select: { name: true } } } },
  invoice: { select: { id: true, issuedAt: true } },
  _count: { select: { receipts: true } },
} satisfies Prisma.OrderInclude
