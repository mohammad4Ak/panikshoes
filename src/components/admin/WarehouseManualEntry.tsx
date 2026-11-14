'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Plus, Search, Trash2 } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import { integerInputError, parseIntegerInput, toAsciiDigits } from '@/lib/localized-input'
import { MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS, MAX_WAREHOUSE_IMPORT_ROWS, type WarehouseImportSourceRow } from '@/lib/warehouse-import-contract'
import styles from './warehouse-manual-entry.module.css'

type Variant = { id: string; size: number; color: string; stock: number; isActive: boolean }
type Product = { id: string; code: string; name: string; variants: Variant[]; variantsTruncated: boolean }
type Pagination = { page: number; pages: number; total: number; pageSize: number }
type Lookup = { status: 'loading' | 'ready' | 'error'; products: Product[]; pagination: Pagination | null; error: string; revision: number }
type Entry = { id: number; product: Product; color: string; size: string; quantity: string }
type Props = { disabled?: boolean; onChange: (rows: WarehouseImportSourceRow[]) => void }

const number = (value: number) => value.toLocaleString('fa-IR')
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= maximum
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647
const normalizedColor = (value: string) => toAsciiDigits(value.normalize('NFKC')).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\s\u200c]+/g, ' ').trim()
const rowKey = (row: Entry) => row.color && row.size ? JSON.stringify([row.product.id, normalizedColor(row.color), row.size]) : ''
const matchingVariants = (row: Entry) => row.product.variants.filter(variant => variant.color === row.color && String(variant.size) === row.size)

function validLookup(value: unknown): value is { products: Product[]; pagination: Pagination } {
  if (!object(value) || !Array.isArray(value.products) || value.products.length > 20 || !object(value.pagination)) return false
  const pagination = value.pagination
  if (!integer(pagination.page, 1) || !integer(pagination.pages, 1) || !integer(pagination.total) || pagination.pageSize !== 20 || pagination.page > pagination.pages || value.products.length > pagination.total) return false
  const ids = new Set<string>()
  return value.products.every(product => {
    if (!object(product) || !text(product.id, 200) || ids.has(product.id) || !text(product.code, 250) || !text(product.name, 500) || typeof product.variantsTruncated !== 'boolean' || !Array.isArray(product.variants) || product.variants.length > 500) return false
    ids.add(product.id)
    const variantIds = new Set<string>()
    return product.variants.every(variant => {
      if (!object(variant) || !text(variant.id, 200) || variantIds.has(variant.id) || !integer(variant.size, 1) || !text(variant.color, 100) || !integer(variant.stock) || typeof variant.isActive !== 'boolean') return false
      variantIds.add(variant.id)
      return true
    })
  })
}

function sourceRows(rows: Entry[]): WarehouseImportSourceRow[] {
  const counts = new Map<string, number>()
  for (const row of rows) { const key = rowKey(row); if (key) counts.set(key, (counts.get(key) ?? 0) + 1) }
  return rows.map((row, index) => {
    const errors: string[] = []
    if (!row.color) errors.push('رنگ را انتخاب کنید.')
    if (!row.size) errors.push('سایز را انتخاب کنید.')
    if (row.color && row.size && matchingVariants(row).length !== 1) errors.push('ترکیب رنگ و سایز یکتا نیست؛ اطلاعات تنوع محصول را بررسی کنید.')
    const quantityError = integerInputError(row.quantity, true, 0, 2_147_483_647)
    if (quantityError) errors.push(quantityError)
    if ((counts.get(rowKey(row)) ?? 0) > 1) errors.push('این رنگ و سایز محصول تکراری است؛ فقط یک ردیف نگه دارید.')
    return { rowNumber: index + 1, code: row.product.code, color: row.color, size: row.size, quantity: row.quantity, ...(errors.length ? { sourceError: errors.join(' ') } : {}) }
  })
}

