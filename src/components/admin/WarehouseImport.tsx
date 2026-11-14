'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, CircleAlert, Download, FileSpreadsheet, ListPlus, LoaderCircle, Upload, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import WarehouseManualEntry from '@/components/admin/WarehouseManualEntry'
import { useAppSession } from '@/components/auth/SessionActivityProvider'
import { MAX_WAREHOUSE_IMPORT_FILE_BYTES, MAX_WAREHOUSE_IMPORT_ROWS, MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS, MAX_WAREHOUSE_IMPORT_TOKEN_CHARS, type WarehouseImportMode, type WarehouseImportSheet, type WarehouseImportSourceRow, type WarehouseImportPreview, type WarehouseImportProduct, type WarehouseImportResult, type WarehouseImportConfirmation } from '@/lib/warehouse-import-contract'
import styles from './warehouse-import.module.css'

type Props = { open: boolean; disabled?: boolean; onClose: () => void; onRecovery: () => void; onBusyChange: (busy: boolean) => void; onCompleted: () => void | Promise<unknown> }
type EntryMethod = 'manual' | 'excel'
type Recovery = { version: 1; preview: WarehouseImportPreview; mode: WarehouseImportMode; note: string; fileName: string; results: Record<number, WarehouseImportResult>; pendingProductId: string; entryMethod?: EntryMethod }
const recoveryKey = 'panik-warehouse-import-pending-v1'
const maxRecoveryChars = 2_500_000
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('fa-IR')
const header = (value: string) => value.trim().toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\s\u200c_()（）]/g, '')
const columns = { code: ['کد', 'کدمحصول', 'کدکالا', 'code', 'productcode'], size: ['سایز', 'size'], color: ['رنگ', 'color'], quantity: ['تعداد', 'تعدادجفت', 'quantity'] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value: unknown, maximum = 4000): value is string => typeof value === 'string' && value.length <= maximum
const nonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optionalText = (value: unknown) => value === undefined || boundedText(value)
const previewExpired = (expiresAt: number) => expiresAt <= Date.now()

function validSheets(value: unknown): value is WarehouseImportSheet[] {
  if (!Array.isArray(value) || !value.length || value.length > 10) return false
  let total = 0
  return value.every(sheet => {
    if (!record(sheet) || !boundedText(sheet.name, 100) || !nonnegativeInteger(sheet.columnCount) || sheet.columnCount > 100 || !Array.isArray(sheet.rows) || sheet.rows.length > MAX_WAREHOUSE_IMPORT_ROWS + 20) return false
    total += sheet.rows.length
    const columnCount = sheet.columnCount
    const seen = new Set<number>()
    return total <= 3000 && sheet.rows.every(row => {
      if (!record(row) || !nonnegativeInteger(row.rowNumber) || !row.rowNumber || row.rowNumber > MAX_WAREHOUSE_IMPORT_ROWS + 20 || seen.has(row.rowNumber) || !Array.isArray(row.cells) || row.cells.length > columnCount) return false
      seen.add(row.rowNumber)
      return row.cells.every(cell => record(cell) && boundedText(cell.text) && optionalText(cell.error) && (cell.numeric === undefined || typeof cell.numeric === 'boolean'))
    })
  })
}

