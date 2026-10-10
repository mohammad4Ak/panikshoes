'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpLeft, ChevronLeft, ChevronRight, Eye, Fingerprint, Globe2, Info, RefreshCw, Users } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatPrice } from '@/lib/utils'
import type { AnalyticsReport } from '@/lib/analytics'
import styles from './analytics.module.css'

const ranges = [{ value: '7d', label: '۷ روز' }, { value: '30d', label: '۳۰ روز' }, { value: '90d', label: '۹۰ روز' }]
const dayFormat = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const paths: Record<string, string> = { '/': 'صفحهٔ اصلی', '/products': 'محصولات', '/about': 'دربارهٔ ما', '/contact': 'تماس با ما', '/cart': 'سبد خرید' }
const pathLabel = (path: string) => paths[path] ?? decodeURIComponent(path.replace('/products/', 'محصول: '))
const dayLabel = (day: string) => dayFormat.format(new Date(day + 'T12:00:00Z'))

function Metrics({ report }: { report: AnalyticsReport }) {
  const metrics = [
    { label: 'بازدید امروز', value: report.summary.todayViews, detail: 'بازدید ثبت‌شده از صفحات فروشگاه', Icon: Eye, primary: true },
    { label: 'بازدیدکنندهٔ امروز', value: report.summary.todayVisitors, detail: 'مرورگرهای متمایز · تخمینی', Icon: Users },
    { label: 'کل بازدیدها', value: report.summary.totalViews, detail: 'از شروع ثبت آمار تا امروز', Icon: Globe2 },
    { label: 'کل بازدیدکنندگان', value: report.summary.totalVisitors, detail: 'مرورگرهای متمایز · تخمینی', Icon: Fingerprint },
  ]
  return <div className={styles.metrics}>{metrics.map(({ label, value, detail, Icon, primary }) => (
    <article key={label} className={styles.metric + (primary ? ' ' + styles.primary : '')}>
      <span className={styles.metricIcon}><Icon size={19} aria-hidden="true" /></span>
      <p>{label}</p><strong>{formatPrice(value)}</strong><small>{detail}</small>
    </article>
  ))}</div>
}

function VisitTrend({ report }: { report: AnalyticsReport }) {
  return <section className={styles.panel} aria-labelledby="visit-trend-title">
    <div className={styles.panelHeading}>
      <div><h2 id="visit-trend-title">روند بازدید فروشگاه</h2><p>{dayLabel(report.range.from)} تا {dayLabel(report.range.to)}</p></div>
      <div className={styles.legend}><span><i />بازدید</span><span><i />بازدیدکننده</span></div>
    </div>
    <div className={styles.rangeTotals}><span><strong>{formatPrice(report.summary.rangeViews)}</strong> بازدید در این بازه</span><span><strong>{formatPrice(report.summary.rangeVisitors)}</strong> مرورگر متمایز</span></div>
    {report.summary.rangeViews ? <div className={styles.chart} dir="ltr" role="img" aria-label={formatPrice(report.summary.rangeViews) + ' بازدید در بازهٔ انتخاب‌شده؛ جدول داده‌ها زیر نمودار قرار دارد.'}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={report.trend} margin={{ top: 15, right: 8, left: 3, bottom: 3 }}>
          <defs><linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgb(var(--theme-brand, 18 102 74))" stopOpacity={0.23} /><stop offset="100%" stopColor="rgb(var(--theme-brand, 18 102 74))" stopOpacity={0.01} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="rgb(var(--theme-line, 232 238 233))" strokeDasharray="3 5" />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgb(var(--theme-muted, 105 116 110))' }} axisLine={false} tickLine={false} minTickGap={30} tickMargin={10} />
          <YAxis allowDecimals={false} width={45} axisLine={false} tickLine={false} tickFormatter={(value: number) => formatPrice(value)} tick={{ fontSize: 10, fill: 'rgb(var(--theme-muted, 105 116 110))' }} />
          <Tooltip contentStyle={{ borderRadius: 16, border: '1px solid rgb(var(--theme-line, 232 238 233))', direction: 'rtl', fontSize: 11 }} formatter={(value, name) => [formatPrice(Number(value)), name === 'views' ? 'بازدید' : 'بازدیدکننده']} />
          <Area type="monotone" dataKey="views" stroke="rgb(var(--theme-brand, 18 102 74))" strokeWidth={2.5} fill="url(#traffic-area)" isAnimationActive={false} />
          <Area type="monotone" dataKey="visitors" stroke="#c69a4c" strokeWidth={2} fill="transparent" strokeDasharray="5 4" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div> : <div className={styles.empty}><Eye size={28} aria-hidden="true" /><p>در این بازه هنوز بازدیدی ثبت نشده است.</p><small>آمار با بازدید از صفحات عمومی فروشگاه شکل می‌گیرد.</small></div>}
    <details className={styles.dataTable}><summary>جدول روزانهٔ بازدیدها</summary><div className={styles.tableScroll}><table><thead><tr><th>روز</th><th>بازدید</th><th>بازدیدکنندهٔ تخمینی</th></tr></thead><tbody>{report.trend.map((row) => <tr key={row.date}><td>{dayLabel(row.date)}</td><td>{formatPrice(row.views)}</td><td>{formatPrice(row.visitors)}</td></tr>)}</tbody></table></div></details>
  </section>
}

