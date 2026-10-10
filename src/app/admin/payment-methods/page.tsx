'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpLeft, Check, CreditCard, LoaderCircle, RefreshCw } from 'lucide-react'
import { isValidCardNumber, normalizePaymentDigits } from '@/lib/payment-contract'
import adminStyles from '@/components/admin/admin.module.css'
import styles from './payment-methods.module.css'

interface PaymentMethod {
  id: string
  name: string
  description: string | null
  isActive: boolean
  cardNumber: string | null
  cardholderName: string | null
  bankName: string | null
  sortOrder: number
  available: boolean
  unavailableReason?: string | null
}

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null)
  return typeof data?.error === 'string' ? data.error : fallback
}

function MethodForm({ method, onSaved }: { method: PaymentMethod; onSaved: (method: PaymentMethod) => void }) {
  const [form, setForm] = useState({
    name: method.name,
    description: method.description ?? '',
    cardNumber: method.cardNumber ?? '',
    cardholderName: method.cardholderName ?? '',
    bankName: method.bankName ?? '',
    sortOrder: String(method.sortOrder),
    isActive: method.isActive,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  const bankTransfer = method.id === 'bank_transfer'

  useEffect(() => () => requestRef.current?.abort(), [])

  const setField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }))
    setNotice('')
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (requestRef.current) return
    const number = normalizePaymentDigits(form.cardNumber).replace(/[\s-]/g, '')
    const sortOrder = Number(normalizePaymentDigits(form.sortOrder))
    setError('')
    setNotice('')
    if (!form.name.trim()) return setError('نام روش پرداخت را وارد کنید.')
    if (!/^\d{1,3}$/.test(normalizePaymentDigits(form.sortOrder).trim()) || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 999) {
      return setError('ترتیب نمایش باید عدد صحیح بین صفر تا ۹۹۹ باشد.')
    }
    if (bankTransfer && number && !isValidCardNumber(number)) {
      return setError('شماره کارت ۱۶ رقمی معتبر وارد کنید.')
    }
    if (bankTransfer && form.isActive && (!number || !form.cardholderName.trim())) {
      return setError('برای فعال کردن کارت‌به‌کارت، شماره کارت معتبر و نام صاحب کارت را وارد کنید.')
    }
    const controller = new AbortController()
    requestRef.current = controller
    setSaving(true)
    try {
      const response = await fetch(`/api/admin/payment-methods/${encodeURIComponent(method.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({
          name: form.name.trim(), description: form.description.trim() || null,
          isActive: bankTransfer ? form.isActive : false, sortOrder,
          ...(bankTransfer ? { cardNumber: number || null, cardholderName: form.cardholderName.trim() || null, bankName: form.bankName.trim() || null } : {}),
        }),
      })
      if (!response.ok) throw new Error(await responseError(response, 'تنظیمات پرداخت ذخیره نشد. دوباره تلاش کنید.'))
      const saved: PaymentMethod = await response.json()
      if (!controller.signal.aborted) {
        onSaved(saved)
        setNotice('تنظیمات این روش پرداخت ذخیره شد.')
        setForm({ name: saved.name, description: saved.description ?? '', cardNumber: saved.cardNumber ?? '', cardholderName: saved.cardholderName ?? '', bankName: saved.bankName ?? '', sortOrder: String(saved.sortOrder), isActive: saved.isActive })
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally {
      requestRef.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  return (
    <article className={styles.method}>
      <div className={styles.methodHeader}>
        <div className={styles.methodTitle}><span className={styles.icon}><CreditCard size={22} aria-hidden="true" /></span><div><h2>{method.name}</h2><p>{bankTransfer ? 'واریز مستقیم · بررسی توسط ادمین' : 'درگاه پرداخت آنلاین'}</p></div></div>
        <span className={`${styles.badge} ${method.isActive && method.available ? styles.active : ''}`}>{method.isActive && method.available ? 'فعال' : 'غیرفعال'}</span>
      </div>
      {bankTransfer ? (
        <div className={styles.bankCard} aria-label="پیش‌نمایش کارت مقصد">
          <div className={styles.bankCardTop}><span>{form.bankName.trim() || 'کارت مقصد فروشگاه'}</span><span className={styles.chip} aria-hidden="true" /></div>
          <b dir="ltr">{normalizePaymentDigits(form.cardNumber).replace(/[\s-]/g, '').match(/.{1,4}/g)?.join(' ') || '••••  ••••  ••••  ••••'}</b>
          <div><small>به نام</small><strong>{form.cardholderName.trim() || 'نام صاحب کارت را وارد کنید'}</strong></div>
        </div>
      ) : <div className={styles.unavailable}><h3>در انتظار اتصال به زرین‌پال</h3><p>{method.unavailableReason || 'پس از تکمیل اتصال و امکان تأیید واقعی تراکنش، این روش قابل فعال‌سازی خواهد بود.'}</p></div>}
      <form onSubmit={save} className={styles.form} aria-busy={saving}>
        <div className={styles.field}><label htmlFor={`${method.id}-name`}>عنوان در صفحهٔ پرداخت</label><input id={`${method.id}-name`} className="input-field" required maxLength={80} value={form.name} onChange={(event) => setField('name', event.target.value)} disabled={saving} /></div>
        {bankTransfer && <>
          <div className={styles.field}><label htmlFor={`${method.id}-number`}>شماره کارت مقصد</label><input id={`${method.id}-number`} className="input-field" dir="ltr" inputMode="numeric" autoComplete="off" maxLength={24} placeholder="شماره کارت ۱۶ رقمی" value={form.cardNumber} onChange={(event) => setField('cardNumber', event.target.value)} disabled={saving} required={form.isActive} /></div>
          <div className={styles.twoFields}>
            <div className={styles.field}><label htmlFor={`${method.id}-holder`}>نام صاحب کارت</label><input id={`${method.id}-holder`} className="input-field" maxLength={100} value={form.cardholderName} onChange={(event) => setField('cardholderName', event.target.value)} disabled={saving} required={form.isActive} /></div>
            <div className={styles.field}><label htmlFor={`${method.id}-bank`}>نام بانک (اختیاری)</label><input id={`${method.id}-bank`} className="input-field" maxLength={80} value={form.bankName} onChange={(event) => setField('bankName', event.target.value)} disabled={saving} /></div>
          </div>
        </>}
        <div className={styles.field}><label htmlFor={`${method.id}-description`}>راهنمای مشتری (اختیاری)</label><textarea id={`${method.id}-description`} className="input-field" maxLength={500} placeholder="توضیح کوتاه برای انتخاب این روش پرداخت" value={form.description} onChange={(event) => setField('description', event.target.value)} disabled={saving} /></div>
        <div className={styles.field}><label htmlFor={`${method.id}-sort`}>ترتیب نمایش</label><input id={`${method.id}-sort`} className="input-field" inputMode="numeric" required maxLength={3} value={form.sortOrder} onChange={(event) => setField('sortOrder', event.target.value)} disabled={saving} /><small>عدد صحیح بین صفر تا ۹۹۹؛ عدد کمتر، جایگاه بالاتر در فهرست روش‌ها</small></div>
        <label className={styles.toggleRow} htmlFor={`${method.id}-active`}><span><strong>فعال برای مشتری‌ها</strong><small>{bankTransfer ? 'تغییرات پس از ذخیره اعمال می‌شوند.' : 'تا زمان تکمیل اتصال، غیرفعال می‌ماند.'}</small></span><input id={`${method.id}-active`} type="checkbox" role="switch" checked={bankTransfer && form.isActive} disabled={saving || !bankTransfer} onChange={(event) => setField('isActive', event.target.checked)} /></label>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status" className={styles.notice}><Check size={17} aria-hidden="true" />{notice}</p>}
        <button type="submit" className={`btn-primary ${styles.save}`} disabled={saving}>{saving ? <><LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> در حال ذخیره...</> : 'ذخیره تنظیمات'}</button>
      </form>
    </article>
  )
}

export default function AdminPaymentMethodsPage() {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/admin/payment-methods', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(await responseError(response, 'روش‌های پرداخت بارگذاری نشدند.'))
        const data = await response.json()
        if (!Array.isArray(data)) throw new Error('پاسخ سرور معتبر نیست.')
        if (!controller.signal.aborted) setMethods(data)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [reloadKey])
  return (
    <div>
      <div className={adminStyles.pageHeader}><div><span className={adminStyles.eyebrow}>راه‌های پرداخت مشتری</span><h1>روش‌های پرداخت</h1><p>روش‌های قابل استفاده و اطلاعات حساب مقصد فروشگاه را تنظیم کنید.</p></div><Link href="/admin/payments" className={adminStyles.headerLink}>بررسی رسیدها <ArrowUpLeft size={17} aria-hidden="true" /></Link></div>
      <div className={styles.guide}><h2>اطلاعات پرداخت هر سفارش حفظ می‌شود</h2><p>تغییر کارت مقصد روی سفارش‌های جدید اعمال می‌شود. سفارش‌های قبلی با همان مشخصات زمان ثبت، قابل بررسی خواهند بود.</p></div>
      {loading ? <div className={styles.empty} role="status">در حال دریافت تنظیمات پرداخت...</div> : error || methods.length === 0 ? <div className={styles.empty}><p role="alert">{error || 'تنظیمات روش‌های پرداخت هنوز در دسترس نیست.'}</p><button type="button" className="btn-outline" onClick={() => { setError(''); setLoading(true); setReloadKey((value) => value + 1) }}><RefreshCw size={17} aria-hidden="true" /> تلاش دوباره</button></div> : <>
        {!methods.some((method) => method.isActive && method.available) && <p className={styles.warning}>هیچ روش پرداختی فعال نیست. برای امکان ثبت سفارش، مشخصات کارت فروشگاه را وارد و کارت‌به‌کارت را فعال کنید.</p>}
        <div className={styles.grid}>{[...methods].sort((a, b) => a.sortOrder - b.sortOrder).map((method) => <MethodForm key={method.id} method={method} onSaved={(saved) => setMethods((previous) => previous.map((item) => item.id === saved.id ? saved : item))} />)}</div>
      </>}
    </div>
  )
}