function validPreview(value: unknown): value is WarehouseImportPreview {
  if (!record(value) || !boundedText(value.token, MAX_WAREHOUSE_IMPORT_TOKEN_CHARS) || !value.token || !nonnegativeInteger(value.expiresAt) || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > MAX_WAREHOUSE_IMPORT_ROWS || !Array.isArray(value.products) || value.products.length > value.rows.length || !record(value.summary)) return false
  const rows = new Map<number, Record<string, unknown>>()
  for (const row of value.rows) {
    if (!record(row) || !nonnegativeInteger(row.rowNumber) || !row.rowNumber || rows.has(row.rowNumber) || !boundedText(row.code) || !boundedText(row.color) || !(row.size === null || nonnegativeInteger(row.size)) || !(row.quantity === null || nonnegativeInteger(row.quantity)) || !optionalText(row.productId) || !optionalText(row.variantId) || !optionalText(row.productName) || !optionalText(row.error) || !optionalText(row.warning) || !['stockBefore', 'stockAfter', 'reserved', 'damaged', 'inventoryVersion'].every(key => row[key] === undefined || nonnegativeInteger(row[key])) || !(row.isActive === undefined || typeof row.isActive === 'boolean')) return false
    rows.set(row.rowNumber, row)
  }
  const productIds = new Set<string>(), signedRows = new Set<number>()
  for (const product of value.products) {
    if (!record(product) || !boundedText(product.productId, 200) || !product.productId || productIds.has(product.productId) || !boundedText(product.productName) || !boundedText(product.code) || !nonnegativeInteger(product.inventoryVersion) || !Array.isArray(product.rowNumbers) || !product.rowNumbers.length || product.rowNumbers.length > MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS) return false
    productIds.add(product.productId)
    for (const rowNumber of product.rowNumbers) {
      const row = rows.get(rowNumber)
      if (!row || row.error || row.productId !== product.productId || !boundedText(row.variantId, 200) || !row.variantId || signedRows.has(rowNumber)) return false
      signedRows.add(rowNumber)
    }
  }
  const valid = value.rows.filter(row => !row.error).length
  return signedRows.size === valid && value.summary.total === value.rows.length && value.summary.valid === valid && value.summary.invalid === value.rows.length - valid && value.summary.products === value.products.length
}

function validResult(value: unknown): value is WarehouseImportResult {
  return record(value) && nonnegativeInteger(value.rowNumber) && value.rowNumber > 0 && boundedText(value.productId, 200) && boundedText(value.variantId, 200) && ['success', 'replayed', 'error'].includes(String(value.status)) && optionalText(value.error) && ['stockBefore', 'stockAfter'].every(key => value[key] === undefined || nonnegativeInteger(value[key]))
}

function validRecovery(value: unknown): value is Recovery {
  if (record(value) && value.entryMethod !== undefined && value.entryMethod !== 'manual' && value.entryMethod !== 'excel') return false
  if (!record(value) || value.version !== 1 || !validPreview(value.preview) || !['RECEIPT', 'ADJUSTMENT'].includes(String(value.mode)) || !boundedText(value.note, 500) || !value.note.trim() || !boundedText(value.fileName, 1000) || !record(value.results) || !boundedText(value.pendingProductId, 200) || !value.preview.products.some(product => product.productId === value.pendingProductId)) return false
  const entries = Object.entries(value.results)
  if (entries.length > value.preview.rows.length) return false
  for (const [key, result] of entries) {
    if (!validResult(result) || key !== String(result.rowNumber) || result.productId === value.pendingProductId || !value.preview.products.some(product => product.productId === result.productId && product.rowNumbers.includes(result.rowNumber))) return false
  }
  const results = value.results
  return value.preview.products.every(product => {
    const group = product.rowNumbers.map(rowNumber => results[rowNumber])
    return group.every(row => row === undefined) || group.every(row => validResult(row) && row.status === 'error') || group.every(row => validResult(row) && row.status !== 'error')
  })
}

function sourceRows(sheet: WarehouseImportSheet | undefined): { rows: WarehouseImportSourceRow[]; error: string } {
  if (!sheet) return { rows: [], error: '' }
  const first = sheet.rows.find(row => row.cells.some(cell => cell.text.trim() || cell.error))
  if (!first) return { rows: [], error: 'برگهٔ انتخاب‌شده خالی است.' }
  if (first.cells.some(cell => cell.error)) return { rows: [], error: 'ردیف عنوان ستون‌ها خطای سلول دارد؛ عنوان‌های قالب را بدون فرمول نگه دارید.' }
  const positions: Record<string, number> = {}
  for (const [key, names] of Object.entries(columns)) {
    const found = first.cells.flatMap((cell, index) => names.includes(header(cell.text)) ? [index] : [])
    if (found.length !== 1) return { rows: [], error: 'عنوان ستون‌ها باید فقط یک بار شامل «کد محصول»، «سایز»، «رنگ» و «تعداد» باشد. از فایل قالب استفاده کنید.' }
    positions[key] = found[0]
  }
  const rows = sheet.rows.filter(row => row.rowNumber > first.rowNumber && row.cells.some(cell => cell.text.trim() || cell.error)).map(row => {
    const cell = (key: keyof typeof columns) => row.cells[positions[key]] ?? { text: '' }
    const errors = row.cells.map(cell => cell.error).filter(Boolean)
    if (cell('code').numeric) errors.push('کد محصول باید در اکسل به صورت متن ذخیره شود؛ صفرهای ابتدایی ممکن است حذف شده باشند.')
    return { rowNumber: row.rowNumber, code: cell('code').text, size: cell('size').text, color: cell('color').text, quantity: cell('quantity').text, ...(errors.length ? { sourceError: errors.join('؛ ') } : {}) }
  })
  return { rows, error: rows.length > MAX_WAREHOUSE_IMPORT_ROWS ? 'فایل بیش از ۱۰۰۰ ردیف داده دارد؛ آن را به فایل‌های کوچک‌تر تقسیم کنید.' : rows.length ? '' : 'برگهٔ انتخاب‌شده ردیف داده ندارد. قالب را تکمیل و دوباره انتخاب کنید.' }
}

