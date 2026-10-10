import type { Prisma } from '@prisma/client'

export const SALES_TIME_ZONE = 'Asia/Tehran'
export const MAX_REPORT_DAYS = 366
export const MAX_CSV_ORDERS = 10_000
const DAY_MS = 86_400_000

export const orderStatusLabels = {
  PENDING: 'در انتظار',
  PROCESSING: 'در حال پردازش',
  SHIPPED: 'ارسال شده',
  DELIVERED: 'تحویل شده',
  CANCELLED: 'لغو شده',
} as const

export type SalesOrderStatus = keyof typeof orderStatusLabels
export type SalesPaymentClass = 'paid' | 'unpaid' | 'paid_cancelled' | 'unpaid_cancelled'
export type SalesRangePreset = '7d' | '30d' | '90d' | 'month' | 'custom'

export const paymentClassLabels: Record<SalesPaymentClass, string> = {
  paid: 'پرداخت تأییدشده',
  unpaid: 'پرداخت تأییدنشده',
  paid_cancelled: 'لغوشده با پرداخت تأییدشده',
  unpaid_cancelled: 'لغوشده بدون پرداخت تأییدشده',
}

export class SalesReportValidationError extends Error {}

export interface SalesRange {
  preset: SalesRangePreset
  from: string
  to: string
  days: number
  timeZone: typeof SALES_TIME_ZONE
  interval: 'day' | 'month'
}

export interface ResolvedSalesRange extends SalesRange {
  start: Date
  end: Date
  previousStart: Date
  previousEnd: Date
  previousFrom: string
  previousTo: string
}

export interface SalesOrder {
  id: string
  createdAt: Date
  total: number
  shippingCost: number
  shippingMethodName: string | null
  status: SalesOrderStatus
  verified: boolean
  items: { productId: string; quantity: number; price: number; product: { name: string } }[]
  user?: { name: string }
}

export interface FinancialSummary {
  orders: number
  receipts: number
  merchandise: number
  shipping: number
  paidOrders: number
  unitsSold: number
  averageOrderValue: number
  unpaidOrders: number
  unpaidAmount: number
  cancelledOrders: number
  cancelledAmount: number
  paidCancelledOrders: number
  paidCancelledAmount: number
}

export interface SalesReport {
  range: SalesRange
  previousRange: { from: string; to: string }
  generatedAt: string
  catalog: { products: number; users: number }
  summary: FinancialSummary
  previous: FinancialSummary
  changes: { receipts: number | null; merchandise: number | null; paidOrders: number | null; averageOrderValue: number | null }
  trend: { date: string; label: string; receipts: number; merchandise: number; shipping: number; paidOrders: number }[]
  statusBreakdown: { status: SalesOrderStatus; label: string; count: number; paidCount: number; total: number }[]
  paymentBreakdown: { classification: SalesPaymentClass; label: string; count: number; amount: number }[]
  topProducts: { productId: string; name: string; sold: number; merchandise: number }[]
  shippingBreakdown: { name: string; paidOrders: number; shipping: number; receipts: number }[]
  notes: string[]
}

export interface SalesLedgerFilters {
  payment: 'all' | SalesPaymentClass
  status: 'all' | SalesOrderStatus
  page: number
  pageSize: 25 | 50 | 100
}

export interface SalesLedgerRow {
  id: string
  createdAt: string
  customerName: string
  status: SalesOrderStatus
  verified: boolean
  classification: SalesPaymentClass
  merchandise: number
  shipping: number
  total: number
  units: number
  shippingMethodName: string
}

export interface SalesLedgerReport {
  range: SalesRange
  filters: Pick<SalesLedgerFilters, 'payment' | 'status'>
  orders: SalesLedgerRow[]
  pagination: { page: number; pageSize: number; total: number; pages: number }
}

const localDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SALES_TIME_ZONE, calendar: 'gregory', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit',
})

function localDay(date: Date): string {
  const parts = localDayFormatter.formatToParts(date)
  const part = (name: string) => parts.find((entry) => entry.type === name)!.value
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1000-01-01' && value <= '9998-12-31' &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
}

function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10)
}

// Find the first instant in this Tehran civil day. This also handles historical
// Iranian DST, including a clock change that skipped midnight.
function startOfLocalDay(day: string): Date {
  const nominal = Date.parse(`${day}T00:00:00.000Z`)
  let lower = nominal - DAY_MS
  let upper = nominal + DAY_MS
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    if (localDay(new Date(middle)) < day) lower = middle + 1
    else upper = middle
  }
  return new Date(lower)
}

