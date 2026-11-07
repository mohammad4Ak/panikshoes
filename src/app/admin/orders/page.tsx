'use client'

import { Fragment, useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Trash2, ChevronDown, Search, SlidersHorizontal, RefreshCw, ArrowLeft, ArrowRight, PackageCheck, ClipboardList, ReceiptText, Truck, ListChecks } from 'lucide-react'
import { formatPrice } from '@/lib/utils'
import type { InvoiceMetadata } from '@/lib/invoice'
import type { AdminOrdersDashboard, AdminOrdersPagination } from '@/lib/admin-orders'
import { ADMIN_ORDER_BULK_LIMIT, ADMIN_ORDER_BULK_BATCH_SIZE, type AdminOrderBulkPreviewRow, type AdminOrderBulkResult } from '@/lib/admin-order-bulk-contract'
import InvoiceDownload from '@/components/shop/InvoiceDownload'
import PersianDatePicker from '@/components/ui/PersianDatePicker'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import styles from '@/components/admin/admin.module.css'
import ui from './orders.module.css'

interface Order {
  id: string
  total: number
  subtotal?: number | null
  productDiscount?: number
  couponDiscount?: number
  couponCode?: string | null
  shippingMethodName: string | null
  shippingCost: number
  status: string
  verified: boolean
  paymentMethod?: string | null
  paymentStatus?: string
  receipts?: { id: string }[]
  _count?: { receipts: number }
  recipientName: string | null
  address: string
  phone: string
  postalCode?: string | null
  trackingCode?: string | null
  trackingRecordedAt?: string | null
  createdAt: string
  invoice?: InvoiceMetadata | null
  user: { name: string; email: string | null }
  items: { id: string; quantity: number; size: number; color: string; price: number; originalPrice?: number | null; couponDiscount?: number; productName?: string | null; product: { name: string } }[]
}

const statusLabels: Record<string, { label: string; color: string; background: string }> = {
  PENDING: { label: 'در انتظار پرداخت', color: '#a16207', background: '#fef9c3' },
  PROCESSING: { label: 'در حال پردازش', color: '#0369a1', background: '#f0f9ff' },
  SHIPPED: { label: 'ارسال شده', color: '#0f766e', background: '#f0fdfa' },
  DELIVERED: { label: 'تحویل شده', color: '#15803d', background: '#dcfce7' },
  CANCELLED: { label: 'لغو شده', color: '#b91c1c', background: '#fee2e2' },
}

const allStatuses = Object.keys(statusLabels)
const choicesFor = (order: Order) => {
  const { status } = order
  // Payment review owns reservation recovery and the first paid transition.
  if (order.paymentMethod === 'bank_transfer' && !order.verified) {
    if (order.paymentStatus === 'AWAITING_REVIEW') return [status]
    return status === 'CANCELLED' ? ['CANCELLED'] : [status, 'CANCELLED'].filter((value, index, values) => values.indexOf(value) === index)
  }
  return status === 'DELIVERED' ? ['DELIVERED']
  : status === 'SHIPPED' ? ['SHIPPED', 'DELIVERED']
  : status === 'CANCELLED' ? ['CANCELLED', 'PENDING', 'PROCESSING'] : allStatuses
}
const paymentLabels: Record<string, string> = {
  AWAITING_RECEIPT: 'در انتظار رسید', AWAITING_REVIEW: 'رسید منتظر بررسی',
  REJECTED: 'نیاز به رسید جدید', PAID: 'پرداخت تأییدشده', EXPIRED: 'مهلت پرداخت تمام شده',
}
const hasPaymentRecord = (order: Order) => Math.max(order.receipts?.length ?? 0, order._count?.receipts ?? 0) > 0

type BulkMode = 'selected' | 'filtered'
type BulkPreview = { key: string; token: string | null; rows: AdminOrderBulkPreviewRow[] }
type BulkDisplayResult = { id: string; outcome: AdminOrderBulkResult['outcome'] | 'unknown' | 'not-sent'; reason?: string }
const bulkOutcomeLabels: Record<BulkDisplayResult['outcome'], string> = {
  updated: 'تغییر کرد', skipped: 'بدون تغییر', error: 'ناموفق', unknown: 'نتیجه نامشخص', 'not-sent': 'ارسال نشد',
}
const bulkRequestUrl = '/api/admin/orders/bulk'

function uniqueIdsMatch(rows: { id: string }[], ids: string[]) {
  const expected = new Set(ids)
  return rows.length === ids.length && new Set(rows.map(row => row.id)).size === ids.length && rows.every(row => expected.has(row.id))
}

function readBulkPreview(data: unknown, key: string, selectedIds?: string[]): BulkPreview {
  const payload = data as { token?: unknown; rows?: unknown } | null
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length > ADMIN_ORDER_BULK_LIMIT ||
      !payload.rows.every(row => row && typeof row.id === 'string' && row.id.length > 0 &&
        (typeof row.status === 'string' || row.status === null) && typeof row.eligible === 'boolean' &&
        (row.reason === undefined || typeof row.reason === 'string')) ||
      new Set(payload.rows.map(row => row.id)).size !== payload.rows.length ||
      (selectedIds && !uniqueIdsMatch(payload.rows, selectedIds)) ||
      (payload.rows.some(row => row.eligible) ? typeof payload.token !== 'string' || !payload.token : payload.token !== null)) {
    throw new Error('پیش‌نمایش سفارش‌ها معتبر نیست. دوباره تلاش کن.')
  }
  return { key, token: payload.token as string | null, rows: payload.rows }
}

function readBulkResults(data: unknown, ids: string[]): AdminOrderBulkResult[] {
  const payload = data as { results?: unknown } | null
  if (!payload || !Array.isArray(payload.results) || !payload.results.every(row => row && typeof row.id === 'string' &&
      ['updated', 'skipped', 'error'].includes(row.outcome) && (row.reason === undefined || typeof row.reason === 'string')) ||
      !uniqueIdsMatch(payload.results, ids)) throw new Error('پاسخ ثبت وضعیت سفارش‌ها معتبر نیست.')
  return payload.results
}

