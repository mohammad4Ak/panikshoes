'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowDownLeft, ArrowLeft, ArrowUpLeft, CalendarDays, ChevronLeft,
  ChevronRight, Download, Info, Package, ReceiptText, RefreshCw,
  ShoppingBag, Wallet,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { formatPrice, toPersianDigits } from '@/lib/utils'
import type { SalesLedgerReport, SalesReport } from '@/lib/sales-report'
import styles from './dashboard.module.css'

type RangePreset = '7d' | '30d' | '90d' | 'month' | 'custom'
type RangeSelection = { preset: RangePreset; from: string; to: string }
type ReportState<T> = { key: string; data: T | null; error: string | null }

const presets: { value: RangePreset; label: string }[] = [
  { value: '7d', label: '۷ روز اخیر' },
  { value: '30d', label: '۳۰ روز اخیر' },
  { value: '90d', label: '۹۰ روز اخیر' },
  { value: 'month', label: 'ماه شمسی جاری' },
  { value: 'custom', label: 'بازهٔ دلخواه' },
]

const statuses: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'در انتظار', color: '#d3a33c' },
  PROCESSING: { label: 'در حال پردازش', color: '#6c98a8' },
  SHIPPED: { label: 'ارسال شده', color: '#6f9a80' },
  DELIVERED: { label: 'تحویل شده', color: '#12664a' },
  CANCELLED: { label: 'لغو شده', color: '#cf7770' },
}

const paymentOptions = [
  { value: 'all', label: 'همهٔ پرداخت‌ها' },
  { value: 'paid', label: 'تأییدشده · لغونشده' },
  { value: 'unpaid', label: 'تأییدنشده · لغونشده' },
  { value: 'paid_cancelled', label: 'لغوشده با پرداخت' },
  { value: 'unpaid_cancelled', label: 'لغوشده بدون پرداخت' },
]

function formatDate(value: string) {
  return new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Tehran',
  }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value))
}

function shortMoney(value: number) {
  const number = (amount: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(amount)
  if (value >= 1_000_000_000) return `${number(value / 1_000_000_000)} میلیارد`
  if (value >= 1_000_000) return `${number(value / 1_000_000)} میلیون`
  if (value >= 1_000) return `${number(value / 1_000)} هزار`
  return number(value)
}

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => {
    throw new Error('پاسخ گزارش از سرور دریافت نشد. دوباره تلاش کن.')
  })
  if (!response.ok) throw new Error(data.error || 'گزارش دریافت نشد. دوباره تلاش کن.')
  return data as T
}

function useReport<T>(url: string | null, revision: number | string) {
  const key = `${url}|${revision}`
  const [state, setState] = useState<ReportState<T> | null>(null)
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(readResponse<T>)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data, error: null })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key, data: null, error: error instanceof Error && error.name !== 'TypeError' ? error.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.' })
        }
      })
    return () => controller.abort()
  }, [url, key])
  return {
    data: state?.key === key ? state.data : null,
    error: state?.key === key ? state.error : null,
    loading: url !== null && state?.key !== key,
  }
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className={`${styles.comparison} ${styles.comparisonNeutral}`}>بازهٔ قبل مبنای مقایسه ندارد</span>
  const Icon = value < 0 ? ArrowDownLeft : ArrowUpLeft
  return (
    <span className={`${styles.comparison} ${value < 0 ? styles.comparisonDown : value === 0 ? styles.comparisonNeutral : ''}`}>
      {value !== 0 && <Icon size={12} aria-hidden="true" />}
      {new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(Math.abs(value))}٪
      {value > 0 ? ' افزایش' : value < 0 ? ' کاهش' : ' تغییر'} نسبت به بازهٔ قبل
    </span>
  )
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className={styles.empty}><ReceiptText size={27} strokeWidth={1.5} aria-hidden="true" /><strong>{title}</strong>{children && <p>{children}</p>}</div>
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.error} role="alert">
      <div><p>{message}</p><small>برای جلوگیری از نمایش اعداد نادرست، گزارش این بازه نمایش داده نمی‌شود.</small></div>
      <button className={styles.retryButton} onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />تلاش دوباره</button>
    </div>
  )
}

function MoneyRow({ label, value, detail, total = false }: { label: string; value: number; detail?: string; total?: boolean }) {
  return (
    <div className={`${styles.breakdownRow} ${total ? styles.totalRow : ''}`}>
      <div className={styles.breakdownLabel}>{label}{detail && <small>{detail}</small>}</div>
      <div className={styles.breakdownAmount}>{formatPrice(value)}<small>تومان</small></div>
    </div>
  )
}

