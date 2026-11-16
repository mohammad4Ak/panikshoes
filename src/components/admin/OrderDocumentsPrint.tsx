'use client'

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, FileText, LoaderCircle, Printer, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { useAppSession } from '@/components/auth/SessionActivityProvider'
import { formatInvoiceNumber, type InvoiceSnapshot } from '@/lib/invoice'
import { ADMIN_ORDER_PRINT_LIMIT, ADMIN_ORDER_DOCUMENT_KINDS, type AdminOrderDocumentKind, type AdminOrderPrintDocument, type AdminOrderPrintResponse } from '@/lib/admin-order-print-contract'
import styles from './order-documents-print.module.css'

export type OrderDocumentsMode = 'selected' | 'filtered'
type Props = {
  open: boolean
  mode: OrderDocumentsMode
  onModeChange: (mode: OrderDocumentsMode) => void
  selectedIds: string[]
  filterQuery: string
  filterSummary: string
  filtersActive: boolean
  total: number
  ready: boolean
  disabled: boolean
  sourceRevision: string
  onClearSelection: () => void
  onClose: () => void
  onBusyChange: (busy: boolean) => void
}

const labels: Record<AdminOrderDocumentKind, string> = { invoice: 'فاکتورهای صادرشده', packing: 'برگهٔ جمع‌آوری و بسته‌بندی', 'shipping-label': 'برچسب ارسال' }
const statusLabels: Record<string, string> = { PENDING: 'در انتظار', PROCESSING: 'در حال پردازش', SHIPPED: 'ارسال‌شده', DELIVERED: 'تحویل‌شده', CANCELLED: 'لغوشده' }
const number = (value: number) => value.toLocaleString('fa-IR')
const formatDate = (value: string) => new Date(value).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 5000): value is string => typeof value === 'string' && value.length <= max
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const date = (value: unknown): value is string => text(value, 40) && Number.isFinite(Date.parse(value))
const nullableText = (value: unknown, max = 5000) => value === null || text(value, max)

function invoiceSnapshot(value: unknown, orderId: string): value is InvoiceSnapshot {
  if (!record(value) || value.schemaVersion !== 1 || value.orderId !== orderId || !date(value.orderCreatedAt) || value.currency !== 'تومان' ||
      !record(value.seller) || !text(value.seller.name) || !record(value.buyer) || !text(value.buyer.name) || !text(value.buyer.email) ||
      !record(value.recipient) || !text(value.recipient.name) || !text(value.recipient.address, 20000) || !text(value.recipient.phone) ||
      !integer(value.subtotal) || !integer(value.shippingCost) || !integer(value.total) || !nullableText(value.shippingMethodName) ||
      !['productDiscount', 'couponDiscount', 'merchandiseTotal'].every(key => value[key] === undefined || integer(value[key])) ||
      !(value.couponCode === undefined || nullableText(value.couponCode)) || !Array.isArray(value.items) || !value.items.length || value.items.length > 2000) return false
  return value.items.every(item => record(item) && text(item.productId, 200) && text(item.productName) && integer(item.quantity, 1) && integer(item.size, 1) && text(item.color) && integer(item.unitPrice) && integer(item.lineTotal) && ['originalUnitPrice', 'productDiscount', 'couponDiscount'].every(key => item[key] === undefined || integer(item[key])))
}

function validDocument(value: unknown, kind: AdminOrderDocumentKind, orderId: string, status: string): value is AdminOrderPrintDocument {
  if (!record(value) || value.kind !== kind || value.orderId !== orderId || value.status !== status) return false
  if (kind === 'invoice') {
    return record(value.invoice) && integer(value.invoice.id, 1) && date(value.invoice.issuedAt) && text(value.invoice.number, 100) &&
      value.invoice.number === formatInvoiceNumber({ id: value.invoice.id, issuedAt: value.invoice.issuedAt }) && invoiceSnapshot(value.invoice.snapshot, orderId)
  }
  if (!date(value.createdAt) || !record(value.seller) || !['name', 'phone', 'address'].every(key => text(value.seller && (value.seller as Record<string, unknown>)[key])) ||
      !record(value.recipient) || !text(value.recipient.name) || !text(value.recipient.address, 20000) || !text(value.recipient.phone) || !nullableText(value.recipient.postalCode, 20) ||
      !nullableText(value.shippingMethodName) || !nullableText(value.trackingCode, 200) || !Array.isArray(value.items) || value.items.length > 2000) return false
  if (!['PROCESSING', 'SHIPPED', 'DELIVERED'].includes(status)) return false
  if (kind === 'shipping-label') return value.items.length === 0 && typeof value.recipient.postalCode === 'string' && /^\d{10}$/.test(value.recipient.postalCode)
  return value.items.length > 0 && value.items.every(item => record(item) && text(item.productName) && integer(item.quantity, 1) && integer(item.size, 1) && text(item.color))
}

