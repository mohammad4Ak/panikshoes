'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, Truck, X } from 'lucide-react'
import adminStyles from '@/components/admin/admin.module.css'
import { MAX_SHIPPING_AMOUNT, type ShippingMethodOption } from '@/lib/shipping'
import styles from './shipping.module.css'

interface ShippingMethod extends ShippingMethodOption {
  createdAt?: string
}

interface ShippingForm {
  name: string
  description: string
  baseCost: string
  additionalItemCost: string
  freeShippingThreshold: string
  isActive: boolean
  sortOrder: string
}

const MAX_AMOUNT = MAX_SHIPPING_AMOUNT
const money = (amount: number) => `${amount.toLocaleString('fa-IR')} تومان`
const sortMethods = (methods: ShippingMethod[]) => [...methods].sort(
  (a, b) => a.sortOrder - b.sortOrder || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
)

async function apiError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null)
  return body && typeof body.error === 'string' ? body.error : fallback
}

function ShippingMethodDialog({
  method,
  onDismiss,
  onSaved,
}: {
  method: ShippingMethod | null
  onDismiss: () => void
  onSaved: (method: ShippingMethod) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<ShippingForm>(() => ({
    name: method?.name ?? '',
    description: method?.description ?? '',
    baseCost: String(method?.baseCost ?? 0),
    additionalItemCost: String(method?.additionalItemCost ?? 0),
    freeShippingThreshold: method?.freeShippingThreshold == null ? '' : String(method.freeShippingThreshold),
    isActive: method?.isActive ?? false,
    sortOrder: String(method?.sortOrder ?? 0),
  }))

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      requestRef.current?.abort()
      dialog?.close()
    }
  }, [])

  const setField = <K extends keyof ShippingForm>(field: K, value: ShippingForm[K]) => {
    setForm((previous) => ({ ...previous, [field]: value }))
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const name = form.name.trim()
    if (!name) {
      setError('نام روش ارسال را وارد کنید.')
      return
    }
    const numericFields = [form.baseCost, form.additionalItemCost]
    if (form.freeShippingThreshold !== '') numericFields.push(form.freeShippingThreshold)
    if (numericFields.some((value) => value.trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > MAX_AMOUNT)) {
      setError('مبلغ‌ها و ترتیب نمایش باید عدد صحیح و غیرمنفی باشند.')
      return
    }
    if (form.sortOrder.trim() === '' || !Number.isSafeInteger(Number(form.sortOrder)) || Number(form.sortOrder) < 0 || Number(form.sortOrder) > 1_000_000) {
      setError('ترتیب نمایش باید عدد صحیح بین صفر تا یک میلیون باشد.')
      return
    }

    const controller = new AbortController()
    requestRef.current = controller
    setSaving(true)
    setError('')

    try {
      const response = await fetch(method ? `/api/admin/shipping-methods/${encodeURIComponent(method.id)}` : '/api/admin/shipping-methods', {
        method: method ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          name,
          description: form.description.trim() || null,
          baseCost: Number(form.baseCost),
          additionalItemCost: Number(form.additionalItemCost),
          freeShippingThreshold: form.freeShippingThreshold === '' ? null : Number(form.freeShippingThreshold),
          isActive: form.isActive,
          sortOrder: Number(form.sortOrder),
        }),
      })
      if (!response.ok) throw new Error(await apiError(response, 'ذخیره روش ارسال انجام نشد. دوباره تلاش کنید.'))
      const savedMethod: ShippingMethod = await response.json()
      if (!controller.signal.aborted) onSaved(savedMethod)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  const previewBase = Number(form.baseCost)
  const previewExtra = Number(form.additionalItemCost)
  const previewValid = form.baseCost !== '' && form.additionalItemCost !== '' && Number.isSafeInteger(previewBase) && Number.isSafeInteger(previewExtra) && previewBase >= 0 && previewExtra >= 0

  return (
    <dialog
      ref={dialogRef}
      className={`${adminStyles.dialog} ${styles.dialog}`}
      aria-labelledby="shipping-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onDismiss()
      }}
    >
      <div className={adminStyles.dialogHeader}>
        <h2 id="shipping-dialog-title">{method ? 'ویرایش روش ارسال' : 'روش ارسال جدید'}</h2>
        <button type="button" onClick={onDismiss} disabled={saving} aria-label="بستن فرم ارسال">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={save} className={styles.form} aria-busy={saving}>
        <div className={styles.field}>
          <label htmlFor="shipping-name">نام روش ارسال <span aria-hidden="true">*</span></label>
          <input id="shipping-name" autoFocus required maxLength={80} className="input-field" placeholder="مثلاً پست پیشتاز" value={form.name} onChange={(event) => setField('name', event.target.value)} disabled={saving} />
        </div>
        <div className={styles.field}>
          <label htmlFor="shipping-description">توضیح برای مشتری (اختیاری)</label>
          <textarea id="shipping-description" maxLength={500} className="input-field" placeholder="مثلاً زمان تقریبی تحویل یا شرایط ارسال" value={form.description} onChange={(event) => setField('description', event.target.value)} disabled={saving} />
        </div>

        <div className={styles.priceFields}>
          <div className={styles.field}>
            <label htmlFor="shipping-base">هزینه پایه (تومان) <span aria-hidden="true">*</span></label>
            <input id="shipping-base" type="number" inputMode="numeric" min={0} max={MAX_AMOUNT} step={1} required className="input-field" value={form.baseCost} onChange={(event) => setField('baseCost', event.target.value)} disabled={saving} aria-describedby="shipping-base-help" />
            <p id="shipping-base-help" className={styles.fieldHelp}>هزینه ارسال سفارش با یک جفت کفش</p>
          </div>
          <div className={styles.field}>
            <label htmlFor="shipping-extra">هزینه هر جفت اضافه (تومان) <span aria-hidden="true">*</span></label>
            <input id="shipping-extra" type="number" inputMode="numeric" min={0} max={MAX_AMOUNT} step={1} required className="input-field" value={form.additionalItemCost} onChange={(event) => setField('additionalItemCost', event.target.value)} disabled={saving} aria-describedby="shipping-extra-help" />
            <p id="shipping-extra-help" className={styles.fieldHelp}>برای هر جفت بعد از جفت اول؛ برای نرخ ثابت صفر بگذارید.</p>
          </div>
        </div>

        {previewValid && (
          <div className={styles.pricePreview} aria-live="polite">
            <span>نمونه هزینه ارسال</span>
            <div><span>یک جفت <strong>{money(previewBase)}</strong></span><span>دو جفت <strong>{money(previewBase + previewExtra)}</strong></span></div>
            <p>پیش از اعمال حد ارسال رایگان</p>
          </div>
        )}

        <div className={styles.priceFields}>
          <div className={styles.field}>
            <label htmlFor="shipping-free">حد ارسال رایگان (تومان)</label>
            <input id="shipping-free" type="number" inputMode="numeric" min={0} max={MAX_AMOUNT} step={1} className="input-field" placeholder="بدون حد ارسال رایگان" value={form.freeShippingThreshold} onChange={(event) => setField('freeShippingThreshold', event.target.value)} disabled={saving} aria-describedby="shipping-free-help" />
            <p id="shipping-free-help" className={styles.fieldHelp}>اگر جمع قیمت کالاها به این مبلغ برسد، ارسال رایگان است. خالی یعنی بدون ارسال رایگان.</p>
          </div>
          <div className={styles.field}>
            <label htmlFor="shipping-sort">ترتیب نمایش</label>
            <input id="shipping-sort" type="number" inputMode="numeric" min={0} max={1_000_000} step={1} required className="input-field" value={form.sortOrder} onChange={(event) => setField('sortOrder', event.target.value)} disabled={saving} aria-describedby="shipping-sort-help" />
            <p id="shipping-sort-help" className={styles.fieldHelp}>عدد کمتر، جایگاه بالاتر در فهرست</p>
          </div>
        </div>

        <label htmlFor="shipping-active" className={styles.activeControl}>
          <span><strong>فعال برای مشتری‌ها</strong><small>روش‌های فعال در مرحله ثبت سفارش نمایش داده می‌شوند.</small></span>
          <input id="shipping-active" type="checkbox" className={styles.toggle} checked={form.isActive} onChange={(event) => setField('isActive', event.target.checked)} disabled={saving} />
        </label>

        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.formActions}>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? <><LoaderCircle size={17} className={styles.spinner} aria-hidden="true" /> در حال ذخیره...</> : method ? 'ذخیره تغییرات' : 'افزودن روش ارسال'}</button>
          <button type="button" disabled={saving} onClick={onDismiss} className="btn-outline">انصراف</button>
        </div>
      </form>
    </dialog>
  )
}