function singleParam(params: URLSearchParams, name: string): string | null {
  if (params.getAll(name).length > 1) throw new SalesReportValidationError('فیلتر تکراری معتبر نیست')
  return params.get(name)
}

export function parseSalesRange(params: URLSearchParams, now = new Date()): ResolvedSalesRange {
  const presetInput = singleParam(params, 'range') ?? '30d'
  if (!['7d', '30d', '90d', 'month', 'custom'].includes(presetInput)) {
    throw new SalesReportValidationError('بازهٔ گزارش معتبر نیست')
  }
  const preset = presetInput as SalesRangePreset
  const suppliedFrom = singleParam(params, 'from')
  const suppliedTo = singleParam(params, 'to')
  let to = localDay(now)
  let from: string

  if (preset === 'custom') {
    if (!suppliedFrom || !suppliedTo || !validDay(suppliedFrom) || !validDay(suppliedTo)) {
      throw new SalesReportValidationError('تاریخ شروع و پایان را به صورت YYYY-MM-DD وارد کنید')
    }
    from = suppliedFrom
    to = suppliedTo
  } else {
    if (suppliedFrom !== null || suppliedTo !== null) {
      throw new SalesReportValidationError('تاریخ دلخواه فقط در بازهٔ سفارشی قابل استفاده است')
    }
    if (preset === 'month') {
      const persianDay = Number(new Intl.DateTimeFormat('en-US-u-ca-persian', {
        timeZone: SALES_TIME_ZONE, day: 'numeric', numberingSystem: 'latn',
      }).formatToParts(now).find((part) => part.type === 'day')!.value)
      from = shiftDay(to, 1 - persianDay)
    } else {
      from = shiftDay(to, 1 - Number(preset.slice(0, -1)))
    }
  }

  if (from > to) throw new SalesReportValidationError('تاریخ پایان نباید قبل از تاریخ شروع باشد')
  const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS + 1
  if (days > MAX_REPORT_DAYS) throw new SalesReportValidationError('بازهٔ گزارش حداکثر ۳۶۶ روز است')
  const previousFrom = shiftDay(from, -days)
  const previousTo = shiftDay(from, -1)
  const start = startOfLocalDay(from)
  return {
    preset, from, to, days, timeZone: SALES_TIME_ZONE, interval: days > 90 ? 'month' : 'day',
    start, end: startOfLocalDay(shiftDay(to, 1)), previousStart: startOfLocalDay(previousFrom),
    previousEnd: start, previousFrom, previousTo,
  }
}

export function publicSalesRange(range: ResolvedSalesRange): SalesRange {
  const { preset, from, to, days, timeZone, interval } = range
  return { preset, from, to, days, timeZone, interval }
}

export function classifyPayment(order: Pick<SalesOrder, 'verified' | 'status'>): SalesPaymentClass {
  if (order.status === 'CANCELLED') return order.verified ? 'paid_cancelled' : 'unpaid_cancelled'
  return order.verified ? 'paid' : 'unpaid'
}

function summarize(orders: SalesOrder[]): FinancialSummary {
  const summary: FinancialSummary = {
    orders: orders.length, receipts: 0, merchandise: 0, shipping: 0, paidOrders: 0, unitsSold: 0,
    averageOrderValue: 0, unpaidOrders: 0, unpaidAmount: 0, cancelledOrders: 0, cancelledAmount: 0,
    paidCancelledOrders: 0, paidCancelledAmount: 0,
  }
  for (const order of orders) {
    switch (classifyPayment(order)) {
      case 'paid':
        summary.receipts += order.total
        summary.merchandise += order.total - order.shippingCost
        summary.shipping += order.shippingCost
        summary.paidOrders++
        summary.unitsSold += order.items.reduce((sum, item) => sum + item.quantity, 0)
        break
      case 'unpaid':
        summary.unpaidOrders++
        summary.unpaidAmount += order.total
        break
      case 'paid_cancelled':
        summary.paidCancelledOrders++
        summary.paidCancelledAmount += order.total
        summary.cancelledOrders++
        summary.cancelledAmount += order.total
        break
      case 'unpaid_cancelled':
        summary.cancelledOrders++
        summary.cancelledAmount += order.total
        break
    }
  }
  summary.averageOrderValue = summary.paidOrders ? Math.round(summary.receipts / summary.paidOrders) : 0
  return summary
}

function change(current: number, previous: number): number | null {
  return previous === 0 ? null : Math.round((current - previous) / previous * 10_000) / 100
}