function Rankings({ report }: { report: AnalyticsReport }) {
  const maximum = report.topProducts[0]?.views || 1
  return <div className={styles.rankings}>
    <section className={styles.panel} aria-labelledby="top-products-title">
      <div className={styles.panelHeading}><div><h2 id="top-products-title">محصولات پربازدید</h2><p>بر اساس بازدیدهای همین بازه</p></div><Link className={styles.smallLink} href="/products?sort=views">فروشگاه<ArrowUpLeft size={15} aria-hidden="true" /></Link></div>
      {report.topProducts.length ? <ol className={styles.productList}>{report.topProducts.map((product, index) => <li key={product.productId}>
        <span className={styles.rank}>{formatPrice(index + 1)}</span><div><Link href={'/products/' + encodeURIComponent(product.slug)}>{product.name}</Link><div className={styles.bar}><span style={{ width: (product.views / maximum * 100) + '%' }} /></div></div><strong>{formatPrice(product.views)}<small>بازدید</small></strong>
      </li>)}</ol> : <p className={styles.quietEmpty}>بازدید محصولی ثبت نشده است.</p>}
    </section>
    <section className={styles.panel} aria-labelledby="top-pages-title"><div className={styles.panelHeading}><div><h2 id="top-pages-title">صفحات محبوب این بازه</h2><p>تعداد بازدید ثبت‌شده از هر صفحه</p></div></div>
      {report.topPaths.length ? <ol className={styles.pathList}>{report.topPaths.map((row) => <li key={row.pathname}><Link href={row.pathname}>{pathLabel(row.pathname)}</Link><span>{formatPrice(row.views)}</span></li>)}</ol> : <p className={styles.quietEmpty}>هنوز داده‌ای برای رتبه‌بندی نداریم.</p>}
    </section>
  </div>
}

