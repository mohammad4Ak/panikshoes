'use client'

import { Fragment, useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Trash2, ChevronDown, Search, SlidersHorizontal, RefreshCw, ArrowLeft, ArrowRight, PackageCheck, ClipboardList, ReceiptText, Truck } from 'lucide-react'
import { formatPrice } from '@/lib/utils'
import type { InvoiceMetadata } from '@/lib/invoice'
import type { AdminOrdersDashboard, AdminOrdersPagination } from '@/lib/admin-orders'
import InvoiceDownload from '@/components/shop/InvoiceDownload'
import styles from '@/components/admin/admin.module.css'
import ui from './orders.module.css'

interface Order {
  id: string
  total: number
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
  createdAt: string
  invoice?: InvoiceMetadata | null
  user: { name: string; email: string }
  items: { id: string; quantity: number; size: number; color: string; price: number; productName?: string | null; product: { name: string } }[]
}

const statusLabels: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'در انتظار پرداخت', color: 'bg-yellow-100 text-yellow-700' },
  PROCESSING: { label: 'در حال پردازش', color: 'bg-sky-50 text-sky-700' },
  SHIPPED: { label: 'ارسال شده', color: 'bg-teal-50 text-teal-700' },
  DELIVERED: { label: 'تحویل شده', color: 'bg-green-100 text-green-700' },
  CANCELLED: { label: 'لغو شده', color: 'bg-red-100 text-red-700' },
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
  const [loadedQuery, setLoadedQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busyIds, setBusyIds] = useState<string[]>([])
  const loadControllerRef = useRef<AbortController | null>(null)
  const writeControllersRef = useRef(new Map<string, AbortController>())
  const params = new URLSearchParams({ q: filters.q, status: filters.status, payment: filters.payment, range: filters.range, page: String(filters.page), pageSize: String(filters.pageSize) })
  if (filters.range === 'custom') { params.set('from', filters.from); params.set('to', filters.to) }
  const query = params.toString()
  const busy = busyIds.length > 0
  const filtersActive = Boolean(filters.q || filters.status !== 'all' || filters.payment !== 'all' || filters.range !== 'all')

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
        }
      })
      .catch((cause) => { if (!signal.aborted) setError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'خطای ارتباط با سرور') })
      .finally(() => { if (!signal.aborted) setLoading(false) })
  }, [query])
  const loadOrdersRef = useRef(loadOrders)

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

  const updateFilters = (values: Partial<typeof filters>) => {
    setExpandedId(null)
    setFilters((previous) => ({ ...previous, ...values, page: 1 }))
  }
  const resetFilters = (values: Partial<typeof filters> = {}) => {
    setSearch('')
    setFrom('')
    setTo('')
    setDateError('')
    setExpandedId(null)
    setFilters({ q: '', status: 'all', payment: 'all', range: 'all', from: '', to: '', page: 1, pageSize: filters.pageSize, ...values })
  }
  const applyDates = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!from || !to || from > to) { setDateError('تاریخ شروع و پایان را به ترتیب وارد کنید.'); return }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 365) { setDateError('بازهٔ دلخواه باید حداکثر ۳۶۶ روز باشد.'); return }
    setDateError('')
    updateFilters({ range: 'custom', from, to })
  }
  const todayLabel = dashboard ? new Date(`${dashboard.date}T12:00:00Z`).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }) : 'به وقت ایران'

  const handleStatusChange = async (id: string, status: string) => {
    const currentOrder = orders.find((order) => order.id === id)
    if (writeControllersRef.current.size > 0 || loading || search.trim() !== filters.q || !currentOrder || status === currentOrder.status || !choicesFor(currentOrder).includes(status)) return
    const controller = new AbortController()
    writeControllersRef.current.set(id, controller)
    loadControllerRef.current?.abort()
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
    if (writeControllersRef.current.size > 0 || loading || search.trim() !== filters.q || !currentOrder || currentOrder.invoice || hasPaymentRecord(currentOrder) || currentOrder.verified || ['SHIPPED', 'DELIVERED'].includes(currentOrder.status)) return
    if (!confirm('این سفارش حذف شود؟')) return
    const controller = new AbortController()
    writeControllersRef.current.set(id, controller)
    loadControllerRef.current?.abort()
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
          <button type="button" className={styles.headerLink} disabled={loading || busy} onClick={() => void loadOrders()}><RefreshCw size={16} aria-hidden="true" />تازه‌سازی</button>
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
          <label className={ui.searchField} htmlFor="orders-search"><span>جستجو</span><div><Search size={18} aria-hidden="true" /><input id="orders-search" type="search" value={search} maxLength={120} disabled={busy} onChange={(event) => setSearch(event.target.value)} placeholder="شماره سفارش، مشتری، تلفن یا نام کالا" /></div></label>
          <label className={ui.field} htmlFor="orders-status-filter"><span>وضعیت سفارش</span><select id="orders-status-filter" value={filters.status} disabled={busy} onChange={(event) => updateFilters({ status: event.target.value })}><option value="all">همهٔ وضعیت‌ها</option><option value="active">سفارش‌های فعال</option><option value="PENDING">در انتظار</option>{allStatuses.filter((status) => status !== 'PENDING').map((status) => <option key={status} value={status}>{statusLabels[status].label}</option>)}</select></label>
          <label className={ui.field} htmlFor="orders-payment-filter"><span>وضعیت پرداخت</span><select id="orders-payment-filter" value={filters.payment} disabled={busy} onChange={(event) => updateFilters({ payment: event.target.value })}><option value="all">همهٔ پرداخت‌ها</option><option value="paid">پرداخت تأییدشده</option><option value="unpaid">پرداخت تأییدنشده</option><option value="AWAITING_REVIEW">رسید منتظر بررسی</option><option value="AWAITING_RECEIPT">در انتظار رسید</option><option value="REJECTED">نیاز به رسید جدید</option><option value="EXPIRED">مهلت تمام‌شده</option></select></label>
          <label className={ui.field} htmlFor="orders-range-filter"><span>زمان ثبت سفارش</span><select id="orders-range-filter" value={filters.range} disabled={busy} onChange={(event) => { if(event.target.value !== 'custom') updateFilters({ range: event.target.value, from: '', to: '' }) }}><option value="all">همهٔ روزها</option><option value="today">امروز</option><option value="7d">۷ روز اخیر</option><option value="30d">۳۰ روز اخیر</option>{filters.range === 'custom' && <option value="custom">بازهٔ دلخواه</option>}</select></label>
        </div>
        <details className={ui.dateDetails}>
          <summary>انتخاب بازهٔ دلخواه{filters.range === 'custom' && <span> · فعال</span>}</summary>
          <form onSubmit={applyDates} className={ui.dateForm}>
            <label className={ui.field} htmlFor="orders-date-from"><span>از تاریخ (میلادی)</span><input id="orders-date-from" type="date" value={from} max={to || undefined} required disabled={busy} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className={ui.field} htmlFor="orders-date-to"><span>تا تاریخ (میلادی)</span><input id="orders-date-to" type="date" value={to} min={from || undefined} required disabled={busy} onChange={(event) => setTo(event.target.value)} /></label>
            <button type="submit" className={ui.applyDates} disabled={busy}>اعمال بازه</button>
            {dateError && <p className={ui.dateError} role="alert">{dateError}</p>}
          </form>
        </details>
      </section>
      {error && <div role="alert" className={ui.error}>{error} <button type="button" disabled={busy} onClick={() => void loadOrders()}>بارگذاری دوباره</button></div>}
      <div className={ui.listHeading}><h2>فهرست سفارش‌ها</h2><p role="status" aria-live="polite">{loading ? 'در حال دریافت سفارش‌ها…' : loadedQuery === query ? `${formatPrice(pagination.total)} سفارش${filtersActive ? ' مطابق فیلترها' : ''}` : 'دریافت اطلاعات انجام نشد'}</p><label className={ui.pageSize} htmlFor="orders-page-size">تعداد در صفحه<select id="orders-page-size" value={filters.pageSize} disabled={busy} onChange={(event) => updateFilters({ pageSize: Number(event.target.value) })}><option value={20}>۲۰</option><option value={50}>۵۰</option></select></label></div>

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
        <table className="w-full min-w-[760px]">
            <thead className="bg-night text-white">
              <tr>
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
                  <tr className="hover:bg-fog/30">
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
                    <td className="px-6 py-4">
                      <select
                        value={order.status}
                        disabled={busy || loading || search.trim() !== filters.q}
                        aria-label={`وضعیت سفارش ${order.id.slice(-6)}`}
                        onChange={(e) => handleStatusChange(order.id, e.target.value)}
                        className={`px-3 py-2 rounded-full text-sm border-none cursor-pointer ${statusLabels[order.status].color}`}
                      >
                        {choicesFor(order).map((s) => (
                          <option key={s} value={s}>{s === 'PENDING' && order.paymentStatus === 'AWAITING_REVIEW' ? 'منتظر تأیید پرداخت' : s === 'PENDING' && order.verified ? 'در انتظار بررسی' : statusLabels[s].label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 text-mist">
                      {new Date(order.createdAt).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })}<span className={ui.orderTime}>{new Date(order.createdAt).toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleDelete(order.id)}
                        disabled={busy || loading || search.trim() !== filters.q || !!order.invoice || hasPaymentRecord(order) || order.verified || ['SHIPPED', 'DELIVERED'].includes(order.status)}
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
                      <td colSpan={7} className="px-6 py-4">
                        <div className={`space-y-2 text-sm ${ui.orderDetails}`}>
                          <p>شناسهٔ کامل سفارش: <bdi>{order.id}</bdi></p>
                          {order.items.map((item) => (
                            <div key={item.id} className="flex justify-between">
                              <span>
                                {item.productName || item.product.name} — سایز {item.size} — رنگ {item.color} × {item.quantity}
                              </span>
                              <span>{formatPrice(item.price * item.quantity)} تومان</span>
                            </div>
                          ))}
                          <div className="border-t border-line pt-3 space-y-2">
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