export function buildSalesReport(
  orders: SalesOrder[], range: ResolvedSalesRange, catalog: { products: number; users: number }, now = new Date(),
): SalesReport {
  const currentOrders = orders.filter((order) => order.createdAt >= range.start && order.createdAt < range.end)
  const previousOrders = orders.filter((order) => order.createdAt >= range.previousStart && order.createdAt < range.previousEnd)
  const summary = summarize(currentOrders)
  const previous = summarize(previousOrders)
  const statusBreakdown = Object.entries(orderStatusLabels).map(([status, label]) => ({
    status: status as SalesOrderStatus, label, count: 0, paidCount: 0, total: 0,
  }))
  const paymentBreakdown = Object.entries(paymentClassLabels).map(([classification, label]) => ({
    classification: classification as SalesPaymentClass, label, count: 0, amount: 0,
  }))
  const products = new Map<string, SalesReport['topProducts'][number]>()
  const shippingMethods = new Map<string, SalesReport['shippingBreakdown'][number]>()
  const trend = new Map<string, SalesReport['trend'][number]>()
  const dayLabel = new Intl.DateTimeFormat('fa-IR', { timeZone: SALES_TIME_ZONE, day: 'numeric', month: 'short' })
  const monthKey = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    timeZone: SALES_TIME_ZONE, numberingSystem: 'latn', year: 'numeric', month: '2-digit',
  })
  const monthLabel = new Intl.DateTimeFormat('fa-IR', { timeZone: SALES_TIME_ZONE, year: 'numeric', month: 'long' })
  const bucketKey = (day: string) => {
    if (range.interval === 'day') return day
    const parts = monthKey.formatToParts(new Date(`${day}T12:00:00.000Z`))
    return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`
  }

  for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) {
    const key = bucketKey(day)
    if (!trend.has(key)) {
      trend.set(key, {
        date: key,
        label: (range.interval === 'day' ? dayLabel : monthLabel).format(new Date(`${day}T12:00:00.000Z`)),
        receipts: 0, merchandise: 0, shipping: 0, paidOrders: 0,
      })
    }
  }

  for (const order of currentOrders) {
    const classification = classifyPayment(order)
    const statusEntry = statusBreakdown.find((entry) => entry.status === order.status)!
    statusEntry.count++
    statusEntry.total += order.total
    if (order.verified) statusEntry.paidCount++
    const paymentEntry = paymentBreakdown.find((entry) => entry.classification === classification)!
    paymentEntry.count++
    paymentEntry.amount += order.total
    if (classification !== 'paid') continue

    const day = localDay(order.createdAt)
    const trendEntry = trend.get(bucketKey(day))!
    trendEntry.receipts += order.total
    trendEntry.merchandise += order.total - order.shippingCost
    trendEntry.shipping += order.shippingCost
    trendEntry.paidOrders++

    for (const item of order.items) {
      const product = products.get(item.productId) ?? { productId: item.productId, name: item.product.name, sold: 0, merchandise: 0 }
      product.sold += item.quantity
      product.merchandise += item.quantity * item.price
      products.set(item.productId, product)
    }
    const name = order.shippingMethodName?.trim() || 'روش ارسال ثبت نشده'
    const shipping = shippingMethods.get(name) ?? { name, paidOrders: 0, shipping: 0, receipts: 0 }
    shipping.paidOrders++
    shipping.shipping += order.shippingCost
    shipping.receipts += order.total
    shippingMethods.set(name, shipping)
  }

  return {
    range: publicSalesRange(range), previousRange: { from: range.previousFrom, to: range.previousTo },
    generatedAt: now.toISOString(), catalog, summary, previous,
    changes: {
      receipts: change(summary.receipts, previous.receipts), merchandise: change(summary.merchandise, previous.merchandise),
      paidOrders: change(summary.paidOrders, previous.paidOrders), averageOrderValue: change(summary.averageOrderValue, previous.averageOrderValue),
    },
    trend: [...trend.values()], statusBreakdown, paymentBreakdown,
    topProducts: [...products.values()].sort((a, b) => b.sold - a.sold || b.merchandise - a.merchandise || a.productId.localeCompare(b.productId)).slice(0, 10),
    shippingBreakdown: [...shippingMethods.values()].sort((a, b) => b.paidOrders - a.paidOrders || a.name.localeCompare(b.name)),
    notes: [
      'همهٔ مبالغ تومان هستند. بازه بر اساس تاریخ ثبت سفارش و روز کاری تهران است؛ وضعیت پرداخت، وضعیت فعلی تأیید سفارش است و زمان واقعی دریافت وجه ثبت نشده است.',
      'دریافت سفارش، فروش کالا و ارسال دریافتی فقط سفارش‌های دارای پرداخت تأییدشده و لغونشده را شامل می‌شوند.',
      'پرداخت‌های تأییدشدهٔ سفارش‌های لغوشده جدا نمایش داده می‌شوند؛ وضعیت و مبلغ استرداد وجه در داده‌ها ثبت نشده است.',
      'ارسال دریافتی مبلغ گرفته‌شده از مشتری است؛ هزینهٔ واقعی شرکت حمل، بهای خرید کالا و سود در این گزارش محاسبه نمی‌شوند.',
    ],
  }
}

export function parseLedgerFilters(params: URLSearchParams): SalesLedgerFilters {
  const payment = singleParam(params, 'payment') ?? 'all'
  const status = singleParam(params, 'status') ?? 'all'
  const pageInput = singleParam(params, 'page') ?? '1'
  const sizeInput = singleParam(params, 'pageSize') ?? '25'
  if (payment !== 'all' && !Object.hasOwn(paymentClassLabels, payment)) {
    throw new SalesReportValidationError('فیلتر پرداخت معتبر نیست')
  }
  if (status !== 'all' && !Object.hasOwn(orderStatusLabels, status)) {
    throw new SalesReportValidationError('فیلتر وضعیت سفارش معتبر نیست')
  }
  if (!/^\d+$/.test(pageInput) || !Number.isSafeInteger(Number(pageInput)) || Number(pageInput) < 1 || Number(pageInput) > 1_000_000) {
    throw new SalesReportValidationError('شمارهٔ صفحه معتبر نیست')
  }
  if (!['25', '50', '100'].includes(sizeInput)) throw new SalesReportValidationError('اندازهٔ صفحه معتبر نیست')
  return { payment: payment as SalesLedgerFilters['payment'], status: status as SalesLedgerFilters['status'], page: Number(pageInput), pageSize: Number(sizeInput) as SalesLedgerFilters['pageSize'] }
}

export function salesLedgerWhere(range: ResolvedSalesRange, filters: SalesLedgerFilters): Prisma.OrderWhereInput {
  const conditions: Prisma.OrderWhereInput[] = [{ createdAt: { gte: range.start, lt: range.end } }]
  if (filters.status !== 'all') conditions.push({ status: filters.status })
  if (filters.payment !== 'all') {
    conditions.push({
      verified: filters.payment === 'paid' || filters.payment === 'paid_cancelled',
      status: filters.payment.endsWith('_cancelled') ? 'CANCELLED' : { not: 'CANCELLED' },
    })
  }
  return { AND: conditions }
}

export function buildSalesLedgerRow(order: SalesOrder): SalesLedgerRow {
  return {
    id: order.id, createdAt: order.createdAt.toISOString(), customerName: order.user?.name ?? 'نام ثبت نشده',
    status: order.status, verified: order.verified, classification: classifyPayment(order),
    merchandise: order.total - order.shippingCost, shipping: order.shippingCost, total: order.total,
    units: order.items.reduce((sum, item) => sum + item.quantity, 0),
    shippingMethodName: order.shippingMethodName?.trim() || 'روش ارسال ثبت نشده',
  }
}

function csvCell(value: string | number): string {
  let text = String(value)
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function salesLedgerCsv(rows: SalesLedgerRow[]): string {
  const timeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: SALES_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const headers = ['شناسه سفارش', 'تاریخ ثبت (تهران، میلادی)', 'نام مشتری', 'وضعیت سفارش', 'وضعیت پرداخت', 'تعداد جفت', 'مبلغ کالا (تومان)', 'ارسال دریافتی (تومان)', 'مبلغ سفارش (تومان)', 'روش ارسال']
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) {
    const date = new Date(row.createdAt)
    lines.push([
      row.id, `${localDay(date)} ${timeFormatter.format(date)}`, row.customerName,
      orderStatusLabels[row.status], paymentClassLabels[row.classification], row.units,
      row.merchandise, row.shipping, row.total, row.shippingMethodName,
    ].map(csvCell).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export const salesOrderSelect = {
  id: true, createdAt: true, total: true, shippingCost: true, shippingMethodName: true,
  status: true, verified: true,
  items: { select: { productId: true, quantity: true, price: true, product: { select: { name: true } } } },
} satisfies Prisma.OrderSelect