function Metrics({ report }: { report: SalesReport }) {
  const { summary, changes } = report
  return (
    <div className={styles.metrics}>
      <article className={`${styles.metric} ${styles.primaryMetric}`}>
        <p className={styles.metricLabel}><Wallet size={17} aria-hidden="true" />مبلغ فروش پرداخت‌شده</p>
        <p className={styles.metricValue}>{formatPrice(summary.receipts)}<small>تومان</small></p>
        <p className={styles.metricDetail}>کالا و ارسال · پرداخت تأییدشده و لغونشده</p>
        <Change value={changes.receipts} />
      </article>
      <article className={styles.metric}>
        <p className={styles.metricLabel}><ShoppingBag size={17} aria-hidden="true" />سفارش پرداخت‌شده</p>
        <p className={styles.metricValue}>{toPersianDigits(summary.paidOrders)}<small>سفارش</small></p>
        <p className={styles.metricDetail}>از {toPersianDigits(summary.orders)} سفارش این بازه</p>
        <Change value={changes.paidOrders} />
      </article>
      <article className={styles.metric}>
        <p className={styles.metricLabel}><Package size={17} aria-hidden="true" />تعداد جفت فروخته‌شده</p>
        <p className={styles.metricValue}>{toPersianDigits(summary.unitsSold)}<small>جفت</small></p>
        <p className={styles.metricDetail}>فقط اقلام سفارش‌های پرداخت‌شده و لغونشده</p>
      </article>
      <article className={styles.metric}>
        <p className={styles.metricLabel}><ReceiptText size={17} aria-hidden="true" />میانگین هر سفارش</p>
        <p className={styles.metricValue}>{formatPrice(Math.round(summary.averageOrderValue))}<small>تومان</small></p>
        <p className={styles.metricDetail}>میانگین مبلغ نهایی سفارش‌های پرداخت‌شده</p>
        <Change value={changes.averageOrderValue} />
      </article>
    </div>
  )
}

function SalesTrend({ report }: { report: SalesReport }) {
  return (
    <section className={styles.panel} aria-labelledby="sales-trend-heading">
      <div className={styles.panelHeading}>
        <div><h2 id="sales-trend-heading">روند فروش پرداخت‌شده</h2><p>مبلغ کالا و ارسال · تومان</p></div>
        <span className={styles.panelTag}>{report.range.interval === 'month' ? 'به تفکیک ماه' : 'به تفکیک روز'}</span>
      </div>
      {report.summary.paidOrders > 0 ? (
        <div className={styles.chart} dir="ltr" role="img" aria-label={`نمودار فروش پرداخت‌شده؛ مجموع ${formatPrice(report.summary.receipts)} تومان در این بازه`}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={report.trend} margin={{ top: 12, right: 5, left: 12, bottom: 0 }}>
              <defs><linearGradient id="admin-sales-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgb(var(--theme-brand, 18 102 74))" stopOpacity={0.24} /><stop offset="100%" stopColor="rgb(var(--theme-brand, 18 102 74))" stopOpacity={0.01} /></linearGradient></defs>
              <CartesianGrid stroke="rgb(var(--theme-line, 232 238 233))" strokeDasharray="3 5" vertical={false} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: 'rgb(var(--theme-muted, 129 144 135))', fontSize: 10 }} minTickGap={25} tickMargin={12} />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: 'rgb(var(--theme-muted, 129 144 135))', fontSize: 10 }} tickFormatter={shortMoney} width={83} />
              <Tooltip
                contentStyle={{ borderRadius: 18, border: '1px solid rgb(var(--theme-line, 226 235 229))', boxShadow: '0 10px 30px rgb(var(--theme-ink, 20 33 28) / .05)', direction: 'rtl', fontSize: 11, fontFamily: 'inherit' }}
                formatter={(value) => [`${formatPrice(Number(value))} تومان`, 'فروش پرداخت‌شده']}
                labelFormatter={(_, items) => items[0]?.payload ? (report.range.interval === 'month' ? items[0].payload.label : formatDate(items[0].payload.date)) : ''}
              />
              <Area dataKey="receipts" type="monotone" stroke="rgb(var(--theme-brand, 18 102 74))" strokeWidth={2.5} fill="url(#admin-sales-fill)" dot={false} activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : <Empty title="هنوز فروش تأییدشده‌ای در این بازه نیست">سفارش‌های بدون تأیید پرداخت در نمودار فروش محاسبه نمی‌شوند.</Empty>}
      <div className={styles.chartFoot}><span><i aria-hidden="true" />فروش پرداخت‌شده</span><span>{toPersianDigits(report.summary.paidOrders)} سفارش · {toPersianDigits(report.summary.unitsSold)} جفت</span></div>
    </section>
  )
}

