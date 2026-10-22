'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, Boxes, Check, CircleAlert, History, PackageCheck, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Warehouse, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import { formatPrice } from '@/lib/utils'
import admin from '@/components/admin/admin.module.css'
import styles from './inventory.module.css'

type MovementType = 'RECEIPT' | 'ADJUSTMENT' | 'RETURN_SELLABLE' | 'RETURN_DAMAGED' | 'DAMAGE' | 'REPAIR' | 'DISPOSAL'
type Variant = { id: string; size: number; color: string; stock: number; damagedStock: number; isActive: boolean; lowStockThreshold: number; reserved: number }
type Product = { id: string; code: string; name: string; images: string[]; inventoryVersion: number; inventoryConfigured: boolean; variants: Variant[] }
type Pagination = { page: number; total: number; pages: number; pageSize: number }
type Summary = { available: number; reserved: number; damaged: number; inactive: number; lowCount: number; unconfiguredCount: number; unallocated?: number }
type StockResponse = { summary: Summary; products: Product[]; pagination: Pagination }
type Movement = { id: string; productId: string; productName: string; variantId: string | null; size: number | null; color: string | null; type: string; quantity: number; stockBefore: number; stockAfter: number; damagedBefore: number; damagedAfter: number; activeBefore: boolean; activeAfter: boolean; actorName: string | null; orderId: string | null; note: string | null; createdAt: string }
type LedgerResponse = { movements: Movement[]; pagination: Pagination }
type Draft = { productId: string; variantId: string; inventoryVersion: number; mode: 'movement' | 'threshold'; type: MovementType; quantity: string; note: string; orderId: string }

const operations: { value: MovementType; label: string; description: string }[] = [
  { value: 'RECEIPT', label: 'ورود کالا', description: 'کالای تولیدشده یا خریداری‌شده به موجودی قابل فروش اضافه می‌شود.' },
  { value: 'ADJUSTMENT', label: 'اصلاح موجودی پس از شمارش', description: 'تعداد نهاییِ قابل فروش را وارد کنید؛ کالاهای رزروشده را در این عدد حساب نکنید.' },
  { value: 'RETURN_SELLABLE', label: 'مرجوعی سالم از مشتری', description: 'پس از بررسی سلامت، کالای برگشتی دوباره قابل فروش می‌شود. شناسهٔ سفارش ارسال‌شده یا تحویل‌شده لازم است.' },
  { value: 'RETURN_DAMAGED', label: 'مرجوعی معیوب از مشتری', description: 'کالای برگشتی فقط به موجودی معیوب اضافه می‌شود و قابل فروش نیست. شناسهٔ سفارش لازم است.' },
  { value: 'DAMAGE', label: 'انتقال به کالای معیوب', description: 'این تعداد از موجودی قابل فروش کم و به موجودی معیوب اضافه می‌شود.' },
  { value: 'REPAIR', label: 'بازگشت کالای تعمیرشده', description: 'این تعداد پس از بررسی سلامت، از موجودی معیوب به موجودی قابل فروش برمی‌گردد.' },
  { value: 'DISPOSAL', label: 'خروج کالای معیوب', description: 'این تعداد از موجودی معیوب خارج می‌شود؛ موجودی قابل فروش تغییر نمی‌کند.' },
]
const movementLabels: Record<string, string> = {
  OPENING: 'موجودی آغازین', RECEIPT: 'ورود کالا', ADJUSTMENT: 'اصلاح شمارش', RESERVE: 'رزرو سفارش', RELEASE: 'آزادسازی رزرو', SALE: 'تأیید فروش',
  RETURN_SELLABLE: 'مرجوعی سالم', RETURN_DAMAGED: 'مرجوعی معیوب', DAMAGE: 'ثبت کالای معیوب', REPAIR: 'تعمیر کالا', DISPOSAL: 'خروج معیوب', VARIANT_STATUS: 'تغییر وضعیت تنوع', SHIPMENT: 'ارسال سفارش',
}
const emptyPagination: Pagination = { page: 1, total: 0, pages: 1, pageSize: 20 }
const number = (value: number) => formatPrice(value)
const date = (value: string) => new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(new Date(value))
const isReturn = (type: MovementType) => type === 'RETURN_SELLABLE' || type === 'RETURN_DAMAGED'

