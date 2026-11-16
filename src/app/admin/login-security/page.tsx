'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { RefreshCw, Save, ShieldCheck, Network } from 'lucide-react'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import type { LoginSecuritySettings } from '@/lib/login-security-settings'
import admin from '@/components/admin/admin.module.css'
import styles from './login-security.module.css'

const limits = [
  { key: 'maxAttempts', label: 'حداکثر تلاش ناموفق برای هر حساب', minimum: 3, maximum: 20, help: 'بین ۳ تا ۲۰ تلاش' },
  { key: 'windowMinutes', label: 'بازهٔ شمارش تلاش‌ها (دقیقه)', minimum: 1, maximum: 60, help: 'بین ۱ تا ۶۰ دقیقه' },
  { key: 'lockMinutes', label: 'مدت محدودیت ورود (دقیقه)', minimum: 1, maximum: 60, help: 'بین ۱ تا ۶۰ دقیقه' },
  { key: 'ipMaxAttempts', label: 'حداکثر تلاش ناموفق از یک آدرس شبکه', minimum: 10, maximum: 200, help: 'بین ۱۰ تا ۲۰۰ تلاش و حداقل برابر با سقف هر حساب' },
] as const
type LimitKey = typeof limits[number]['key']
type Draft = Omit<LoginSecuritySettings, LimitKey> & Record<LimitKey, string>
type Snapshot = { settings: LoginSecuritySettings }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const persian = (value: number) => value.toLocaleString('fa-IR')

function validSnapshot(value: unknown): value is Snapshot {
  if (!record(value) || !record(value.settings)) return false
  const { settings } = value
  return Number.isSafeInteger(settings.version) && Number(settings.version) >= 0 && Number(settings.version) <= 2_147_483_647 &&
    limits.every(({ key, minimum, maximum }) => Number.isInteger(settings[key]) && Number(settings[key]) >= minimum && Number(settings[key]) <= maximum) &&
    Number(settings.ipMaxAttempts) >= Number(settings.maxAttempts)
}

function makeDraft(settings: LoginSecuritySettings): Draft {
  return { version: settings.version, maxAttempts: String(settings.maxAttempts), windowMinutes: String(settings.windowMinutes), lockMinutes: String(settings.lockMinutes), ipMaxAttempts: String(settings.ipMaxAttempts) }
}

