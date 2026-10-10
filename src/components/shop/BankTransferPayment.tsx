'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, Copy, RefreshCw, Upload, X } from 'lucide-react'
import { PaymentStatusIcon } from '@/components/ui/BrandIcons'
import { formatPrice } from '@/lib/utils'
import type { InvoiceMetadata } from '@/lib/invoice'
import { MAX_RECEIPT_BYTES, normalizePaymentDigits, paymentStatusLabels, type PaymentStatus } from '@/lib/payment-contract'
import InvoiceDownload from './InvoiceDownload'
import styles from './bank-transfer.module.css'

interface Receipt {
  id: string
  createdAt: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  reviewNote: string | null
  reviewedAt: string | null
  payerCardLast4: string | null
  transferReference: string | null
  isLate: boolean
}

interface PaymentData {
  order: {
    id: string
    total: number
    status: string
    verified: boolean
    paymentMethod: string | null
    paymentStatus: PaymentStatus
    paymentExpiresAt: string | null
    paymentCardNumber: string | null
    paymentCardholderName: string | null
    paymentBankName: string | null
    invoice?: InvoiceMetadata | null
  }
  receipts: Receipt[]
  serverTime: string
}

const receiptLabels = { PENDING: 'در انتظار بررسی', APPROVED: 'تأییدشده', REJECTED: 'ردشده' }
const receiptTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const latinDigits = normalizePaymentDigits
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const isNullableString = (value: unknown) => value === null || typeof value === 'string'
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isPaymentStatus = (value: unknown): value is PaymentStatus => typeof value === 'string' && Object.hasOwn(paymentStatusLabels, value)
const isReceipt = (value: unknown): value is Receipt => isRecord(value)
  && typeof value.id === 'string' && value.id.length > 0 && isTimestamp(value.createdAt)
  && typeof value.status === 'string' && Object.hasOwn(receiptLabels, value.status)
  && isNullableString(value.reviewNote) && (value.reviewedAt === null || isTimestamp(value.reviewedAt))
  && isNullableString(value.payerCardLast4) && isNullableString(value.transferReference) && typeof value.isLate === 'boolean'

function isPaymentData(value: unknown, orderId: string): value is PaymentData {
  if (!isRecord(value) || !isRecord(value.order)) return false
  const order = value.order
  const invoice = order.invoice
  const needsDeadline = !order.verified && order.status === 'PENDING' && (order.paymentStatus === 'AWAITING_RECEIPT' || order.paymentStatus === 'REJECTED')
  return order.id === orderId && typeof order.total === 'number' && Number.isFinite(order.total) && order.total >= 0
    && typeof order.status === 'string' && typeof order.verified === 'boolean' && isNullableString(order.paymentMethod)
    && isPaymentStatus(order.paymentStatus) && (order.paymentExpiresAt === null || isTimestamp(order.paymentExpiresAt))
    && (!needsDeadline || isTimestamp(order.paymentExpiresAt))
    && isNullableString(order.paymentCardNumber) && isNullableString(order.paymentCardholderName) && isNullableString(order.paymentBankName)
    && (invoice == null || (isRecord(invoice) && Number.isSafeInteger(invoice.id) && Number(invoice.id) > 0 && isTimestamp(invoice.issuedAt)))
    && Array.isArray(value.receipts) && value.receipts.every(isReceipt) && isTimestamp(value.serverTime)
}

function newSubmissionKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // getRandomValues is also available during a plain HTTP preview on the local network.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function CardChip() {
  return <svg viewBox="0 0 44 34" fill="none" aria-hidden="true"><rect x="1" y="1" width="42" height="32" rx="8" fill="currentColor" fillOpacity=".15" stroke="currentColor" /><path d="M16 1v9H1m42 0H28V1M1 24h15v9m12 0v-9h15M16 10h12v14H16z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export default function BankTransferPayment({ orderId }: { orderId: string }) {
  const router = useRouter()
  const [data, setData] = useState<PaymentData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [last4, setLast4] = useState('')
  const [reference, setReference] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [lateUpload, setLateUpload] = useState(false)
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')
  const request = useRef<AbortController | null>(null)
  const uploadRequest = useRef<AbortController | null>(null)
  const cancelRequest = useRef<AbortController | null>(null)
  const submissionKey = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const clock = useRef({ expiresAt: 0, serverTime: 0, receivedAt: 0 })
  const expiredRefresh = useRef('')
  const copyTimer = useRef<number | null>(null)
  const mounted = useRef(false)
  const paymentUrl = `/payment/transfer/${encodeURIComponent(orderId)}`

  const signIn = useCallback(() => {
    router.replace(`/login?callbackUrl=${encodeURIComponent(paymentUrl)}`)
  }, [router, paymentUrl])

  const remainingSeconds = useCallback(() => {
    const elapsed = performance.now() - clock.current.receivedAt
    return Math.max(0, Math.ceil((clock.current.expiresAt - clock.current.serverTime - elapsed) / 1000))
  }, [])

  const loadPayment = useCallback(async () => {
    if (!mounted.current || request.current || uploadRequest.current || cancelRequest.current) return
    const controller = new AbortController()
    request.current = controller
    let timedOut = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payment`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      const receivedAt = performance.now()
      if (!mounted.current || controller.signal.aborted) return
      if (response.status === 401) { signIn(); return }
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : 'اطلاعات پرداخت دریافت نشد. دوباره تلاش کن.')
      }
      const next: unknown = await response.json()
      if (!mounted.current || controller.signal.aborted) return
      if (!isPaymentData(next, orderId)) throw new Error('اطلاعات پرداخت معتبر نیست. دوباره تلاش کن.')
      const serverTime = Date.parse(next.serverTime)
      const expiresAt = next.order.paymentExpiresAt ? Date.parse(next.order.paymentExpiresAt) : 0
      if (!Number.isFinite(serverTime) || !Number.isFinite(expiresAt)) throw new Error('زمان پرداخت دریافت نشد. دوباره تلاش کن.')
      // Keep the server clock anchored to monotonic time, including time spent reading the body.
      clock.current = { serverTime, expiresAt, receivedAt }
      setSecondsLeft(remainingSeconds())
      setData(next)
      if (next.order.status === 'CANCELLED' && next.order.paymentStatus === 'UNPAID') {
        setCancelError('')
        setCancelConfirm(false)
      }
      setLoadError('')
    } catch (cause) {
      if (mounted.current && (timedOut || !controller.signal.aborted)) setLoadError(timedOut ? 'دریافت وضعیت پرداخت طول کشید. دوباره تلاش کن.' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.')
    } finally {
      window.clearTimeout(timeout)
      if (request.current === controller) request.current = null
      if (mounted.current && (timedOut || !controller.signal.aborted)) { setLoading(false); setRefreshing(false) }
    }
  }, [orderId, signIn, remainingSeconds])

  const refreshPayment = () => {
    if (request.current || uploadRequest.current || cancelRequest.current) return
    setRefreshing(true)
    void loadPayment()
  }

  useEffect(() => {
    mounted.current = true
    const initial = window.setTimeout(() => void loadPayment(), 0)
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void loadPayment() }, 15_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void loadPayment() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mounted.current = false
      window.clearTimeout(initial)
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      request.current?.abort()
      request.current = null
      uploadRequest.current?.abort()
      cancelRequest.current?.abort()
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    }
  }, [loadPayment])

  const order = data?.order
  const paid = order?.verified === true
  const awaitingReview = !paid && order?.paymentStatus === 'AWAITING_REVIEW'
  const rejected = !paid && order?.paymentStatus === 'REJECTED'
  const timedState = !paid && !awaitingReview && order?.status === 'PENDING' && (order.paymentStatus === 'AWAITING_RECEIPT' || rejected)
  const expired = !paid && (order?.status === 'CANCELLED' || order?.paymentStatus === 'EXPIRED' || (timedState && secondsLeft <= 0))
  const active = !!order && !paid && !awaitingReview && !expired && timedState && secondsLeft > 0
  const cancelled = !paid && !awaitingReview && order?.status === 'CANCELLED' && order.paymentStatus === 'UNPAID'

  useEffect(() => {
    if (!timedState || !order?.paymentExpiresAt) return
    const deadline = order.paymentExpiresAt
    const tick = () => {
      const remaining = remainingSeconds()
      setSecondsLeft(remaining)
      if (remaining === 0 && document.visibilityState === 'visible' && expiredRefresh.current !== deadline) {
        expiredRefresh.current = deadline
        void loadPayment()
      }
    }
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [timedState, order?.paymentExpiresAt, remainingSeconds, loadPayment])

  useEffect(() => {
    if (!file) return
    const objectUrl = URL.createObjectURL(file)
    const scheduled = window.setTimeout(() => setPreview(objectUrl), 0)
    return () => { window.clearTimeout(scheduled); URL.revokeObjectURL(objectUrl) }
  }, [file])

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      if (!mounted.current) return
      setCopied(label)
      setCopyError('')
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(''), 2500)
    } catch {
      if (mounted.current) setCopyError('کپی خودکار انجام نشد؛ مقدار را انتخاب و کپی کن.')
    }
  }

  const chooseFile = (next: File | null) => {
    setUploadError('')
    setUploadMessage('')
    setPreview('')
    submissionKey.current = null
    if (next && (!receiptTypes.has(next.type) || next.size > MAX_RECEIPT_BYTES || next.size === 0)) {
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      setUploadError('یک تصویر JPG، PNG یا WebP با حجم حداکثر ۵ مگابایت انتخاب کن.')
      return
    }
    setFile(next)
    if (!next && fileInput.current) fileInput.current.value = ''
  }

  const submitReceipt = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!mounted.current || uploadRequest.current || cancelRequest.current || !order) return
    const late = expired && lateUpload
    if ((!active && !late) || awaitingReview || paid) return
    if (!file) { setUploadError('ابتدا تصویر رسید را انتخاب کن.'); return }
    const payerCardLast4 = latinDigits(last4.trim())
    if (payerCardLast4 && !/^\d{4}$/.test(payerCardLast4)) { setUploadError('چهار رقم آخر کارت مبدأ را کامل وارد کن.'); return }
    const controller = new AbortController()
    uploadRequest.current = controller
    request.current?.abort()
    request.current = null
    setRefreshing(false)
    setSubmitting(true)
    setUploadError('')
    setUploadMessage('')
    let timedOut = false
    let requiresLogin = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
    try {
      submissionKey.current ??= newSubmissionKey()
      const body = new FormData()
      body.set('file', file)
      body.set('submissionKey', submissionKey.current)
      if (payerCardLast4) body.set('payerCardLast4', payerCardLast4)
      if (reference.trim()) body.set('transferReference', latinDigits(reference.trim()))
      if (late) body.set('latePayment', 'true')
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/receipts`, { method: 'POST', credentials: 'same-origin', body, signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      if (response.status === 401) { requiresLogin = true; signIn(); return }
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'رسید ثبت نشد. دوباره تلاش کن.')
      if (!mounted.current || controller.signal.aborted) return
      if (!isRecord(result) || !isReceipt(result.receipt) || !isPaymentStatus(result.paymentStatus)) throw new Error('پاسخ ثبت رسید دریافت نشد. دوباره تلاش کن؛ رسید تکراری ثبت نمی‌شود.')
      const receipt = result.receipt
      const paymentStatus = result.paymentStatus
      setUploadMessage(receipt.status === 'PENDING' ? 'رسید با موفقیت ثبت شد. نتیجهٔ بررسی ادمین در همین صفحه و حساب کاربری نمایش داده می‌شود.' : 'این رسید قبلاً ثبت و بررسی شده است. آخرین وضعیت سفارش در حال دریافت است.')
      setFile(null)
      setPreview('')
      if (fileInput.current) fileInput.current.value = ''
      submissionKey.current = null
      // A successful upload confirms receipt submission only, never the money transfer.
      setData((previous) => previous ? {
        ...previous,
        order: { ...previous.order, paymentStatus, ...(paymentStatus === 'AWAITING_REVIEW' ? { paymentExpiresAt: null } : {}) },
        receipts: [receipt, ...previous.receipts.filter((previousReceipt) => previousReceipt.id !== receipt.id)],
      } : previous)
    } catch (cause) {
      if (mounted.current && (timedOut || !controller.signal.aborted)) setUploadError(timedOut ? 'ارسال رسید طول کشید. دوباره تلاش کن؛ ارسال تکراری ثبت نمی‌شود.' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط قطع شد. با «ثبت رسید» دوباره تلاش کن؛ ارسال تکراری ثبت نمی‌شود.')
    } finally {
      window.clearTimeout(timeout)
      if (uploadRequest.current === controller) uploadRequest.current = null
      if (mounted.current && (timedOut || !controller.signal.aborted)) { setSubmitting(false); if (!requiresLogin) void loadPayment() }
    }
  }

  const cancelPurchase = async () => {
    if (!mounted.current || uploadRequest.current || cancelRequest.current || !active || !order) return
    const controller = new AbortController()
    cancelRequest.current = controller
    request.current?.abort()
    request.current = null
    setRefreshing(false)
    setCancelling(true)
    setCancelError('')
    let timedOut = false
    let requiresLogin = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', credentials: 'same-origin', signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      if (response.status === 401) { requiresLogin = true; signIn(); return }
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'انصراف ثبت نشد. دوباره تلاش کن.')
      if (!isRecord(result) || !isRecord(result.order) || result.order.id !== orderId || result.order.status !== 'CANCELLED'
        || result.order.verified !== false || !isPaymentStatus(result.order.paymentStatus)
        || !['UNPAID', 'EXPIRED', 'REJECTED'].includes(result.order.paymentStatus) || result.order.paymentExpiresAt !== null) {
        throw new Error('نتیجهٔ انصراف دریافت نشد. آخرین وضعیت را بررسی کن.')
      }
      const paymentStatus = result.order.paymentStatus
      setData((previous) => previous ? { ...previous, order: { ...previous.order, status: 'CANCELLED', paymentStatus, paymentExpiresAt: null } } : previous)
      setCancelConfirm(false)
      setUploadError('')
      setUploadMessage('')
      setFile(null)
      setPreview('')
      setLateUpload(false)
    } catch (cause) {
      if (mounted.current && (timedOut || !controller.signal.aborted)) {
        setCancelError(timedOut ? 'دریافت نتیجهٔ انصراف طول کشید. آخرین وضعیت را بررسی کن؛ می‌توانی دوباره تلاش کنی.'
          : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. وضعیت سفارش را بررسی و دوباره تلاش کن.')
      }
    } finally {
      window.clearTimeout(timeout)
      if (cancelRequest.current === controller) cancelRequest.current = null
      if (mounted.current && (timedOut || !controller.signal.aborted)) { setCancelling(false); if (!requiresLogin) void loadPayment() }
    }
  }

  if (loading || !data) {
    return <div className={styles.page}><div className={styles.container}><section className={styles.loadState} aria-busy={loading}>
      <h1>پرداخت سفارش</h1>
      {loadError ? <><p role="alert">{loadError}</p><button className="btn-primary" onClick={refreshPayment} disabled={refreshing}>تلاش دوباره</button><Link href="/profile">بازگشت به سفارش‌ها</Link></> : <p role="status">در حال دریافت اطلاعات پرداخت…</p>}
    </section></div></div>
  }

  if (data.order.paymentMethod !== 'bank_transfer') {
    return <div className={styles.page}><div className={styles.container}><section className={styles.loadState}><h1>روش پرداخت این سفارش متفاوت است.</h1><Link href={`/payment/result?orderId=${encodeURIComponent(orderId)}`} className="btn-primary">مشاهدهٔ وضعیت پرداخت</Link></section></div></div>
  }

  const destination = data.order.paymentCardNumber ?? ''
  const cardGroups = destination.replace(/\s/g, '').match(/.{1,4}/g) ?? []
  const latestRejection = data.receipts.find((receipt) => receipt.status === 'REJECTED')
  const label = paid ? 'پرداخت تأییدشده' : awaitingReview ? 'در انتظار تأیید ادمین' : cancelled ? 'انصراف از خرید' : expired ? 'مهلت پرداخت تمام شده' : rejected ? 'اصلاح رسید پرداخت' : 'پرداخت کارت‌به‌کارت'
  const title = paid ? 'پرداختت تأیید شد.' : awaitingReview ? 'رسیدت در حال بررسیه.' : cancelled ? 'سفارشت لغو شد.' : expired ? 'مهلت این پرداخت تمام شد.' : rejected ? 'رسیدت نیاز به اصلاح داره.' : 'یه قدم تا تکمیل خرید.'
  const description = paid ? (data.order.status === 'CANCELLED' ? 'سفارش لغو شده است. برای پیگیری مبلغ واریزی با پشتیبانی در ارتباط باش.' : 'واریزت بررسی و تأیید شد. ادامهٔ مراحل سفارش را از حسابت پیگیری کن.')
    : awaitingReview ? (data.order.status === 'CANCELLED' ? 'رسید واریز پس از پایان مهلت ثبت شده است. موجودی رزرو نیست؛ ادمین پرداخت و امکان تأمین سفارش را بررسی می‌کند.' : 'کالا تا نتیجهٔ بررسی برایت رزرو می‌ماند. نیازی به واریز مجدد نیست؛ بعد از تأیید، سفارش وارد مرحلهٔ پردازش می‌شود.')
      : cancelled ? 'انصراف ثبت شد و رزرو موجودی آزاد شده است. مبلغی برای این سفارش واریز نکن.'
        : expired ? 'رزرو موجودی آزاد شده است. مبلغی واریز نکن؛ اگر قبلاً پرداخت کرده‌ای، رسید را برای بررسی بفرست.'
        : rejected ? 'توضیح ادمین را بخوان و رسید درست را در مهلت باقی‌مانده ارسال کن. اگر قبلاً واریز کرده‌ای، دوباره پرداخت نکن.'
          : 'مبلغ دقیق سفارش را به کارت زیر واریز کن و پیش از پایان مهلت، تصویر رسید را همین‌جا بفرست.'
  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه"><Link href="/">خانه</Link><span>/</span><Link href="/profile">سفارش‌های من</Link><span>/</span><span>پرداخت سفارش</span></nav>
        <header className={styles.heading}>
          <div><p className={styles.eyebrow}>{label}</p><h1>{title}</h1><p className={styles.description} role={cancelled ? 'status' : undefined}>{description}</p></div>
          {active && <div className={`${styles.timer} ${secondsLeft <= 60 ? styles.urgent : ''}`}><span>مهلت ارسال رسید</span><b dir="ltr" role="timer" aria-label={`${formatPrice(minutes)} دقیقه و ${formatPrice(seconds)} ثانیه باقی مانده`}>{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</b><small>موجودی برای تو رزرو است</small></div>}
        </header>

        {loadError && <div className={styles.notice} role="alert"><p>{loadError} آخرین وضعیت دریافت‌شده نمایش داده می‌شود.</p><button type="button" onClick={refreshPayment} disabled={refreshing}>بررسی دوباره</button></div>}
        {uploadMessage && <p className={styles.successNotice} role="status">{uploadMessage}</p>}
        {cancelError && <p className={`${styles.error} ${styles.cancelError}`} role="alert">{cancelError}</p>}

        <div className={styles.layout}>
          <aside className={styles.summary} aria-label="جزئیات پرداخت سفارش">
            <div className={styles.sectionTop}><span>جزئیات واریز</span><bdi>#{data.order.id.slice(-8)}</bdi></div>
            <div className={styles.amount}><span>مبلغ دقیق سفارش</span><strong>{formatPrice(data.order.total)} <small>تومان</small></strong><p>{formatPrice(data.order.total * 10)} ریال</p>{active && <button type="button" onClick={() => void copy(String(data.order.total * 10), 'مبلغ ریالی')}>{copied === 'مبلغ ریالی' ? <Check size={14} /> : <Copy size={14} />}کپی مبلغ به ریال</button>}</div>
            <div className={styles.bankCard} aria-label="کارت مقصد واریز">
              <div className={styles.cardTop}><span>{data.order.paymentBankName || 'کارت بانکی مقصد'}</span><span className={styles.cardChip}><CardChip /></span></div>
              <div className={styles.cardNumber} dir="ltr">{cardGroups.length ? cardGroups.map((group, index) => <span key={index}>{group}</span>) : <span>شماره کارت ثبت نشده</span>}</div>
              <div className={styles.cardBottom}><div><small>نام صاحب کارت</small><strong>{data.order.paymentCardholderName || 'ثبت نشده'}</strong></div>{active && destination && <button type="button" onClick={() => void copy(destination, 'شماره کارت')} aria-label="کپی شماره کارت">{copied === 'شماره کارت' ? <Check size={18} /> : <Copy size={18} />}</button>}</div>
            </div>
            <p className={styles.cardNote}>مشخصات مقصد برای همین سفارش ثبت شده است. نام صاحب کارت را پیش از واریز بررسی کن.</p>
            <p className={styles.copyStatus} role="status">{copied ? `${copied} کپی شد.` : copyError}</p>
            <div className={styles.orderTotal}><span>وضعیت سفارش</span><strong>{data.order.status === 'CANCELLED' ? 'لغوشده / موجودی آزاد شده' : paid ? 'پرداخت تأیید شده' : awaitingReview ? 'رزرو تا بررسی رسید' : active ? 'رزرو موقت' : 'در انتظار تعیین تکلیف'}</strong></div>
            <Link href="/profile" className={styles.textLink}>مشاهدهٔ سفارش‌ها <ArrowLeft size={16} /></Link>
            {active && <section className={styles.cancelPurchase} aria-label="انصراف از خرید" aria-busy={cancelling}>
              {cancelConfirm ? <>
                <h2>از این خرید انصراف می‌دهی؟</h2>
                <p>سفارش لغو می‌شود و کالا دوباره در دسترس دیگران قرار می‌گیرد. فقط اگر هنوز مبلغی واریز نکرده‌ای، انصراف بده.</p>
                <div className={styles.cancelActions}>
                  <button type="button" className={styles.cancelButton} disabled={cancelling || submitting} onClick={() => void cancelPurchase()}>{cancelling ? 'در حال ثبت انصراف…' : 'تأیید انصراف'}</button>
                  <button type="button" disabled={cancelling || submitting} onClick={() => { setCancelConfirm(false); setCancelError('') }}>ادامهٔ خرید</button>
                </div>
              </> : <>
                <p>اگر نمی‌خواهی پرداخت کنی، انصراف بده تا رزرو کالا آزاد شود.</p>
                <button type="button" className={styles.cancelButton} disabled={submitting || cancelling} onClick={() => { setCancelConfirm(true); setCancelError('') }}>انصراف از خرید</button>
              </>}
            </section>}
          </aside>

          <section className={styles.content} aria-label="ارسال و پیگیری رسید">
            {(paid || awaitingReview) ? (
              <div className={styles.result}>
                <PaymentStatusIcon status={paid ? 'success' : 'pending'} className={styles.resultIcon} />
                <h2>{paid ? 'واریز تأیید شد' : 'رسید دریافت شد'}</h2>
                <p>{paid ? 'سوابق پرداخت و فاکتور سفارش در دسترس توست.' : 'تأیید پرداخت پس از بررسی واریز توسط ادمین انجام می‌شود. می‌توانی این صفحه را ببندی و از حساب کاربری نتیجه را پیگیری کنی.'}</p>
                {!paid && <button type="button" className={styles.refresh} disabled={refreshing} onClick={refreshPayment}><RefreshCw size={16} />{refreshing ? 'در حال بررسی…' : 'بررسی آخرین وضعیت'}</button>}
                {paid && <InvoiceDownload orderId={orderId} status={data.order.status} invoice={data.order.invoice} />}
              </div>
            ) : expired && !lateUpload ? (
              <div className={styles.result}>
                <PaymentStatusIcon status="failed" className={styles.resultIcon} />
                <h2>قبلاً واریز کرده‌ای؟</h2>
                <p>اگر انتقال وجه انجام شده اما فرصت ارسال رسید نداشتی، آن را برای بررسی بفرست. ثبت رسید در این مرحله به معنی رزرو دوبارهٔ کالا نیست.</p>
                <button type="button" className="btn-primary" onClick={() => setLateUpload(true)}>{cancelled ? 'قبل از انصراف واریز کرده‌ام' : 'واریز کردم، مهلت تمام شد'}</button>
                <Link href="/products" className={styles.textLink}>بازگشت به محصولات <ArrowLeft size={16} /></Link>
              </div>
            ) : (active || (expired && lateUpload)) ? (
              <form className={styles.uploadForm} onSubmit={submitReceipt} aria-busy={submitting || cancelling}>
                <div><p className={styles.eyebrow}>{expired ? 'پیگیری واریز قبلی' : 'ثبت رسید پرداخت'}</p><h2>{expired ? 'رسید واریزت رو بفرست.' : 'پرداخت کردی؟ رسید رو بفرست.'}</h2><p className={styles.formHint}>{expired ? 'فقط رسید پرداختی را بفرست که قبلاً انجام داده‌ای. تا بررسی ادمین موجودی رزرو نیست؛ در صورت ناموجود بودن کالا، پشتیبانی برای تعیین تکلیف مبلغ با تو هماهنگ می‌کند.' : 'تصویر واضحی انتخاب کن که مبلغ، تاریخ، کارت مقصد و شمارهٔ پیگیری روی آن خوانا باشد.'}</p></div>
                {rejected && latestRejection?.reviewNote && <div className={styles.rejection}><strong>توضیح ادمین</strong><p>{latestRejection.reviewNote}</p></div>}
                <div className={styles.fileArea}>
                  <label htmlFor="transfer-receipt" className={styles.fileLabel}><Upload size={24} /><strong>{file ? 'تغییر تصویر رسید' : 'انتخاب تصویر رسید'}</strong><span>JPG، PNG یا WebP · حداکثر ۵ مگابایت</span></label>
                  <input ref={fileInput} id="transfer-receipt" type="file" accept="image/jpeg,image/png,image/webp" disabled={submitting || cancelling} onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} aria-describedby="receipt-privacy" />
                  {file && <div className={styles.filePreview}>{preview && <Image src={preview} alt="پیش‌نمایش رسید انتخاب‌شده" width={160} height={120} unoptimized />}<div><strong>{file.name}</strong><span>{formatPrice(Math.ceil(file.size / 1024))} کیلوبایت</span></div><button type="button" aria-label="حذف تصویر انتخاب‌شده" disabled={submitting || cancelling} onClick={() => chooseFile(null)}><X size={18} /></button></div>}
                </div>
                <p id="receipt-privacy" className={styles.privacy}>رسید فقط برای صاحب سفارش و ادمین قابل مشاهده است.</p>
                <div className={styles.fields}>
                  <div><label htmlFor="payer-last-four">۴ رقم آخر کارت مبدأ <small>اختیاری</small></label><input id="payer-last-four" className="input-field" dir="ltr" type="text" inputMode="numeric" autoComplete="off" maxLength={4} placeholder="1234" value={last4} disabled={submitting || cancelling} onChange={(event) => { setLast4(latinDigits(event.target.value).replace(/\D/g, '').slice(0, 4)); submissionKey.current = null }} /></div>
                  <div><label htmlFor="transfer-reference">شمارهٔ پیگیری <small>اختیاری</small></label><input id="transfer-reference" className="input-field" dir="ltr" type="text" autoComplete="off" maxLength={80} value={reference} disabled={submitting || cancelling} onChange={(event) => { setReference(event.target.value); submissionKey.current = null }} /></div>
                </div>
                <p className={styles.formHint}>این اطلاعات برای تطبیق واریز است؛ تأیید نهایی پس از بررسی ادمین انجام می‌شود.</p>
                {uploadError && <p className={styles.error} role="alert">{uploadError}</p>}
                <button type="submit" className="btn-primary" disabled={submitting || cancelling || !file}>{submitting ? 'در حال ارسال رسید…' : expired ? 'ثبت رسید برای پیگیری واریز' : 'ثبت رسید و درخواست تأیید'}<ArrowLeft size={17} /></button>
              </form>
            ) : <div className={styles.result}><h2>وضعیت پرداخت نیاز به بررسی دارد.</h2><p>برای پیگیری این سفارش با پشتیبانی در ارتباط باش.</p><Link href="/contact" className="btn-primary">ارتباط با پشتیبانی</Link></div>}

            {data.receipts.length > 0 && <section className={styles.history} aria-labelledby="receipt-history-title"><h2 id="receipt-history-title">سوابق رسیدها</h2>{data.receipts.map((receipt) => <article key={receipt.id} className={styles.historyItem}><div><span className={`${styles.receiptStatus} ${receipt.status === 'REJECTED' ? styles.rejected : ''}`}>{receiptLabels[receipt.status]}</span><time dateTime={receipt.createdAt}>{new Date(receipt.createdAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' })}</time></div>{receipt.isLate && <p>ارسال پس از پایان مهلت رزرو</p>}{receipt.payerCardLast4 && <p>چهار رقم کارت مبدأ: <bdi>{receipt.payerCardLast4}</bdi></p>}{receipt.transferReference && <p>شمارهٔ پیگیری: <bdi>{receipt.transferReference}</bdi></p>}{receipt.reviewNote && <p className={styles.reviewNote}>{receipt.reviewNote}</p>}<a href={`/api/orders/${encodeURIComponent(orderId)}/receipts/${encodeURIComponent(receipt.id)}`} target="_blank" rel="noopener noreferrer" className={styles.textLink}>مشاهدهٔ تصویر رسید <ArrowLeft size={14} /></a></article>)}</section>}
          </section>
        </div>
        <footer className={styles.help}><div><strong>برای پیگیری پرداخت، کنارت هستیم.</strong><p>در صورت مشکل، شمارهٔ سفارش را برای پشتیبانی بفرست. مبلغ را دوباره واریز نکن.</p></div><Link href="/contact">ارتباط با پشتیبانی <ArrowLeft size={17} /></Link></footer>
      </div>
    </div>
  )
}