function Reconciliation({ report }: { report: SalesReport }) {
  const { summary } = report
  return (
    <section className={styles.panel} aria-labelledby="reconciliation-heading">
      <div className={styles.panelHeading}><div><h2 id="reconciliation-heading">جمع‌بندی حساب فروش</h2><p>تفکیک مبلغ دریافت‌شده و سفارش‌های باز</p></div></div>
      <div className={styles.breakdown}>
        <MoneyRow label="مبلغ کالای فروخته‌شده" value={summary.merchandise} />
        <MoneyRow label="مبلغ ارسال دریافتی" value={summary.shipping} detail="مبلغی که مشتری بابت ارسال پرداخت کرده" />
        <MoneyRow label="مجموع فروش پرداخت‌شده" value={summary.receipts} total />
        <MoneyRow label="سفارش‌های پرداخت‌تأییدنشده" value={summary.unpaidAmount} detail={`${toPersianDigits(summary.unpaidOrders)} سفارش · در مبلغ فروش محاسبه نشده`} />
        <MoneyRow label="لغوشده با پرداخت تأییدشده" value={summary.paidCancelledAmount} detail={`${toPersianDigits(summary.paidCancelledOrders)} سفارش · نیازمند بررسی بازپرداخت`} />
      </div>
      <div className={styles.notice}><Info size={14} aria-hidden="true" /><p>لغو سفارش به معنی برگشت وجه نیست. مبلغ ارسال دریافتی نیز هزینهٔ پرداخت‌شده به شرکت حمل‌ونقل محسوب نمی‌شود.</p></div>
    </section>
  )
}

