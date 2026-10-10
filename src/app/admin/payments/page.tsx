'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpLeft, Check, ChevronDown, ExternalLink, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { formatPrice } from '@/lib/utils'
import adminStyles from '@/components/admin/admin.module.css'
import styles from './payments.module.css'

interface Receipt {
  id: string
  createdAt: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  payerCardLast4: string | null
  transferReference: string | null
  reviewNote: string | null
  reviewedAt: string | null
  isLate: boolean
}
interface PaymentOrder {
  id: string
  total: number
  status: string
  paymentStatus: string
  paymentExpiresAt: string | null
  paymentCardNumber: string | null
  paymentCardholderName: string | null
  paymentBankName: string | null
  verified: boolean
  createdAt: string
  phone: string
  recipientName: string | null
  user: { name: string; email: string }
  receipts: Receipt[]
  items: { id: string; productName?: string | null; quantity: number; size: number; color: string; product: { name: string } }[]
}
const paymentLabels: Record<string, string> = {
  AWAITING_REVIEW: 'منتظر بررسی', AWAITING_RECEIPT: 'منتظر رسید',
  REJECTED: 'نیاز به رسید جدید', PAID: 'تأییدشده', EXPIRED: 'مهلت تمام‌شده',
}
const receiptLabels = { PENDING: 'منتظر بررسی', APPROVED: 'تأییدشده', REJECTED: 'ردشده' }
const dateTime = (value: string) => new Date(value).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' })
const money = (value: number) => `${formatPrice(value)} تومان`
const receiptUrl = (orderId: string, receiptId: string) => `/api/orders/${encodeURIComponent(orderId)}/receipts/${encodeURIComponent(receiptId)}`

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null)
  return typeof body?.error === 'string' ? body.error : fallback
}