export function readOrderPrintResponse(value: unknown, kind: AdminOrderDocumentKind, selectedIds?: string[]): AdminOrderPrintResponse {
  const invalid = () => new Error('مدارک کامل و معتبر دریافت نشدند؛ دوباره آماده‌سازی کن.')
  if (!record(value) || value.kind !== kind || value.limit !== ADMIN_ORDER_PRINT_LIMIT || !date(value.generatedAt) || !Array.isArray(value.rows) || value.rows.length > ADMIN_ORDER_PRINT_LIMIT) throw invalid()
  const seen = new Set<string>()
  for (const row of value.rows) {
    if (!record(row) || !text(row.id, 128) || !row.id || seen.has(row.id) || !(row.status === null || text(row.status, 30) && Object.hasOwn(statusLabels, row.status)) || typeof row.eligible !== 'boolean' ||
        !(row.reason === undefined || text(row.reason, 2000)) || !Array.isArray(row.warnings) || row.warnings.length > 20 || !row.warnings.every(warning => text(warning, 2000)) ||
        (row.eligible ? !row.status || !validDocument(row.document, kind, row.id, row.status) : row.document !== null || !text(row.reason, 2000) || !row.reason)) throw invalid()
    seen.add(row.id)
  }
  if (selectedIds && (value.rows.length !== selectedIds.length || selectedIds.some(id => !seen.has(id)))) throw invalid()
  return value as unknown as AdminOrderPrintResponse
}