function requestKey() {
  const generator = globalThis.crypto
  if (typeof generator?.randomUUID === 'function') return generator.randomUUID()
  // Unlike randomUUID, getRandomValues also works on a plain HTTP LAN preview.
  if (typeof generator?.getRandomValues === 'function') {
    const bytes = generator.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  throw new Error('مرورگر امکان ساخت شناسهٔ امن درخواست را ندارد. از مرورگر به‌روز یا اتصال HTTPS استفاده کنید.')
}

function preview(variant: Variant, type: MovementType, quantity: number) {
  let available = variant.stock, damaged = variant.damagedStock
  if (type === 'ADJUSTMENT') available = quantity
  else if (type === 'RECEIPT' || type === 'RETURN_SELLABLE') available += quantity
  else if (type === 'RETURN_DAMAGED') damaged += quantity
  else if (type === 'DAMAGE') { available -= quantity; damaged += quantity }
  else if (type === 'REPAIR') { damaged -= quantity; available += quantity }
  else if (type === 'DISPOSAL') damaged -= quantity
  return { available, damaged }
}

function PaginationControls({ pagination, onChange, disabled, label }: { pagination: Pagination; onChange: (page: number) => void; disabled: boolean; label: string }) {
  if (pagination.pages < 2) return null
  return <nav className={styles.pagination} aria-label={label}>
    <button type="button" disabled={disabled || pagination.page <= 1} onClick={() => onChange(pagination.page - 1)}><ArrowRight size={16} /> قبلی</button>
    <span>صفحهٔ {number(pagination.page)} از {number(pagination.pages)}</span>
    <button type="button" disabled={disabled || pagination.page >= pagination.pages} onClick={() => onChange(pagination.page + 1)}>بعدی <ArrowLeft size={16} /></button>
  </nav>
}

export default function AdminInventoryPage() {
  const [stock, setStock] = useState<StockResponse | null>(null)
  const [ledger, setLedger] = useState<LedgerResponse | null>(null)
  const [filters, setFilters] = useState({ q: '', filter: 'all', page: 1 })
  const [historyFilters, setHistoryFilters] = useState({ productId: '', productName: '', type: '', page: 1 })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [loadedStockQuery, setLoadedStockQuery] = useState('')
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const stockController = useRef<AbortController | null>(null)
  const historyController = useRef<AbortController | null>(null)
  const writeController = useRef<AbortController | null>(null)
  const writeLock = useRef(false)
  const mounted = useRef(true)
  const retry = useRef<{ fingerprint: string; key: string } | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const historyRef = useRef<HTMLElement | null>(null)
  const stockQuery = new URLSearchParams({ q: filters.q, filter: filters.filter, page: String(filters.page) }).toString()
  const historyQuery = new URLSearchParams({ productId: historyFilters.productId, type: historyFilters.type, page: String(historyFilters.page) }).toString()
  const dialogOpen = draft !== null

  const loadStock = useCallback(async () => {
    stockController.current?.abort()
    const controller = new AbortController()
    stockController.current = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    setLoading(true)
    try {
      const response = await fetch(`/api/admin/inventory?${stockQuery}`, { cache: 'no-store', signal: controller.signal })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.summary || !Array.isArray(data.products) || !data.pagination) throw new Error(data?.error || 'دریافت موجودی ممکن نشد.')
      if (!controller.signal.aborted && mounted.current) { setStock(data); setLoadedStockQuery(stockQuery); setError(''); return data as StockResponse }
    } catch (cause) {
      if (mounted.current && stockController.current === controller && (!controller.signal.aborted || timedOut)) setError(timedOut ? 'دریافت موجودی طول کشید؛ دوباره تلاش کنید.' : cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally { clearTimeout(timeout); if (mounted.current && stockController.current === controller) setLoading(false) }
    return null
  }, [stockQuery])

  const loadLedger = useCallback(async () => {
    historyController.current?.abort()
    const controller = new AbortController()
    historyController.current = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    setHistoryLoading(true)
    try {
      const response = await fetch(`/api/admin/inventory/movements?${historyQuery}`, { cache: 'no-store', signal: controller.signal })
      const data = await response.json().catch(() => null)
      if (!response.ok || !Array.isArray(data?.movements) || !data.pagination) throw new Error(data?.error || 'دریافت گردش موجودی ممکن نشد.')
      if (!controller.signal.aborted && mounted.current) { setLedger(data); setHistoryError('') }
    } catch (cause) {
      if (mounted.current && historyController.current === controller && (!controller.signal.aborted || timedOut)) setHistoryError(timedOut ? 'دریافت سوابق طول کشید؛ دوباره تلاش کنید.' : cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally { clearTimeout(timeout); if (mounted.current && historyController.current === controller) setHistoryLoading(false) }
  }, [historyQuery])

  useEffect(() => { const timer = setTimeout(() => void loadStock(), 0); return () => { clearTimeout(timer); stockController.current?.abort() } }, [loadStock])
  useEffect(() => { const timer = setTimeout(() => void loadLedger(), 0); return () => { clearTimeout(timer); historyController.current?.abort() } }, [loadLedger])
  useEffect(() => {
    const timer = setTimeout(() => setFilters(current => current.q === search.trim() ? current : { ...current, q: search.trim(), page: 1 }), 300)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stockController.current?.abort(); historyController.current?.abort(); writeController.current?.abort() } }, [])
  useEffect(() => {
    if (!dialogOpen) return
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('[role="listbox"]')) return
      if (event.key === 'Escape' && !writeLock.current) setDraft(null)
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), a[href], [tabindex="0"]')
      const available = focusable ? Array.from(focusable).filter(element => !element.matches(':disabled') && element.getAttribute('aria-hidden') !== 'true' && !element.hidden && element.getClientRects().length) : []
      const first = available[0], last = available[available.length - 1]
      if (!first) { event.preventDefault(); dialogRef.current?.focus() }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [dialogOpen])

  const product = stock?.products.find(item => item.id === draft?.productId)
  const variant = product?.variants.find(item => item.id === draft?.variantId)
  const quantity = Number(draft?.quantity)
  const projected = draft && variant && draft.quantity !== '' && Number.isSafeInteger(quantity) ? preview(variant, draft.type, quantity) : null
  const stockFresh = !loading && !error && loadedStockQuery === stockQuery

  function open(product: Product, variant: Variant, mode: Draft['mode']) {
    if (!product.inventoryConfigured || !stockFresh || writeLock.current) return
    retry.current = null
    setDraft({ productId: product.id, variantId: variant.id, inventoryVersion: product.inventoryVersion, mode, type: 'RECEIPT', quantity: mode === 'threshold' ? String(variant.lowStockThreshold) : '', note: '', orderId: '' })
    setFormError(''); setConflict(false); setNotice('')
  }
  function change<K extends keyof Draft>(field: K, value: Draft[K]) { if (!writeLock.current) { setDraft(current => current ? { ...current, [field]: value } : null); setFormError('') } }

  async function refreshConflict() {
    if (writeLock.current) return
    const fresh = await loadStock()
    if (!fresh || !draft || !mounted.current) return
    const freshProduct = fresh.products.find(item => item.id === draft.productId)
    const freshVariant = freshProduct?.variants.find(item => item.id === draft.variantId)
    if (!freshProduct?.inventoryConfigured || !freshVariant) { setFormError('این تنوع دیگر قابل تغییر نیست. پنجره را ببندید و وضعیت محصول را بررسی کنید.'); return }
    retry.current = null
    setDraft(current => current ? { ...current, inventoryVersion: freshProduct.inventoryVersion } : null)
    setConflict(false); setFormError('موجودی تازه دریافت شد. مقدار و پیش‌نمایش را دوباره بررسی کنید، سپس ثبت کنید.')
    void loadLedger()
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (writeLock.current || !draft || conflict) return
    if (!product?.inventoryConfigured || !variant || !stockFresh) { setFormError('ابتدا موجودی تازه را دریافت کنید.'); setConflict(true); return }
    const amount = Number(draft.quantity)
    if (draft.quantity === '' || !Number.isSafeInteger(amount) || amount > 2_147_483_647 || amount < (draft.mode === 'threshold' || draft.type === 'ADJUSTMENT' ? 0 : 1)) { setFormError('تعداد معتبر وارد کنید.'); return }
    if (draft.mode === 'movement' && !draft.note.trim()) { setFormError('علت یا توضیح این تغییر را بنویسید.'); return }
    if (draft.mode === 'movement' && isReturn(draft.type) && !draft.orderId.trim()) { setFormError('شناسهٔ کامل سفارشِ مرجوعی را وارد کنید.'); return }
    if (draft.mode === 'movement' && projected && (projected.available < 0 || projected.damaged < 0)) { setFormError('این تعداد از موجودی فعلی بیشتر است.'); return }
    const payload = draft.mode === 'threshold'
      ? { productId: draft.productId, variantId: draft.variantId, inventoryVersion: draft.inventoryVersion, lowStockThreshold: amount }
      : { productId: draft.productId, variantId: draft.variantId, inventoryVersion: draft.inventoryVersion, type: draft.type, quantity: amount, note: draft.note.trim(), ...(isReturn(draft.type) ? { orderId: draft.orderId.trim() } : {}) }
    const fingerprint = JSON.stringify(payload)
    writeLock.current = true; setSaving(true); setFormError('')
    const controller = new AbortController()
    writeController.current = controller
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      if (draft.mode === 'movement' && retry.current?.fingerprint !== fingerprint) {
        try { retry.current = { fingerprint, key: requestKey() } }
        catch { throw new Error('ساخت شناسهٔ درخواست ممکن نشد؛ دوباره تلاش کنید یا از مرورگر به‌روز استفاده کنید.') }
      }
      const response = await fetch('/api/admin/inventory', { method: draft.mode === 'threshold' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft.mode === 'threshold' ? payload : { ...payload, requestKey: retry.current!.key }), signal: controller.signal })
      const data = await response.json().catch(() => null)
      if (!mounted.current) return
      if (!response.ok) {
        if (response.status === 409 && (!data?.code || ['PRODUCT_INVENTORY_CHANGED', 'INVENTORY_CONFLICT', 'INVENTORY_NOT_CONFIGURED', 'WAREHOUSE_REQUEST_CONFLICT'].includes(data.code))) setConflict(true)
        throw new Error(data?.error || 'ثبت تغییر ممکن نشد.')
      }
      if (controller.signal.aborted) throw new Error('مهلت ارتباط تمام شد.')
      retry.current = null; setDraft(null); setNotice(draft.mode === 'threshold' ? 'حد هشدار موجودی ذخیره شد.' : 'گردش موجودی ثبت شد.')
      await Promise.all([loadStock(), loadLedger()])
    } catch (cause) {
      if (mounted.current) setFormError(controller.signal.aborted ? 'پاسخ سرور دریافت نشد. با همین اطلاعات دوباره تلاش کنید؛ درخواست تکراری دوباره در موجودی اعمال نمی‌شود.' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. با همین اطلاعات دوباره تلاش کنید.')
    } finally { clearTimeout(timeout); writeLock.current = false; if (mounted.current) setSaving(false) }
  }

  function showHistory(item: Product) {
    setHistoryFilters(current => ({ ...current, productId: item.id, productName: item.name, page: 1 }))
    historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return <div className={styles.page}>
    <div className={admin.pageHeader}>
      <div><span className={admin.eyebrow}>کنترل موجودی فروشگاه</span><h1>انبارداری</h1><p>ورود کالا، مرجوعی و همهٔ تغییرات موجودی، رنگ‌به‌رنگ و سایزبه‌سایز.</p></div>
      <button className={styles.secondary} type="button" disabled={loading || historyLoading || saving} onClick={() => { void loadStock(); void loadLedger() }}><RefreshCw size={16} /> تازه‌سازی</button>
    </div>
    {notice && <p role="status" className={styles.notice}><Check size={17} />{notice}</p>}
    <div className={styles.summary} aria-label="خلاصهٔ انبار">
      {[
        { key: 'available', label: 'قابل فروش', Icon: Boxes }, { key: 'reserved', label: 'رزروشده / آمادهٔ ارسال', Icon: PackageCheck },
        { key: 'damaged', label: 'معیوب', Icon: ShieldAlert }, { key: 'inactive', label: 'موجودی تنوع غیرفعال', Icon: Warehouse },
        { key: 'lowCount', label: 'تنوع با موجودی کم', Icon: CircleAlert }, { key: 'unconfiguredCount', label: 'محصول بدون تنظیم موجودی', Icon: SlidersHorizontal },
      ].map(({ key, label, Icon }) => <article className={styles.stat} key={key}><span className={styles.statIcon}><Icon size={19} /></span><strong>{stock ? number(stock.summary[key as keyof Summary] ?? 0) : '—'}</strong><span>{label}</span></article>)}
    </div>
    <p className={styles.explanation}>موجودی قابل فروش از رزروها جداست. کالای سفارش پرداخت‌شده تا زمان ارسال در «رزروشده / آمادهٔ ارسال» باقی می‌ماند. کالای معیوب قابل خرید نیست.</p>
    {(stock?.summary.unallocated ?? 0) > 0 && <div className={styles.setup}><CircleAlert size={18} /><p>{number(stock!.summary.unallocated!)} جفت موجودی قدیمی هنوز بین رنگ و سایزها تقسیم نشده و در موجودی قابل فروش حساب نمی‌شود.</p><Link href="/admin/products">تخصیص موجودی <ArrowLeft size={15} /></Link></div>}

    <section className={styles.panel} aria-labelledby="inventory-title">
      <div className={styles.panelHeader}><h2 id="inventory-title"><Boxes size={20} /> موجودی محصولات</h2><span>{stock ? `${number(stock.pagination.total)} محصول` : ''}</span></div>
      <div className={styles.filters}>
        <label className={styles.search}><span>جستجوی محصول</span><span><Search size={17} /><input value={search} maxLength={100} onChange={event => setSearch(event.target.value)} placeholder="کد، نام یا مدل کفش" /></span></label>
        <label><span>نمایش موجودی</span><EnhancedSelect value={filters.filter} onChange={event => setFilters(current => ({ ...current, filter: event.target.value, page: 1 }))} aria-label="فیلتر موجودی">
          <option value="all">همهٔ محصولات</option><option value="low">موجودی کم</option><option value="unconfigured">تنظیم‌نشده</option><option value="damaged">دارای کالای معیوب</option>
        </EnhancedSelect></label>
      </div>
      {error && <div role="alert" className={styles.error}>{error}<button type="button" onClick={() => void loadStock()}>تلاش دوباره</button></div>}
      <div aria-busy={loading} className={loading && stock ? styles.pending : undefined}>
        {loading && !stock ? <p className={styles.empty} role="status">در حال دریافت موجودی…</p> : stock?.products.length ? <div className={styles.products}>{stock.products.map(item => <article className={styles.product} key={item.id}>
          <div className={styles.productHeader}>
            <div className={styles.productTitle}>{item.images[0] && <Image src={item.images[0]} alt="" width={52} height={52} unoptimized />}<div><h3>{item.name}</h3><span className={styles.productCode}>کد محصول: <bdi dir="ltr">{item.code}</bdi></span><span>{number(item.variants.filter(row => row.isActive).length)} تنوع فعال</span></div></div>
            <button className={styles.textButton} type="button" onClick={() => showHistory(item)}><History size={15} /> گردش این محصول</button>
          </div>
          {!item.inventoryConfigured ? <div className={styles.setup}><CircleAlert size={18} /><p>موجودی این محصول هنوز به تفکیک رنگ و سایز تنظیم نشده است.</p><Link href="/admin/products">تنظیم در محصولات <ArrowLeft size={15} /></Link></div> : item.variants.length ? <div className={styles.variantScroll}><table className={styles.variantTable}><thead><tr><th>رنگ / سایز</th><th>قابل فروش</th><th>رزرو / آماده ارسال</th><th>معیوب</th><th>حد هشدار</th><th>عملیات</th></tr></thead><tbody>{item.variants.map(row => <tr key={row.id} className={!row.isActive ? styles.inactive : undefined}>
            <td><span className={styles.variantName}>{row.color} <b>{number(row.size)}</b></span>{!row.isActive ? <small>غیرفعال — خارج از فروش</small> : row.stock <= row.lowStockThreshold && <small className={styles.low}>موجودی کم</small>}</td>
            <td><strong>{number(row.stock)}</strong></td><td>{number(row.reserved)}</td><td className={row.damagedStock > 0 ? styles.damaged : undefined}>{number(row.damagedStock)}</td>
            <td><button className={styles.threshold} type="button" aria-label={`تنظیم حد هشدار ${item.name} ${row.color} سایز ${row.size}`} disabled={!stockFresh || saving} onClick={() => open(item, row, 'threshold')}>{number(row.lowStockThreshold)} <SlidersHorizontal size={13} /></button></td>
            <td><button className={styles.action} type="button" disabled={!stockFresh || saving} onClick={() => open(item, row, 'movement')}><ArrowDownToLine size={15} /> ثبت گردش</button></td>
          </tr>)}</tbody></table></div> : <p className={styles.empty}>تنوعی برای این محصول ثبت نشده است.</p>}
        </article>)}</div> : !error && <p className={styles.empty}>محصولی با این شرایط پیدا نشد.</p>}
      </div>
      <PaginationControls pagination={stock?.pagination ?? emptyPagination} onChange={page => setFilters(current => ({ ...current, page }))} disabled={loading} label="صفحه‌های موجودی" />
    </section>

    <section className={styles.panel} aria-labelledby="inventory-history-title" ref={historyRef}>
      <div className={styles.panelHeader}><h2 id="inventory-history-title"><History size={20} /> تاریخچهٔ گردش موجودی</h2><button type="button" className={styles.textButton} disabled={historyLoading} onClick={() => void loadLedger()} aria-label="تازه‌سازی تاریخچه"><RefreshCw size={16} /></button></div>
      <div className={styles.historyFilters}>
        <label><span>نوع گردش</span><EnhancedSelect value={historyFilters.type} onChange={event => setHistoryFilters(current => ({ ...current, type: event.target.value, page: 1 }))} aria-label="نوع گردش موجودی"><option value="">همهٔ گردش‌ها</option>{Object.entries(movementLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</EnhancedSelect></label>
        <div className={styles.productFilter}><span>{historyFilters.productName || 'همهٔ محصولات'}</span>{historyFilters.productId && <button type="button" aria-label="حذف فیلتر محصول" onClick={() => setHistoryFilters(current => ({ ...current, productId: '', productName: '', page: 1 }))}><X size={16} /></button>}</div>
      </div>
      {historyError && <div role="alert" className={styles.error}>{historyError}<button type="button" onClick={() => void loadLedger()}>تلاش دوباره</button></div>}
      <div aria-busy={historyLoading} className={historyLoading && ledger ? styles.pending : undefined}>
        {historyLoading && !ledger ? <p className={styles.empty} role="status">در حال دریافت گردش‌ها…</p> : ledger?.movements.length ? <ol className={styles.movements}>{ledger.movements.map(movement => <li className={styles.movement} key={movement.id}>
          <div className={styles.movementHeading}><span className={styles.movementType}>{movementLabels[movement.type] || movement.type}</span><time dateTime={movement.createdAt}>{date(movement.createdAt)}</time></div>
          <div className={styles.movementBody}><div><h3>{movement.productName}</h3><p>{movement.color ?? '—'}{movement.size !== null ? ` · سایز ${number(movement.size)}` : ''} · {number(movement.quantity)} جفت</p></div>
            <div className={styles.changes}><span>قابل فروش <b>{number(movement.stockBefore)} ← {number(movement.stockAfter)}</b></span><span>معیوب <b>{number(movement.damagedBefore)} ← {number(movement.damagedAfter)}</b></span>{movement.activeBefore !== movement.activeAfter && <span>وضعیت <b>{movement.activeAfter ? 'فعال' : 'غیرفعال'}</b></span>}</div>
          </div>
          {movement.note && <p className={styles.movementNote}>{movement.note}</p>}
          <div className={styles.movementFooter}><span>ثبت‌کننده: {movement.actorName || 'سیستم'}</span>{movement.orderId && <Link href={`/admin/orders?q=${encodeURIComponent(movement.orderId)}`}>سفارش <b dir="ltr">#{movement.orderId.slice(-8)}</b> <ArrowLeft size={13} /></Link>}</div>
        </li>)}</ol> : !historyError && <p className={styles.empty}>گردشی با این شرایط ثبت نشده است.</p>}
      </div>
      <PaginationControls pagination={ledger?.pagination ?? emptyPagination} onChange={page => setHistoryFilters(current => ({ ...current, page }))} disabled={historyLoading} label="صفحه‌های گردش موجودی" />
    </section>

    {draft && <div className={styles.backdrop} onClick={event => { if (event.target === event.currentTarget && !saving) setDraft(null) }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="inventory-dialog-title" tabIndex={-1} ref={dialogRef}>
        <div className={styles.dialogHeader}><div><span>{product?.name}</span><h2 id="inventory-dialog-title">{draft.mode === 'threshold' ? 'تنظیم حد هشدار' : 'ثبت گردش موجودی'}</h2></div><button type="button" aria-label="بستن پنجره" disabled={saving} onClick={() => setDraft(null)}><X size={20} /></button></div>
        <form onSubmit={save}><fieldset disabled={saving} className={styles.fieldset}>
          <label><span>رنگ و سایز</span><EnhancedSelect value={draft.variantId} aria-label="تنوع کالا" onChange={event => { change('variantId', event.target.value); change('quantity', draft.mode === 'threshold' ? String(product?.variants.find(row => row.id === event.target.value)?.lowStockThreshold ?? 2) : '') }}>
            {product?.variants.map(row => <option value={row.id} key={row.id}>{row.color} · سایز {number(row.size)}{row.isActive ? '' : ' · غیرفعال'}</option>)}
          </EnhancedSelect></label>
          {variant && !variant.isActive && <p className={styles.inactiveWarning}>این رنگ و سایز غیرفعال است. ورود یا مرجوعی، آن را فعال نمی‌کند؛ موجودی آن تا فعال‌سازی در بخش محصولات، خارج از فروش می‌ماند.</p>}
          {draft.mode === 'movement' && <label><span>نوع عملیات</span><EnhancedSelect value={draft.type} aria-label="عملیات انبار" onChange={event => change('type', event.target.value as MovementType)}>{operations.map(operation => <option key={operation.value} value={operation.value}>{operation.label}</option>)}</EnhancedSelect></label>}
          <p className={styles.operationHelp}>{draft.mode === 'threshold' ? 'وقتی موجودی قابل فروش به این تعداد یا کمتر برسد، این تنوع در فیلتر «موجودی کم» نمایش داده می‌شود.' : operations.find(operation => operation.value === draft.type)?.description}</p>
          <label><span>{draft.mode === 'threshold' ? 'حد هشدار (جفت)' : draft.type === 'ADJUSTMENT' ? 'موجودی نهایی قابل فروش (جفت)' : 'تعداد (جفت)'}</span><FormattedNumberInput required min={draft.mode === 'threshold' || draft.type === 'ADJUSTMENT' ? 0 : 1} max={2_147_483_647} value={draft.quantity} onValueChange={value => change('quantity', value)} aria-label={draft.mode === 'threshold' ? 'حد هشدار' : 'تعداد گردش'} /></label>
          {draft.mode === 'movement' && isReturn(draft.type) && <label><span>شناسهٔ کامل سفارش مرجوعی</span><input required value={draft.orderId} onChange={event => change('orderId', event.target.value)} dir="ltr" placeholder="شناسهٔ سفارش، نه شمارهٔ کوتاه" /><small>برگشت کالا فقط برای تعداد ارسال‌شده و مرجوع‌نشدهٔ همین رنگ و سایز ثبت می‌شود. این ثبت، بازپرداخت وجه انجام نمی‌دهد. <Link className={styles.inlineLink} href="/admin/orders" target="_blank" rel="noopener noreferrer">یافتن شناسه در جزئیات سفارش ↗</Link></small></label>}
          {draft.mode === 'movement' && <label><span>علت یا توضیح</span><textarea required maxLength={500} value={draft.note} onChange={event => change('note', event.target.value)} placeholder="مثلاً ورود تولید جدید، نتیجهٔ شمارش یا دلیل مرجوعی" /></label>}
          {variant && draft.mode === 'movement' && <div className={styles.preview} aria-label="پیش‌نمایش موجودی"><span>پیش‌نمایش پس از ثبت</span><div><span>قابل فروش <b>{number(variant.stock)} ← {projected ? number(projected.available) : '—'}</b></span><span>معیوب <b>{number(variant.damagedStock)} ← {projected ? number(projected.damaged) : '—'}</b></span></div><small>رزرو سفارش‌ها: {number(variant.reserved)} جفت؛ این عملیات آن را تغییر نمی‌دهد.</small></div>}
          {formError && <p role="alert" className={styles.formError}>{formError}</p>}
          {conflict && <button type="button" className={styles.secondary} disabled={loading} onClick={() => void refreshConflict()}><RefreshCw size={15} /> دریافت موجودی تازه و بازبینی</button>}
          <div className={styles.formActions}><button type="submit" className={styles.primary} disabled={conflict || loading}>{saving ? 'در حال ثبت…' : draft.mode === 'threshold' ? 'ذخیرهٔ حد هشدار' : 'تأیید و ثبت گردش'}</button><button type="button" className={styles.secondary} onClick={() => setDraft(null)}>انصراف</button></div>
        </fieldset></form>
      </div>
    </div>}
  </div>
}