export default function WarehouseManualEntry({ disabled = false, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [attempt, setAttempt] = useState(0)
  const [lookup, setLookup] = useState<Lookup>({ status: 'loading', products: [], pagination: null, error: '', revision: 0 })
  const [entries, setEntries] = useState<Entry[]>([])
  const [entryError, setEntryError] = useState('')
  const mounted = useRef(false)
  const blocked = useRef(disabled)
  const callback = useRef(onChange)
  const rows = useRef<Entry[]>([])
  const nextId = useRef(1)
  const revision = useRef(0)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => { callback.current = onChange; blocked.current = disabled }, [onChange, disabled])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])

  useEffect(() => {
    if (disabled) return
    const active = new AbortController(), currentRevision = ++revision.current
    controller.current?.abort(); controller.current = active
    let timeout: ReturnType<typeof setTimeout> | undefined, timedOut = false
    const current = () => mounted.current && !blocked.current && revision.current === currentRevision
    const timer = setTimeout(async () => {
      if (!current()) return
      setLookup({ status: 'loading', products: [], pagination: null, error: '', revision: currentRevision })
      timeout = setTimeout(() => { timedOut = true; active.abort() }, 15000)
      try {
        const response = await fetch(`/api/admin/inventory/import/products?q=${encodeURIComponent(query.trim())}&page=${page}`, { cache: 'no-store', signal: active.signal })
        const data: unknown = await response.json()
        if (!current() || active.signal.aborted) return
        if (!response.ok) throw new Error(object(data) && text(data.error, 500) ? data.error : 'دریافت محصولات انجام نشد. دوباره تلاش کنید.')
        if (!validLookup(data)) throw new Error('فهرست کامل محصولات دریافت نشد. دوباره تلاش کنید.')
        if (data.pagination.page !== page) {
          setLookup({ status: 'loading', products: [], pagination: null, error: '', revision: currentRevision })
          setPage(data.pagination.page)
          return
        }
        setLookup({ status: 'ready', products: data.products, pagination: data.pagination, error: '', revision: currentRevision })
      } catch (cause) {
        if (current() && (!active.signal.aborted || timedOut)) setLookup({ status: 'error', products: [], pagination: null, error: timedOut ? 'پاسخ جست‌وجو در زمان مقرر دریافت نشد. دوباره تلاش کنید.' : cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.', revision: currentRevision })
      } finally {
        clearTimeout(timeout)
        if (controller.current === active) controller.current = null
      }
    }, 300)
    return () => { clearTimeout(timer); clearTimeout(timeout); active.abort(); if (controller.current === active) controller.current = null }
  }, [query, page, attempt, disabled])

  function resetSearch() {
    revision.current++; controller.current?.abort()
    setLookup({ status: 'loading', products: [], pagination: null, error: '', revision: 0 })
  }

  function changeRows(next: Entry[]) {
    if (!mounted.current || blocked.current) return
    rows.current = next; setEntries(next); setEntryError(''); callback.current(sourceRows(next))
  }

  function addProduct(product: Product, resultRevision: number) {
    if (!mounted.current || blocked.current || resultRevision !== revision.current || !product.variants.length) return
    if (rows.current.length >= MAX_WAREHOUSE_IMPORT_ROWS) { setEntryError('حداکثر ۱۰۰۰ ردیف در هر ورود مجاز است. برای ادامه، ورود تازه‌ای بسازید.'); return }
    if (rows.current.filter(row => row.product.id === product.id).length >= MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS) { setEntryError('هر محصول حداکثر ۵۰۰ ردیف در هر ورود داشته باشد.'); return }
    changeRows([...rows.current, { id: nextId.current++, product, color: '', size: '', quantity: '' }])
  }

  function editRow(id: number, field: 'color' | 'size' | 'quantity', value: string) {
    if (!mounted.current || blocked.current) return
    const row = rows.current.find(entry => entry.id === id)
    if (!row || row[field] === value) return
    if (field === 'color' && value && !row.product.variants.some(variant => variant.color === value)) return
    if (field === 'size' && value && !row.product.variants.some(variant => variant.color === row.color && String(variant.size) === value)) return
    if (field === 'quantity') { const canonical = parseIntegerInput(value); if (canonical === null) return; value = canonical }
    changeRows(rows.current.map(entry => entry.id !== id ? entry : { ...entry, [field]: value, ...(field === 'color' ? { size: '', quantity: '' } : field === 'size' ? { quantity: '' } : {}) }))
  }

  const source = sourceRows(entries)
  return <div className={styles.editor} dir="rtl">
    <div className={styles.searchPanel}>
      <label className={styles.searchLabel}><span>جست‌وجوی محصول با نام یا کد</span><span className={styles.searchField}><Search size={17} aria-hidden="true" /><input type="search" value={query} maxLength={120} disabled={disabled} autoComplete="off" placeholder="مثلاً نام مدل یا PN-001" aria-label="جست‌وجوی محصول برای ورود دستی" onChange={event => { if (blocked.current) return; resetSearch(); setQuery(event.target.value); setPage(1) }} /></span></label>
      <p className={styles.help}>برای هر رنگ و سایز یک ردیف اضافه کنید. نام و کد محصول ثابت است؛ ابتدا رنگ، سپس سایز و تعداد را انتخاب کنید.</p>
      {!disabled && lookup.status === 'loading' && <p className={styles.loading} role="status"><LoaderCircle size={16} /> در حال جست‌وجوی محصولات…</p>}
      {lookup.status === 'error' && <div className={styles.error} role="alert"><span>{lookup.error}</span><button type="button" disabled={disabled} onClick={() => { if (blocked.current) return; resetSearch(); setAttempt(value => value + 1) }}>تلاش دوباره</button></div>}
      {lookup.status === 'ready' && <>
        <p className={styles.resultCount} role="status">{lookup.pagination?.total ? `${number(lookup.pagination.total)} محصول پیدا شد؛ افزودن ردیف، موجودی را تغییر نمی‌دهد.` : 'محصولی با این نام یا کد پیدا نشد. نام یا کد دیگری را جست‌وجو کنید.'}</p>
        {!!lookup.products.length && <ul className={styles.results} aria-label="نتیجه‌های جست‌وجوی محصول">{lookup.products.map(product => <li key={product.id}>
          <div className={styles.product}><strong>{product.name}</strong><bdi dir="ltr">{product.code}</bdi>{product.variantsTruncated && <small className={styles.warning}>۵۰۰ تنوع نخست نمایش داده می‌شود؛ برای تنوع‌های بیشتر از ورود اکسل استفاده کنید.</small>}{!product.variants.length && <small className={styles.warning}>این محصول رنگ و سایز تعریف‌شده ندارد.</small>}</div>
          <button type="button" className={styles.add} disabled={disabled || !product.variants.length || entries.length >= MAX_WAREHOUSE_IMPORT_ROWS || entries.filter(row => row.product.id === product.id).length >= MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS} aria-label={`افزودن ردیف برای ${product.name}، کد ${product.code}`} onClick={() => addProduct(product, lookup.revision)}><Plus size={15} /> افزودن ردیف</button>
        </li>)}</ul>}
        {lookup.pagination && lookup.pagination.pages > 1 && <nav className={styles.pagination} aria-label="صفحه‌های جست‌وجوی محصولات"><button type="button" disabled={disabled || page <= 1} onClick={() => { if (blocked.current || page <= 1) return; resetSearch(); setPage(value => value - 1) }}><ChevronRight size={14} /> قبلی</button><span>{number(page)} از {number(lookup.pagination.pages)}</span><button type="button" disabled={disabled || page >= lookup.pagination.pages} onClick={() => { if (blocked.current || !lookup.pagination || page >= lookup.pagination.pages) return; resetSearch(); setPage(value => value + 1) }}>بعدی <ChevronLeft size={14} /></button></nav>}
      </>}
    </div>
    <div className={styles.tableHeading}><h3>جدول ورود دستی</h3><span>{number(entries.length)} از ۱۰۰۰ ردیف</span></div>
    {entryError && <p className={styles.error} role="alert">{entryError}</p>}
    {!entries.length ? <p className={styles.empty}>محصول را در بالا پیدا کنید و «افزودن ردیف» را بزنید؛ سپس رنگ، سایز و تعداد را در همین جدول وارد کنید.</p> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="جدول ویرایش ورود دستی انبار"><table className={styles.table}><thead><tr><th>ردیف</th><th>محصول / کد</th><th>رنگ</th><th>سایز</th><th>تعداد</th><th>وضعیت ردیف</th><th>حذف</th></tr></thead><tbody>{entries.map((row, index) => {
      const colors = [...new Set(row.product.variants.map(variant => variant.color))]
      const sizes = [...new Set(row.product.variants.filter(variant => variant.color === row.color).map(variant => variant.size))].sort((a, b) => a - b)
      const variants = matchingVariants(row), variant = variants.length === 1 ? variants[0] : undefined
      const rowError = source[index].sourceError, errorId = `warehouse-manual-row-${row.id}-error`
      return <tr key={row.id} className={rowError ? styles.invalidRow : undefined}>
        <td data-label="ردیف">{number(index + 1)}</td>
        <td data-label="محصول / کد" className={styles.productCell}><strong>{row.product.name}</strong><bdi dir="ltr">{row.product.code}</bdi>{row.product.variantsTruncated && <small className={styles.warning}>۵۰۰ تنوع نخست؛ سایر تنوع‌ها را با اکسل وارد کنید.</small>}</td>
        <td data-label="رنگ"><EnhancedSelect aria-label={`رنگ ردیف ${number(index + 1)}`} disabled={disabled} value={row.color} onChange={event => editRow(row.id, 'color', event.target.value)}><option value="">انتخاب رنگ</option>{colors.map(color => <option key={color} value={color}>{color === '-' ? 'بدون رنگ' : color}</option>)}</EnhancedSelect></td>
        <td data-label="سایز"><EnhancedSelect aria-label={`سایز ردیف ${number(index + 1)}`} disabled={disabled || !row.color} value={row.size} onChange={event => editRow(row.id, 'size', event.target.value)}><option value="">{row.color ? 'انتخاب سایز' : 'ابتدا رنگ'}</option>{sizes.map(size => <option key={size} value={String(size)}>{number(size)}</option>)}</EnhancedSelect></td>
        <td data-label="تعداد"><FormattedNumberInput aria-label={`تعداد ردیف ${number(index + 1)}`} aria-describedby={rowError ? errorId : undefined} aria-invalid={!!rowError} disabled={disabled} className={styles.quantity} value={row.quantity} maxLength={18} min={0} max={2_147_483_647} placeholder="تعداد جفت" onValueChange={value => editRow(row.id, 'quantity', value)} /></td>
        <td data-label="وضعیت ردیف" className={styles.rowStatus}>{rowError ? <p id={errorId} className={styles.danger}>{rowError}</p> : <span>آمادهٔ بررسی</span>}{variant && <small>موجودی فعلی: {number(variant.stock)} جفت</small>}{variant?.isActive === false && <small className={styles.warning}><CircleAlert size={13} /> این تنوع غیرفعال است؛ ثبت موجودی آن را فعال نمی‌کند.</small>}</td>
        <td data-label="حذف"><button type="button" disabled={disabled} className={styles.remove} aria-label={`حذف ردیف ${number(index + 1)}`} onClick={() => changeRows(rows.current.filter(entry => entry.id !== row.id))}><Trash2 size={16} /></button></td>
      </tr>
    })}</tbody></table></div>}
    {!!entries.length && <p className={styles.help}>تغییر رنگ، سایز و تعداد همان ردیف را پاک می‌کند؛ تغییر سایز هم تعداد را پاک می‌کند. ردیف‌های ناقص یا تکراری در پیش‌نمایش خطا خواهند داشت. موجودی فعلی صرفاً راهنماست؛ مقدار نهایی در پیش‌نمایش دوباره بررسی می‌شود.</p>}
  </div>
}