export function OrderPrintDocument({ document: doc }: { document: AdminOrderPrintDocument }) {
  if (doc.kind === 'invoice') {
    const { snapshot } = doc.invoice
    return <article className={styles.sheet} aria-label={`فاکتور ${doc.invoice.number}`} dir="rtl">
      <header className={styles.documentHeader}><div><small>{snapshot.seller.name}</small><h2>فاکتور فروش</h2></div><div><bdi dir="ltr">{doc.invoice.number}</bdi><p>تاریخ صدور: {formatDate(doc.invoice.issuedAt)}</p></div></header>
      {doc.status === 'CANCELLED' && <p className={styles.statusBanner}>سفارش لغو شده است؛ این فاکتور فقط برای حفظ سابقهٔ سفارش است.</p>}
      {doc.status === 'PENDING' && <p className={styles.statusBanner}>سفارش اکنون در انتظار بررسی است؛ این فاکتور مربوط به تأیید قبلی سفارش است.</p>}
      <div className={styles.orderReference}><span>سفارش: <bdi dir="ltr">{snapshot.orderId}</bdi></span><span>ثبت سفارش: {formatDate(snapshot.orderCreatedAt)}</span></div>
      <section className={styles.infoGrid}><div><h3>خریدار</h3><p>{snapshot.buyer.name}</p>{snapshot.buyer.email && <p><bdi dir="ltr">{snapshot.buyer.email}</bdi></p>}</div><div><h3>گیرنده</h3><p>{snapshot.recipient.name} · <bdi dir="ltr">{snapshot.recipient.phone}</bdi></p><address>{snapshot.recipient.address}</address></div></section>
      <table className={styles.documentTable}><thead><tr><th>کالا</th><th>سایز / رنگ</th><th>تعداد</th><th>قیمت واحد (تومان)</th><th>مبلغ نهایی (تومان)</th></tr></thead><tbody>{snapshot.items.map((item, index) => <tr key={index}><td>{item.productName}</td><td>{number(item.size)} / {item.color === '-' ? 'بدون رنگ' : item.color}</td><td>{number(item.quantity)}</td><td>{item.originalUnitPrice != null && item.originalUnitPrice > item.unitPrice && <del>{number(item.originalUnitPrice)}</del>}{number(item.unitPrice)}</td><td>{number(item.lineTotal)}{(item.couponDiscount ?? 0) > 0 && <small>تخفیف کد: {number(item.couponDiscount!)}</small>}</td></tr>)}</tbody></table>
      <dl className={styles.totals}><div><dt>جمع کالاها</dt><dd>{number(snapshot.subtotal)} تومان</dd></div>{(snapshot.productDiscount ?? 0) > 0 && <div><dt>تخفیف محصولات</dt><dd>{number(snapshot.productDiscount!)} تومان</dd></div>}{(snapshot.couponDiscount ?? 0) > 0 && <div><dt>تخفیف کد {snapshot.couponCode && <bdi dir="ltr">{snapshot.couponCode}</bdi>}</dt><dd>{number(snapshot.couponDiscount!)} تومان</dd></div>}<div><dt>ارسال{snapshot.shippingMethodName && ` (${snapshot.shippingMethodName})`}</dt><dd>{number(snapshot.shippingCost)} تومان</dd></div><div className={styles.grandTotal}><dt>مبلغ نهایی</dt><dd>{number(snapshot.total)} تومان</dd></div></dl>
      <footer className={styles.documentFooter}>اطلاعات و مبالغ این فاکتور از سابقهٔ زمان صدور خوانده شده‌اند.</footer>
    </article>
  }
  const label = doc.kind === 'shipping-label'
  return <article className={`${styles.sheet} ${label ? styles.shippingLabel : ''}`} aria-label={`${label ? 'برچسب ارسال' : 'برگهٔ بسته‌بندی'} ${doc.orderId}`} dir="rtl">
    <header className={styles.documentHeader}><div><small>{doc.seller.name}</small><h2>{label ? 'برچسب ارسال' : 'برگهٔ جمع‌آوری و بسته‌بندی'}</h2></div><div><bdi dir="ltr">{doc.orderId}</bdi><p>تاریخ سفارش: {formatDate(doc.createdAt)}</p></div></header>
    {label && <section className={styles.sender}><h3>فرستنده</h3><p>{doc.seller.name}{doc.seller.phone && <> · <bdi dir="ltr">{doc.seller.phone}</bdi></>}</p>{doc.seller.address && <address>{doc.seller.address}</address>}</section>}
    <section className={styles.recipient}><h3>گیرنده</h3><strong>{doc.recipient.name}</strong><address>{doc.recipient.address}</address><p>شماره تماس: <bdi dir="ltr">{doc.recipient.phone}</bdi></p><p>کدپستی: <bdi dir="ltr">{doc.recipient.postalCode || 'ثبت نشده'}</bdi></p></section>
    <div className={styles.orderReference}><span>روش ارسال: {doc.shippingMethodName || 'ثبت نشده'}</span>{doc.trackingCode && <span>کد رهگیری: <bdi dir="ltr">{doc.trackingCode}</bdi></span>}</div>
    {!label && <><table className={`${styles.documentTable} ${styles.packingTable}`}><thead><tr><th>بررسی</th><th>کالا</th><th>سایز</th><th>رنگ</th><th>تعداد</th></tr></thead><tbody>{doc.items.map((item, index) => <tr key={index}><td><span className={styles.packCheck} aria-label="محل علامت بررسی" /></td><td>{item.productName}</td><td>{number(item.size)}</td><td>{item.color === '-' ? 'بدون رنگ' : item.color}</td><td>{number(item.quantity)}</td></tr>)}</tbody></table><div className={styles.packingSignatures}><span>جمع‌آوری‌کننده: ………………</span><span>کنترل بسته: ………………</span><span>تعداد بسته: ………………</span></div></>}
    <footer className={styles.documentFooter}>{label ? 'اطلاعات گیرنده مطابق نشانی ثبت‌شده در همین سفارش است.' : 'این برگه برای آماده‌سازی بسته است و فاکتور فروش یا رسید پرداخت نیست.'}</footer>
  </article>
}

