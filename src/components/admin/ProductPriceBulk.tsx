'use client'

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CircleAlert, LoaderCircle, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import { useAppSession } from '@/components/auth/SessionActivityProvider'
import { productPricing } from '@/lib/pricing'
import { PRODUCT_PRICE_BULK_LIMIT, type ProductPriceBulkPreview, type ProductPriceBulkResult, type ProductPriceBulkSettings, type ProductPriceSnapshot } from '@/lib/product-price-bulk-contract'
import styles from './product-price-bulk.module.css'

type ProductSource = { id: string; name: string; code: string; price: number; salePrice?: number | null; saleStartsAt?: string | null; saleEndsAt?: string | null; pricingVersion?: number }
type Props = { open: boolean; selectedIds: string[]; products: ProductSource[]; disabled?: boolean; onClose: () => void; onRecovery: () => void; onBusyChange: (busy: boolean) => void; onCompleted: () => void | Promise<unknown> }
type Recovery = { version: 1; preview: ProductPriceBulkPreview; results: Record<string, ProductPriceBulkResult>; pendingProductId: string }
const initialSettings: ProductPriceBulkSettings = { operation: 'increase', unit: 'amount', value: 0, includeSalePrice: false }
const recoveryPrefix = 'panik-product-price-bulk-pending-v1'
const money = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('fa-IR')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 500) => typeof value === 'string' && value.length <= max
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647
const date = (value: unknown) => value === null || (text(value, 40) && Number.isFinite(Date.parse(value as string)))
function validSnapshot(value: unknown): value is ProductPriceSnapshot {
  // Invalid legacy prices still need a visible, ineligible preview row.
  return record(value) && integer(value.price, -2_147_483_648) && (value.salePrice === null || integer(value.salePrice, -2_147_483_648)) && date(value.saleStartsAt) && date(value.saleEndsAt) && integer(value.pricingVersion, -2_147_483_648)
}
const previewExpired = (expiresAt: string) => Date.parse(expiresAt) <= Date.now()
function validSettings(value: unknown): value is ProductPriceBulkSettings {
  return record(value) && ['increase', 'decrease'].includes(String(value.operation)) && ['amount', 'percent'].includes(String(value.unit)) && integer(value.value, 1) && typeof value.includeSalePrice === 'boolean' && !(value.operation === 'decrease' && value.unit === 'percent' && value.value >= 100)
}
function validPreview(value: unknown): value is ProductPriceBulkPreview {
  if (!record(value) || !(value.token === null || (text(value.token, 1_000_000) && value.token)) || !text(value.batchId, 200) || !value.batchId || !text(value.expiresAt, 40) || !Number.isFinite(Date.parse(String(value.expiresAt))) || !validSettings(value.settings) || !text(value.reason) || !String(value.reason).trim() || value.limit !== PRODUCT_PRICE_BULK_LIMIT || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > PRODUCT_PRICE_BULK_LIMIT) return false
  const ids = new Set<string>()
  for (const row of value.rows) {
    if (!record(row) || !text(row.id, 200) || !row.id || ids.has(String(row.id)) || !(row.code === null || text(row.code, 100)) || !(row.name === null || text(row.name, 1000)) || typeof row.eligible !== 'boolean' || !(row.reason === undefined || text(row.reason, 2000)) || !(row.before === null || validSnapshot(row.before)) || !(row.after === null || validSnapshot(row.after)) || (row.eligible && (!row.before || !row.after || !value.token))) return false
    ids.add(String(row.id))
  }
  return true
}
function validResult(value: unknown): value is ProductPriceBulkResult {
  if (!record(value) || !text(value.id, 200) || !value.id || !['updated', 'already_applied', 'skipped'].includes(String(value.outcome)) || !(value.reason === undefined || text(value.reason, 2000)) || !(value.before === undefined || validSnapshot(value.before)) || !(value.after === undefined || validSnapshot(value.after))) return false
  return value.outcome === 'skipped' || (text(value.auditId, 200) && !!String(value.auditId).trim() && validSnapshot(value.before) && validSnapshot(value.after))
}
function validRecovery(value: unknown): value is Recovery {
  if (!record(value) || value.version !== 1 || !validPreview(value.preview) || !record(value.results) || !text(value.pendingProductId, 200)) return false
  const rows = value.preview.rows
  return rows.some(row => row.id === value.pendingProductId && row.eligible) && !value.results[String(value.pendingProductId)] && Object.entries(value.results).length <= rows.length && Object.entries(value.results).every(([id, result]) => validResult(result) && id === result.id && rows.some(row => row.id === id && row.eligible))
}
class RequestError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message) }
}

