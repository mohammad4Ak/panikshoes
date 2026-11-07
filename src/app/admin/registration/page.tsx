'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpLeft, Check, LoaderCircle, Mail, RefreshCw, Save, ShieldCheck, Smartphone } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { normalizeContactDigits } from '@/lib/customer-contact'
import type { RegistrationAdminSnapshot, RegistrationSettings } from '@/lib/registration-settings'
import adminStyles from '@/components/admin/admin.module.css'
import styles from '../settings/settings.module.css'

const limits = [
  { key: 'expiryMinutes', label: 'اعتبار کد (دقیقه)', help: 'از ۱ تا ۱۰ دقیقه پس از صدور کد' },
  { key: 'maxAttempts', label: 'تلاش برای ورود هر کد', help: 'از ۱ تا ۱۰ تلاش برای هر کد' },
  { key: 'resendSeconds', label: 'فاصلهٔ ارسال مجدد (ثانیه)', help: 'از ۱۵ تا ۳۰۰ ثانیه برای یک مقصد' },
  { key: 'destinationHourlyLimit', label: 'حد ارسال ساعتی برای هر مقصد', help: 'از ۱ تا ۲۰ درخواست برای هر ایمیل یا شماره' },
  { key: 'ipHourlyLimit', label: 'حد ارسال ساعتی برای هر IP', help: 'از ۱ تا ۱۰۰ درخواست برای هر آدرس شبکه' },
] as const

type LimitKey = (typeof limits)[number]['key']
type Draft = Omit<RegistrationSettings, LimitKey> & Record<LimitKey, string>

function makeDraft(settings: RegistrationSettings): Draft {
  return {
    ...settings,
    expiryMinutes: settings.expiryMinutes.toLocaleString('fa-IR'),
    maxAttempts: settings.maxAttempts.toLocaleString('fa-IR'),
    resendSeconds: settings.resendSeconds.toLocaleString('fa-IR'),
    destinationHourlyLimit: settings.destinationHourlyLimit.toLocaleString('fa-IR'),
    ipHourlyLimit: settings.ipHourlyLimit.toLocaleString('fa-IR'),
  }
}

function ChannelStatus({ enabled, configured, otpConfigured }: { enabled: boolean; configured: boolean; otpConfigured: boolean }) {
  const active = enabled && configured && otpConfigured
  const color = active ? 'bg-emerald-50 text-emerald-800' : enabled ? 'bg-amber-50 text-amber-800' : 'bg-line/55 text-night'
  return (
    <span className={`ms-auto inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${color}`}>
      {active ? 'فعال در سایت' : enabled ? 'نیاز به تنظیم' : 'غیرفعال'}
    </span>
  )
}