export default function AdminShippingPage() {
  const [methods, setMethods] = useState<ShippingMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [dialog, setDialog] = useState<{ method: ShippingMethod | null } | null>(null)
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const deleteRequestRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/admin/shipping-methods', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error(await apiError(response, 'دریافت روش‌های ارسال انجام نشد.'))
        const data = await response.json()
        if (!Array.isArray(data)) throw new Error('پاسخ سرور برای روش‌های ارسال معتبر نیست.')
        if (!controller.signal.aborted) setMethods(sortMethods(data))
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [reloadKey])

  useEffect(() => () => deleteRequestRef.current?.abort(), [])

  const reload = () => {
    setLoading(true)
    setLoadError('')
    setReloadKey((previous) => previous + 1)
  }

  const openForm = (method: ShippingMethod | null) => {
    setNotice('')
    setActionError('')
    setDeleteConfirmationId(null)
    setDialog({ method })
  }

  const saveMethod = (method: ShippingMethod) => {
    setMethods((previous) => sortMethods([...previous.filter((item) => item.id !== method.id), method]))
    setNotice(dialog?.method ? 'تغییرات روش ارسال ذخیره شد.' : 'روش ارسال جدید اضافه شد.')
    setDialog(null)
  }

  const deleteMethod = async (method: ShippingMethod) => {
    if (deletingId) return
    const controller = new AbortController()
    deleteRequestRef.current = controller
    setDeletingId(method.id)
    setActionError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/shipping-methods/${encodeURIComponent(method.id)}`, { method: 'DELETE', signal: controller.signal })
      if (!response.ok) throw new Error(await apiError(response, 'حذف روش ارسال انجام نشد.'))
      if (!controller.signal.aborted) {
        setMethods((previous) => previous.filter((item) => item.id !== method.id))
        setDeleteConfirmationId(null)
        setNotice(`روش ارسال «${method.name}» حذف شد.`)
      }
    } catch (cause) {
      if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally {
      if (!controller.signal.aborted) setDeletingId(null)
    }
  }

  return (
    <div>
      <div className={adminStyles.pageHeader}>
        <div><span className={adminStyles.eyebrow}>از فروشگاه تا درِ خانه</span><h1>مدیریت روش‌های ارسال</h1><p>روش‌های تحویل و هزینه ارسال هر سفارش را تنظیم کنید.</p></div>
        <button type="button" onClick={() => openForm(null)} disabled={loading || !!loadError || !!deletingId} className={`btn-primary ${styles.addButton}`}><Plus size={18} aria-hidden="true" /> روش ارسال جدید</button>
      </div>

      <div className={styles.guide}>
        <span className={styles.guideIcon} aria-hidden="true"><Truck size={25} /></span>
        <div><h2>هزینه پایه + هزینه جفت‌های اضافه</h2><p>برای هر روش، مبلغ پایه و هزینه هر جفت بعد از جفت اول را تعیین کنید. حد ارسال رایگان هم بر اساس جمع قیمت کالاها اعمال می‌شود.</p></div>
        {!loading && !loadError && <span className={styles.count}>{methods.filter((method) => method.isActive).length.toLocaleString('fa-IR')} روش فعال</span>}
      </div>

      {notice && <p role="status" className={styles.notice}><Check size={18} aria-hidden="true" />{notice}</p>}
      {actionError && <p role="alert" className={styles.error}>{actionError}</p>}

      {loading ? (
        <div className={styles.empty} role="status"><LoaderCircle size={28} className={styles.spinner} aria-hidden="true" /><p>در حال دریافت روش‌های ارسال...</p></div>
      ) : loadError ? (
        <div className={styles.empty}><p role="alert">{loadError}</p><button type="button" onClick={reload} className="btn-outline"><RefreshCw size={16} aria-hidden="true" /> تلاش دوباره</button></div>
      ) : methods.length === 0 ? (
        <div className={styles.empty}><span className={styles.emptyIcon} aria-hidden="true"><Truck size={32} /></span><h2>هنوز روش ارسالی ثبت نشده</h2><p>پست پیشتاز، پست معمولی، تیپاکس یا ماهکس را با نرخ دلخواه اضافه کنید.</p><button type="button" onClick={() => openForm(null)} className="btn-primary">افزودن اولین روش ارسال</button></div>
      ) : (
        <div className={styles.grid}>
          {methods.map((method) => (
            <article key={method.id} className={styles.methodCard}>
              <div className={styles.cardHeader}><div className={styles.methodName}><span className={styles.methodIcon} aria-hidden="true"><Truck size={21} /></span><h2>{method.name}</h2></div><span className={`${styles.badge} ${method.isActive ? styles.activeBadge : styles.inactiveBadge}`}>{method.isActive ? 'فعال' : 'غیرفعال'}</span></div>
              <p className={styles.description}>{method.description || 'توضیحی برای مشتری ثبت نشده است.'}</p>
              <dl className={styles.costs}>
                <div><dt>هزینه پایه</dt><dd>{money(method.baseCost)}</dd></div>
                <div><dt>هر جفت اضافه</dt><dd>{money(method.additionalItemCost)}</dd></div>
                <div className={styles.freeCost}><dt>ارسال رایگان</dt><dd>{method.freeShippingThreshold === null ? 'بدون حد ارسال رایگان' : `از ${money(method.freeShippingThreshold)}`}</dd></div>
              </dl>
              <div className={styles.cardFooter}>
                <span className={styles.sortOrder}>ترتیب نمایش: {method.sortOrder.toLocaleString('fa-IR')}</span>
                <div className={styles.cardActions}><button type="button" onClick={() => openForm(method)} disabled={!!deletingId} aria-label={`ویرایش ${method.name}`}><Pencil size={16} aria-hidden="true" /> ویرایش</button><button type="button" className={styles.deleteButton} onClick={() => { setDeleteConfirmationId(method.id); setActionError(''); setNotice('') }} disabled={!!deletingId} aria-label={`حذف ${method.name}`}><Trash2 size={16} aria-hidden="true" /></button></div>
              </div>
              {deleteConfirmationId === method.id && (
                <div className={styles.deleteConfirmation} role="group" aria-label={`تأیید حذف ${method.name}`}>
                  <p>«{method.name}» حذف شود؟ اطلاعات ارسال سفارش‌های قبلی حفظ می‌شود.</p>
                  <div><button type="button" className={styles.confirmDelete} onClick={() => void deleteMethod(method)} disabled={!!deletingId}>{deletingId === method.id ? 'در حال حذف...' : 'بله، حذف شود'}</button><button type="button" onClick={() => setDeleteConfirmationId(null)} disabled={!!deletingId}>انصراف</button></div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {dialog && <ShippingMethodDialog method={dialog.method} onDismiss={() => setDialog(null)} onSaved={saveMethod} />}
    </div>
  )
}