class RequestError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message) }
}

export default function WarehouseImport(props: Props) {
  const { session } = useAppSession()
  const userId = session?.user.id
  if (!userId) return props.open ? <section className={styles.panel} role="status">در حال بررسی حساب مدیر برای ورود گروهی…</section> : null
  return <WarehouseImportContent key={userId} {...props} userId={userId} />
}

function WarehouseImportContent({ open, disabled = false, onClose, onRecovery, onBusyChange, onCompleted, userId }: Props & { userId: string }) {
  const storageKey = `${recoveryKey}:${encodeURIComponent(userId)}`
  const [entryMethod, setEntryMethod] = useState<EntryMethod>('manual')
  const [manualRows, setManualRows] = useState<WarehouseImportSourceRow[]>([])
  const [manualReset, setManualReset] = useState(0)
  const [sheets, setSheets] = useState<WarehouseImportSheet[]>([])
  const [sheetIndex, setSheetIndex] = useState(0)
  const [fileName, setFileName] = useState('')
  const [priorSuccessCount, setPriorSuccessCount] = useState(0)
  const [mode, setMode] = useState<WarehouseImportMode>('RECEIPT')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<WarehouseImportPreview | null>(null)
  const [results, setResults] = useState<Record<number, WarehouseImportResult>>({})
  const [pendingProductId, setPendingProductId] = useState('')
  const [runStarted, setRunStarted] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<'upload' | 'preview' | 'confirm' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState(1)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const mounted = useRef(true)
  const lock = useRef(false)
  const pending = useRef('')
  const controller = useRef<AbortController | null>(null)
  const revision = useRef(0)
  const callbacks = useRef({ onBusyChange, onCompleted, onRecovery })
  useEffect(() => { callbacks.current = { onBusyChange, onCompleted, onRecovery } }, [onBusyChange, onCompleted, onRecovery])
  const source = entryMethod === 'manual' ? { rows: manualRows, error: '' } : sourceRows(sheets[sheetIndex])
  const locked = !!busy || !!pendingProductId || runStarted || disabled
  const successful = Object.values(results).filter(row => row.status !== 'error').length
  const failed = Object.values(results).filter(row => row.status === 'error').length
  const remaining = preview?.products.filter(product => product.rowNumbers.some(rowNumber => !results[rowNumber])) ?? []
  const remainingCount = remaining.reduce((total, product) => total + product.rowNumbers.length, 0)
  const visibleRows = preview?.rows.slice((page - 1) * 25, page * 25) ?? []
  const pages = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / 25))

  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => {
      try {
        const raw = sessionStorage.getItem(storageKey)
        if (!raw) return
        if (raw.length > maxRecoveryChars) { sessionStorage.removeItem(storageKey); return }
        const saved: unknown = JSON.parse(raw)
        if (!validRecovery(saved)) { sessionStorage.removeItem(storageKey); return }
        setPreview(saved.preview); setMode(saved.mode); setNote(saved.note); setFileName(saved.fileName); setResults(saved.results ?? {}); setEntryMethod(saved.entryMethod ?? 'excel')
        pending.current = saved.pendingProductId; setPendingProductId(saved.pendingProductId); setRunStarted(true)
        setError('پاسخ آخرین ثبت مشخص نیست. برای بررسی نتیجه، همان عملیات را دوباره پیگیری کنید؛ هیچ ثبت تازه‌ای خودکار انجام نمی‌شود.')
        callbacks.current.onBusyChange(true); callbacks.current.onRecovery()
      } catch { try { sessionStorage.removeItem(storageKey) } catch { /* A damaged local draft never authorizes a stock change. */ } }
    }, 0)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current || lock.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { clearTimeout(timer); mounted.current = false; controller.current?.abort(); window.removeEventListener('beforeunload', beforeUnload); callbacks.current.onBusyChange(false) }
  }, [storageKey])

  async function request(url: string, body: FormData | Record<string, unknown>, mutation = false) {
    const active = new AbortController()
    controller.current?.abort(); controller.current = active
    const timeout = setTimeout(() => active.abort(), 60000)
    try {
      const response = await fetch(url, { method: 'POST', cache: 'no-store', body: body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, signal: active.signal })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new RequestError(data?.error || 'درخواست انجام نشد؛ دوباره تلاش کنید.', mutation && response.status >= 500)
      if (!data || active.signal.aborted) throw new RequestError('پاسخ کامل سرور دریافت نشد.', mutation)
      return data
    } catch (cause) {
      if (cause instanceof RequestError) throw cause
      throw new RequestError(active.signal.aborted ? 'پاسخ سرور در زمان مقرر دریافت نشد.' : 'ارتباط با سرور برقرار نشد.', mutation)
    } finally { clearTimeout(timeout); if (controller.current === active) controller.current = null }
  }

  const invalidate = useCallback(() => { revision.current++; setPreview(null); setResults({}); setAcknowledged(false); setError(''); setNotice(''); setPage(1) }, [])
  const onManualRowsChange = useCallback((rows: WarehouseImportSourceRow[]) => {
    if (lock.current || pending.current || runStarted || disabled || !open || entryMethod !== 'manual') return
    setManualRows(rows); invalidate()
  }, [runStarted, disabled, open, entryMethod, invalidate])
  function changeEntryMethod(value: EntryMethod) {
    if (lock.current || pending.current || runStarted || disabled || value === entryMethod) return
    setEntryMethod(value); invalidate()
  }
  function begin(stage: 'upload' | 'preview' | 'confirm') { lock.current = true; setBusy(stage); callbacks.current.onBusyChange(true) }
  function finish() { lock.current = false; if (mounted.current) { setBusy(null); callbacks.current.onBusyChange(!!pending.current) } }
  function clearRecovery() { try { sessionStorage.removeItem(storageKey) } catch { /* The operation result remains visible in this panel. */ } }

  async function upload(file?: File) {
    if (!file || entryMethod !== 'excel' || lock.current || pending.current || runStarted || disabled) return
    invalidate(); setSheets([]); setFileName(''); setSheetIndex(0)
    if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > MAX_WAREHOUSE_IMPORT_FILE_BYTES) { setError('یک فایل xlsx با حداکثر حجم ۴ مگابایت انتخاب کنید.'); return }
    begin('upload'); const currentRevision = revision.current
    try {
      const form = new FormData(); form.set('file', file)
      const data = await request('/api/admin/inventory/import/workbook', form)
      if (!validSheets(data.sheets)) throw new Error('فایل، برگهٔ قابل خواندن ندارد یا پاسخ آن کامل نیست.')
      if (mounted.current && currentRevision === revision.current) { setSheets(data.sheets); setFileName(file.name) }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'خواندن فایل انجام نشد.') }
    finally { finish() }
  }

  async function makePreview(event: FormEvent) {
    event.preventDefault()
    if (lock.current || pending.current || runStarted || disabled) return
    invalidate()
    if (!note.trim()) { setError('علت یا توضیح مشترک همهٔ ردیف‌ها را بنویسید.'); return }
    if (source.error || !source.rows.length) { setError(source.error || (entryMethod === 'manual' ? 'ابتدا محصول را انتخاب و ردیف‌های موجودی را تکمیل کنید.' : 'ابتدا فایل اکسل را انتخاب کنید.')); return }
    begin('preview'); const currentRevision = revision.current
    try {
      const data: unknown = await request('/api/admin/inventory/import/preview', { mode, note: note.trim(), rows: source.rows })
      if (!validPreview(data)) throw new Error('پیش‌نمایش کامل دریافت نشد. دوباره بررسی کنید.')
      if (mounted.current && currentRevision === revision.current) setPreview(data)
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'پیش‌نمایش دریافت نشد.') }
    finally { finish() }
  }

  async function confirmGroups(retry = false, continueRun = false) {
    if (lock.current || disabled || !preview || (!retry && ((!continueRun && (runStarted || !acknowledged)) || pending.current))) return
    const groups = retry ? preview.products.filter(product => product.productId === pending.current) : remaining
    if (!groups.length) return
    if (!retry && previewExpired(preview.expiresAt)) { setError('مهلت پیش‌نمایش تمام شده است. دوباره پیش‌نمایش بگیرید.'); return }
    begin('confirm'); setRunStarted(true); setError(''); setNotice(''); setProgress({ done: 0, total: groups.length })
    let nextResults = { ...results }, completed = 0, changed = false
    try {
      for (const product of groups) {
        if (!mounted.current) break
        const recovery: Recovery = { version: 1, preview, mode, note, fileName, entryMethod, results: nextResults, pendingProductId: product.productId }
        // Persist before dispatch so a lost response or page reload can only retry this exact signed operation.
        try { sessionStorage.setItem(storageKey, JSON.stringify(recovery)) }
        catch { setError('مرورگر نتوانست اطلاعات بازیابی ثبت را نگه دارد. اجازهٔ ذخیره‌سازی این صفحه را فعال کنید و دوباره تلاش کنید.'); break }
        pending.current = product.productId; setPendingProductId(product.productId)
        let groupResults: WarehouseImportResult[]
        try {
          const data = await request('/api/admin/inventory/import/confirm', { token: preview.token, productId: product.productId }, true) as WarehouseImportConfirmation
          if (data.productId !== product.productId || !Array.isArray(data.results) || data.results.some(row => !validResult(row)) || data.results.length !== product.rowNumbers.length || new Set(data.results.map(row => row.rowNumber)).size !== product.rowNumbers.length || data.results.some(row => row.productId !== product.productId || !product.rowNumbers.includes(row.rowNumber)) || (data.results.some(row => row.status === 'error') && data.results.some(row => row.status !== 'error'))) throw new RequestError('پاسخ ثبت کامل نیست؛ نتیجهٔ همین عملیات را دوباره پیگیری کنید.', true)
          groupResults = data.results
        } catch (cause) {
          if (!(cause instanceof RequestError) || cause.uncertain || retry) {
            if (mounted.current) setError(`${cause instanceof Error ? cause.message : 'پاسخ ثبت دریافت نشد.'} نتیجهٔ محصول «${product.productName}» مشخص نیست. پیگیری همان عملیات، ورود کالا را دوباره اعمال نمی‌کند.`)
            break
          }
          groupResults = product.rowNumbers.map(rowNumber => ({ rowNumber, productId: product.productId, variantId: preview.rows.find(row => row.rowNumber === rowNumber)?.variantId ?? '', status: 'error', error: cause.message }))
        }
        for (const row of groupResults) nextResults[row.rowNumber] = row
        changed ||= groupResults.some(row => row.status !== 'error')
        pending.current = ''; clearRecovery()
        if (mounted.current) { setPendingProductId(''); setResults({ ...nextResults }); setProgress({ done: ++completed, total: groups.length }) }
      }
      if (mounted.current && !pending.current && completed === groups.length) setNotice('نتیجهٔ ثبت هر ردیف در جدول مشخص است. ردیف‌های ثبت‌شده قفل هستند؛ برای ادامه فقط ردیف‌های ثبت‌نشده را در ورود تازه وارد کنید.')
    } finally {
      finish()
      if (changed && mounted.current) { try { await callbacks.current.onCompleted() } catch { if (mounted.current) setError('ثبت انجام شد، اما تازه‌سازی فهرست انبار ممکن نشد. فهرست و تاریخچه را تازه‌سازی کنید.') } }
    }
  }

  function reset() {
    if (lock.current || pending.current) return
    if (successful) setPriorSuccessCount(successful)
    invalidate(); clearRecovery(); setSheets([]); setSheetIndex(0); setFileName(''); setManualRows([]); setManualReset(value => value + 1); setNote(''); setRunStarted(false); setProgress({ done: 0, total: 0 })
  }

  function groupLabel(product: WarehouseImportProduct) {
    const rows = product.rowNumbers.map(rowNumber => results[rowNumber])
    return pendingProductId === product.productId ? busy === 'confirm' ? 'در حال ثبت…' : 'نتیجه نامشخص؛ نیاز به پیگیری' : rows.every(Boolean) ? rows.some(row => row.status === 'error') ? 'ثبت نشد' : 'ثبت شد' : 'آمادهٔ ثبت'
  }

  return <section hidden={!open} className={styles.panel} aria-labelledby="warehouse-import-title" dir="rtl">
    <div className={styles.heading}><div><span className={styles.eyebrow}>ورود مستقیم یا فایل اکسل</span><h2 id="warehouse-import-title"><ListPlus size={21} /> ورود گروهی موجودی</h2><p>محصول، رنگ، سایز و تعداد را داخل پنل انتخاب کنید یا فایل اکسل آماده را وارد کنید.</p></div><button type="button" className={styles.close} disabled={!!busy || !!pendingProductId} onClick={onClose} aria-label="بستن ورود گروهی"><X size={19} /></button></div>
    <ol className={styles.steps} aria-label="مراحل ورود گروهی"><li><span>۱</span> ورود اطلاعات</li><li><span>۲</span> بررسی پیش‌نمایش</li><li><span>۳</span> تأیید و ثبت</li></ol>
    <div className={styles.entryMethods} role="group" aria-label="روش ورود اطلاعات">
      <button type="button" aria-pressed={entryMethod === 'manual'} disabled={locked} onClick={() => changeEntryMethod('manual')}><ListPlus size={18} aria-hidden="true" /><span>ورود داخل پنل</span></button>
      <button type="button" aria-pressed={entryMethod === 'excel'} disabled={locked} onClick={() => changeEntryMethod('excel')}><FileSpreadsheet size={18} aria-hidden="true" /><span>فایل اکسل</span></button>
    </div>
    {priorSuccessCount > 0 && <p className={styles.importWarning}><CircleAlert size={17} />{number(priorSuccessCount)} ردیف از عملیات قبلی ثبت شده است. برای ادامه فقط ردیف‌های ثبت‌نشده را وارد یا بارگذاری کنید؛ ثبت دوبارهٔ ردیف‌های موفق در حالت ورود کالا، موجودی آن‌ها را دوباره اضافه می‌کند.</p>}
    <div hidden={entryMethod !== 'manual'}><WarehouseManualEntry key={manualReset} disabled={!!locked || !open || entryMethod !== 'manual'} onChange={onManualRowsChange} /></div>
    <form onSubmit={makePreview}>
      <fieldset disabled={locked} className={styles.fieldset}>
        <div hidden={entryMethod !== 'excel'}>
          <div className={styles.upload}><a href="/api/admin/inventory/import/workbook" className={styles.secondary}><Download size={16} /> دریافت قالب خالی اکسل</a><label className={styles.uploadButton}><Upload size={17} /> انتخاب فایل تکمیل‌شده<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} /></label><span>{fileName || 'xlsx · حداکثر ۴ مگابایت و ۱۰۰۰ ردیف'}</span></div>
          <p className={styles.help}>ستون‌های قالب: کد محصول، سایز، رنگ، تعداد. کد محصول را به صورت متن نگه دارید؛ فرمول و ردیف تکراری قابل ثبت نیست. هر محصول حداکثر ۵۰۰ ردیف دارد.</p>
        </div>
        <div className={styles.settings}>
          {entryMethod === 'excel' && sheets.length > 1 && <label><span>برگهٔ اکسل</span><EnhancedSelect aria-label="برگهٔ اکسل انبار" value={String(sheetIndex)} disabled={locked} onChange={event => { if (locked) return; setSheetIndex(Number(event.target.value)); invalidate() }}>{sheets.map((sheet, index) => <option key={index} value={String(index)}>{sheet.name}</option>)}</EnhancedSelect></label>}
          <label><span>نوع عملیات</span><EnhancedSelect aria-label="نوع ورود گروهی" value={mode} onChange={event => { if (locked) return; setMode(event.target.value as WarehouseImportMode); invalidate() }}><option value="RECEIPT">ورود کالا؛ افزودن به موجودی</option><option value="ADJUSTMENT">اصلاح پس از شمارش؛ موجودی نهایی</option></EnhancedSelect></label>
          <label className={styles.reason}><span>علت یا توضیح مشترک همهٔ ردیف‌ها</span><input required maxLength={500} value={note} onChange={event => { if (locked) return; setNote(event.target.value); invalidate() }} placeholder="مثلاً ورود تولید آبان یا نتیجهٔ شمارش انبار" /></label>
        </div>
        <div className={styles.semantics}><CircleAlert size={18} /><p>{mode === 'ADJUSTMENT' ? <><strong>«تعداد» یعنی موجودی نهایی قابل فروش؛ رزرو سفارش‌ها را در این عدد حساب نکنید.</strong> مثلاً ۸ جفت قابل فروش و ۳ جفت رزرو: برای رسیدن به ۵ جفت قابل فروش، عدد ۵ را وارد کنید. رزروها تغییر نمی‌کنند. صفر مجاز است.</> : <><strong>«تعداد» به موجودی قابل فروش فعلی اضافه می‌شود.</strong> فقط تعداد کالای ورودی را وارد کنید؛ مثلاً ورود ۵ جفت به موجودی ۸ جفت، نتیجهٔ ۱۳ جفت دارد. رزرو سفارش‌ها تغییر نمی‌کند.</>}</p></div>
        {(entryMethod === 'manual' ? !!manualRows.length : !!sheets.length) && <p className={source.error ? styles.error : styles.help}>{source.error || (entryMethod === 'manual' ? `${number(source.rows.length)} ردیف برای بررسی آماده است؛ ردیف‌های ناقص هم در پیش‌نمایش مشخص می‌شوند.` : `${number(source.rows.length)} ردیف از برگهٔ «${sheets[sheetIndex]?.name}» برای بررسی آماده است.`)}</p>}
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked || !source.rows.length || !!source.error}><FileSpreadsheet size={17} />{busy === 'preview' ? 'در حال بررسی…' : 'بررسی و پیش‌نمایش'}</button><span>در این مرحله موجودی تغییر نمی‌کند.</span></div>
      </fieldset>
    </form>
    {busy === 'upload' && <p className={styles.loading} role="status"><LoaderCircle size={17} /> در حال خواندن فایل…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}><Check size={17} />{notice}</p>}
    {preview && <div className={styles.preview}>
      <div className={styles.previewHeading}><h3>پیش‌نمایش پیش از ثبت</h3><p>{number(preview.summary.valid)} ردیف قابل ثبت · {number(preview.summary.invalid)} ردیف خطادار · {number(preview.products.length)} محصول</p></div>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="جدول پیش‌نمایش ورود گروهی"><table className={styles.table}><thead><tr><th>ردیف</th><th>کد / مدل محصول</th><th>رنگ / سایز</th><th>قابل فروش قبل</th><th>رزرو</th><th>معیوب (بدون تغییر)</th><th>{mode === 'ADJUSTMENT' ? 'نهایی قابل فروش' : 'تعداد ورودی'}</th><th>قابل فروش بعد</th><th>وضعیت و نتیجه</th></tr></thead><tbody>{visibleRows.map(row => {
        const result = results[row.rowNumber], unknown = row.productId === pendingProductId, saved = result && result.status !== 'error'
        return <tr key={row.rowNumber} className={row.error || result?.status === 'error' ? styles.invalidRow : saved ? styles.savedRow : undefined}><td>{number(row.rowNumber)}</td><td><bdi dir="ltr">{row.code || '—'}</bdi><small>{row.productName || 'محصول شناسایی نشد'}</small></td><td>{row.color || '—'}<small>سایز {number(row.size)}</small></td><td>{number(result?.stockBefore ?? row.stockBefore)}</td><td>{number(row.reserved)}</td><td>{number(row.damaged)}</td><td><strong>{number(row.quantity)}</strong></td><td><strong>{number(result?.stockAfter ?? row.stockAfter)}</strong></td><td className={styles.rowStatus}>{row.error ? <span className={styles.danger}>قابل ثبت نیست: {row.error}</span> : result ? result.status === 'error' ? <span className={styles.danger}>ثبت نشد: {result.error}</span> : <span className={styles.success}><Check size={14} />{result.status === 'replayed' ? 'قبلاً ثبت شده؛ دوباره اعمال نشد' : 'ثبت شد؛ قفل‌شده'}</span> : unknown ? <span className={styles.warning}>{busy === 'confirm' ? 'در حال ثبت…' : 'نتیجه نامشخص؛ پیگیری لازم است'}</span> : <span>آمادهٔ ثبت</span>}{row.warning && <small className={styles.warning}>{row.warning}</small>}{row.isActive === false && !row.warning && <small className={styles.warning}>تنوع غیرفعال است؛ این ورود آن را فعال نمی‌کند.</small>}</td></tr>
      })}</tbody></table></div>
      {pages > 1 && <nav className={styles.pagination} aria-label="صفحه‌های پیش‌نمایش موجودی"><button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>قبلی</button><span>{number(page)} از {number(pages)}</span><button type="button" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>بعدی <ArrowLeft size={14} /></button></nav>}
      <details className={styles.groups}><summary>وضعیت ثبت به تفکیک محصول ({number(preview.products.length)})</summary><ul>{preview.products.map(product => <li key={product.productId}><span><bdi dir="ltr">{product.code}</bdi> · {product.productName} · {number(product.rowNumbers.length)} ردیف</span><strong>{groupLabel(product)}</strong></li>)}</ul></details>
      <p className={styles.help}>ثبت هر محصول یک‌جا انجام می‌شود. خطای ثبت یک رنگ یا سایز، همهٔ ردیف‌های همان محصول را ثبت‌نشده نگه می‌دارد. محصولات به ترتیب ثبت می‌شوند؛ محصولات موفق دوباره ثبت نمی‌شوند.</p>
      {!runStarted && <label className={styles.acknowledgment}><input type="checkbox" checked={acknowledged} disabled={!!busy || disabled || !preview.summary.valid} onChange={event => setAcknowledged(event.target.checked)} /><span>{preview.summary.invalid ? `می‌پذیرم ${number(preview.summary.invalid)} ردیف خطادار ثبت نمی‌شود و فقط ${number(preview.summary.valid)} ردیف معتبرِ پیش‌نمایش ثبت شود.` : `پیش‌نمایش و علت مشترک را بررسی کردم؛ ثبت ${number(preview.summary.valid)} ردیف در ${number(preview.products.length)} محصول را تأیید می‌کنم.`}</span></label>}
      {busy === 'confirm' && <div className={styles.progress} role="status"><progress max={progress.total || 1} value={progress.done} /><span>{number(progress.done)} از {number(progress.total)} محصول بررسی شد؛ لطفاً صفحه را باز نگه دارید.</span></div>}
      <div className={styles.confirmActions}>{pendingProductId && busy !== 'confirm' ? <button type="button" className={styles.primary} disabled={!!busy || disabled} onClick={() => void confirmGroups(true)}>پیگیری دوبارهٔ همان عملیات</button> : !runStarted ? <button type="button" className={styles.primary} disabled={!!busy || disabled || !acknowledged || !preview.summary.valid} onClick={() => void confirmGroups()}><Check size={17} /> تأیید و ثبت {number(preview.summary.valid)} ردیف معتبر</button> : null}{runStarted && !busy && !pendingProductId && remaining.length > 0 && <button type="button" className={styles.primary} disabled={disabled} onClick={() => void confirmGroups(false, true)}>تأیید و ادامهٔ ثبت {number(remainingCount)} ردیف باقیمانده</button>}{!busy && !pendingProductId && <button type="button" className={styles.secondary} onClick={reset}>پاک‌کردن و شروع ورود تازه</button>}</div>
      {runStarted && <p className={styles.help}>{number(successful)} ردیف ثبت‌شده · {number(failed)} ردیف ثبت‌نشده{pendingProductId ? '؛ تا روشن‌شدن نتیجه، اطلاعات عملیات قفل می‌ماند.' : '؛ برای ادامه فقط ردیف‌های ثبت‌نشده را دوباره وارد کنید. ثبت دوبارهٔ ردیف‌های موفق در حالت ورود کالا، موجودی آن‌ها را دوباره اضافه می‌کند.'}</p>}
    </div>}
  </section>
}
