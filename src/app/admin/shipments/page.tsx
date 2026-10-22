'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Check, Download, FileSpreadsheet, PackageCheck, Truck, Upload, ArrowLeft, ArrowRight } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import admin from '@/components/admin/admin.module.css'
import styles from './shipments.module.css'

type Cell = { text: string; error?: string }
type Sheet = { name: string; columnCount: number; rows: { rowNumber: number; cells: Cell[] }[] }
type Source = { rowNumber: number; matchValue: string; trackingCode: string; orderReference?: string; sourceError?: string }
type Candidate = { id: string; recipientName: string; phone: string; postalCode: string | null; status: string; trackingCode: string | null; updatedAt: string; createdAt: string; shippingMethodName: string | null; total: number }
type PreviewRow = Source & { candidates: Candidate[]; error?: string }
type Preview = { rows: PreviewRow[]; token: string; expiresAt: string }
type Choice = { selected: boolean; orderId: string; overwrite: boolean }
type Result = { rowNumber: number; orderId: string; status: 'saved' | 'unchanged' | 'error'; error?: string }
const number = (value: number) => value.toLocaleString('fa-IR')
const date = (value: string) => new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'Asia/Tehran' }).format(new Date(value))
const columnName = (index: number) => { let name = '', n = index + 1; while (n) { n--; name = String.fromCharCode(65 + n % 26) + name; n = Math.floor(n / 26) } return name }

async function request(url: string, body: FormData | Record<string, unknown>, timeoutMs = 60000) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, signal: controller.signal })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error || 'درخواست انجام نشد؛ دوباره تلاش کنید.')
    return data
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('پاسخ سرور دریافت نشد؛ وضعیت را دوباره بررسی کنید. تکرار ثبت همان پیش‌نمایش، ارسال را دوباره ثبت نمی‌کند.')
    throw error
  } finally { clearTimeout(timeout) }
}