function ReviewDialog({ order, receipt, action, onDismiss, onReviewed, onConflict }: {
  order: PaymentOrder
  receipt: Receipt
  action: 'approve' | 'reject'
  onDismiss: () => void
  onReviewed: (order: PaymentOrder) => void
  onConflict: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const approve = action === 'approve'
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => { requestRef.current?.abort(); dialog?.close() }
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (requestRef.current) return
    setError('')
    if (approve && !confirmed) return setError('ابتدا دریافت مبلغ در حساب بانکی را تأیید کنید.')
    if (!approve && !note.trim()) return setError('دلیل رد رسید را برای مشتری بنویسید.')
    const controller = new AbortController()
    requestRef.current = controller
    setSaving(true)
    try {
      const response = await fetch(`/api/admin/payments/${encodeURIComponent(order.id)}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ receiptId: receipt.id, action, note: note.trim() || undefined }),
      })
      if (!response.ok) {
        const message = await responseError(response, 'نتیجهٔ بررسی ثبت نشد. دوباره تلاش کنید.')
        if (response.status === 409) onConflict()
        throw new Error(message)
      }
      const result = await response.json()
      if (!result?.order || result.order.id !== order.id) throw new Error('پاسخ بررسی پرداخت معتبر نیست؛ وضعیت پرداخت را دوباره بارگذاری کنید.')
      if (!controller.signal.aborted) onReviewed(result.order)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally {
      requestRef.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  return (
    <dialog ref={dialogRef} className={`${adminStyles.dialog} ${styles.dialog}`} aria-labelledby="payment-review-title" onCancel={(event) => { event.preventDefault(); if (!saving) onDismiss() }}>
      <div className={adminStyles.dialogHeader}><h2 id="payment-review-title">{approve ? 'تأیید دریافت وجه' : 'رد رسید پرداخت'}</h2><button type="button" onClick={onDismiss} disabled={saving} aria-label="بستن بررسی رسید"><X size={20} aria-hidden="true" /></button></div>
      <form onSubmit={submit} className={styles.reviewForm} aria-busy={saving}>
        <div className={styles.reviewSummary}><span>سفارش <b dir="ltr">#{order.id.slice(-6)}</b></span><strong>{money(order.total)}</strong><small>{order.user.name}</small></div>
        <a href={receiptUrl(order.id, receipt.id)} target="_blank" rel="noopener noreferrer" className={styles.receiptLink}>باز کردن تصویر رسید <ExternalLink size={15} aria-hidden="true" /></a>
        {approve ? <>
          <p className={styles.help}>با تأیید، پرداخت ثبت می‌شود، سفارش به «در حال پردازش» می‌رود و فاکتور صادر می‌شود.</p>
          {(receipt.isLate || order.status === 'CANCELLED') && <p className={styles.warning}>این پرداخت پس از پایان رزرو یا لغو سفارش بررسی می‌شود. تأیید فقط در صورت موجود بودن تمام کالاها انجام خواهد شد.</p>}
          <label className={styles.confirmLabel}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={saving} required /><span>دریافت مبلغ <strong>{money(order.total)}</strong> را در حساب بانکی بررسی کرده‌ام و این واریز مربوط به همین سفارش است.</span></label>
        </> : <p className={styles.help}>دلیل رد برای مشتری نمایش داده می‌شود تا بتواند رسید صحیح را دوباره ارسال کند.</p>}
        <div className={styles.field}><label htmlFor="payment-review-note">{approve ? 'یادداشت بررسی (اختیاری)' : 'دلیل رد رسید'}</label><textarea id="payment-review-note" className="input-field" maxLength={1000} required={!approve} value={note} onChange={(event) => setNote(event.target.value)} disabled={saving} placeholder={approve ? 'توضیح تکمیلی برای سابقهٔ این پرداخت' : 'مثلاً مبلغ واریزی با مبلغ سفارش تطابق ندارد.'} /></div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.dialogActions}><button type="submit" className={approve ? 'btn-primary' : styles.rejectSubmit} disabled={saving || (approve && !confirmed)}>{saving ? <><LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> در حال ثبت...</> : approve ? 'تأیید پرداخت و پردازش سفارش' : 'ثبت دلیل و رد رسید'}</button><button type="button" className="btn-outline" onClick={onDismiss} disabled={saving}>انصراف</button></div>
      </form>
    </dialog>
  )
}

function ReceiptPreview({ orderId, receipt }: { orderId: string; receipt: Receipt }) {
  const [failed, setFailed] = useState(false)
  return <a className={styles.preview} href={receiptUrl(orderId, receipt.id)} target="_blank" rel="noopener noreferrer" aria-label="مشاهده تصویر رسید در اندازهٔ اصلی">
    {failed ? <span>نمایش تصویر ممکن نشد؛ برای باز کردن رسید کلیک کنید.</span> : (
      // Receipt access must use the authenticated route without the public image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={receiptUrl(orderId, receipt.id)} alt="تصویر رسید بارگذاری‌شده توسط مشتری" loading="lazy" onError={() => setFailed(true)} />
    )}
    <span className={styles.previewCaption}>مشاهده اصل رسید <ExternalLink size={14} aria-hidden="true" /></span>
  </a>
}

export default function AdminPaymentsPage() {
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('AWAITING_REVIEW')
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [review, setReview] = useState<{ order: PaymentOrder; receipt: Receipt; action: 'approve' | 'reject' } | null>(null)
  const loadControllerRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    return fetch('/api/admin/payments', { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response, 'پرداخت‌ها بارگذاری نشدند.'))
      const data = await response.json()
      if (!Array.isArray(data)) throw new Error('پاسخ سرور برای پرداخت‌ها معتبر نیست.')
      if (!controller.signal.aborted) {
        setOrders(data)
        const focusedId = new URL(window.location.href).searchParams.get('orderId')
        if (focusedId) { setFilter('ALL'); setSearch(focusedId); setExpandedId(focusedId) }
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false) }
    })
  }, [])

  useEffect(() => {
    void load()
    return () => loadControllerRef.current?.abort()
  }, [load])

  const refresh = () => { setRefreshing(true); setError(''); void load() }

  const pending = orders.filter((order) => order.paymentStatus === 'AWAITING_REVIEW' && !order.verified)
  const query = search.trim().toLocaleLowerCase()
  const visibleOrders = orders.filter((order) => (filter === 'ALL' || order.paymentStatus === filter) && (!query || [order.id, order.user.name, order.user.email, order.phone].some((value) => value?.toLocaleLowerCase().includes(query))))

  return (
    <div>
      <div className={adminStyles.pageHeader}><div><span className={adminStyles.eyebrow}>از رسید تا تأیید واریز</span><h1>بررسی پرداخت‌ها</h1><p>رسید مشتری را با واریز واقعی حساب فروشگاه تطبیق دهید.</p></div><Link href="/admin/payment-methods" className={adminStyles.headerLink}>تنظیم روش‌های پرداخت <ArrowUpLeft size={17} aria-hidden="true" /></Link></div>
      <div className={styles.summary}>
        <div><span>در انتظار بررسی</span><strong>{loading ? '—' : pending.length.toLocaleString('fa-IR')} <small>پرداخت</small></strong></div>
        <div><span>مبلغ رسیدهای در انتظار</span><strong>{loading ? '—' : money(pending.reduce((total, order) => total + order.total, 0))}</strong><small>تا پیش از تأیید، جزو فروش پرداخت‌شده نیست.</small></div>
        <button type="button" onClick={refresh} disabled={refreshing} className={styles.refresh}><RefreshCw size={17} className={refreshing ? styles.spinner : undefined} aria-hidden="true" />{refreshing ? 'در حال دریافت...' : 'به‌روزرسانی'}</button>
      </div>
      {notice && <p role="status" className={styles.notice}><Check size={17} aria-hidden="true" />{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.filters}>
        <div className={styles.tabs} role="group" aria-label="فیلتر وضعیت پرداخت">{[['AWAITING_REVIEW', 'منتظر بررسی'], ['ALL', 'همه'], ['AWAITING_RECEIPT', 'منتظر رسید'], ['REJECTED', 'رد رسید'], ['PAID', 'تأییدشده'], ['EXPIRED', 'مهلت تمام‌شده']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? styles.selected : ''} onClick={() => setFilter(value)}>{label}{value === 'AWAITING_REVIEW' && <span>{pending.length.toLocaleString('fa-IR')}</span>}</button>)}</div>
        <label className={styles.search}><Search size={18} aria-hidden="true" /><input aria-label="جست‌وجو بر اساس مشتری، تلفن یا شماره سفارش" placeholder="نام مشتری، تلفن یا شماره سفارش" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      {loading ? <div className={styles.empty} role="status">در حال دریافت پرداخت‌ها...</div> : error && orders.length === 0 ? <div className={styles.empty}><p>اطلاعات پرداخت‌ها در دسترس نیست.</p><button type="button" className="btn-outline" onClick={refresh} disabled={refreshing}>تلاش دوباره</button></div> : visibleOrders.length === 0 ? <div className={styles.empty}><h2>{filter === 'AWAITING_REVIEW' && !query ? 'رسیدی منتظر بررسی نیست' : 'پرداختی پیدا نشد'}</h2><p>{filter === 'AWAITING_REVIEW' && !query ? 'رسیدهای جدید مشتری‌ها در این بخش نمایش داده می‌شوند.' : 'وضعیت دیگری را انتخاب کنید یا عبارت جست‌وجو را تغییر دهید.'}</p></div> : <div className={styles.orders}>
        {visibleOrders.map((order) => {
          const expanded = expandedId === order.id
          const receipts = order.receipts ?? []
          const latest = receipts[0]
          const awaitingReview = order.paymentStatus === 'AWAITING_REVIEW' && !order.verified
          return <article className={styles.order} key={order.id}>
            <button type="button" className={styles.orderHeader} onClick={() => setExpandedId(expanded ? null : order.id)} aria-expanded={expanded} aria-controls={`payment-${order.id}`}>
              <div className={styles.customer}><span className={styles.avatar} aria-hidden="true">{order.user.name?.trim().charAt(0) || 'م'}</span><div><h2>{order.user.name}</h2><p>سفارش <b dir="ltr">#{order.id.slice(-6)}</b> · {dateTime(latest?.createdAt ?? order.createdAt)}</p></div></div>
              <div className={styles.orderTotal}><strong>{money(order.total)}</strong><span className={`${styles.badge} ${order.verified ? styles.paid : awaitingReview ? styles.pending : ''}`}>{paymentLabels[order.paymentStatus] || 'ثبت‌شده'}</span></div><ChevronDown size={18} className={`${styles.chevron} ${expanded ? styles.open : ''}`} aria-hidden="true" />
            </button>
            {expanded && <div id={`payment-${order.id}`} className={styles.orderBody}>
              <div className={styles.orderInfo}>
                <dl><div><dt>شماره تماس</dt><dd dir="ltr">{order.phone}</dd></div><div><dt>صاحب کارت مقصد</dt><dd>{order.paymentCardholderName || 'ثبت نشده'}</dd></div><div><dt>کارت مقصد این سفارش</dt><dd dir="ltr" className={styles.cardNumber}>{order.paymentCardNumber?.match(/.{1,4}/g)?.join(' ') || '—'}</dd></div><div><dt>بانک مقصد</dt><dd>{order.paymentBankName || 'ثبت نشده'}</dd></div></dl>
                <div className={styles.items}>{(order.items ?? []).map((item) => <p key={item.id}><strong>{item.productName || item.product.name}</strong><span>سایز {item.size.toLocaleString('fa-IR')} · {item.color} · {item.quantity.toLocaleString('fa-IR')} عدد</span></p>)}</div>
                <p className={styles.reservation}>{order.status === 'CANCELLED' ? 'رزرو موجودی آزاد شده است؛ تأیید پرداخت نیازمند بررسی دوبارهٔ موجودی است.' : awaitingReview ? 'موجودی سفارش تا تعیین تکلیف این رسید رزرو است.' : order.paymentStatus === 'AWAITING_RECEIPT' || order.paymentStatus === 'REJECTED' ? `مهلت ارسال رسید: ${order.paymentExpiresAt ? dateTime(order.paymentExpiresAt) : 'ثبت نشده'}` : order.verified ? 'پرداخت این سفارش تأیید شده است.' : 'مهلت پرداخت تمام شده است.'}</p>
                <Link href="/admin/orders" className={styles.textLink}>مدیریت سفارش‌ها <ArrowUpLeft size={15} aria-hidden="true" /></Link>
              </div>
              <div className={styles.receipts}>
                <h3>رسیدهای این سفارش <span>{receipts.length.toLocaleString('fa-IR')}</span></h3>
                {receipts.length === 0 ? <p className={styles.noReceipt}>مشتری هنوز رسیدی ارسال نکرده است.</p> : receipts.map((receipt, index) => <section key={receipt.id} className={styles.receipt} aria-label={`رسید ${receipts.length - index}`}>
                  <div className={styles.receiptHeader}><span>{dateTime(receipt.createdAt)}</span><strong className={`${styles.badge} ${receipt.status === 'APPROVED' ? styles.paid : receipt.status === 'PENDING' ? styles.pending : styles.rejected}`}>{receiptLabels[receipt.status]}</strong></div>
                  {receipt.isLate && <p className={styles.warning}>رسید پس از پایان مهلت پرداخت ارسال شده است.</p>}
                  <div className={styles.receiptContent}><ReceiptPreview orderId={order.id} receipt={receipt} /><div className={styles.receiptDetails}><div><span>چهار رقم آخر کارت پرداخت‌کننده</span><b dir="ltr">{receipt.payerCardLast4 || '—'}</b></div><div><span>شماره پیگیری اعلام‌شده</span><b dir="ltr">{receipt.transferReference || '—'}</b></div>{receipt.reviewedAt && <div><span>زمان بررسی</span><b>{dateTime(receipt.reviewedAt)}</b></div>}{receipt.reviewNote && <p className={styles.reviewNote}><strong>یادداشت بررسی</strong>{receipt.reviewNote}</p>}</div></div>
                  {receipt.status === 'PENDING' && awaitingReview && <div className={styles.actions}><button type="button" className="btn-primary" onClick={() => { setNotice(''); setReview({ order, receipt, action: 'approve' }) }}>بررسی و تأیید واریز</button><button type="button" className={styles.rejectButton} onClick={() => { setNotice(''); setReview({ order, receipt, action: 'reject' }) }}>رد رسید با توضیح</button></div>}
                </section>)}
              </div>
            </div>}
          </article>
        })}
      </div>}
      {review && <ReviewDialog {...review} onDismiss={() => setReview(null)} onConflict={refresh} onReviewed={(updated) => { setOrders((previous) => previous.map((order) => order.id === updated.id ? updated : order)); setNotice(review.action === 'approve' ? 'واریز تأیید شد؛ سفارش وارد پردازش شد و فاکتور آن صادر شد.' : 'رسید رد شد و دلیل آن برای مشتری ثبت شد.'); setReview(null); refresh() }} />}
    </div>
  )
}
