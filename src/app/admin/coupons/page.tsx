'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BadgePercent, CalendarDays, Pencil, Plus, RefreshCw, Search, TicketPercent, Trash2, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import PersianDatePicker from '@/components/ui/PersianDatePicker'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import { formatPrice } from '@/lib/utils'
import styles from './coupons.module.css'

interface Coupon {
  id: string; code: string; name: string; type: 'PERCENT' | 'FIXED'; value: number
  maxDiscount: number | null; minSubtotal: number; maxUses: number | null; perUserLimit: number
  startsAt: string | null; endsAt: string | null; isActive: boolean; usedCount: number; version: number
}
interface Draft {
  code: string; name: string; type: 'PERCENT' | 'FIXED'; value: string; maxDiscount: string
  minSubtotal: string; maxUses: string; perUserLimit: string; startsAt: string; endsAt: string; isActive: boolean
}
const emptyDraft = (): Draft => ({ code: '', name: '', type: 'PERCENT', value: '', maxDiscount: '', minSubtotal: '0', maxUses: '', perUserLimit: '1', startsAt: '', endsAt: '', isActive: true })

function localDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
function stateOf(coupon: Coupon) {
  const now = Date.now()
  if (!coupon.isActive) return { label: 'غیرفعال', kind: 'muted' }
  if (coupon.endsAt && new Date(coupon.endsAt).getTime() <= now) return { label: 'منقضی', kind: 'muted' }
  if (coupon.startsAt && new Date(coupon.startsAt).getTime() > now) return { label: 'شروع نشده', kind: 'waiting' }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) return { label: 'ظرفیت تکمیل', kind: 'waiting' }
  return { label: 'فعال', kind: 'active' }
}
function dateLabel(value: string | null, empty: string) {
  return value ? new Date(value).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' }) : empty
}

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('ALL')
  const [editing, setEditing] = useState<Coupon | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [deleting, setDeleting] = useState<string | null>(null)
  const readController = useRef<AbortController | null>(null)
  const writeController = useRef<AbortController | null>(null)
  const writeLock = useRef(false)
  const formRef = useRef<HTMLElement | null>(null)

  const load = useCallback(async () => {
    readController.current?.abort()
    const controller = new AbortController()
    readController.current = controller
    setLoading(true)
    try {
      const response = await fetch('/api/admin/coupons', { cache: 'no-store', signal: controller.signal })
      const data = await response.json()
      if (!response.ok || !Array.isArray(data)) throw new Error(data.error || 'دریافت کدهای تخفیف ممکن نشد')
      if (!controller.signal.aborted) { setCoupons(data); setError('') }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => { clearTimeout(timer); readController.current?.abort(); writeController.current?.abort() }
  }, [load])

  function change<K extends keyof Draft>(field: K, value: Draft[K]) { setDraft(current => ({ ...current, [field]: value })) }
  function openForm(coupon: Coupon | null) {
    setEditing(coupon); setError(''); setNotice(''); setDeleting(null)
    setDraft(coupon ? {
      code: coupon.code, name: coupon.name, type: coupon.type, value: String(coupon.value),
      maxDiscount: coupon.maxDiscount === null ? '' : String(coupon.maxDiscount), minSubtotal: String(coupon.minSubtotal),
      maxUses: coupon.maxUses === null ? '' : String(coupon.maxUses), perUserLimit: String(coupon.perUserLimit),
      startsAt: localDate(coupon.startsAt), endsAt: localDate(coupon.endsAt), isActive: coupon.isActive,
    } : emptyDraft())
    setFormOpen(true)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (writeLock.current) return
    writeLock.current = true; setSaving(true); setError(''); setNotice('')
    const controller = new AbortController(); writeController.current = controller
    try {
      const payload = {
        ...draft, code: draft.code.trim().toUpperCase(), value: Number(draft.value), minSubtotal: Number(draft.minSubtotal),
        maxDiscount: draft.type === 'PERCENT' && draft.maxDiscount !== '' ? Number(draft.maxDiscount) : null,
        maxUses: draft.maxUses === '' ? null : Number(draft.maxUses), perUserLimit: Number(draft.perUserLimit),
        startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
        endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
        ...(editing ? { expectedVersion: editing.version } : {}),
      }
      const response = await fetch(editing ? `/api/admin/coupons/${editing.id}` : '/api/admin/coupons', {
        method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'ذخیرهٔ کد تخفیف ممکن نشد')
      if (!controller.signal.aborted) {
        setFormOpen(false); setEditing(null); setDraft(emptyDraft()); await load()
        if (!controller.signal.aborted) setNotice('کد تخفیف ذخیره شد.')
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ذخیرهٔ کد تخفیف ممکن نشد') }
    finally { writeLock.current = false; if (!controller.signal.aborted) setSaving(false) }
  }

  async function remove(coupon: Coupon) {
    if (writeLock.current) return
    writeLock.current = true; setSaving(true); setError(''); setNotice('')
    const controller = new AbortController(); writeController.current = controller
    try {
      const response = await fetch(`/api/admin/coupons/${coupon.id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: coupon.version }), signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'حذف کد تخفیف ممکن نشد')
      if (!controller.signal.aborted) {
        setDeleting(null); await load()
        if (!controller.signal.aborted) setNotice('کد تخفیف حذف شد؛ سوابق سفارش‌های قبلی حفظ شده‌اند.')
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'حذف کد تخفیف ممکن نشد') }
    finally { writeLock.current = false; if (!controller.signal.aborted) setSaving(false) }
  }

  const needle = query.trim().toLocaleLowerCase()
  const visible = coupons.filter(coupon => (!needle || `${coupon.code} ${coupon.name}`.toLocaleLowerCase().includes(needle)) &&
    (filter === 'ALL' || (filter === 'ACTIVE' ? stateOf(coupon).kind === 'active' : stateOf(coupon).kind !== 'active')))
  const activeCount = coupons.filter(coupon => stateOf(coupon).kind === 'active').length

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div><span className={styles.eyebrow}><TicketPercent size={17} /> مدیریت تخفیف‌ها</span><h1>کدهای تخفیف</h1><p>یک کد برای پیشنهادهای ویژه، با سقف و زمان‌بندی مشخص.</p></div>
        <button type="button" className={styles.primary} disabled={saving} onClick={() => openForm(null)}><Plus size={18} /> کد تخفیف جدید</button>
      </header>
      <div className={styles.summary}>
        <div><span>همهٔ کدها</span><strong>{coupons.length.toLocaleString('fa-IR')}</strong></div>
        <div><span>قابل استفاده اکنون</span><strong>{activeCount.toLocaleString('fa-IR')}</strong></div>
        <div><span>استفاده و رزرو فعال</span><strong>{coupons.reduce((sum, coupon) => sum + coupon.usedCount, 0).toLocaleString('fa-IR')}</strong></div>
      </div>
      {error && <div role="alert" className={styles.error}>{error}<button type="button" disabled={saving} onClick={() => void load()}>تازه‌سازی فهرست</button></div>}
      {notice && <div role="status" className={styles.notice}>{notice}</div>}

      {formOpen && <section ref={formRef} className={styles.formPanel} aria-label={editing ? 'ویرایش کد تخفیف' : 'تعریف کد تخفیف'}>
        <div className={styles.panelHeading}><h2>{editing ? 'ویرایش کد تخفیف' : 'تعریف کد تخفیف'}</h2><button type="button" className={styles.iconButton} aria-label="بستن فرم" disabled={saving} onClick={() => setFormOpen(false)}><X size={20} /></button></div>
        <form onSubmit={save}>
          <fieldset disabled={saving} className={styles.fields}>
            <label>عنوان<input required maxLength={120} value={draft.name} onChange={event => change('name', event.target.value)} placeholder="مثلاً پیشنهاد شروع پاییز" /></label>
            <label>کد تخفیف<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9_\-]{3,32}" dir="ltr" value={draft.code} onChange={event => change('code', event.target.value.toUpperCase())} placeholder="PANIK10" autoCapitalize="characters" autoComplete="off" /><small>حروف انگلیسی، عدد، خط تیره یا زیرخط</small></label>
            <label>نوع تخفیف<EnhancedSelect aria-label="نوع تخفیف" value={draft.type} onChange={event => change('type', event.target.value as Draft['type'])}><option value="PERCENT">درصدی</option><option value="FIXED">مبلغ ثابت</option></EnhancedSelect></label>
            <label>{draft.type === 'PERCENT' ? 'درصد تخفیف' : 'مبلغ تخفیف (تومان)'}<FormattedNumberInput required min={1} max={draft.type === 'PERCENT' ? 99 : 2_147_483_647} value={draft.value} onValueChange={value => change('value', value)} /></label>
            {draft.type === 'PERCENT' && <label>سقف مبلغ تخفیف (تومان)<FormattedNumberInput min={1} max={2_147_483_647} value={draft.maxDiscount} onValueChange={value => change('maxDiscount', value)} placeholder="بدون سقف" /></label>}
            <label>حداقل خرید (تومان)<FormattedNumberInput required min={0} max={2_147_483_647} value={draft.minSubtotal} onValueChange={value => change('minSubtotal', value)} /><small>پس از تخفیف محصول، بدون هزینهٔ ارسال{draft.type === 'FIXED' ? '؛ بیشتر از مبلغ کد باشد.' : ''}</small></label>
            <label>حداکثر استفادهٔ کل<FormattedNumberInput min={1} max={2_147_483_647} value={draft.maxUses} onValueChange={value => change('maxUses', value)} placeholder="نامحدود" /></label>
            <label>حداکثر استفادهٔ هر کاربر<FormattedNumberInput required min={1} max={2_147_483_647} value={draft.perUserLimit} onValueChange={value => change('perUserLimit', value)} /></label>
            <div className="flex min-w-0 flex-col gap-2 text-xs font-semibold"><label htmlFor="coupon-start-date">شروع اعتبار</label><PersianDatePicker aria-label="شروع اعتبار" id="coupon-start-date" includeTime disabled={saving} value={draft.startsAt} onChange={value => change('startsAt', value)} aria-describedby="coupon-start-hint" /><small id="coupon-start-hint">خالی باشد، بلافاصله قابل استفاده است.</small></div>
            <div className="flex min-w-0 flex-col gap-2 text-xs font-semibold"><label htmlFor="coupon-end-date">پایان اعتبار</label><PersianDatePicker aria-label="پایان اعتبار" id="coupon-end-date" includeTime disabled={saving} value={draft.endsAt} onChange={value => change('endsAt', value)} aria-describedby="coupon-end-hint" /><small id="coupon-end-hint">خالی باشد، تاریخ انقضا ندارد.</small></div>
            <label className={styles.checkbox}><input type="checkbox" checked={draft.isActive} onChange={event => change('isActive', event.target.checked)} /> کد تخفیف فعال باشد</label>
          </fieldset>
          <p className={styles.help}>زمان‌ها بر اساس ساعت دستگاه شما ثبت می‌شوند. تخفیف کد روی مبلغ کالاها پس از تخفیف محصول محاسبه می‌شود. هر سفارش فقط یک کد می‌پذیرد.</p>
          <div className={styles.formActions}><button type="submit" disabled={saving} className={styles.primary}>{saving ? 'در حال ذخیره…' : 'ذخیرهٔ کد تخفیف'}</button><button type="button" disabled={saving} className={styles.secondary} onClick={() => setFormOpen(false)}>انصراف</button></div>
        </form>
      </section>}

      <section className={styles.listPanel} aria-label="فهرست کدهای تخفیف">
        <div className={styles.toolbar}>
          <label className={styles.search}><Search size={19} /><input aria-label="جستجوی کدهای تخفیف" value={query} onChange={event => setQuery(event.target.value)} placeholder="جستجوی کد یا عنوان" /></label>
          <EnhancedSelect aria-label="فیلتر کدهای تخفیف" value={filter} onChange={event => setFilter(event.target.value)}><option value="ALL">همهٔ کدها</option><option value="ACTIVE">قابل استفاده اکنون</option><option value="INACTIVE">سایر کدها</option></EnhancedSelect>
          <button type="button" aria-label="تازه‌سازی کدهای تخفیف" className={styles.iconButton} disabled={loading || saving} onClick={() => void load()}><RefreshCw size={18} /></button>
        </div>
        <p className={styles.help}>رزرو کد از زمان ثبت سفارش شروع می‌شود؛ با انصراف یا اتمام مهلت پرداخت آزاد می‌شود. حذف یا ویرایش کد، مبلغ سفارش‌های قبلی را تغییر نمی‌دهد.</p>
        {loading ? <p role="status" className={styles.empty}>در حال دریافت کدها…</p> : !visible.length ? <p className={styles.empty}>{error ? 'فهرست دریافت نشد؛ دوباره تلاش کنید.' : coupons.length ? 'کدی با این جستجو پیدا نشد.' : 'هنوز کد تخفیفی تعریف نشده است.'}</p> : <div className={styles.cards}>
          {visible.map(coupon => {
            const status = stateOf(coupon)
            return <article key={coupon.id} className={styles.card}>
              <div className={styles.cardHeading}><span className={styles.discount}><BadgePercent size={20} />{coupon.type === 'PERCENT' ? `${coupon.value.toLocaleString('fa-IR')}٪` : `${formatPrice(coupon.value)} تومان`}</span><span className={`${styles.status} ${styles[status.kind]}`}>{status.label}</span></div>
              <code className={styles.code} dir="ltr">{coupon.code}</code><h2>{coupon.name}</h2>
              <dl className={styles.details}>
                <div><dt>حداقل خرید</dt><dd>{formatPrice(coupon.minSubtotal)} تومان</dd></div>
                {coupon.type === 'PERCENT' && <div><dt>سقف تخفیف</dt><dd>{coupon.maxDiscount === null ? 'بدون سقف' : `${formatPrice(coupon.maxDiscount)} تومان`}</dd></div>}
                <div><dt>استفاده و رزرو</dt><dd>{coupon.usedCount.toLocaleString('fa-IR')} از {coupon.maxUses === null ? 'نامحدود' : coupon.maxUses.toLocaleString('fa-IR')}</dd></div>
                <div><dt>سقف هر کاربر</dt><dd>{coupon.perUserLimit.toLocaleString('fa-IR')} بار</dd></div>
              </dl>
              <div className={styles.dates}><CalendarDays size={16} /><span>از {dateLabel(coupon.startsAt, 'همین حالا')}<br />تا {dateLabel(coupon.endsAt, 'بدون انقضا')}</span></div>
              {deleting === coupon.id ? <div className={styles.confirm} role="group" aria-label={`تأیید حذف ${coupon.code}`}><p>این کد حذف شود؟ سابقهٔ سفارش‌ها باقی می‌ماند.</p><button type="button" disabled={saving} onClick={() => void remove(coupon)}>بله، حذف شود</button><button type="button" disabled={saving} onClick={() => setDeleting(null)}>انصراف</button></div> : <div className={styles.cardActions}><button type="button" disabled={saving || loading} onClick={() => openForm(coupon)}><Pencil size={16} /> ویرایش</button><button type="button" disabled={saving || loading} aria-label={`حذف کد ${coupon.code}`} onClick={() => setDeleting(coupon.id)}><Trash2 size={16} /> حذف</button></div>}
            </article>
          })}
        </div>}
      </section>
    </div>
  )
}