function ProductSales({ report }: { report: SalesReport }) {
  return (
    <section className={styles.panel} aria-labelledby="product-sales-heading">
      <div className={styles.panelHeading}><div><h2 id="product-sales-heading">محصولات پرفروش</h2><p>بر اساس اقلام سفارش‌های پرداخت‌شده و لغونشده</p></div><span className={styles.panelTag}>مبلغ کالا · تومان</span></div>
      {report.topProducts.length ? (
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col">محصول</th><th scope="col">تعداد جفت</th><th scope="col">مبلغ فروش</th></tr></thead>
          <tbody>{report.topProducts.map((product, index) => (
            <tr key={product.productId}><td><span className={styles.productName}><span className={styles.productRank}>{toPersianDigits(index + 1)}</span>{product.name}</span></td><td>{toPersianDigits(product.sold)}</td><td className={styles.moneyCell}>{formatPrice(product.merchandise)}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="محصول فروخته‌شده‌ای در این بازه نیست" />}
    </section>
  )
}

function OrderStatuses({ report }: { report: SalesReport }) {
  return (
    <section className={styles.panel} aria-labelledby="order-status-heading">
      <div className={styles.panelHeading}><div><h2 id="order-status-heading">وضعیت سفارش‌های بازه</h2><p>وضعیت ارسال، مستقل از تأیید پرداخت است</p></div></div>
      {report.summary.orders > 0 ? (
        <div className={styles.statusList}>{report.statusBreakdown.map((status) => (
          <div className={styles.statusLine} key={status.status}>
            <span className={styles.statusLabel}><i className={styles.statusDot} style={{ background: statuses[status.status]?.color || 'rgb(var(--theme-muted, 129 144 135))' }} aria-hidden="true" />{status.label}</span>
            <span className={styles.statusNumber}>{toPersianDigits(status.count)} سفارش</span>
            <div className={styles.statusBar} aria-hidden="true"><span style={{ width: `${status.count / report.summary.orders * 100}%`, background: statuses[status.status]?.color || 'rgb(var(--theme-muted, 129 144 135))' }} /></div>
          </div>
        ))}</div>
      ) : <Empty title="سفارشی در این بازه ثبت نشده" />}
      <div className={styles.statusFoot}><span>مجموع سفارش‌ها</span><strong>{toPersianDigits(report.summary.orders)} سفارش</strong></div>
    </section>
  )
}

function ShippingCollections({ report }: { report: SalesReport }) {
  return (
    <section className={styles.panel} aria-labelledby="shipping-report-heading">
      <div className={styles.panelHeading}><div><h2 id="shipping-report-heading">دریافتی به تفکیک ارسال</h2><p>فقط سفارش‌های پرداخت‌شده و لغونشده</p></div><Link href="/admin/shipping" className={styles.panelTag}>مدیریت روش‌ها</Link></div>
      {report.shippingBreakdown.length ? report.shippingBreakdown.map((method) => (
        <div className={styles.shippingRow} key={method.name}>
          <div><p className={styles.shippingName}>{method.name}</p><p className={styles.shippingCount}>{toPersianDigits(method.paidOrders)} سفارش</p></div>
          <p className={styles.shippingAmount}>{formatPrice(method.shipping)}<small>تومان بابت ارسال</small></p>
        </div>
      )) : <Empty title="ارسال پرداخت‌شده‌ای در این بازه نیست" />}
      <div className={styles.notice}><Info size={14} aria-hidden="true" /><p>ارسال رایگان با مبلغ صفر نمایش داده می‌شود. هزینهٔ واقعی پست و شرکت حمل‌ونقل در این گزارش ثبت نشده است.</p></div>
    </section>
  )
}

function paymentLabel(classification: string, verified: boolean) {
  if (classification === 'paid_cancelled') return 'لغوشده با پرداخت'
  if (classification === 'unpaid_cancelled') return 'لغوشده بدون پرداخت'
  return verified ? 'پرداخت تأییدشده' : 'پرداخت تأییدنشده'
}

export default function AdminDashboard() {
  const [range, setRange] = useState<RangeSelection>({ preset: '30d', from: '', to: '' })
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [customMode, setCustomMode] = useState(false)
  const [dateError, setDateError] = useState('')
  const [payment, setPayment] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [ledgerRevision, setLedgerRevision] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const rangeParams = new URLSearchParams({ range: range.preset })
  if (range.preset === 'custom') { rangeParams.set('from', range.from); rangeParams.set('to', range.to) }
  const rangeQuery = rangeParams.toString()
  const report = useReport<SalesReport>(`/api/admin/stats?${rangeQuery}`, revision)
  const data = report.data
  const ledgerParams = new URLSearchParams(data
    ? { range: 'custom', from: data.range.from, to: data.range.to }
    : undefined)
  ledgerParams.set('payment', payment)
  ledgerParams.set('status', status)
  const exportQuery = ledgerParams.toString()
  ledgerParams.set('page', String(page))
  ledgerParams.set('pageSize', '25')
  const ledger = useReport<SalesLedgerReport>(data ? `/api/admin/reports/orders?${ledgerParams}` : null, `${rangeQuery}|${revision}|${ledgerRevision}`)

  function selectPreset(preset: RangePreset) {
    setDateError('')
    setCustomMode(preset === 'custom')
    if (preset === 'custom') {
      if (!draft.from || !draft.to) setDraft({ from: data?.range.from || '', to: data?.range.to || '' })
      return
    }
    setRange({ preset, from: '', to: '' })
    setPage(1)
    setExportError('')
  }

  function applyCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const from = Date.parse(`${draft.from}T00:00:00Z`)
    const to = Date.parse(`${draft.to}T00:00:00Z`)
    if (!draft.from || !draft.to || !Number.isFinite(from) || !Number.isFinite(to)) { setDateError('تاریخ شروع و پایان را انتخاب کن.'); return }
    if (from > to) { setDateError('تاریخ پایان باید بعد از تاریخ شروع باشد.'); return }
    if ((to - from) / 86_400_000 + 1 > 366) { setDateError('بازهٔ گزارش می‌تواند حداکثر ۳۶۶ روز باشد.'); return }
    setDateError('')
    setRange({ preset: 'custom', ...draft })
    setPage(1)
    setExportError('')
  }

  async function exportCsv() {
    setExporting(true)
    setExportError('')
    try {
      const response = await fetch(`/api/admin/reports/orders?${exportQuery}&format=csv`, { cache: 'no-store' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'دریافت فایل گزارش انجام نشد. دوباره تلاش کن.' }))
        throw new Error(body.error || 'دریافت فایل گزارش انجام نشد.')
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      const exportedRange = ledger.data?.range || data?.range
      link.download = `sales-orders-${exportedRange?.from || 'report'}-${exportedRange?.to || ''}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      setExportError(error instanceof Error && error.name !== 'TypeError' ? error.message : 'دریافت فایل گزارش انجام نشد. دوباره تلاش کن.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={styles.dashboard}>
      <header className={styles.heading}>
        <div><span className={styles.eyebrow}>گزارش‌های مالی فروشگاه</span><h1>فروش و دریافت‌ها</h1><p>پرداخت‌های تأییدشده، مبلغ ارسال و ریز سفارش‌ها را در یک بازه بررسی کن.</p></div>
        <Link href="/admin/orders" className={styles.headerAction}>مدیریت سفارش‌ها<ArrowLeft size={15} aria-hidden="true" /></Link>
      </header>
      <section className={styles.filterPanel} aria-label="انتخاب بازهٔ گزارش">
        <div className={styles.filterTop}>
          <span className={styles.filterTitle}><CalendarDays size={17} aria-hidden="true" />بازهٔ گزارش</span>
          <div className={styles.presets}>{presets.map((preset) => (
            <button key={preset.value} type="button" onClick={() => selectPreset(preset.value)} aria-pressed={(customMode ? 'custom' : range.preset) === preset.value} className={`${styles.preset} ${(customMode ? 'custom' : range.preset) === preset.value ? styles.presetActive : ''}`}>{preset.label}</button>
          ))}</div>
        </div>
        {customMode && <form className={styles.dateRow} onSubmit={applyCustom}>
          <label className={styles.dateField}><span>از تاریخ</span><input type="date" value={draft.from} onChange={(event) => setDraft((previous) => ({ ...previous, from: event.target.value }))} required aria-describedby="date-picker-note" /></label>
          <label className={styles.dateField}><span>تا تاریخ</span><input type="date" value={draft.to} onChange={(event) => setDraft((previous) => ({ ...previous, to: event.target.value }))} required aria-describedby="date-picker-note" /></label>
          <button type="submit" className={styles.applyButton}>نمایش گزارش</button>
          <p className={styles.rangeCaption} id="date-picker-note">تاریخ ورودی میلادی است؛ گزارش به تاریخ شمسی نمایش داده می‌شود.</p>
        </form>}
        <div className={styles.dateRow}><p className={styles.rangeCaption} aria-live="polite">
          {data ? <><strong>{formatDate(data.range.from)} تا {formatDate(data.range.to)}</strong>مقایسه با {formatDate(data.previousRange.from)} تا {formatDate(data.previousRange.to)} · ساعت تهران</> : report.loading ? 'در حال دریافت بازهٔ گزارش…' : 'بازهٔ گزارش در دسترس نیست'}
        </p></div>
        {dateError && <p className={styles.filterError} role="alert">{dateError}</p>}
      </section>
      {report.error ? <ErrorPanel message={report.error} onRetry={() => setRevision((value) => value + 1)} /> : report.loading ? (
        <div aria-busy="true" aria-label="در حال بارگذاری گزارش"><div className={styles.metrics}>{Array.from({ length: 4 }, (_, index) => <div key={index} className={`${styles.skeleton} ${styles.metricSkeleton}`} />)}</div><p className={styles.loadingText} role="status">در حال آماده‌سازی گزارش فروش…</p></div>
      ) : data ? <>
        <Metrics report={data} />
        <div className={styles.splitGrid}><SalesTrend report={data} /><Reconciliation report={data} /></div>
        <div className={styles.splitGrid}><ProductSales report={data} /><OrderStatuses report={data} /></div>
        <ShippingCollections report={data} />
      </> : null}
      <section className={`${styles.panel} ${styles.ledgerPanel}`} aria-labelledby="order-ledger-heading">
        <div className={`${styles.panelHeading} ${styles.ledgerHeader}`}><div><h2 id="order-ledger-heading">ریز حساب سفارش‌ها</h2><p>مبلغ کالا، ارسال و وضعیت پرداخت هر سفارش · همهٔ مبالغ به تومان</p></div></div>
        <div className={styles.ledgerTools}>
          <label className={styles.ledgerFilter}><span>وضعیت پرداخت</span><select value={payment} onChange={(event) => { setPayment(event.target.value); setPage(1); setExportError('') }}>{paymentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className={styles.ledgerFilter}><span>وضعیت سفارش</span><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); setExportError('') }}><option value="all">همهٔ وضعیت‌ها</option>{Object.entries(statuses).map(([value, status]) => <option key={value} value={value}>{status.label}</option>)}</select></label>
          <button className={styles.exportButton} onClick={exportCsv} disabled={exporting || !data || ledger.loading || !!ledger.error || !ledger.data?.pagination.total}><Download size={15} aria-hidden="true" />{exporting ? 'در حال دریافت…' : 'خروجی برای Excel · CSV'}</button>
        </div>
        <p className={styles.footnote}>فایل شامل همهٔ سفارش‌های مطابق بازه و فیلترهاست، تا سقف ۱۰٬۰۰۰ ردیف؛ فقط صفحهٔ جاری نیست.</p>
        {exportError && <p className={styles.filterError} role="alert">{exportError}</p>}
        {report.loading ? <p className={styles.loadingText} role="status">ابتدا بازهٔ گزارش آماده می‌شود…</p> : report.error ? <Empty title="ریز سفارش‌ها تا دریافت گزارش بازه در دسترس نیست">با تلاش دوباره برای گزارش، ریز سفارش‌ها نیز دریافت می‌شود.</Empty> : ledger.loading ? <p className={styles.loadingText} role="status">در حال دریافت ریز سفارش‌ها…</p> : ledger.error ? <ErrorPanel message={ledger.error} onRetry={() => setLedgerRevision((value) => value + 1)} /> : ledger.data?.orders.length ? <>
          <div className={styles.tableWrap}><table className={`${styles.table} ${styles.ledgerTable}`}>
            <thead><tr><th scope="col">سفارش / مشتری</th><th scope="col">تاریخ ثبت</th><th scope="col">مبلغ کالا</th><th scope="col">ارسال</th><th scope="col">مجموع</th><th scope="col">پرداخت</th><th scope="col">وضعیت سفارش</th></tr></thead>
            <tbody>{ledger.data.orders.map((order) => <tr key={order.id}>
              <td><span className={styles.orderId} title={order.id}>#{order.id.slice(-8)}</span><span className={styles.customerName}>{order.customerName || 'بدون نام'}</span></td>
              <td className={styles.dateCell}>{formatDate(order.createdAt)}<br />{toPersianDigits(order.units)} جفت</td>
              <td className={styles.moneyCell}>{formatPrice(order.merchandise)}</td>
              <td>{formatPrice(order.shipping)}<span className={styles.shippingCount} style={{ display: 'block' }}>{order.shippingMethodName || 'ثبت نشده'}</span></td>
              <td className={styles.moneyCell}>{formatPrice(order.total)}</td>
              <td><span className={`${styles.badge} ${order.status === 'CANCELLED' ? styles.cancelledBadge : order.verified ? styles.paidBadge : styles.unpaidBadge}`}>{paymentLabel(order.classification, order.verified)}</span></td>
              <td><span className={`${styles.badge} ${order.status === 'CANCELLED' ? styles.cancelledBadge : ''}`}>{statuses[order.status]?.label || order.status}</span></td>
            </tr>)}</tbody>
          </table></div>
          <div className={styles.pager}>
            <p>صفحهٔ {toPersianDigits(ledger.data.pagination.page)} از {toPersianDigits(ledger.data.pagination.pages)} · {toPersianDigits(ledger.data.pagination.total)} سفارش</p>
            <div className={styles.pagerButtons}><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronRight size={13} aria-hidden="true" />صفحهٔ قبل</button><button disabled={page >= ledger.data.pagination.pages} onClick={() => setPage((value) => value + 1)}>صفحهٔ بعد<ChevronLeft size={13} aria-hidden="true" /></button></div>
          </div>
        </> : ledger.data && ledger.data.pagination.total > 0 ? (
          <div className={styles.empty}>
            <ReceiptText size={27} strokeWidth={1.5} aria-hidden="true" />
            <strong>تعداد سفارش‌ها تغییر کرده و این صفحه خالی شده</strong>
            <p>{toPersianDigits(ledger.data.pagination.total)} سفارش مطابق این فیلترها موجود است.</p>
            <button className={styles.retryButton} onClick={() => setPage(Math.max(1, ledger.data!.pagination.pages))}>بازگشت به آخرین صفحهٔ موجود</button>
          </div>
        ) : <Empty title="سفارشی مطابق این فیلترها نیست">بازهٔ زمانی یا وضعیت پرداخت را تغییر بده.</Empty>}
      </section>
      {data && <p className={styles.footnote}>{data.notes.join(' ')}<br />آخرین محاسبه: {formatDate(data.generatedAt)}، {new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(data.generatedAt))} · {toPersianDigits(data.catalog.products)} محصول و {toPersianDigits(data.catalog.users)} کاربر در فروشگاه</p>}
    </div>
  )
}