export default function OrderDocumentsPrint(props: Props) {
  const { session } = useAppSession()
  if (!session?.user.id || session.user.role !== 'ADMIN') return props.open ? <p role="status">در حال بررسی حساب مدیر…</p> : null
  return <OrderDocumentsContent key={session.user.id} {...props} />
}

function OrderDocumentsContent({ open, mode, onModeChange, selectedIds, filterQuery, filterSummary, filtersActive, total, ready, disabled, sourceRevision, onClearSelection, onClose, onBusyChange }: Props) {
  const [kind, setKind] = useState<AdminOrderDocumentKind>('invoice')
  const [batch, setBatch] = useState<{ key: string; data: AdminOrderPrintResponse } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const request = useRef<AbortController | null>(null), mounted = useRef(true), lock = useRef(false), printLock = useRef(false), generation = useRef(0)
  const dialog = useRef<HTMLDivElement | null>(null), heading = useRef<HTMLHeadingElement | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const busyCallback = useRef(onBusyChange)
  useLayoutEffect(() => { busyCallback.current = onBusyChange }, [onBusyChange])
  const ids = [...new Set(selectedIds)].sort()
  const key = JSON.stringify([open, mode, kind, mode === 'selected' ? ids : filterQuery, sourceRevision, ready, disabled])
  const latest = useRef({ key, ready, disabled, open })
  useLayoutEffect(() => { latest.current = { key, ready, disabled, open } }, [key, ready, disabled, open])
  const current = batch?.key === key && ready && !disabled && open ? batch.data : null
  const documents = current?.rows.flatMap(row => row.document ? [row.document] : []) ?? []
  const count = mode === 'selected' ? ids.length : total
  const canPrepare = open && ready && !disabled && !loading && count > 0 && count <= ADMIN_ORDER_PRINT_LIMIT && (mode === 'selected' || filtersActive)
  const visibleModal = modalOpen && !!current
  const previewVisible = useRef(visibleModal)
  useLayoutEffect(() => { previewVisible.current = visibleModal }, [visibleModal])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current?.abort(); busyCallback.current(false) }
  }, [])
  useEffect(() => {
    const currentGeneration = ++generation.current
    request.current?.abort()
    request.current = null
    lock.current = false
    printLock.current = false
    // The key comparison above removes stale documents before this cleanup runs.
    const timer = setTimeout(() => { if (mounted.current && generation.current === currentGeneration) { setLoading(false); setPrinting(false); setModalOpen(false); setBatch(null); setError(''); busyCallback.current(false) } }, 0)
    return () => clearTimeout(timer)
  }, [key])

  useEffect(() => {
    if (!visibleModal) return
    busyCallback.current(true)
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.setAttribute('data-order-documents-preview', '')
    heading.current?.focus()
    return () => { document.body.style.overflow = priorOverflow; document.body.removeAttribute('data-order-documents-preview'); (trigger.current || focused)?.focus(); busyCallback.current(false) }
  }, [visibleModal])

  function closePreview() {
    if (printLock.current) return
    previewVisible.current = false
    setModalOpen(false)
    busyCallback.current(false)
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !printLock.current) { event.preventDefault(); closePreview(); return }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0)
    const first = focusable[0], last = focusable.at(-1)
    if (!first || !last) { event.preventDefault(); heading.current?.focus(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  async function prepare() {
    if (lock.current || !canPrepare || latest.current.key !== key || !latest.current.ready || latest.current.disabled || !latest.current.open) return
    generation.current++
    lock.current = true; const active = new AbortController(); request.current = active
    const requestKey = key
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setError(''); setBatch(null); setLoading(true); busyCallback.current(true)
    const timeout = setTimeout(() => active.abort(), 60000)
    let opened = false
    try {
      const response = await fetch('/api/admin/orders/documents', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, mode, ...(mode === 'selected' ? { ids } : { filters: filterQuery }) }), signal: active.signal })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new Error(record(data) && typeof data.error === 'string' ? data.error : 'آماده‌سازی مدارک انجام نشد؛ دوباره تلاش کن.')
      const prepared = readOrderPrintResponse(data, kind, mode === 'selected' ? ids : undefined)
      if (!mounted.current || active.signal.aborted || latest.current.key !== requestKey) return
      setBatch({ key: requestKey, data: prepared }); setModalOpen(true); opened = true
    } catch (cause) {
      if (mounted.current && latest.current.key === requestKey) setError(active.signal.aborted ? 'دریافت مدارک بیش از حد طول کشید؛ دوباره آماده‌سازی کن.' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد؛ دوباره تلاش کن.')
    } finally {
      clearTimeout(timeout)
      if (request.current === active) { request.current = null; lock.current = false; if (mounted.current) { setLoading(false); busyCallback.current(opened) } }
    }
  }
  async function printDocuments() {
    if (printLock.current || !previewVisible.current || !current || !documents.length || !visibleModal || latest.current.disabled || !latest.current.ready) return
    const expectedKey = key
    printLock.current = true; setPrinting(true)
    try {
      await document.fonts.ready
      if (!mounted.current || !previewVisible.current || expectedKey !== latest.current.key || !latest.current.open || latest.current.disabled || !latest.current.ready) return
      window.print()
    } catch { if (mounted.current) setError('پنجرهٔ چاپ باز نشد؛ تنظیمات چاپ مرورگر را بررسی کن.') }
    finally { printLock.current = false; if (mounted.current) setPrinting(false) }
  }

  return <>
    {open && <section className={styles.panel} id="order-documents-panel" aria-labelledby="order-documents-title" aria-busy={loading}>
      <div className={styles.heading}><div><h2 id="order-documents-title"><Printer size={18} aria-hidden="true" />چاپ دسته‌ای مدارک</h2><p>نوع مدرک و سفارش‌ها را انتخاب کن؛ ابتدا پیش‌نمایش را ببین، سپس همه را یک‌جا چاپ کن.</p></div><button type="button" className={styles.close} aria-label="بستن چاپ دسته‌ای مدارک" disabled={loading} onClick={onClose}><X size={18} /></button></div>
      <div className={styles.controls}>
        <fieldset disabled={loading || disabled} className={styles.scopes}>
          <legend className={styles.controlLabel}>دامنهٔ چاپ</legend>
          <div className={styles.scopeOptions}>
            <label><input type="radio" name="order-documents-scope" checked={mode === 'selected'} onChange={() => { if (!lock.current) onModeChange('selected') }} />سفارش‌های انتخاب‌شده</label>
            <label><input type="radio" name="order-documents-scope" checked={mode === 'filtered'} disabled={!filtersActive} onChange={() => { if (!lock.current && filtersActive) onModeChange('filtered') }} />همهٔ نتایج فیلتر</label>
          </div>
        </fieldset>
        <label className={styles.kind}>
          <span className={styles.controlLabel}>نوع مدرک</span>
          <EnhancedSelect aria-label="نوع مدرک سفارش" value={kind} disabled={loading || disabled} onChange={event => { if (!lock.current && ADMIN_ORDER_DOCUMENT_KINDS.includes(event.target.value as AdminOrderDocumentKind)) setKind(event.target.value as AdminOrderDocumentKind) }}>{ADMIN_ORDER_DOCUMENT_KINDS.map(value => <option key={value} value={value}>{labels[value]}</option>)}</EnhancedSelect>
        </label>
        <button type="button" className={styles.primary} disabled={!canPrepare} onClick={() => void prepare()}>{loading ? <><LoaderCircle size={16} /> در حال آماده‌سازی…</> : <><FileText size={16} /> آماده‌سازی و پیش‌نمایش</>}</button>
      </div>
      <div className={styles.scopeNote}><p role="status">{mode === 'selected' ? `${number(ids.length)} سفارش انتخاب‌شده؛ انتخاب‌ها بین صفحه‌ها حفظ می‌شوند.` : `${number(total)} سفارش در همهٔ صفحه‌های نتایج فیلتر`}</p>{mode === 'selected' && ids.length > 0 && <button type="button" disabled={loading || disabled} onClick={onClearSelection}>پاک‌کردن انتخاب‌ها</button>}</div>
      {mode === 'filtered' && filterSummary && <p className={styles.help}>{filterSummary}</p>}
      {mode === 'selected' && !ids.length && <p className={styles.help}>از جدول پایین، سفارش‌ها را تکی یا برای همین صفحه انتخاب کن.</p>}
      {!filtersActive && <p className={styles.help}>برای چاپ همهٔ نتایج، ابتدا جستجو یا فیلتر زمان، وضعیت یا پرداخت را اعمال کن.</p>}
      <p className={styles.help}>حداکثر {number(ADMIN_ORDER_PRINT_LIMIT)} سفارش در هر نوبت. فاکتور فقط برای سفارش دارای فاکتور صادرشده است؛ برگهٔ بسته‌بندی و برچسب فقط برای سفارش پرداخت‌شده و در حال آماده‌سازی یا ارسال‌اند.</p>
      {count > ADMIN_ORDER_PRINT_LIMIT && <p className={styles.error} role="alert">تعداد سفارش‌ها بیشتر از {number(ADMIN_ORDER_PRINT_LIMIT)} است؛ بازه یا فیلتر را محدودتر کن. هیچ سفارش به‌صورت پنهانی از چاپ حذف نمی‌شود.</p>}
      {error && !visibleModal && <p className={styles.error} role="alert"><CircleAlert size={16} />{error}</p>}
      {current && !visibleModal && <button type="button" className={styles.secondary} onClick={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setModalOpen(true) }}>بازکردن دوبارهٔ پیش‌نمایش</button>}
    </section>}
    {visibleModal && typeof document !== 'undefined' && createPortal(<div className={styles.printRoot} data-order-documents-root="" dir="rtl" role="dialog" aria-modal="true" aria-labelledby="order-documents-preview-title" onKeyDown={onKeyDown} ref={dialog}>
      <style media="print">{'@page { size: A4 portrait; margin: 12mm; }'}</style>
      <div className={styles.previewToolbar}><div><h2 id="order-documents-preview-title" tabIndex={-1} ref={heading}>پیش‌نمایش {labels[kind]}</h2><p>{number(documents.length)} مدرک آماده · {number(current!.rows.length - documents.length)} سفارش بدون مدرک · آماده‌سازی در {formatDate(current!.generatedAt)}، {new Date(current!.generatedAt).toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' })}</p></div><div><button type="button" className={styles.primary} disabled={printing || !documents.length} onClick={() => void printDocuments()}><Printer size={17} />{printing ? 'در حال بازکردن چاپ…' : `چاپ ${number(documents.length)} مدرک / ذخیره PDF`}</button><button type="button" className={styles.secondary} disabled={printing} onClick={closePreview}>بازگشت به سفارش‌ها</button></div></div>
      <div className={styles.previewNotes}><p>سفارش‌ها با چاپ تغییر وضعیت نمی‌دهند. در پنجرهٔ چاپ، کاغذ A4 را انتخاب کن؛ سربرگ و پابرگ خودکار مرورگر را خاموش کن.</p>{current!.rows.some(row => !row.eligible || row.warnings.length > 0) && <details open><summary>سفارش‌های چاپ‌نشده و نکات ({number(current!.rows.filter(row => !row.eligible || row.warnings.length > 0).length)})</summary><ul>{current!.rows.filter(row => !row.eligible || row.warnings.length > 0).map(row => <li key={row.id}><bdi dir="ltr">{row.id}</bdi> — {!row.eligible && <strong>چاپ نمی‌شود: {row.reason} </strong>}{row.warnings.join(' · ')}</li>)}</ul></details>}{error && <p role="alert" className={styles.error}>{error}</p>}</div>
      <div className={styles.documents}>{documents.map(doc => <OrderPrintDocument key={doc.orderId} document={doc} />)}</div>
      {!documents.length && <p className={styles.empty} role="status">برای سفارش‌های این دامنه مدرک قابل چاپی آماده نشد؛ علت هر سفارش را در فهرست بالا ببین.</p>}
    </div>, document.body)}
  </>
}