async function requestBulk(body: object, signal: AbortSignal) {
  const response = await fetch(bulkRequestUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'درخواست تغییر گروهی انجام نشد.')
  return data
}

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [dashboard, setDashboard] = useState<AdminOrdersDashboard | null>(null)
  const [pagination, setPagination] = useState<AdminOrdersPagination>({ page: 1, pageSize: 20, total: 0, pages: 1 })
  const [filters, setFilters] = useState({ q: '', status: 'all', payment: 'all', range: 'all', from: '', to: '', page: 1, pageSize: 20 })
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [dateError, setDateError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadedQuery, setLoadedQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busyIds, setBusyIds] = useState<string[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkMode, setBulkMode] = useState<BulkMode>('selected')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkStatus, setBulkStatus] = useState('')
  const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkDisplayResult[] | null>(null)
  const [bulkError, setBulkError] = useState('')
  const [bulkPhase, setBulkPhase] = useState<'preview' | 'confirm' | null>(null)
  const [bulkProcessed, setBulkProcessed] = useState(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const writeControllersRef = useRef(new Map<string, AbortController>())
  const bulkControllerRef = useRef<AbortController | null>(null)
  const selectPageRef = useRef<HTMLInputElement>(null)
  const bulkPreviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const bulkResultHeadingRef = useRef<HTMLHeadingElement>(null)
  const params = new URLSearchParams({ q: filters.q, status: filters.status, payment: filters.payment, range: filters.range, page: String(filters.page), pageSize: String(filters.pageSize) })
  if (filters.range === 'custom') { params.set('from', filters.from); params.set('to', filters.to) }
  const query = params.toString()
  params.delete('page')
  params.delete('pageSize')
  const filterQuery = params.toString()
  const busy = busyIds.length > 0 || bulkPhase !== null
  const filtersActive = Boolean(filters.q || filters.status !== 'all' || filters.payment !== 'all' || filters.range !== 'all')
  const listReady = !loading && !loadFailed && loadedQuery === query && search.trim() === filters.q
  const bulkKey = JSON.stringify([filterQuery, bulkMode, bulkStatus, bulkMode === 'selected' ? [...selectedIds].sort() : null])
  const currentPreview = bulkPreview?.key === bulkKey ? bulkPreview : null
  const eligibleRows = currentPreview?.rows.filter(row => row.eligible) ?? []
  const showSelection = bulkOpen && bulkMode === 'selected'
  const checkedOnPage = orders.filter(order => selectedIds.has(order.id)).length
  const allPageChecked = orders.length > 0 && checkedOnPage === orders.length
  const partlyPageChecked = checkedOnPage > 0 && !allPageChecked
  const scopeCount = bulkMode === 'selected' ? selectedIds.size : pagination.total
  const canPreview = bulkOpen && listReady && !busy && allStatuses.includes(bulkStatus) &&
    scopeCount > 0 && scopeCount <= ADMIN_ORDER_BULK_LIMIT && (bulkMode === 'selected' || filtersActive)
  const bulkCounts = bulkResult?.reduce<Record<BulkDisplayResult['outcome'], number>>((counts, row) => {
    counts[row.outcome]++
    return counts
  }, { updated: 0, skipped: 0, error: 0, unknown: 0, 'not-sent': 0 })

  useEffect(() => {
    if (selectPageRef.current) selectPageRef.current.indeterminate = partlyPageChecked
  }, [partlyPageChecked, showSelection, listReady])
  useEffect(() => {
    if (currentPreview) bulkPreviewHeadingRef.current?.focus()
  }, [currentPreview])
  useEffect(() => {
    if (bulkResult) bulkResultHeadingRef.current?.focus()
  }, [bulkResult])

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((previous) => previous.q === search.trim() ? previous : { ...previous, q: search.trim(), page: 1 })
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const loadOrders = useCallback(() => {
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    const { signal } = controller
    setLoading(true)
    setError('')
    return fetch(`/api/admin/orders?${query}`, { signal, cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || 'سفارش‌ها بارگذاری نشدند. دوباره تلاش کنید.')
        if (!data || !Array.isArray(data.orders) || !data.dashboard || !data.pagination) throw new Error('پاسخ سفارش‌ها معتبر نیست.')
        if (!signal.aborted) {
          setOrders(data.orders)
          setDashboard(data.dashboard)
          setPagination(data.pagination)
          setLoadedQuery(query)
          setLoadFailed(false)
        }
      })
      .catch((cause) => {
        if (!signal.aborted) {
          setLoadFailed(true)
          setError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'خطای ارتباط با سرور')
        }
      })
      .finally(() => { if (!signal.aborted) setLoading(false) })
  }, [query])
  const loadOrdersRef = useRef(loadOrders)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const initialSearch = new URLSearchParams(window.location.search).get('q')?.trim().slice(0, 120)
    let active = true
    void Promise.resolve().then(() => {
      if (active && initialSearch) {
        setSearch(initialSearch)
        setFilters(previous => ({ ...previous, q: initialSearch, page: 1 }))
      }
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    loadOrdersRef.current = loadOrders
    let active = true
    void Promise.resolve().then(() => { if (active) void loadOrders() })
    return () => { active = false; loadControllerRef.current?.abort() }
  }, [loadOrders])

  useEffect(() => {
    const writes = writeControllersRef.current
    return () => { for (const controller of writes.values()) controller.abort() }
  }, [])
  useEffect(() => {
    const controllers = bulkControllerRef
    return () => controllers.current?.abort()
  }, [])

  const clearBulkPreview = () => {
    setBulkPreview(null)
    setBulkResult(null)
    setBulkError('')
  }
  const clearBulkScope = () => {
    setSelectedIds(new Set())
    clearBulkPreview()
  }
  const toggleBulk = () => {
    if (bulkControllerRef.current || writeControllersRef.current.size > 0) return
    clearBulkScope()
    setBulkMode('selected')
    setBulkStatus('')
    setBulkOpen(!bulkOpen)
  }

  const toggleOrder = (id: string) => {
    if (!showSelection || !listReady || busy || bulkControllerRef.current) return
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else if (next.size < ADMIN_ORDER_BULK_LIMIT) next.add(id)
    else { setBulkError(`در هر عملیات حداکثر ${formatPrice(ADMIN_ORDER_BULK_LIMIT)} سفارش می‌توان انتخاب کرد.`); return }
    clearBulkPreview()
    setSelectedIds(next)
  }

  const togglePage = () => {
    if (!showSelection || !listReady || busy || bulkControllerRef.current) return
    const next = new Set(selectedIds)
    for (const order of orders) {
      if (allPageChecked) next.delete(order.id)
      else next.add(order.id)
    }
    if (next.size > ADMIN_ORDER_BULK_LIMIT) { setBulkError(`در هر عملیات حداکثر ${formatPrice(ADMIN_ORDER_BULK_LIMIT)} سفارش می‌توان انتخاب کرد.`); return }
    clearBulkPreview()
    setSelectedIds(next)
  }

  const previewBulk = async () => {
    if (!canPreview || bulkControllerRef.current || writeControllersRef.current.size > 0) return
    const controller = new AbortController()
    bulkControllerRef.current = controller
    clearBulkPreview()
    setBulkPhase('preview')
    const ids = bulkMode === 'selected' ? [...selectedIds] : undefined
    try {
      const data = await requestBulk({ action: 'preview', mode: bulkMode, status: bulkStatus, ...(ids ? { ids } : { filters: filterQuery }) }, controller.signal)
      if (!controller.signal.aborted) setBulkPreview(readBulkPreview(data, bulkKey, ids))
    } catch (cause) {
      if (!controller.signal.aborted) setBulkError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره پیش‌نمایش بگیر.')
    } finally {
      bulkControllerRef.current = null
      if (!controller.signal.aborted) setBulkPhase(null)
    }
  }

  const confirmBulk = async () => {
    if (!canPreview || !currentPreview?.token || !eligibleRows.length || bulkControllerRef.current || writeControllersRef.current.size > 0) return
    const controller = new AbortController()
    bulkControllerRef.current = controller
    const { token, rows } = currentPreview
    const eligibleIds = eligibleRows.map(row => row.id)
    const results = new Map<string, BulkDisplayResult>(rows.filter(row => !row.eligible).map(row => [row.id, { id: row.id, outcome: 'skipped', reason: row.reason }]))
    setBulkError('')
    setBulkProcessed(0)
    setBulkPhase('confirm')
    try {
      for (let index = 0; index < eligibleIds.length; index += ADMIN_ORDER_BULK_BATCH_SIZE) {
        const ids = eligibleIds.slice(index, index + ADMIN_ORDER_BULK_BATCH_SIZE)
        try {
          const data = await requestBulk({ action: 'confirm', token, ids }, controller.signal)
          if (controller.signal.aborted) return
          for (const row of readBulkResults(data, ids)) results.set(row.id, row)
          setBulkProcessed(index + ids.length)
        } catch (cause) {
          if (controller.signal.aborted) return
          const reason = cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور قطع شد.'
          for (const id of ids) results.set(id, { id, outcome: 'unknown', reason })
          for (const id of eligibleIds.slice(index + ids.length)) results.set(id, { id, outcome: 'not-sent' })
          setBulkError('ثبت گروهی متوقف شد. وضعیت سفارش‌های نامشخص را در فهرست بررسی کن؛ هیچ درخواستی خودکار تکرار نشد.')
          break
        }
      }
      setBulkResult(rows.flatMap(row => { const result = results.get(row.id); return result ? [result] : [] }))
      setBulkPreview(null)
      setSelectedIds(new Set())
      await loadOrdersRef.current()
    } finally {
      bulkControllerRef.current = null
      if (!controller.signal.aborted) setBulkPhase(null)
    }
  }

  const updateFilters = (values: Partial<typeof filters>) => {
    if (bulkControllerRef.current) return
    setExpandedId(null)
    if (Object.keys(values).some(key => key !== 'pageSize' && key !== 'page')) clearBulkScope()
    setFilters((previous) => ({ ...previous, ...values, page: 1 }))
  }
  const resetFilters = (values: Partial<typeof filters> = {}) => {
    if (bulkControllerRef.current) return
    clearBulkScope()
    if (!Object.keys(values).length) setBulkMode('selected')
    setSearch('')
    setFrom('')
    setTo('')
    setDateError('')
    setExpandedId(null)
    setFilters({ q: '', status: 'all', payment: 'all', range: 'all', from: '', to: '', page: 1, pageSize: filters.pageSize, ...values })
  }
  const applyDates = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (bulkControllerRef.current) return
    if (!from || !to || from > to) { setDateError('تاریخ شروع و پایان را به ترتیب وارد کنید.'); return }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 365) { setDateError('بازهٔ دلخواه باید حداکثر ۳۶۶ روز باشد.'); return }
    setDateError('')
    updateFilters({ range: 'custom', from, to })
  }
  const todayLabel = dashboard ? new Date(`${dashboard.date}T12:00:00Z`).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }) : 'به وقت ایران'
  const showDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })
  const bulkFilterSummary = [
    filters.q && `جستجو: «${filters.q}»`,
    filters.status !== 'all' && `وضعیت: ${filters.status === 'active' ? 'فعال' : statusLabels[filters.status]?.label}`,
    filters.payment !== 'all' && (filters.payment === 'paid' ? 'پرداخت تأییدشده' : filters.payment === 'unpaid' ? 'پرداخت تأییدنشده' : paymentLabels[filters.payment]),
    filters.range === 'custom' ? `از ${showDate(filters.from)} تا ${showDate(filters.to)}` : ({ today: 'امروز', '7d': '۷ روز اخیر', '30d': '۳۰ روز اخیر' } as Record<string, string>)[filters.range],
  ].filter(Boolean).join(' · ')

  const refreshOrders = () => {
    if (bulkControllerRef.current || writeControllersRef.current.size > 0) return
    setBulkPreview(null)
    void loadOrders()
  }

  const handleStatusChange = async (id: string, status: string) => {
    const currentOrder = orders.find((order) => order.id === id)
    if (writeControllersRef.current.size > 0 || bulkControllerRef.current || !listReady || !currentOrder || status === currentOrder.status || !choicesFor(currentOrder).includes(status)) return
    const controller = new AbortController()
    writeControllersRef.current.set(id, controller)
    loadControllerRef.current?.abort()
    setBulkPreview(null)
    setError('')
    setBusyIds((previous) => [...previous, id])
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }), signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (controller.signal.aborted) return
      if (!res.ok) {
        if (res.status === 409) await loadOrdersRef.current()
        throw new Error(data?.error || 'خطا در تغییر وضعیت')
      }
      if (!data || data.id !== id) throw new Error('پاسخ تغییر وضعیت معتبر نیست. سفارش‌ها را دوباره بارگذاری کنید.')
      if (!controller.signal.aborted) {
        setOrders((prev) => prev.map((order) => order.id === id ? { ...order, ...data, _count: data._count ?? order._count } : order))
        await loadOrdersRef.current()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'خطای ارتباط با سرور')
    } finally {
      writeControllersRef.current.delete(id)
      if (!controller.signal.aborted) setBusyIds((previous) => previous.filter((value) => value !== id))
    }
  }

  const handleDelete = async (id: string) => {
    const currentOrder = orders.find((order) => order.id === id)
    if (writeControllersRef.current.size > 0 || bulkControllerRef.current || !listReady || !currentOrder || currentOrder.invoice || hasPaymentRecord(currentOrder) || currentOrder.verified || ['SHIPPED', 'DELIVERED'].includes(currentOrder.status)) return
    if (!confirm('این سفارش حذف شود؟')) return
    const controller = new AbortController()
    writeControllersRef.current.set(id, controller)
    loadControllerRef.current?.abort()
    setBulkPreview(null)
    setError('')
    setBusyIds((previous) => [...previous, id])
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE', signal: controller.signal })
      const data = await res.json().catch(() => null)
      if (controller.signal.aborted) return
      if (!res.ok) {
        if (res.status === 409) await loadOrdersRef.current()
        throw new Error(data?.error || 'خطا در حذف سفارش')
      }
      if (!controller.signal.aborted) {
        setOrders((prev) => prev.filter((o) => o.id !== id))
        setSelectedIds(previous => { const next = new Set(previous); next.delete(id); return next })
        await loadOrdersRef.current()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'خطای ارتباط با سرور')
    } finally {
      writeControllersRef.current.delete(id)
      if (!controller.signal.aborted) setBusyIds((previous) => previous.filter((value) => value !== id))
    }
  }

  return (
    <div>

      <div className={styles.pageHeader}>
        <div><span className={styles.eyebrow}>میز کار فروشگاه</span><h1>مدیریت سفارش‌ها</h1><p>سفارش‌های امروز را ببین و خریدهای نیازمند رسیدگی را سریع پیدا کن.</p></div>
        <div className={ui.headerActions}>
          <button type="button" className={styles.headerLink} disabled={loading || busy} onClick={refreshOrders}><RefreshCw size={16} aria-hidden="true" />تازه‌سازی</button>
          <Link href="/admin/payments" className={styles.headerLink}>بررسی رسیدهای پرداخت</Link>
        </div>
      </div>
      <section className={ui.overview} aria-labelledby="orders-overview-title" aria-busy={loading}>
        <div className={ui.sectionHeading}><div><h2 id="orders-overview-title">سفارش‌های امروز و صف رسیدگی</h2><p>{todayLabel} · آمار مستقل از فیلترهای فهرست</p></div><span className={ui.liveLabel}>به وقت ایران</span></div>
        <div className={ui.metrics}>
          <button type="button" className={ui.metric} disabled={busy} onClick={() => resetFilters({ range: 'today' })}>
            <span className={ui.metricTop}><ClipboardList size={20} aria-hidden="true" /><span>امروز</span></span>
            <strong>{dashboard ? formatPrice(dashboard.todayOrders) : '—'}</strong><span className={ui.metricLabel}>سفارش ثبت‌شده</span><small>مشاهدهٔ سفارش‌های امروز <ArrowLeft size={13} aria-hidden="true" /></small>
          </button>
          <button type="button" className={`${ui.metric} ${ui.salesMetric}`} disabled={busy} onClick={() => resetFilters({ range: 'today', payment: 'paid', status: 'active' })}>
            <span className={ui.metricTop}><PackageCheck size={20} aria-hidden="true" /><span>امروز</span></span>
            <strong>{dashboard ? formatPrice(dashboard.todayPaidTotal) : '—'}<em>تومان</em></strong><span className={ui.metricLabel}>مبلغ سفارش‌های تأییدشدهٔ امروز</span><small>{dashboard ? formatPrice(dashboard.todayPaidOrders) : '—'} سفارش · بدون سفارش‌های لغوشده</small>
          </button>
          <button type="button" className={ui.metric} disabled={busy} onClick={() => resetFilters({ payment: 'AWAITING_REVIEW' })}>
            <span className={ui.metricTop}><ReceiptText size={20} aria-hidden="true" /><span>همهٔ روزها</span></span>
            <strong>{dashboard ? formatPrice(dashboard.awaitingReview) : '—'}</strong><span className={ui.metricLabel}>رسید منتظر بررسی</span><small>رسیدهای دیرهنگام هم در این صف هستند</small>
          </button>
          <button type="button" className={ui.metric} disabled={busy} onClick={() => resetFilters({ status: 'PROCESSING', payment: 'paid' })}>
            <span className={ui.metricTop}><Truck size={20} aria-hidden="true" /><span>همهٔ روزها</span></span>
            <strong>{dashboard ? formatPrice(dashboard.readyToShip) : '—'}</strong><span className={ui.metricLabel}>در صف آماده‌سازی و ارسال</span><small>سفارش‌های پرداخت‌شده و در حال پردازش</small>
          </button>
        </div>
        <p className={ui.note}>مبلغ امروز مربوط به سفارش‌های ثبت‌شده در امروز با پرداخت تأییدشده است؛ زمان واریز وجه را نشان نمی‌دهد.</p>
      </section>
      <section className={ui.filters} aria-labelledby="orders-filters-title">
        <div className={ui.sectionHeading}><h2 id="orders-filters-title"><SlidersHorizontal size={17} aria-hidden="true" />جستجو و فیلتر سفارش‌ها</h2>{filtersActive && <button type="button" className={ui.reset} disabled={busy} onClick={() => resetFilters()}>پاک کردن فیلترها</button>}</div>
        <div className={ui.filterGrid}>
          <label className={ui.searchField} htmlFor="orders-search"><span>جستجو</span><div><Search size={18} aria-hidden="true" /><input id="orders-search" type="search" value={search} maxLength={120} disabled={busy} onChange={(event) => {
            if (bulkControllerRef.current) return
            if (event.target.value.trim() !== filters.q) clearBulkScope()
            setSearch(event.target.value)
          }} placeholder="شماره سفارش، مشتری، تلفن یا نام کالا" /></div></label>
          <label className={ui.field} htmlFor="orders-status-filter"><span>وضعیت سفارش</span><EnhancedSelect nativeAppearance id="orders-status-filter" value={filters.status} disabled={busy} onChange={(event) => updateFilters({ status: event.target.value })}><option value="all">همهٔ وضعیت‌ها</option><option value="active">سفارش‌های فعال</option><option value="PENDING">در انتظار</option>{allStatuses.filter((status) => status !== 'PENDING').map((status) => <option key={status} value={status}>{statusLabels[status].label}</option>)}</EnhancedSelect></label>
          <label className={ui.field} htmlFor="orders-payment-filter"><span>وضعیت پرداخت</span><EnhancedSelect nativeAppearance id="orders-payment-filter" value={filters.payment} disabled={busy} onChange={(event) => updateFilters({ payment: event.target.value })}><option value="all">همهٔ پرداخت‌ها</option><option value="paid">پرداخت تأییدشده</option><option value="unpaid">پرداخت تأییدنشده</option><option value="AWAITING_REVIEW">رسید منتظر بررسی</option><option value="AWAITING_RECEIPT">در انتظار رسید</option><option value="REJECTED">نیاز به رسید جدید</option><option value="EXPIRED">مهلت تمام‌شده</option></EnhancedSelect></label>
          <label className={ui.field} htmlFor="orders-range-filter"><span>زمان ثبت سفارش</span><EnhancedSelect nativeAppearance id="orders-range-filter" value={filters.range} disabled={busy} onChange={(event) => { if(event.target.value !== 'custom') updateFilters({ range: event.target.value, from: '', to: '' }) }}><option value="all">همهٔ روزها</option><option value="today">امروز</option><option value="7d">۷ روز اخیر</option><option value="30d">۳۰ روز اخیر</option>{filters.range === 'custom' && <option value="custom">بازهٔ دلخواه</option>}</EnhancedSelect></label>
        </div>
        <details className={ui.dateDetails}>
          <summary>انتخاب بازهٔ دلخواه{filters.range === 'custom' && <span> · فعال</span>}</summary>
          <form onSubmit={applyDates} className={ui.dateForm}>
            <div className={ui.field}><span><label htmlFor="orders-date-from">از تاریخ</label></span><PersianDatePicker id="orders-date-from" value={from} max={to || undefined} required disabled={busy} onChange={setFrom} /></div>
            <div className={ui.field}><span><label htmlFor="orders-date-to">تا تاریخ</label></span><PersianDatePicker id="orders-date-to" value={to} min={from || undefined} required disabled={busy} onChange={setTo} /></div>
            <button type="submit" className={ui.applyDates} disabled={busy}>اعمال بازه</button>
            {dateError && <p className={ui.dateError} role="alert">{dateError}</p>}
          </form>
        </details>
      </section>
      {error && <div role="alert" className={ui.error}>{error} <button type="button" disabled={busy} onClick={refreshOrders}>بارگذاری دوباره</button></div>}
      <div className={ui.listHeading}>
        <h2>فهرست سفارش‌ها</h2>
        <p role="status" aria-live="polite">{loading ? 'در حال دریافت سفارش‌ها…' : loadedQuery === query ? `${formatPrice(pagination.total)} سفارش${filtersActive ? ' مطابق فیلترها' : ''}` : 'دریافت اطلاعات انجام نشد'}</p>
        <label className={ui.pageSize} htmlFor="orders-page-size">تعداد در صفحه<EnhancedSelect nativeAppearance small id="orders-page-size" value={filters.pageSize} disabled={busy} onChange={(event) => updateFilters({ pageSize: Number(event.target.value) })}><option value={20}>۲۰</option><option value={50}>۵۰</option></EnhancedSelect></label>
        <button type="button" className={ui.bulkToggle} aria-expanded={bulkOpen} aria-controls={bulkOpen ? 'order-bulk-panel' : undefined}
          disabled={busy || (!bulkOpen && (!listReady || pagination.total === 0))} onClick={toggleBulk}>
          <ListChecks size={17} aria-hidden="true" />{bulkOpen ? 'بستن تغییر گروهی' : 'تغییر گروهی وضعیت'}
        </button>
      </div>

      {bulkOpen && <section id="order-bulk-panel" className={ui.bulkPanel} aria-labelledby="order-bulk-title" aria-busy={bulkPhase !== null}>
        <div className={ui.bulkHeader}>
          <div><h2 id="order-bulk-title">تغییر گروهی وضعیت</h2><p>سفارش‌ها و وضعیت مقصد را مشخص کن، سپس پیش‌نمایش را بررسی کن.</p></div>
          <span className={ui.bulkLimit}>حداکثر {formatPrice(ADMIN_ORDER_BULK_LIMIT)} سفارش در هر نوبت</span>
        </div>
        <div className={ui.bulkControls}>
          <fieldset className={ui.bulkScopes} disabled={busy}>
            <legend>دامنهٔ تغییر</legend>
            <label><input type="radio" name="bulk-order-scope" value="selected" checked={bulkMode === 'selected'} onChange={() => {
              if (!bulkControllerRef.current) { clearBulkPreview(); setBulkMode('selected') }
            }} />سفارش‌های انتخاب‌شده</label>
            <label><input type="radio" name="bulk-order-scope" value="filtered" checked={bulkMode === 'filtered'} disabled={!filtersActive} onChange={() => {
              if (filtersActive && !bulkControllerRef.current) { clearBulkPreview(); setBulkMode('filtered') }
            }} />همهٔ نتایج فیلتر</label>
          </fieldset>
          <label className={`${ui.field} ${ui.bulkStatus}`} htmlFor="bulk-order-status">
            <span>وضعیت مقصد</span>
            <EnhancedSelect nativeAppearance id="bulk-order-status" value={bulkStatus} disabled={busy} onChange={event => {
              if (!bulkControllerRef.current) { clearBulkPreview(); setBulkStatus(event.target.value) }
            }}>
              <option value="">انتخاب وضعیت</option>
              {allStatuses.map(status => <option key={status} value={status}>{status === 'PENDING' ? 'در انتظار' : statusLabels[status].label}</option>)}
            </EnhancedSelect>
          </label>
          <button type="button" className={ui.bulkPrimary} disabled={!canPreview} onClick={previewBulk}>
            {bulkPhase === 'preview' ? 'در حال بررسی…' : 'پیش‌نمایش تغییر'}
          </button>
        </div>
        <div className={ui.bulkScopeNote}>
          <p role="status" aria-live="polite">{bulkMode === 'selected'
            ? selectedIds.size ? `${formatPrice(selectedIds.size)} سفارش انتخاب شده · انتخاب‌ها بین صفحه‌ها حفظ می‌شوند.` : 'از جدول پایین، سفارش‌ها را تکی یا برای همین صفحه انتخاب کن.'
            : listReady ? `${formatPrice(pagination.total)} سفارش مطابق فیلترهای اعمال‌شده، در تمام صفحه‌ها.` : 'در حال دریافت نتایج فیلتر…'}</p>
          {bulkMode === 'selected' && selectedIds.size > 0 && <button type="button" className={ui.reset} disabled={busy} onClick={clearBulkScope}>پاک‌کردن انتخاب‌ها</button>}
        </div>
        {bulkMode === 'filtered' && filtersActive && <p className={ui.bulkFilterSummary}>{bulkFilterSummary}</p>}
        {!filtersActive && <p className={ui.bulkHint}>برای انتخاب همهٔ نتایج، ابتدا یک فیلتر مثل «امروز» یا یک بازهٔ دلخواه اعمال کن.</p>}
        {bulkMode === 'filtered' && listReady && scopeCount > ADMIN_ORDER_BULK_LIMIT && <p className={ui.bulkHint}>نتایج بیشتر از سقف این عملیات است. بازه را کوتاه‌تر کن یا سفارش‌ها را دستی انتخاب کن.</p>}
        {bulkError && <p role="alert" className={ui.bulkError}>{bulkError}</p>}

        {currentPreview && <div className={ui.bulkReview}>
          <h3 ref={bulkPreviewHeadingRef} tabIndex={-1}>پیش‌نمایش تغییر به «{bulkStatus === 'PENDING' ? 'در انتظار' : statusLabels[bulkStatus]?.label}»</h3>
          <p>{formatPrice(currentPreview.rows.length)} سفارش بررسی شد · {formatPrice(eligibleRows.length)} قابل تغییر · {formatPrice(currentPreview.rows.length - eligibleRows.length)} بدون تغییر</p>
          {currentPreview.rows.length > 0 ? <ul className={ui.bulkRows} aria-label="سفارش‌های پیش‌نمایش" tabIndex={0}>
            {currentPreview.rows.map(row => <li key={row.id}>
              <bdi title={row.id}>#{row.id.slice(-6)}</bdi>
              <span>{row.status === 'PENDING' ? 'در انتظار' : row.status ? statusLabels[row.status]?.label ?? 'وضعیت نامشخص' : 'سفارش یافت نشد'}</span>
              <strong className={row.eligible ? ui.bulkGood : ui.bulkMuted}>{row.eligible ? 'قابل تغییر' : 'بدون تغییر'}</strong>
              {row.reason && <small>{row.reason}</small>}
            </li>)}
          </ul> : <p>سفارشی با این فیلترها باقی نمانده است.</p>}
          {eligibleRows.length > 0 && <div className={ui.bulkConfirm}>
            {bulkStatus === 'CANCELLED' && <p className={ui.bulkHint}>لغو سفارش، وجه پرداخت‌شده را به‌صورت خودکار برنمی‌گرداند.</p>}
            {bulkStatus === 'SHIPPED' && <p className={ui.bulkHint}>تغییر وضعیت ارسال، کد رهگیری ثبت نمی‌کند.</p>}
            <button type="button" className={ui.bulkPrimary} disabled={!canPreview || !currentPreview.token} onClick={confirmBulk}>
              {bulkPhase === 'confirm' ? `در حال ثبت… ${formatPrice(bulkProcessed)} از ${formatPrice(eligibleRows.length)}` : `تأیید و تغییر ${formatPrice(eligibleRows.length)} سفارش`}
            </button>
            <button type="button" className={ui.bulkSecondary} disabled={busy} onClick={clearBulkPreview}>انصراف از پیش‌نمایش</button>
          </div>}
        </div>}

        {bulkResult && bulkCounts && <div className={ui.bulkReview}>
          <h3 ref={bulkResultHeadingRef} tabIndex={-1}>نتیجهٔ تغییر گروهی</h3>
          <p role="status">{Object.entries(bulkCounts).filter(([outcome, count]) => outcome === 'updated' || count > 0)
            .map(([outcome, count]) => `${formatPrice(count)} ${bulkOutcomeLabels[outcome as BulkDisplayResult['outcome']]}`).join(' · ')}</p>
          <ul className={ui.bulkRows} aria-label="نتیجهٔ هر سفارش" tabIndex={0}>
            {bulkResult.map(row => <li key={row.id}>
              <bdi title={row.id}>#{row.id.slice(-6)}</bdi>
              <strong className={row.outcome === 'updated' ? ui.bulkGood : row.outcome === 'error' || row.outcome === 'unknown' ? ui.bulkBad : ui.bulkMuted}>{bulkOutcomeLabels[row.outcome]}</strong>
              {row.reason && <small>{row.reason}</small>}
            </li>)}
          </ul>
        </div>}
      </section>}

      <div className={styles.tablePanel} aria-busy={loading}>
        {loading ? (
          <div className="p-12 text-center text-mist">در حال بارگذاری...</div>
        ) : loadedQuery !== query ? <div className="p-12 text-center text-mist">اطلاعات سفارش‌ها در دسترس نیست.</div> : orders.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-xl font-bold mb-2">{filtersActive ? 'سفارشی مطابق فیلترها پیدا نشد' : 'هنوز سفارشی ثبت نشده'}</p>
            <p className="text-mist mb-6">{filtersActive ? 'عبارت جستجو یا فیلترها را تغییر بده.' : 'سفارش‌های مشتری‌ها پس از ثبت خرید اینجا نمایش داده می‌شوند.'}</p>{filtersActive && <button type="button" className={ui.reset} disabled={busy} onClick={() => resetFilters()}>نمایش همهٔ سفارش‌ها</button>}
          </div>
        ) : (
          <div className="overflow-x-auto">
        <table className={`w-full ${showSelection ? 'min-w-[810px]' : 'min-w-[760px]'}`}>
            <thead className="bg-night text-white">
              <tr>
                {showSelection && <th scope="col" className={ui.bulkCheckCell}><label className={ui.bulkCheck}>
                  <input ref={selectPageRef} type="checkbox" aria-label="انتخاب همهٔ سفارش‌های این صفحه" aria-checked={partlyPageChecked ? 'mixed' : allPageChecked}
                    checked={allPageChecked} disabled={!listReady || busy} onChange={togglePage} />
                </label></th>}
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">شماره</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">مشتری</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">اقلام</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">مبلغ (تومان)</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">وضعیت</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">تاریخ</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.map((order) => (
                <Fragment key={order.id}>
                  <tr className={`hover:bg-fog/30 ${showSelection && selectedIds.has(order.id) ? ui.bulkSelected : ''}`}>
                    {showSelection && <td className={ui.bulkCheckCell}><label className={ui.bulkCheck}>
                      <input type="checkbox" aria-label={`انتخاب سفارش ${order.id.slice(-6)}`} checked={selectedIds.has(order.id)}
                        disabled={!listReady || busy} onChange={() => toggleOrder(order.id)} />
                    </label></td>}
                    <td className="px-4 py-3 md:px-6 md:py-4 font-mono">#{order.id.slice(-6)}</td>
                    <td className="px-4 py-3 md:px-6 md:py-4 font-medium">{order.user.name}<span dir="ltr" className={ui.customerPhone}>{order.phone}</span></td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}
                        aria-expanded={expandedId === order.id}
                        className={`flex items-center gap-1 hover:text-brand ${ui.detailsButton}`}
                      >
                        {formatPrice(order.items.reduce((sum, item) => sum + item.quantity, 0))} جفت · جزئیات
                        <ChevronDown className={`w-4 h-4 transition-transform ${expandedId === order.id ? 'rotate-180' : ''}`} />
                      </button>
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 font-bold">{formatPrice(order.total)}<span className={`block text-xs font-normal mt-1 ${order.verified ? 'text-green-700' : 'text-amber-700'}`}>{order.verified ? 'پرداخت تأییدشده' : paymentLabels[order.paymentStatus ?? ''] || 'پرداخت تأیید نشده'}</span>{order.paymentMethod === 'bank_transfer' && <Link href={`/admin/payments?orderId=${encodeURIComponent(order.id)}`} className="inline-block mt-2 text-xs font-medium text-brand underline underline-offset-4">{order.paymentStatus === 'AWAITING_REVIEW' ? 'بررسی رسید' : 'جزئیات پرداخت'}</Link>}</td>
                    <td className={`px-6 py-4 ${ui.statusCell}`}>
                      <EnhancedSelect nativeAppearance
                        value={order.status}
                        disabled={busy || !listReady}
                        aria-label={`وضعیت سفارش ${order.id.slice(-6)}`}
                        onChange={(e) => handleStatusChange(order.id, e.target.value)}
                        wrapperClassName={ui.statusControl}
                        className={ui.statusSelect}
                        style={{ color: statusLabels[order.status].color, backgroundColor: statusLabels[order.status].background }}
                      >
                        {choicesFor(order).map((s) => (
                          <option key={s} value={s}>{s === 'PENDING' && order.paymentStatus === 'AWAITING_REVIEW' ? 'منتظر تأیید پرداخت' : s === 'PENDING' && order.verified ? 'در انتظار بررسی' : statusLabels[s].label}</option>
                        ))}
                      </EnhancedSelect>
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 text-mist">
                      {new Date(order.createdAt).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })}<span className={ui.orderTime}>{new Date(order.createdAt).toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleDelete(order.id)}
                        disabled={busy || !listReady || !!order.invoice || hasPaymentRecord(order) || order.verified || ['SHIPPED', 'DELIVERED'].includes(order.status)}
                        className="p-2 hover:bg-fog rounded-2xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title={order.invoice ? 'سفارش دارای فاکتور برای حفظ سابقه حذف نمی‌شود' : hasPaymentRecord(order) ? 'برای پیگیری واریز و رسید، سابقهٔ این سفارش حفظ می‌شود' : order.verified || ['SHIPPED', 'DELIVERED'].includes(order.status) ? 'سابقهٔ سفارش پرداخت‌شده یا ارسال‌شده حفظ می‌شود' : 'حذف'}
                        aria-label={`حذف سفارش ${order.id.slice(-6)}`}
                      >
                        <Trash2 className="w-5 h-5 text-red-600" />
                      </button>
                    </td>
                  </tr>
                  {expandedId === order.id && (
                    <tr className="bg-fog/50">
                      <td colSpan={showSelection ? 8 : 7} className="px-6 py-4">
                        <div className={`space-y-2 text-sm ${ui.orderDetails}`}>
                          <p>شناسهٔ کامل سفارش: <bdi>{order.id}</bdi></p>
                          {order.postalCode && <p>کدپستی گیرنده: <bdi dir="ltr">{order.postalCode}</bdi></p>}
                          {order.trackingCode && <p>کد رهگیری مرسوله: <bdi dir="ltr">{order.trackingCode}</bdi></p>}
                          <Link href={`/admin/shipments?orderId=${encodeURIComponent(order.id)}`} className="inline-block text-brand underline underline-offset-4">ثبت و مدیریت رهگیری مرسوله</Link>
                          {order.items.map((item) => (
                            <div key={item.id} className="flex justify-between">
                              <span>
                                {item.productName || item.product.name} — سایز {item.size} — رنگ {item.color} × {item.quantity}
                              </span>
                              <span className="text-left">{item.originalPrice != null && item.originalPrice > item.price && <del className="block text-xs text-mist">{formatPrice(item.originalPrice * item.quantity)} تومان</del>}{formatPrice(item.price * item.quantity - (item.couponDiscount ?? 0))} تومان{(item.couponDiscount ?? 0) > 0 && <small className="block text-brand">سهم تخفیف کد: {formatPrice(item.couponDiscount!)} تومان</small>}</span>
                            </div>
                          ))}
                          <div className="border-t border-line pt-3 space-y-2">
                            {((order.productDiscount ?? 0) > 0 || (order.couponDiscount ?? 0) > 0) && <>
                              <p className="flex justify-between gap-3"><span className="text-mist">جمع اولیهٔ کالاها</span><span>{formatPrice(order.subtotal ?? order.total - order.shippingCost + (order.productDiscount ?? 0) + (order.couponDiscount ?? 0))} تومان</span></p>
                              {(order.productDiscount ?? 0) > 0 && <p className="flex justify-between gap-3 text-brand"><span>تخفیف محصولات</span><span>−{formatPrice(order.productDiscount!)} تومان</span></p>}
                              {(order.couponDiscount ?? 0) > 0 && <p className="flex justify-between gap-3 text-brand"><span>تخفیف کد {order.couponCode && <bdi>{order.couponCode}</bdi>}</span><span>−{formatPrice(order.couponDiscount!)} تومان</span></p>}
                            </>}
                            <p className="flex justify-between gap-3"><span className="text-mist">روش ارسال</span><span>{order.shippingMethodName || 'ثبت نشده'}</span></p>
                            <p className="flex justify-between gap-3"><span className="text-mist">هزینهٔ ارسال</span><span>{order.shippingCost === 0 ? 'رایگان' : `${formatPrice(order.shippingCost)} تومان`}</span></p>
                            <p className="flex justify-between gap-3 font-bold"><span>مجموع سفارش</span><span>{formatPrice(order.total)} تومان</span></p>
                          </div>
                          <div className="border-t border-line pt-2 flex justify-between text-mist">
                            <span>گیرنده: {order.recipientName || order.user.name} | آدرس: {order.address} | تلفن: {order.phone}</span>
                          </div>
                          <InvoiceDownload orderId={order.id} status={order.status} invoice={order.invoice} />
                        </div>
                      </td>
                    </tr>
                   )}
                 </Fragment>
               ))}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {!loading && loadedQuery === query && pagination.total > 0 && <nav className={ui.pagination} aria-label="صفحه‌بندی سفارش‌ها">
        <p>صفحهٔ {formatPrice(pagination.page)} از {formatPrice(pagination.pages)} · {formatPrice(pagination.total)} سفارش</p>
        <div><button type="button" aria-label="صفحهٔ قبل" disabled={busy || pagination.page <= 1} onClick={() => { setExpandedId(null); setFilters((previous) => ({ ...previous, page: pagination.page - 1 })) }}><ArrowRight size={15} aria-hidden="true" />قبلی</button><button type="button" aria-label="صفحهٔ بعد" disabled={busy || pagination.page >= pagination.pages} onClick={() => { setExpandedId(null); setFilters((previous) => ({ ...previous, page: pagination.page + 1 })) }}>بعدی<ArrowLeft size={15} aria-hidden="true" /></button></div>
      </nav>}
    </div>
  )
}