export default function AdminRegistrationPage() {
  const [snapshot, setSnapshot] = useState<RegistrationAdminSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const requestRef = useRef<AbortController | null>(null)

  const requestSettings = useCallback(async (form?: Draft) => {
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15_000)
    setBusy(form ? 'saving' : 'loading')
    setError('')
    setNotice('')

    try {
      const body = form ? { ...form, ...Object.fromEntries(limits.map(({ key }) => [key, normalizeContactDigits(form[key])])) } : undefined
      const response = await fetch('/api/admin/registration-settings', {
        method: form ? 'PATCH' : 'GET',
        cache: 'no-store',
        signal: controller.signal,
        ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const data = await response.json().catch(() => null)
      if (requestRef.current !== controller) return
      controller.signal.throwIfAborted()
      if (!response.ok) {
        if (response.status === 409) setConflict(true)
        throw new Error(typeof data?.error === 'string' ? data.error : 'درخواست تنظیمات ثبت‌نام انجام نشد.')
      }
      if (!data?.settings || !data?.readiness) throw new Error('پاسخ تنظیمات ثبت‌نام معتبر نیست.')
      const saved: RegistrationAdminSnapshot = data
      setSnapshot(saved)
      setDraft(makeDraft(saved.settings))
      setConflict(false)
      if (form) setNotice('تنظیمات ثبت‌نام ذخیره شد.')
    } catch (cause) {
      if (requestRef.current === controller) {
        if (timedOut && form) setConflict(true)
        setError(timedOut
          ? 'پاسخ سرور دیر رسید. آخرین تنظیمات را دریافت و وضعیت را بررسی کنید.'
          : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.')
      }
    } finally {
      clearTimeout(timer)
      if (requestRef.current === controller) {
        requestRef.current = null
        setBusy(null)
      }
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void requestSettings(), 0)
    return () => {
      clearTimeout(timer)
      requestRef.current?.abort()
      requestRef.current = null
    }
  }, [requestSettings])

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(previous => previous ? { ...previous, [key]: value } : previous)
    setNotice('')
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (draft && !conflict) void requestSettings(draft)
  }

  const readiness = snapshot?.readiness
  const dirty = snapshot && draft && JSON.stringify(draft) !== JSON.stringify(makeDraft(snapshot.settings))

  return (
    <div>
      <div className={adminStyles.pageHeader}>
        <div><span className={adminStyles.eyebrow}>مدیریت دسترسی کاربران</span><h1>ثبت‌نام و تأیید حساب</h1><p>روش‌های ثبت‌نام و قواعد ارسال کد یک‌بارمصرف را تنظیم کنید.</p></div>
        <Link href="/register" className={adminStyles.headerLink}>مشاهدهٔ صفحهٔ ثبت‌نام <ArrowUpLeft size={17} aria-hidden="true" /></Link>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status"><Check size={16} aria-hidden="true" />{notice}</p>}
      {!snapshot || !draft || !readiness ? (
        <div className={styles.empty}>
          {busy ? <p role="status">در حال دریافت تنظیمات ثبت‌نام…</p> : (
            <button type="button" className="btn-outline" onClick={() => void requestSettings()}><RefreshCw size={16} aria-hidden="true" /> تلاش دوباره</button>
          )}
        </div>
      ) : (
        <form className={styles.form} onSubmit={submit} aria-busy={!!busy}>
          <section className={styles.panel} aria-labelledby="registration-email-heading">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
              <div className={`${styles.sectionTitle} min-w-0 grow basis-36`}>
                <span><Mail size={19} aria-hidden="true" /></span>
                <div><h2 id="registration-email-heading">تأیید با ایمیل</h2><p>کد ثبت‌نام از سرویس ایمیل پانیک ارسال می‌شود.</p></div>
              </div>
              <ChannelStatus enabled={snapshot.settings.emailEnabled} configured={readiness.emailConfigured} otpConfigured={readiness.otpConfigured} />
            </div>
            <label className={styles.toggleRow} htmlFor="registration-email-enabled">
              <span><strong>ثبت‌نام با ایمیل</strong><small>وضعیت ثبت‌نام مشتریان جدید پس از ذخیره اعمال می‌شود.</small></span>
              <input id="registration-email-enabled" type="checkbox" role="switch" checked={draft.emailEnabled} disabled={!!busy || (!draft.emailEnabled && (!readiness.emailConfigured || !readiness.otpConfigured))} onChange={event => setField('emailEnabled', event.target.checked)} />
            </label>
            <div className={styles.twoFields}>
              <div className={styles.field}>
                <label htmlFor="registration-email-sender">فرستندهٔ کد</label>
                <EnhancedSelect id="registration-email-sender" dir="ltr" value={draft.emailSender} disabled={!!busy} onChange={event => setField('emailSender', event.target.value as Draft['emailSender'])}>
                  <option value="auth">auth@panikshoes.com</option>
                  <option value="order">order@panikshoes.com</option>
                  <option value="noreply">noreply@panikshoes.com</option>
                </EnhancedSelect>
              </div>
              <p className={styles.paletteHelp}>
                {readiness.emailConfigured ? 'کلید سرویس ایمیل تنظیم شده است. برای آزمودن ارسال، بعد از فعال‌سازی با یک ایمیل تحت کنترل خود ثبت‌نام کنید.' : <>برای فعال‌سازی، کلید سرویس را در متغیر محیطی <bdi className="break-all">REGISTRATION_EMAIL_API_KEY</bdi> قرار دهید.</>}
              </p>
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="registration-sms-heading">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
              <div className={`${styles.sectionTitle} min-w-0 grow basis-36`}>
                <span><Smartphone size={19} aria-hidden="true" /></span>
                <div><h2 id="registration-sms-heading">تأیید با پیامک</h2><p>ارسال کد با الگوی تأیید در سرویس کاوه‌نگار.</p></div>
              </div>
              <ChannelStatus enabled={snapshot.settings.smsEnabled} configured={readiness.smsConfigured} otpConfigured={readiness.otpConfigured} />
            </div>
            <label className={styles.toggleRow} htmlFor="registration-sms-enabled">
              <span><strong>ثبت‌نام با شمارهٔ موبایل</strong><small>فعال‌سازی پس از تنظیم کلید سرویس و الگوی تأیید امکان‌پذیر است.</small></span>
              <input id="registration-sms-enabled" type="checkbox" role="switch" checked={draft.smsEnabled} disabled={!!busy || (!draft.smsEnabled && (!readiness.smsKeyConfigured || !readiness.otpConfigured || !draft.smsTemplate.trim()))} onChange={event => setField('smsEnabled', event.target.checked)} />
            </label>
            <div className={styles.twoFields}>
              <div className={styles.field}>
                <label htmlFor="registration-sms-template">نام الگوی تأیید کاوه‌نگار</label>
                <input id="registration-sms-template" className="input-field" dir="ltr" value={draft.smsTemplate} disabled={!!busy} maxLength={100} autoComplete="off" onChange={event => setField('smsTemplate', event.target.value)} />
              </div>
              <p className={styles.paletteHelp}>
                {readiness.smsKeyConfigured ? <>کلید کاوه‌نگار تنظیم شده است. در الگو، <bdi>%token</bdi> را برای کد قرار دهید.</> : <>برای فعال‌سازی، کلید سرویس را در متغیر محیطی <bdi className="break-all">REGISTRATION_KAVENEGAR_API_KEY</bdi> قرار دهید.</>}
              </p>
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="registration-policy-heading">
            <div className={styles.sectionTitle}>
              <span><ShieldCheck size={19} aria-hidden="true" /></span>
              <div><h2 id="registration-policy-heading">اعتبار کد و محدودیت ارسال</h2><p>این قواعد برای هر دو روش ثبت‌نام اعمال می‌شوند.</p></div>
            </div>
            {!readiness.otpConfigured && <p className={styles.error}>برای فعال‌سازی روش‌ها، <bdi className="break-all">REGISTRATION_OTP_SECRET</bdi> یا <bdi>AUTH_SECRET</bdi> باید در محیط سرور با حداقل ۳۲ نویسه تنظیم شده باشد.</p>}
            <div className={styles.twoFields}>
              {limits.map(({ key, label, help }) => (
                <div key={key} className={styles.field}>
                  <label htmlFor={`registration-${key}`}>{label}</label>
                  <input id={`registration-${key}`} className="input-field" inputMode="numeric" pattern="[0-9۰-۹٠-٩]+" aria-describedby={`registration-${key}-help`} required value={draft[key]} disabled={!!busy} onChange={event => setField(key, event.target.value)} />
                  <small id={`registration-${key}-help`} className={styles.paletteHelp}>{help}</small>
                </div>
              ))}
            </div>
          </section>

          <div className={styles.savePanel}>
            <div className={styles.saveActions}>
              <div><strong>اعمال تنظیمات</strong><p>تغییر روش‌ها بر ورود کاربران دارای حساب اثر ندارد.</p></div>
              <div className={styles.buttons}>
                <button type="button" className={`btn-outline ${styles.reload}`} disabled={!!busy} onClick={() => {
                  if (!dirty || window.confirm('تغییرات ذخیره‌نشده کنار گذاشته می‌شود. آخرین تنظیمات را دریافت می‌کنید؟')) void requestSettings()
                }}><RefreshCw size={16} aria-hidden="true" /> دریافت آخرین تنظیمات</button>
                <button type="submit" className={`btn-primary ${styles.save}`} disabled={!!busy || !!conflict || !dirty}>
                  {busy === 'saving' ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
                  {busy === 'saving' ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
                </button>
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