function ShipmentContent() {
  const search = useSearchParams(), linkedOrder = search.get('orderId') ?? ''
  const [mode, setMode] = useState<'file' | 'manual'>(linkedOrder ? 'manual' : 'file')
  const [matchBy, setMatchBy] = useState<'phone' | 'postalCode'>('phone')
  const [markShipped, setMarkShipped] = useState(false)
  const [sheets, setSheets] = useState<Sheet[]>([]), [sheetIndex, setSheetIndex] = useState(0)
  const [mapping, setMapping] = useState({ headerRow: '1', matchColumn: '', trackingColumn: '', orderColumn: '' })
  const [overrides, setOverrides] = useState<Record<number, Partial<Source>>>({})
  const [excluded, setExcluded] = useState<Record<number, boolean>>({})
  const [sourcePage, setSourcePage] = useState(1), [previewPage, setPreviewPage] = useState(1)
  const [fileName, setFileName] = useState('')
  const [manual, setManual] = useState({ matchValue: '', trackingCode: '', orderReference: linkedOrder })
  const [preview, setPreview] = useState<Preview | null>(null), [choices, setChoices] = useState<Record<number, Choice>>({})
  const [results, setResults] = useState<Record<number, Result>>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const writeLock = useRef(false), previewRef = useRef<HTMLElement>(null)
  const sheet = sheets[sheetIndex]

  useEffect(() => {
    if (!linkedOrder) return
    let active = true
    fetch(`/api/admin/shipments/order?id=${encodeURIComponent(linkedOrder)}`, { cache: 'no-store' }).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'سفارش پیدا نشد.')
      if (active) {
        setManual({ matchValue: data.order.phone, trackingCode: data.order.trackingCode ?? '', orderReference: data.order.id })
        if (data.order.status === 'PROCESSING') setNotice('این سفارش در حال پردازش است. اگر آن را تحویل شرکت حمل داده‌ای، گزینهٔ تغییر به «ارسال‌شده» را فعال کن.')
      }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'دریافت سفارش انجام نشد.') })
    return () => { active = false }
  }, [linkedOrder])

  function resetPreview() { setPreview(null); setChoices({}); setResults({}); setError(''); setNotice('') }
  function configureSheet(next: Sheet | undefined) {
    const header = next?.rows[0]
    const find = (pattern: RegExp) => { const index = header?.cells.findIndex(cell => pattern.test(cell.text)) ?? -1; return index < 0 ? '' : String(index) }
    setMapping({ headerRow: String(header?.rowNumber ?? 1), matchColumn: find(matchBy === 'phone' ? /تلفن|همراه|موبایل|phone|mobile/i : /کد\s*پستی|postal|zip/i), trackingColumn: find(/رهگیری|مرسوله|بارکد|tracking|barcode/i), orderColumn: find(/سفارش|order/i) })
    setOverrides({}); setExcluded({}); setSourcePage(1); resetPreview()
  }
  const sourceRows = useMemo(() => {
    if (!sheet || mapping.matchColumn === '' || mapping.trackingColumn === '') return []
    return sheet.rows.filter(row => row.rowNumber > Number(mapping.headerRow)).map(row => {
      const edits = overrides[row.rowNumber] ?? {}
      const matchCell = row.cells[Number(mapping.matchColumn)] ?? { text: '' }, trackingCell = row.cells[Number(mapping.trackingColumn)] ?? { text: '' }
      const orderCell = mapping.orderColumn === '' ? { text: '' } : row.cells[Number(mapping.orderColumn)] ?? { text: '' }
      return { rowNumber: row.rowNumber, matchValue: edits.matchValue ?? matchCell.text, trackingCode: edits.trackingCode ?? trackingCell.text, orderReference: edits.orderReference ?? orderCell.text,
        sourceError: (edits.matchValue === undefined ? matchCell.error : '') || (edits.trackingCode === undefined ? trackingCell.error : '') || (edits.orderReference === undefined ? orderCell.error : '') }
    }).filter(row => row.matchValue || row.trackingCode || row.sourceError)
  }, [sheet, mapping, overrides])
  const includedRows = sourceRows.filter(row => !excluded[row.rowNumber])
  const pageRows = sourceRows.slice((sourcePage - 1) * 50, sourcePage * 50)
  const previewRows = preview?.rows.slice((previewPage - 1) * 25, previewPage * 25) ?? []
  const selectedRows = preview?.rows.filter(row => choices[row.rowNumber]?.selected && choices[row.rowNumber].orderId && !row.error && !['saved', 'unchanged'].includes(results[row.rowNumber]?.status)) ?? []
  const savedCount = Object.values(results).filter(result => result.status === 'saved' || result.status === 'unchanged').length

  async function upload(file?: File) {
    if (!file || writeLock.current) return
    resetPreview()
    if (!/\.xlsx$/i.test(file.name) || file.size > 4 * 1024 * 1024) { setError('یک فایل xlsx با حداکثر حجم ۴ مگابایت انتخاب کنید.'); return }
    writeLock.current = true; setBusy(true)
    try {
      const form = new FormData(); form.set('file', file)
      const data = await request('/api/admin/shipments/workbook', form)
      setSheets(data.sheets); setSheetIndex(0); setFileName(file.name); configureSheet(data.sheets[0])
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'خواندن فایل انجام نشد.') }
    finally { writeLock.current = false; setBusy(false) }
  }

  async function makePreview(event: FormEvent) {
    event.preventDefault()
    if (writeLock.current) return
    resetPreview()
    const rows: Source[] = mode === 'manual' ? [{ ...manual, rowNumber: 1 }] : includedRows
    if (!rows.length || rows.length > 1000) { setError('بین ۱ تا ۱۰۰۰ ردیف انتخاب کنید.'); return }
    const invalid = rows.find(row => row.sourceError)
    if (invalid) { setError(`ردیف ${number(invalid.rowNumber)}: ${invalid.sourceError}`); return }
    writeLock.current = true; setBusy(true)
    try {
      const data: Preview = await request('/api/admin/shipments/preview', { matchBy, markShipped, rows: rows.map(({ rowNumber, matchValue, trackingCode, orderReference }) => ({ rowNumber, matchValue, trackingCode, orderReference })) })
      const initial: Record<number, Choice> = {}
      for (const row of data.rows) {
        const candidate = row.candidates.length === 1 ? row.candidates[0] : undefined
        initial[row.rowNumber] = { orderId: candidate?.id ?? '', selected: !!candidate && !row.error && (!candidate.trackingCode || candidate.trackingCode === row.trackingCode), overwrite: false }
      }
      setPreview(data); setChoices(initial); setPreviewPage(1)
      setTimeout(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'بررسی سفارش‌ها انجام نشد.') }
    finally { writeLock.current = false; setBusy(false) }
  }

  async function confirm() {
    if (writeLock.current || !preview || !selectedRows.length) return
    const seenOrders = new Set<string>(), seenTracking = new Set<string>()
    for (const row of selectedRows) {
      const choice = choices[row.rowNumber], candidate = row.candidates.find(order => order.id === choice.orderId)
      if (seenOrders.has(choice.orderId) || seenTracking.has(row.trackingCode)) { setError('یک سفارش یا کد رهگیری چند بار انتخاب شده است؛ انتخاب‌ها را اصلاح کنید.'); return }
      if (candidate?.trackingCode && candidate.trackingCode !== row.trackingCode && !choice.overwrite) { setError(`جایگزینی کد ردیف ${number(row.rowNumber)} باید تأیید شود.`); return }
      seenOrders.add(choice.orderId); seenTracking.add(row.trackingCode)
    }
    setError(''); setNotice(''); writeLock.current = true; setBusy(true)
    let completed = 0
    try {
      for (let index = 0; index < selectedRows.length; index += 25) {
        const batch = selectedRows.slice(index, index + 25)
        const data: { results: Result[] } = await request('/api/admin/shipments/confirm', { token: preview.token, choices: batch.map(row => ({ rowNumber: row.rowNumber, orderId: choices[row.rowNumber].orderId, overwrite: choices[row.rowNumber].overwrite })) })
        setResults(previous => { const next = { ...previous }; for (const result of data.results) next[result.rowNumber] = result; return next })
        completed += data.results.length
        setNotice(`${number(completed)} ردیف از ${number(selectedRows.length)} ردیف بررسی شد.`)
      }
      setNotice('نتیجهٔ ثبت هر ردیف در فهرست زیر مشخص است. برای موارد ناموفق، اطلاعات را اصلاح و دوباره پیش‌نمایش بگیرید.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ثبت انجام نشد. نتیجهٔ ردیف‌های قبلی را بررسی کنید.') }
    finally { writeLock.current = false; setBusy(false) }
  }

  const edit = (rowNumber: number, key: keyof Pick<Source, 'matchValue' | 'trackingCode' | 'orderReference'>, value: string) => { resetPreview(); setOverrides(previous => ({ ...previous, [rowNumber]: { ...previous[rowNumber], [key]: value } })) }
  const changeMapping = (key: keyof typeof mapping, value: string) => { resetPreview(); setOverrides({}); setExcluded({}); setMapping(previous => ({ ...previous, [key]: value })); setSourcePage(1) }
  const columnOptions = Array.from({ length: sheet?.columnCount ?? 0 }, (_, index) => ({ value: String(index), label: `${columnName(index)} — ${sheet?.rows.find(row => row.rowNumber === Number(mapping.headerRow))?.cells[index]?.text.slice(0, 60) || 'بدون عنوان'}` }))
  return <div className={styles.page}>
    <div className={admin.pageHeader}><div><span className={admin.eyebrow}>پس از تحویل به شرکت حمل</span><h1>رهگیری مرسوله‌ها</h1><p>کدهای رهگیری را از اکسل وارد کن یا برای یک سفارش ثبت کن؛ مشتری آن‌ها را در جزئیات سفارش می‌بیند.</p></div><Link href="/admin/orders" className={admin.headerLink}>مدیریت سفارش‌ها <ArrowLeft size={16} /></Link></div>
    <div className={styles.guide}><Truck size={22} /><div><strong>تطبیق با مشخصات گیرنده در زمان سفارش انجام می‌شود.</strong><p>فقط سفارش‌های با پرداخت تأییدشده قابل انتخاب‌اند. اگر چند سفارش مطابق باشند، انتخاب سفارش با توست. کدپستی سفارش‌های قدیمی که ثبت نشده، قابل تطبیق نیست.</p></div></div>
    <form onSubmit={makePreview} className={styles.panel}>
      <div className={styles.panelHeader}><h2><FileSpreadsheet size={20} /> اطلاعات مرسوله</h2><div className={styles.tabs}><button type="button" disabled={busy} aria-pressed={mode === 'file'} onClick={() => { setMode('file'); resetPreview() }}>فایل اکسل</button><button type="button" disabled={busy} aria-pressed={mode === 'manual'} onClick={() => { setMode('manual'); resetPreview() }}>ثبت تکی</button></div></div>
      <fieldset disabled={busy} className={styles.fieldset}>
        <div className={styles.settings}><label>تطبیق سفارش با<EnhancedSelect value={matchBy} onChange={event => { setMatchBy(event.target.value as typeof matchBy); setMapping(previous => ({ ...previous, matchColumn: '' })); setOverrides({}); resetPreview() }}><option value="phone">شماره تلفن گیرنده</option><option value="postalCode">کدپستی گیرنده</option></EnhancedSelect></label>
          <label className={styles.checkbox}><input type="checkbox" checked={markShipped} onChange={event => { setMarkShipped(event.target.checked); resetPreview() }} /><span>مرسوله‌ها تحویل شرکت حمل شده‌اند؛ سفارش «در حال پردازش» را هم به «ارسال‌شده» ببر.</span></label></div>
        {!markShipped && <p className={styles.hint}>فعلاً فقط سفارش‌هایی که وضعیت «ارسال‌شده» دارند بررسی می‌شوند.</p>}
        {mode === 'file' ? <>
          <div className={styles.upload}><label className={styles.uploadButton}><Upload size={18} />{busy ? 'در حال پردازش…' : 'انتخاب فایل اکسل'}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} /></label><span>{fileName || 'xlsx · حداکثر ۴ مگابایت و ۱۰۰۰ ردیف داده'}</span><a href="/api/admin/shipments/workbook" className={styles.template}><Download size={16} /> دریافت فایل نمونه</a></div>
          <p className={styles.hint}>ستون تلفن، کدپستی و کد رهگیری را در اکسل روی Text بگذار تا صفر ابتدایی و رقم‌های طولانی از بین نروند. صفر ابتدای تلفن ۱۰ رقمی در پیش‌نمایش برگردانده می‌شود؛ کدپستی یا کد رهگیری ناقص باید اصلاح شود. فایل فقط خوانده می‌شود و روی سایت ذخیره نمی‌شود.</p>
          {!!sheets.length && <div className={styles.mapping}>
            <label>برگهٔ اکسل<EnhancedSelect value={String(sheetIndex)} onChange={event => { const index = Number(event.target.value); setSheetIndex(index); configureSheet(sheets[index]) }}>{sheets.map((item, index) => <option value={String(index)} key={index}>{item.name}</option>)}</EnhancedSelect></label>
            <label>ردیف عنوان ستون‌ها<input type="number" min="0" max="20" value={mapping.headerRow} onChange={event => changeMapping('headerRow', event.target.value)} /><small>اگر عنوان ندارد، صفر وارد کن.</small></label>
            <label>ستون {matchBy === 'phone' ? 'شماره تلفن' : 'کدپستی'}<EnhancedSelect required value={mapping.matchColumn} onChange={event => changeMapping('matchColumn', event.target.value)}><option value="">انتخاب ستون</option>{columnOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</EnhancedSelect></label>
            <label>ستون کد رهگیری<EnhancedSelect required value={mapping.trackingColumn} onChange={event => changeMapping('trackingColumn', event.target.value)}><option value="">انتخاب ستون</option>{columnOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</EnhancedSelect></label>
            <label>ستون شمارهٔ سفارش (اختیاری)<EnhancedSelect value={mapping.orderColumn} onChange={event => changeMapping('orderColumn', event.target.value)}><option value="">ندارد</option>{columnOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</EnhancedSelect></label>
          </div>}
          {!!sourceRows.length && <><div className={styles.listHeader}><strong>{number(includedRows.length)} ردیف برای بررسی</strong><span>مقادیر را همین‌جا اصلاح کن یا تیک ردیف‌های اضافی را بردار.</span></div><div className={styles.tableScroll}><table className={styles.sourceTable}><thead><tr><th>انتخاب</th><th>ردیف</th><th>{matchBy === 'phone' ? 'تلفن' : 'کدپستی'}</th><th>کد رهگیری</th><th>شمارهٔ سفارش</th></tr></thead><tbody>{pageRows.map(row => <tr key={row.rowNumber}><td><input type="checkbox" aria-label={`بررسی ردیف ${row.rowNumber}`} checked={!excluded[row.rowNumber]} onChange={event => { resetPreview(); setExcluded(previous => ({ ...previous, [row.rowNumber]: !event.target.checked })) }} /></td><td>{number(row.rowNumber)}</td><td><input dir="ltr" aria-label={`مشخصات تطبیق ردیف ${row.rowNumber}`} value={row.matchValue} maxLength={100} onChange={event => edit(row.rowNumber, 'matchValue', event.target.value)} /></td><td><input dir="ltr" aria-label={`کد رهگیری ردیف ${row.rowNumber}`} value={row.trackingCode} maxLength={100} onChange={event => edit(row.rowNumber, 'trackingCode', event.target.value)} />{row.sourceError && <small className={styles.cellError}>{row.sourceError}</small>}</td><td><input dir="ltr" aria-label={`شماره سفارش ردیف ${row.rowNumber}`} value={row.orderReference ?? ''} maxLength={80} onChange={event => edit(row.rowNumber, 'orderReference', event.target.value)} /></td></tr>)}</tbody></table></div><Pagination page={sourcePage} count={sourceRows.length} pageSize={50} disabled={busy} onChange={setSourcePage} /></>}
        </> : <div className={styles.manual}>
          <label>{matchBy === 'phone' ? 'شماره تلفن گیرنده' : 'کدپستی گیرنده'}<input required dir="ltr" inputMode="tel" maxLength={100} value={manual.matchValue} onChange={event => { setManual(previous => ({ ...previous, matchValue: event.target.value })); resetPreview() }} placeholder={matchBy === 'phone' ? '09123456789' : '1234567890'} /></label>
          <label>کد رهگیری<input required dir="ltr" maxLength={60} value={manual.trackingCode} onChange={event => { setManual(previous => ({ ...previous, trackingCode: event.target.value })); resetPreview() }} /></label>
          <label>شمارهٔ سفارش (اختیاری)<input dir="ltr" maxLength={80} value={manual.orderReference} onChange={event => { setManual(previous => ({ ...previous, orderReference: event.target.value })); resetPreview() }} placeholder="شناسهٔ کامل یا ۶ نویسهٔ آخر" /></label>
        </div>}
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={mode === 'file' && !includedRows.length}><PackageCheck size={18} /> بررسی و پیش‌نمایش</button><span>در این مرحله هیچ سفارشی تغییر نمی‌کند.</span></div>
      </fieldset>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {preview && <section ref={previewRef} className={styles.panel} aria-label="نتیجهٔ تطبیق مرسوله‌ها">
      <div className={styles.panelHeader}><div><h2>بررسی نهایی سفارش‌ها</h2><p>{number(preview.rows.length)} ردیف بررسی شد؛ {number(selectedRows.length)} ردیف انتخاب شده و {number(savedCount)} ردیف ثبت یا از قبل یکسان است.</p></div><button type="button" className={styles.primary} disabled={busy || !selectedRows.length} onClick={() => void confirm()}><Check size={18} />{busy ? 'در حال ثبت…' : `ثبت ${number(selectedRows.length)} کد رهگیری`}</button></div>
      <p className={styles.hint}>اعتبار پیش‌نمایش ۱۰ دقیقه است. کد قبلی بدون تأیید جداگانه جایگزین نمی‌شود.{markShipped ? ' سفارش‌های در حال پردازشِ انتخاب‌شده نیز ارسال‌شده خواهند شد.' : ''}</p>
      <div className={styles.previewList}>{previewRows.map(row => {
        const choice = choices[row.rowNumber], candidate = row.candidates.find(order => order.id === choice?.orderId), result = results[row.rowNumber]
        const replacing = !!candidate?.trackingCode && candidate.trackingCode !== row.trackingCode
        const done = result?.status === 'saved' || result?.status === 'unchanged'
        return <article key={row.rowNumber} className={`${styles.previewRow} ${row.error || result?.status === 'error' ? styles.invalidRow : ''}`}>
          <div className={styles.rowHeading}><label className={styles.checkbox}><input type="checkbox" aria-label={`ثبت ردیف ${row.rowNumber}`} disabled={busy || !!row.error || !choice?.orderId || done || replacing && !choice.overwrite} checked={choice?.selected ?? false} onChange={event => setChoices(previous => ({ ...previous, [row.rowNumber]: { ...previous[row.rowNumber], selected: event.target.checked } }))} /><strong>ردیف {number(row.rowNumber)}</strong></label><span dir="ltr" className={styles.identifier}>{row.matchValue}</span><span className={styles.tracking}>کد رهگیری: <bdi>{row.trackingCode}</bdi></span></div>
          {row.error ? <p className={styles.rowError}>{row.error}</p> : <>
            <label className={styles.orderSelect}>سفارش مرتبط{row.candidates.length > 1 && <span className={styles.warning}>چند سفارش مطابق است؛ یکی را انتخاب کن.</span>}<EnhancedSelect disabled={busy || done} value={choice?.orderId ?? ''} onChange={event => { const order = row.candidates.find(item => item.id === event.target.value); setChoices(previous => ({ ...previous, [row.rowNumber]: { orderId: event.target.value, selected: !!order && (!order.trackingCode || order.trackingCode === row.trackingCode), overwrite: false } })) }}><option value="">انتخاب سفارش</option>{row.candidates.map(order => <option key={order.id} value={order.id}>{`#${order.id.slice(-6)} · ${order.recipientName} · ${date(order.createdAt)} · ${order.shippingMethodName || 'ارسال'}`}</option>)}</EnhancedSelect></label>
            {candidate && <div className={styles.orderDetails}><Link href={`/admin/orders?q=${encodeURIComponent(candidate.id)}`}>سفارش <bdi>#{candidate.id.slice(-6)}</bdi></Link><span>{candidate.status === 'PROCESSING' ? 'در حال پردازش ← ارسال‌شده' : 'ارسال‌شده'}</span><span>{number(candidate.total)} تومان</span><span>تلفن: <bdi>{candidate.phone}</bdi></span><span>کدپستی: <bdi>{candidate.postalCode || 'ثبت نشده'}</bdi></span></div>}
            {replacing && <div className={styles.conflict}><p>کد فعلی: <bdi>{candidate?.trackingCode}</bdi></p><label className={styles.checkbox}><input type="checkbox" disabled={busy || done} checked={choice.overwrite} onChange={event => setChoices(previous => ({ ...previous, [row.rowNumber]: { ...previous[row.rowNumber], overwrite: event.target.checked, selected: event.target.checked } }))} />جایگزینی کد قبلی را پس از بررسی تأیید می‌کنم.</label></div>}
          </>}
          {result && <p role="status" className={result.status === 'error' ? styles.rowError : styles.saved}>{result.status === 'saved' ? 'کد رهگیری ثبت شد.' : result.status === 'unchanged' ? 'این کد قبلاً ثبت شده و تغییری لازم نبود.' : result.error}</p>}
        </article>
      })}</div><Pagination page={previewPage} count={preview.rows.length} pageSize={25} disabled={busy} onChange={setPreviewPage} />
    </section>}
  </div>
}

function Pagination({ page, count, pageSize, disabled, onChange }: { page: number; count: number; pageSize: number; disabled: boolean; onChange: (page: number) => void }) {
  const pages = Math.ceil(count / pageSize)
  if (pages < 2) return null
  return <nav className={styles.pagination} aria-label="صفحه‌بندی ردیف‌ها"><button type="button" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}><ArrowRight size={16} />قبلی</button><span>{number(page)} از {number(pages)}</span><button type="button" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}>بعدی<ArrowLeft size={16} /></button></nav>
}

export default function AdminShipmentsPage() {
  return <Suspense fallback={<p className={styles.hint}>در حال دریافت اطلاعات…</p>}><ShipmentContent /></Suspense>
}