export default function AdminLoginSecurityPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const request = useRef<AbortController | null>(null), mounted = useRef(true)

  const requestSettings = useCallback(async (form?: Draft) => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    setBusy(form ? 'saving' : 'loading'); setError(''); setNotice('')
    try {
      const response = await fetch('/api/admin/login-security-settings', {
        method: form ? 'PATCH' : 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        ...(form && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          version: form.version, ...Object.fromEntries(limits.map(({ key }) => [key, Number(form[key])])),
        }) }),
      })
      const data: unknown = await response.json().catch(() => null)
      if (!mounted.current || request.current !== controller) return
      controller.signal.throwIfAborted()
      if (!response.ok) {
        if (response.status === 409 || form && response.status >= 500) setConflict(true)
        throw new Error(record(data) && typeof data.error === 'string' ? data.error : 'تنظیمات امنیت ورود دریافت یا ذخیره نشد.')
      }
      if (!validSnapshot(data)) {
        if (form) setConflict(true)
        throw new Error('پاسخ کامل تنظیمات دریافت نشد. آخرین تنظیمات را دوباره بگیر.')
      }
      setSnapshot(data); setDraft(makeDraft(data.settings)); setConflict(false)
      if (form) setNotice('تنظیمات امنیت ورود ذخیره شد.')
    } catch (cause) {
      if (mounted.current && request.current === controller) {
        if (form && (timedOut || !(cause instanceof Error) || cause.name === 'TypeError')) setConflict(true)
        setError(timedOut ? 'پاسخ سرور دیر رسید. برای مشخص شدن نتیجه، آخرین تنظیمات را دوباره دریافت کن.' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.')
      }
    } finally { clearTimeout(timeout); if (request.current === controller) { request.current = null; if (mounted.current) setBusy(null) } }
  }, [])

  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => void requestSettings(), 0)
    return () => { mounted.current = false; clearTimeout(timer); request.current?.abort(); request.current = null }
  }, [requestSettings])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft || conflict || request.current) return
    setNotice('')
    for (const { key, minimum, maximum, label } of limits) {
      if (!/^\d+$/.test(draft[key]) || Number(draft[key]) < minimum || Number(draft[key]) > maximum) { setError(`${label} خارج از محدودهٔ مجاز است.`); return }
    }
    if (Number(draft.ipMaxAttempts) < Number(draft.maxAttempts)) { setError('سقف تلاش از یک آدرس شبکه نباید کمتر از سقف هر حساب باشد.'); return }
    await requestSettings(draft)
  }

  function field({ key, label, minimum, maximum, help }: typeof limits[number]) {
    if (!draft) return null
    return <div className={styles.field} key={key}>
      <label htmlFor={`login-security-${key}`}>{label}</label>
      <FormattedNumberInput id={`login-security-${key}`} aria-describedby={`login-security-${key}-help`} value={draft[key]} min={minimum} max={maximum} required disabled={busy !== null} grouping={false} onValueChange={value => setDraft({ ...draft, [key]: value })} className="input-field" />
      <small id={`login-security-${key}-help`}>{help}</small>
    </div>
  }

  return <div>
    <div className={admin.pageHeader}><div><span className={admin.eyebrow}>امنیت حساب‌ها</span><h1>امنیت ورود</h1><p>تعداد تلاش‌های ناموفق و مدت محدودیت ورود با رمز عبور را مدیریت کن.</p></div></div>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {busy === 'loading' && !draft ? <p role="status" className={styles.loading}>در حال دریافت تنظیمات امنیت ورود…</p> : !draft || !snapshot ? <button type="button" className="btn-outline" disabled={busy !== null} onClick={() => void requestSettings()}><RefreshCw size={16} />تلاش دوباره</button> : <form onSubmit={submit} className={styles.form}>
      <section className={styles.section} aria-labelledby="login-account-policy-title">
        <div className={styles.heading}><ShieldCheck size={23} aria-hidden="true" /><div><h2 id="login-account-policy-title">محدودیت ورود هر حساب</h2><p>این حفاظت برای تمام حساب‌ها، از جمله مدیران، فعال است.</p></div></div>
        <div className={styles.savedPolicy}><span className={styles.badge}>تنظیمات ذخیره‌شده</span><p>پس از {persian(snapshot.settings.maxAttempts)} تلاش ناموفق در بازهٔ {persian(snapshot.settings.windowMinutes)} دقیقه، ورود با آن ایمیل یا موبایل به مدت {persian(snapshot.settings.lockMinutes)} دقیقه محدود می‌شود.</p></div>
        <div className={styles.limitGrid}>{limits.slice(0, 3).map(field)}</div>
        <ul className={styles.explanation}>
          <li>تلاش دوباره در زمان محدودیت، پایان آن را عقب نمی‌اندازد.</li>
          <li>ورود موفق با رمز عبور، شمارش تلاش‌های ناموفق همان حساب را پاک می‌کند.</li>
          <li>محدودیت در سرور نگهداری می‌شود؛ عوض‌کردن مرورگر یا دستگاه آن را پاک نمی‌کند.</li>
        </ul>
      </section>
      <section className={styles.section} aria-labelledby="login-network-policy-title">
        <div className={styles.heading}><Network size={23} aria-hidden="true" /><div><h2 id="login-network-policy-title">حفاظت مشترک آدرس شبکه</h2><p>برای جلوگیری از امتحان رمز روی چند حساب از یک شبکه، تلاش‌های ناموفق آن شبکه با هم شمرده می‌شوند.</p></div></div>
        <div className={styles.networkGrid}>{field(limits[3])}<div className={styles.help}>
          <p>بازهٔ شمارش و مدت محدودیت شبکه همان مقادیر بخش بالاست. ورود موفق یک حساب، شمارش مشترک شبکه را پاک نمی‌کند.</p>
          <p>کاربرانی که از اینترنت مشترک استفاده می‌کنند ممکن است آدرس شبکهٔ یکسان داشته باشند؛ این سقف باید از سقف هر حساب کمتر نباشد.</p>
        </div></div>
        <p className={styles.warning}>اگر آدرس شبکهٔ قابل اعتماد از میزبان دریافت نشود، مانند اجرای خارج از Vercel، تلاش‌ها در یک شمارندهٔ مشترک ثبت می‌شوند؛ در این حالت رسیدن به سقف شبکه می‌تواند ورود همهٔ کاربران را موقتاً محدود کند.</p>
      </section>
      {conflict && <div role="status" className={styles.warning}>ممکن است نسخهٔ ذخیره‌شده تغییر کرده باشد. برای ادامه، آخرین تنظیمات را دریافت کن؛ پیش‌نویس این صفحه با نسخهٔ ذخیره‌شده جایگزین می‌شود.</div>}
      <div className={styles.actions}><button type="submit" className="btn-primary" disabled={busy !== null || conflict}><Save size={17} />{busy === 'saving' ? 'در حال ذخیره…' : 'ذخیره تنظیمات امنیت ورود'}</button><button type="button" className="btn-outline" disabled={busy !== null} onClick={() => void requestSettings()}><RefreshCw size={17} />دریافت آخرین تنظیمات</button></div>
    </form>}
  </div>
}