export default function AnalyticsPage() {
  const [range, setRange] = useState('30d')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const key = range + ':' + page + ':' + revision
  const [state, setState] = useState<{ key: string; data: AnalyticsReport | null; error: string | null }>({ key: '', data: null, error: null })
  const current = state.key === key
  const report = current ? state.data : null
  const error = current ? state.error : null
  const loading = !current
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/admin/analytics?' + new URLSearchParams({ range, page: String(page) }), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'دریافت آمار بازدید انجام نشد.')
        return data as AnalyticsReport
      })
      .then((data) => { if (!controller.signal.aborted) setState({ key, data, error: null }) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setState({ key, data: null, error: reason instanceof Error ? reason.message : 'دریافت آمار بازدید انجام نشد.' }) })
    return () => controller.abort()
  }, [key, range, page])
  return <div className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>نبض فروشگاه</span><h1>آمار بازدید سایت</h1><p>دید دقیق‌تری از رفت‌وآمد کاربران و محصولاتی که توجه می‌گیرند.</p></div><button type="button" className={styles.refresh} onClick={() => setRevision((value) => value + 1)} disabled={loading}><RefreshCw size={16} aria-hidden="true" />به‌روزرسانی</button></header>
    <div className={styles.toolbar}><div role="group" aria-label="بازهٔ گزارش" className={styles.ranges}>{ranges.map((item) => <button key={item.value} type="button" aria-pressed={range === item.value} onClick={() => { setRange(item.value); setPage(1) }}>{item.label}</button>)}</div><p>زمان گزارش‌ها: تهران{report && <span> · آخرین به‌روزرسانی {timeFormat.format(new Date(report.generatedAt))}</span>}</p></div>
    {loading && <div className={styles.loading} role="status"><div /><p>در حال دریافت آمار بازدید…</p></div>}
    {error && <div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>تلاش دوباره</button></div>}
    {report && <><Metrics report={report} /><VisitTrend report={report} /><Rankings report={report} />
      <section className={styles.panel} aria-labelledby="visit-log-title"><div className={styles.panelHeading}><div><h2 id="visit-log-title">گزارش بازدیدها و آدرس IP</h2><p>فقط قابل مشاهده برای مدیر · {formatPrice(report.pagination.total)} بازدید در این بازه</p></div><span className={styles.private}>دسترسی مدیر</span></div>
        {report.recent.length ? <div className={styles.tableScroll}><table className={styles.logs}><thead><tr><th>زمان بازدید</th><th>صفحه</th><th>IP گزارش‌شده</th><th>مبدأ ورود</th></tr></thead><tbody>{report.recent.map((visit) => <tr key={visit.id}><td><time dateTime={visit.createdAt}>{timeFormat.format(new Date(visit.createdAt))}</time></td><td><Link href={visit.pathname}>{pathLabel(visit.pathname)}</Link></td><td><bdi className={styles.ip}>{visit.ipAddress || 'ثبت نشده'}</bdi></td><td><bdi className={styles.referrer}>{visit.referrer ? new URL(visit.referrer).hostname : 'مستقیم / نامشخص'}</bdi></td></tr>)}</tbody></table></div> : <p className={styles.quietEmpty}>هنوز بازدیدی در این بازه ثبت نشده است.</p>}
        {report.pagination.pages > 1 && <div className={styles.pagination}><p>صفحهٔ {formatPrice(report.pagination.page)} از {formatPrice(report.pagination.pages)}</p><div><button type="button" onClick={() => setPage(report.pagination.page - 1)} disabled={report.pagination.page <= 1}><ChevronRight size={15} aria-hidden="true" />قبلی</button><button type="button" onClick={() => setPage(report.pagination.page + 1)} disabled={report.pagination.page >= report.pagination.pages}>بعدی<ChevronLeft size={15} aria-hidden="true" /></button></div></div>}
      </section>
      <aside className={styles.notes}><Info size={19} aria-hidden="true" /><div><h2>این اعداد چگونه محاسبه می‌شوند؟</h2><p>بازدیدهای تکراری از یک صفحه در یک مرورگر، تا ۳۰ دقیقه یک بازدید حساب می‌شوند. ربات‌های شناخته‌شده، پیش‌بارگذاری لینک‌ها و صفحات خصوصی حساب، مدیریت و پرداخت در این آمار نیستند.</p><p>«بازدیدکننده» تعداد تخمینی مرورگرهای متمایز با کوکی ناشناس است؛ یک نفر با دو مرورگر ممکن است دو بار شمرده شود و حذف کوکی هم شمارش تازه‌ای ایجاد می‌کند. IP شناسهٔ فرد نیست و در صورت استفاده از پراکسی، صحت آن به تنظیم درست هدرهای پراکسی وابسته است.</p><p>{report.firstTrackedAt ? 'شروع داده‌های ثبت‌شده: ' + dayFormat.format(new Date(report.firstTrackedAt)) : 'ثبت آمار از زمان فعال شدن این بخش آغاز می‌شود؛ بازدیدهای گذشته بازسازی نشده‌اند.'}</p></div></aside>
    </>}
  </div>
}
