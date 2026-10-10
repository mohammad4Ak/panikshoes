'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, MessageSquareText, RefreshCw, Search, Star, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { formatPrice } from '@/lib/utils'
import styles from './reviews.module.css'

type Review = { id: string; rating: number; comment: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; moderationNote: string | null; revision: number; createdAt: string; updatedAt: string; product: { name: string; slug: string }; user: { name: string } }
type Report = { reviews: Review[]; total: number; pending: number; page: number; totalPages: number }
const labels = { PENDING: 'منتظر بررسی', APPROVED: 'تأییدشده', REJECTED: 'ردشده' }
const time = (value: string) => new Date(value).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' })

export default function AdminReviewsPage() {
  const [report, setReport] = useState<Report | null>(null)
  const [status, setStatus] = useState('PENDING')
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const [page, setPage] = useState(1), [reload, setReload] = useState(0)
  const requestKey = [status, search, page, reload].join(':')
  const [settledRequest, setSettledRequest] = useState('')
  const [readError, setReadError] = useState<{ key: string; message: string } | null>(null)
  const loading = settledRequest !== requestKey
  const error = readError?.key === requestKey ? readError.message : ''
  const [message, setMessage] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState('')
  const [busyId, setBusyId] = useState('')
  const mutation = useRef<AbortController | null>(null)
  useEffect(() => () => mutation.current?.abort(), [])
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setPage(1) }, 300); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ status, q: search, page: String(page) })
    void fetch('/api/admin/reviews?' + params, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || 'نظرات دریافت نشد')
      if (!Array.isArray(data?.reviews)) throw new Error('پاسخ نظرات معتبر نیست')
      if (!controller.signal.aborted) {
        setReadError(null)
        if (page > data.totalPages) setPage(data.totalPages)
        else setReport(data)
      }
    }).catch(cause => { if (!controller.signal.aborted) setReadError({ key: requestKey, message: cause instanceof Error ? cause.message : 'ارتباط برقرار نشد' }) })
      .finally(() => { if (!controller.signal.aborted) setSettledRequest(requestKey) })
    return () => controller.abort()
  }, [status, search, page, reload, requestKey])

  async function moderate(review: Review, action: 'approve' | 'reject') {
    if (mutation.current || loading) return
    const controller = new AbortController(); mutation.current = controller
    setBusyId(review.id); setActionError(''); setMessage('')
    try {
      const response = await fetch('/api/admin/reviews/' + encodeURIComponent(review.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ action, expectedRevision: review.revision, note: notes[review.id] ?? review.moderationNote ?? '' }),
      })
      const data = await response.json().catch(() => null)
      if (controller.signal.aborted) return
      if (!response.ok) {
        if (response.status === 409) setReload(value => value + 1)
        throw new Error(data?.error || 'نتیجه بررسی ثبت نشد')
      }
      if (!controller.signal.aborted) { setMessage(action === 'approve' ? 'نظر تأیید شد و امتیاز آن در محبوبیت محصول محاسبه می‌شود.' : 'نظر از نمایش عمومی و محاسبه امتیاز کنار گذاشته شد.'); setReload(value => value + 1) }
    } catch (cause) { if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : 'ارتباط برقرار نشد') }
    finally { if (mutation.current === controller) mutation.current = null; if (!controller.signal.aborted) setBusyId('') }
  }

  return <div className={styles.page}>
    <header className={styles.heading}><div><p>بازخورد مشتری‌ها</p><h1>نظرات و امتیازها</h1><span>فقط امتیازهای تأییدشده در ویترین و مرتب‌سازی محبوب‌ترین محاسبه می‌شوند.</span></div><span className={styles.pending}><MessageSquareText size={20} />{formatPrice(report?.pending ?? 0)} منتظر بررسی</span></header>
    <section className={styles.filters} aria-label="فیلتر نظرات">
      <label className={styles.search}><Search size={18} /><input aria-label="جستجوی نظرات" placeholder="نام محصول، مشتری یا متن نظر" value={query} onChange={event => setQuery(event.target.value)} maxLength={100} /></label>
      <EnhancedSelect aria-label="وضعیت نظر" value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}><option value="PENDING">منتظر بررسی</option><option value="APPROVED">تأییدشده</option><option value="REJECTED">ردشده</option><option value="ALL">همه نظرات</option></EnhancedSelect>
      <button type="button" className="btn-outline" disabled={loading || !!busyId} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} />تازه‌سازی</button>
    </section>
    {message && <p className={styles.success} role="status">{message}</p>}
    {actionError && <p className={styles.error} role="alert">{actionError}</p>}
    {error && <div className={styles.error} role="alert">{error}<button type="button" onClick={() => setReload(value => value + 1)}>تلاش دوباره</button></div>}
    {loading ? <div className={styles.empty} role="status">در حال دریافت نظرات…</div> : !error && !report?.reviews.length ? <div className={styles.empty}><MessageSquareText size={32} /><h2>نظری با این فیلتر نداریم.</h2><p>نظرات تازهٔ کاربران برای بررسی در این بخش قرار می‌گیرند.</p></div> : <div className={styles.list} aria-busy={!!busyId}>
      {report?.reviews.map(review => <article key={review.id} className={styles.review}>
        <div className={styles.reviewHeader}><div><Link href={'/products/' + encodeURIComponent(review.product.slug)}>{review.product.name}</Link><p>{review.user.name} · <time dateTime={review.createdAt}>{time(review.createdAt)}</time></p></div><span className={styles[review.status]}>{labels[review.status]}</span></div>
        <div className={styles.rating} aria-label={formatPrice(review.rating) + ' از ۵'}>{Array.from({ length: 5 }, (_, index) => <Star key={index} size={18} fill={index < review.rating ? 'currentColor' : 'none'} />)}<strong>{formatPrice(review.rating)} / ۵</strong></div>
        <p className={styles.comment}>{review.comment || 'این کاربر فقط امتیاز ثبت کرده است.'}</p>
        <div className={styles.reviewFooter}><label>یادداشت برای کاربر <span>(اختیاری)</span><input aria-label={'یادداشت بررسی برای ' + review.user.name} value={notes[review.id] ?? review.moderationNote ?? ''} onChange={event => setNotes(value => ({ ...value, [review.id]: event.target.value }))} maxLength={500} placeholder="مثلاً دلیل رد یا نیاز به اصلاح نظر" disabled={!!busyId} /></label><div className={styles.actions}><button type="button" className="btn-primary" disabled={!!busyId || review.status === 'APPROVED'} onClick={() => void moderate(review, 'approve')}><Check size={17} />تأیید</button><button type="button" className={styles.reject} disabled={!!busyId || review.status === 'REJECTED'} onClick={() => void moderate(review, 'reject')}><X size={17} />رد نظر</button></div></div>
      </article>)}
    </div>}
    {!!report?.total && <nav className={styles.pagination} aria-label="صفحه‌های نظرات"><span>{formatPrice(report.total)} نظر · صفحهٔ {formatPrice(page)} از {formatPrice(report.totalPages)}</span><div><button type="button" disabled={loading || !!busyId || page <= 1} onClick={() => setPage(value => value - 1)}>قبلی</button><button type="button" disabled={loading || !!busyId || page >= report.totalPages} onClick={() => setPage(value => value + 1)}>بعدی</button></div></nav>}
  </div>
}