export default function ProductPriceBulk(props: Props) {
  const { session } = useAppSession()
  const userId = session?.user.id
  if (!userId) return props.open ? <section className={styles.panel} role="status">در حال بررسی حساب مدیر…</section> : null
  return <ProductPriceBulkContent key={userId} {...props} userId={userId} />
}

function ProductPriceBulkContent({ open, selectedIds, products, disabled = false, onClose, onRecovery, onBusyChange, onCompleted, userId }: Props & { userId: string }) {
  const storageKey = `${recoveryPrefix}:${encodeURIComponent(userId)}`
  const [settings, setSettings] = useState(initialSettings)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ProductPriceBulkPreview | null>(null)
  const [previewSource, setPreviewSource] = useState('')
  const [results, setResults] = useState<Record<string, ProductPriceBulkResult>>({})
  const [pendingProductId, setPendingProductId] = useState('')
  const [started, setStarted] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const mounted = useRef(true), lock = useRef(false), pending = useRef(''), revision = useRef(0), runStarted = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const callbacks = useRef({ onBusyChange, onRecovery, onCompleted })
  useLayoutEffect(() => { callbacks.current = { onBusyChange, onRecovery, onCompleted } }, [onBusyChange, onRecovery, onCompleted])
  const ids = [...new Set(selectedIds)].sort()
  const source = JSON.stringify(ids.map(id => { const product = products.find(row => row.id === id); return [id, product?.price, product?.salePrice ?? null, product?.saleStartsAt ?? null, product?.saleEndsAt ?? null, product?.pricingVersion] }))
  const latest = useRef({ source, disabled, open })
  useLayoutEffect(() => { latest.current = { source, disabled, open } }, [source, disabled, open])
  const previousSource = useRef(source)
  const locked = !!busy || !!pendingProductId || started || disabled
  const eligible = preview?.rows.filter(row => row.eligible) ?? []
  const invalid = (preview?.rows.length ?? 0) - eligible.length
  const remaining = eligible.filter(row => !results[row.id])
  const sourceMatches = previewSource === source

  useEffect(() => {
    if (previousSource.current !== source) {
      previousSource.current = source
      if (!runStarted.current && !pending.current) { revision.current++; setPreview(null); setAcknowledged(false); setError(''); setNotice('') }
    }
  }, [source])

  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => {
      try {
        const raw = sessionStorage.getItem(storageKey)
        if (!raw) return
        const saved: unknown = raw.length <= 2_000_000 ? JSON.parse(raw) : null
        if (!validRecovery(saved)) { sessionStorage.removeItem(storageKey); return }
        setPreview(saved.preview); setSettings(saved.preview.settings); setAmount(String(saved.preview.settings.value)); setReason(saved.preview.reason); setResults(saved.results); setStarted(true); runStarted.current = true
        pending.current = saved.pendingProductId; setPendingProductId(saved.pendingProductId)
        setError('پاسخ آخرین ثبت مشخص نیست. فقط همان عملیات ذخیره‌شده را پیگیری کنید؛ ثبت خودکار انجام نمی‌شود.')
        callbacks.current.onBusyChange(true); callbacks.current.onRecovery()
      } catch { try { sessionStorage.removeItem(storageKey) } catch { /* Invalid browser data cannot authorize a mutation. */ } }
    }, 0)
    const beforeUnload = (event: BeforeUnloadEvent) => { if (pending.current || lock.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { clearTimeout(timer); mounted.current = false; controller.current?.abort(); window.removeEventListener('beforeunload', beforeUnload); callbacks.current.onBusyChange(false) }
  }, [storageKey])

  function invalidate() { revision.current++; setPreview(null); setAcknowledged(false); setResults({}); setError(''); setNotice('') }
  function editable() { return !lock.current && !pending.current && !runStarted.current && !latest.current.disabled && latest.current.open }
  function changeSettings(changes: Partial<ProductPriceBulkSettings>) { if (!editable()) return; setSettings(previous => ({ ...previous, ...changes })); invalidate() }
  function begin(stage: 'preview' | 'confirm') { lock.current = true; setBusy(stage); callbacks.current.onBusyChange(true) }
  function finish() { lock.current = false; if (mounted.current) { setBusy(null); callbacks.current.onBusyChange(!!pending.current) } }
  function clearRecovery() { try { sessionStorage.removeItem(storageKey) } catch { /* Results remain visible. */ } }
  async function request(url: string, body: Record<string, unknown>, mutation = false): Promise<unknown> {
    const active = new AbortController(); controller.current = active
    const timeout = setTimeout(() => active.abort(), 60000)
    try {
      const response = await fetch(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: active.signal })
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) throw new RequestError(record(data) && typeof data.error === 'string' ? data.error : 'درخواست انجام نشد.', mutation && response.status >= 500)
      if (!record(data) || active.signal.aborted) throw new RequestError('پاسخ کامل سرور دریافت نشد.', mutation)
      return data
    } catch (cause) { if (cause instanceof RequestError) throw cause; throw new RequestError('ارتباط با سرور کامل نشد.', mutation) }
    finally { clearTimeout(timeout); if (controller.current === active) controller.current = null }
  }
  async function makePreview(event: FormEvent) {
    event.preventDefault()
    if (!editable()) return
    invalidate()
    const chosenSettings = { ...settings, value: Number(amount) }
    if (!reason.trim()) { setError('علت تغییر گروهی قیمت را بنویسید.'); return }
    if (!validSettings(chosenSettings)) { setError('مقدار باید عدد صحیح و بزرگ‌تر از صفر باشد؛ کاهش درصدی باید کمتر از ۱۰۰ باشد.'); return }
    if (!ids.length || ids.length > PRODUCT_PRICE_BULK_LIMIT) { setError('بین ۱ تا ۲۰۰ محصول انتخاب کنید.'); return }
    begin('preview'); const currentRevision = revision.current, currentSource = source
    try {
      const data = await request('/api/admin/products/prices/preview', { ids, settings: chosenSettings, reason: reason.trim() })
      if (!validPreview(data) || data.rows.length !== ids.length || data.rows.some(row => !ids.includes(row.id)) || Object.entries(chosenSettings).some(([key, value]) => data.settings[key as keyof ProductPriceBulkSettings] !== value) || data.reason !== reason.trim()) throw new Error('پیش‌نمایش کامل و مطابق انتخاب شما دریافت نشد. دوباره بررسی کنید.')
      if (mounted.current && currentRevision === revision.current && latest.current.source === currentSource) { setPreview(data); setPreviewSource(currentSource) }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'پیش‌نمایش دریافت نشد.') }
    finally { finish() }
  }
  async function confirmProducts(retry = false, continueRun = false) {
    if (lock.current || latest.current.disabled || !preview || !preview.token || (!retry && ((!continueRun && (runStarted.current || !acknowledged || previewSource !== latest.current.source)) || pending.current))) return
    const rows = retry ? eligible.filter(row => row.id === pending.current) : remaining
    if (!rows.length) return
    if (!retry && previewExpired(preview.expiresAt)) { setError('مهلت پیش‌نمایش تمام شده است؛ پیش‌نمایش تازه بگیرید.'); return }
    begin('confirm'); runStarted.current = true; setStarted(true); setError(''); setNotice(''); setProgress({ done: 0, total: rows.length })
    let nextResults = { ...results }, changed = false, done = 0
    try {
      for (const row of rows) {
        if (!mounted.current) break
        const recovery: Recovery = { version: 1, preview, results: nextResults, pendingProductId: row.id }
        try { sessionStorage.setItem(storageKey, JSON.stringify(recovery)) }
        catch { setError('مرورگر نتوانست اطلاعات بازیابی را ذخیره کند؛ ذخیره‌سازی این صفحه را فعال کنید.'); break }
        pending.current = row.id; setPendingProductId(row.id)
        let result: ProductPriceBulkResult
        try {
          const data = await request('/api/admin/products/prices/confirm', { token: preview.token, productId: row.id }, true)
          if (!record(data) || !validResult(data.result) || data.result.id !== row.id) throw new RequestError('پاسخ ثبت کامل نیست.', true)
          result = data.result
        } catch (cause) {
          if (!(cause instanceof RequestError) || cause.uncertain || retry) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : 'پاسخ ثبت دریافت نشد.'} نتیجهٔ «${row.name || row.code || row.id}» مشخص نیست؛ همان عملیات را پیگیری کنید.`); break }
          result = { id: row.id, outcome: 'skipped', reason: cause.message }
        }
        nextResults[row.id] = result; changed ||= result.outcome !== 'skipped'
        pending.current = ''; clearRecovery()
        if (mounted.current) { setPendingProductId(''); setResults({ ...nextResults }); setProgress({ done: ++done, total: rows.length }) }
      }
      if (mounted.current && !pending.current && done === rows.length) setNotice('عملیات پایان یافت؛ نتیجهٔ هر محصول در جدول مشخص است.')
    } finally {
      finish()
      if (changed && mounted.current) { try { await callbacks.current.onCompleted() } catch { if (mounted.current) setError('قیمت‌ها ثبت شدند، اما تازه‌سازی فهرست انجام نشد. فهرست را دوباره بارگذاری کنید.') } }
    }
  }
  function reset() {
    if (lock.current || pending.current) return
    invalidate(); clearRecovery(); runStarted.current = false; setStarted(false); setProgress({ done: 0, total: 0 }); callbacks.current.onBusyChange(false)
  }
  function pricingCell(snapshot: ProductPriceSnapshot | null) {
    return snapshot ? <div className={styles.prices}><span>اصلی: <strong>{money(snapshot.price)}</strong></span><span>بعد از تخفیف: <strong>{money(snapshot.salePrice)}</strong></span><small>قابل پرداخت اکنون: {snapshot.price >= 1 ? money(productPricing(snapshot).effectivePrice) : 'نامعتبر'}</small></div> : '—'
  }
  return <section hidden={!open} className={styles.panel} aria-labelledby="product-price-bulk-title" dir="rtl">
    <div className={styles.heading}><div><span className={styles.eyebrow}>بررسی، سپس تأیید</span><h2 id="product-price-bulk-title">ویرایش گروهی قیمت</h2><p>{money(started ? preview?.rows.length : ids.length)} محصول انتخاب‌شده · حداکثر {money(PRODUCT_PRICE_BULK_LIMIT)} محصول در هر عملیات</p></div><button type="button" className={styles.close} aria-label="بستن ویرایش گروهی قیمت" disabled={!!busy || !!pendingProductId} onClick={() => { if (!lock.current && !pending.current) onClose() }}><X size={19} /></button></div>
    <form onSubmit={makePreview}>
      <fieldset disabled={locked} className={styles.fieldset}>
        <div className={styles.settings}>
          <label><span>نوع تغییر</span><EnhancedSelect aria-label="نوع تغییر قیمت" value={settings.operation} onChange={event => changeSettings({ operation: event.target.value as ProductPriceBulkSettings['operation'] })}><option value="increase">افزایش قیمت</option><option value="decrease">کاهش قیمت</option></EnhancedSelect></label>
          <label><span>روش محاسبه</span><EnhancedSelect aria-label="روش محاسبه قیمت" value={settings.unit} onChange={event => changeSettings({ unit: event.target.value as ProductPriceBulkSettings['unit'] })}><option value="amount">مبلغ ثابت (تومان)</option><option value="percent">درصد صحیح</option></EnhancedSelect></label>
          <label><span>{settings.unit === 'amount' ? 'مبلغ تغییر (تومان)' : 'درصد تغییر'}</span><FormattedNumberInput aria-label="مقدار تغییر قیمت" required min={1} max={settings.unit === 'percent' && settings.operation === 'decrease' ? 99 : 2_147_483_647} value={amount} onValueChange={value => { if (!editable()) return; setAmount(value); invalidate() }} /></label>
          <label className={styles.reason}><span>علت تغییر گروهی قیمت</span><input required maxLength={500} value={reason} onChange={event => { if (!editable()) return; setReason(event.target.value); invalidate() }} placeholder="مثلاً اصلاح قیمت خرید آبان" /></label>
        </div>
        <label className={styles.checkbox}><input type="checkbox" checked={settings.includeSalePrice} onChange={event => changeSettings({ includeSalePrice: event.target.checked })} /><span>همین تغییر روی قیمت‌های بعد از تخفیفِ موجود هم اعمال شود.</span></label>
        <p className={styles.help}>حالت پیش‌فرض فقط قیمت اصلی را تغییر می‌دهد. {settings.includeSalePrice ? 'قیمت بعد از تخفیفِ موجود هم با همین فرمول تغییر می‌کند؛ محصول بدون تخفیف، تخفیف تازه نمی‌گیرد.' : 'قیمت بعد از تخفیف ثابت می‌ماند؛ مبلغ قابل پرداختِ تخفیف فعال ممکن است تغییر نکند.'} زمان شروع و پایان تخفیف حفظ می‌شود.</p>
        <p className={styles.help}>در محاسبهٔ درصدی، قیمت نهایی به نزدیک‌ترین تومان گرد می‌شود؛ نیم تومان رو به بالا است. قیمت صفر، منفی، خارج از سقف مجاز یا تخفیفِ بزرگ‌تر یا مساوی قیمت اصلی قابل ثبت نیست.</p>
        <button type="submit" className={styles.primary} disabled={locked || !ids.length || ids.length > PRODUCT_PRICE_BULK_LIMIT}>{busy === 'preview' ? <><LoaderCircle size={16} /> در حال بررسی…</> : 'بررسی و پیش‌نمایش'}</button>
      </fieldset>
    </form>
    {error && <p className={styles.error} role="alert"><CircleAlert size={17} />{error}</p>}
    {notice && <p className={styles.notice} role="status"><Check size={17} />{notice}</p>}
    {preview && (sourceMatches || started) && <div className={styles.preview}>
      <div className={styles.previewHeading}><h3>پیش‌نمایش قیمت‌ها (تومان)</h3><span>{money(eligible.length)} قابل ثبت · {money(invalid)} غیرقابل ثبت</span></div>
      <p className={styles.help}>علت ثبت: {preview.reason} · این عملیات قیمت سفارش‌های قبلی را تغییر نمی‌دهد.</p>
      <div className={styles.scroll} role="region" tabIndex={0} aria-label="جدول پیش‌نمایش قیمت‌ها"><table className={styles.table}><thead><tr><th>کد / محصول</th><th>قبل از تغییر</th><th>بعد از تغییر</th><th>وضعیت</th></tr></thead><tbody>{preview.rows.map(row => {
        const result = results[row.id], unknown = row.id === pendingProductId
        return <tr key={row.id} className={!row.eligible || result?.outcome === 'skipped' ? styles.invalid : result ? styles.saved : undefined}><td><bdi dir="ltr">{row.code || '—'}</bdi><small>{row.name || 'محصول در دسترس نیست'}</small></td><td>{pricingCell(row.before)}</td><td>{pricingCell(row.after)}</td><td className={styles.status}>{!row.eligible ? `قابل ثبت نیست: ${row.reason || 'نیاز به اصلاح'}` : result ? result.outcome === 'skipped' ? `ثبت نشد: ${result.reason || 'قیمت تغییر کرده است'}` : result.outcome === 'already_applied' ? 'قبلاً ثبت شده؛ دوباره اعمال نشد' : 'ثبت شد' : unknown ? busy === 'confirm' ? 'در حال ثبت…' : 'نتیجه نامشخص؛ پیگیری لازم است' : 'آمادهٔ ثبت'}</td></tr>
      })}</tbody></table></div>
      {!started && <label className={styles.checkbox}><input type="checkbox" checked={acknowledged} disabled={!!busy || disabled || !eligible.length || !sourceMatches} onChange={event => { if (!lock.current && !pending.current && sourceMatches) setAcknowledged(event.target.checked) }} /><span>{invalid ? `می‌پذیرم ${money(invalid)} محصول خطادار ثبت نشود و فقط ${money(eligible.length)} محصول معتبرِ این پیش‌نمایش ثبت شود.` : `قیمت‌های قبل و بعد و علت تغییر را بررسی کردم و ثبت ${money(eligible.length)} محصول را تأیید می‌کنم.`}</span></label>}
      {busy === 'confirm' && <div className={styles.progress} role="status"><progress max={progress.total || 1} value={progress.done} /><span>{money(progress.done)} از {money(progress.total)} محصول بررسی شد.</span></div>}
      <div className={styles.actions}>{pendingProductId && busy !== 'confirm' ? <button type="button" className={styles.primary} disabled={!!busy || disabled} onClick={() => void confirmProducts(true)}>پیگیری دوبارهٔ همان عملیات</button> : !started ? <button type="button" className={styles.primary} disabled={!!busy || disabled || !acknowledged || !eligible.length || !sourceMatches} onClick={() => void confirmProducts()}>تأیید و ثبت {money(eligible.length)} محصول معتبر</button> : null}{started && !busy && !pendingProductId && remaining.length > 0 && <button type="button" className={styles.primary} disabled={disabled} onClick={() => void confirmProducts(false, true)}>ادامهٔ ثبت {money(remaining.length)} محصول باقیمانده</button>}{!busy && !pendingProductId && <button type="button" className={styles.secondary} onClick={reset}>پاک‌کردن پیش‌نمایش و شروع تازه</button>}</div>
      {started && <p className={styles.help}>{money(Object.values(results).filter(result => result.outcome !== 'skipped').length)} محصول ثبت‌شده · {money(Object.values(results).filter(result => result.outcome === 'skipped').length)} ثبت‌نشده{pendingProductId ? '؛ تا روشن شدن نتیجه، انتخاب و ورودی‌ها قفل هستند.' : '؛ هر محصول مستقل ثبت می‌شود و نتیجه‌های موفق دوباره اعمال نمی‌شوند.'}</p>}
    </div>}
  </section>
}
