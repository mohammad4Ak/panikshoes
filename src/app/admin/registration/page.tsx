'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpLeft, Check, LoaderCircle, Mail, Plus, RefreshCw, Save, ShieldCheck, Smartphone, Trash2, X } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { normalizeContactDigits } from '@/lib/customer-contact'
import type { RegistrationAdminSnapshot, RegistrationPublicSettings } from '@/lib/registration-settings'
import adminStyles from '@/components/admin/admin.module.css'
import styles from '../settings/settings.module.css'
import localStyles from './registration.module.css'

const limits = [
  { key: 'expiryMinutes', label: 'اعتبار کد (دقیقه)', help: 'از ۱ تا ۱۰ دقیقه پس از صدور کد' },
  { key: 'maxAttempts', label: 'تلاش برای ورود هر کد', help: 'از ۱ تا ۱۰ تلاش برای هر کد' },
  { key: 'resendSeconds', label: 'فاصلهٔ ارسال مجدد (ثانیه)', help: 'از ۱۵ تا ۳۰۰ ثانیه برای یک مقصد' },
  { key: 'destinationHourlyLimit', label: 'حد ارسال ساعتی برای هر مقصد', help: 'از ۱ تا ۲۰ درخواست برای هر ایمیل یا شماره' },
  { key: 'ipHourlyLimit', label: 'حد ارسال ساعتی برای هر IP', help: 'از ۱ تا ۱۰۰ درخواست برای هر آدرس شبکه' },
] as const

type LimitKey = (typeof limits)[number]['key']
type HeaderDraft = RegistrationPublicSettings['smsHeaders'][number] & { id: number }
type Draft = Omit<RegistrationPublicSettings, LimitKey | 'smsHeaders'> & Record<LimitKey, string> & { smsHeaders: HeaderDraft[] }

function makeDraft(settings: RegistrationPublicSettings): Draft {
  return {
    ...settings,
    smsHeaders: settings.smsHeaders.map((header, id) => ({ ...header, id })),
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
  const [smsApiKey, setSmsApiKey] = useState('')
  const [clearSmsApiKey, setClearSmsApiKey] = useState(false)
  const requestRef = useRef<AbortController | null>(null)

  const requestSettings = useCallback(async (form?: Draft, keyUpdate?: { smsApiKey: string; clearSmsApiKey: boolean }) => {
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15_000)
    setBusy(form ? 'saving' : 'loading')
    setError('')
    setNotice('')

    try {
      const body = form ? {
        ...form,
        ...keyUpdate,
        smsHeaders: form.smsHeaders.map(({ name, value }) => ({ name, value })),
        ...Object.fromEntries(limits.map(({ key }) => [key, normalizeContactDigits(form[key])])),
      } : undefined
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
      setSmsApiKey('')
      setClearSmsApiKey(false)
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
    if (draft && !conflict) void requestSettings(draft, { smsApiKey, clearSmsApiKey })
  }

  const readiness = snapshot?.readiness
  const dirty = snapshot && draft && (JSON.stringify(draft) !== JSON.stringify(makeDraft(snapshot.settings)) || !!smsApiKey.trim() || clearSmsApiKey)

  const changeHeader = (id: number, field: 'name' | 'value', value: string) => {
    if (draft) setField('smsHeaders', draft.smsHeaders.map(header => header.id === id ? { ...header, [field]: value } : header))
  }

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
                <div><h2 id="registration-sms-heading">تأیید با پیامک</h2><p>سرویس ارسال پیامک و مشخصات اتصال آن را تنظیم کنید.</p></div>
              </div>
              <ChannelStatus enabled={snapshot.settings.smsEnabled} configured={readiness.smsConfigured} otpConfigured={readiness.otpConfigured} />
            </div>
            <label className={styles.toggleRow} htmlFor="registration-sms-enabled">
              <span><strong>ثبت‌نام با شمارهٔ موبایل</strong><small>پس از تکمیل تنظیمات، این گزینه را فعال و ذخیره کنید.</small></span>
              <input id="registration-sms-enabled" type="checkbox" role="switch" checked={draft.smsEnabled} disabled={!!busy || (!draft.smsEnabled && !readiness.otpConfigured)} onChange={event => setField('smsEnabled', event.target.checked)} />
            </label>
            <div className={styles.twoFields}>
              <div className={styles.field}>
                <label htmlFor="registration-sms-provider">سرویس پیامک</label>
                <EnhancedSelect id="registration-sms-provider" value={draft.smsProvider} disabled={!!busy} onChange={event => setField('smsProvider', event.target.value as Draft['smsProvider'])}>
                  <option value="kavenegar">کاوه‌نگار</option>
                  <option value="custom">API دلخواه</option>
                </EnhancedSelect>
              </div>
              <div className={styles.field}>
                <label htmlFor="registration-sms-template">نام الگوی پیامک{draft.smsProvider === 'custom' ? ' (در صورت نیاز)' : ''}</label>
                <input id="registration-sms-template" className="input-field" dir="ltr" value={draft.smsTemplate} disabled={!!busy} maxLength={100} autoComplete="off" onChange={event => setField('smsTemplate', event.target.value)} />
              </div>
            </div>

            <div className={localStyles.secretPanel}>
              <div className={styles.field}>
                <label htmlFor="registration-sms-api-key">کلید API پیامک</label>
                <input id="registration-sms-api-key" type="password" className="input-field" dir="ltr" value={smsApiKey} disabled={!!busy || !readiness.settingsEncryptionConfigured} autoComplete="new-password" maxLength={2048}
                  placeholder={readiness.smsStoredKeyConfigured && !clearSmsApiKey ? 'برای جایگزینی، کلید جدید را وارد کنید' : 'کلید دریافتی از سرویس پیامک'}
                  onChange={event => { setSmsApiKey(event.target.value); setClearSmsApiKey(false); setNotice('') }} aria-describedby="registration-sms-key-help" />
                <small id="registration-sms-key-help" className={styles.paletteHelp}>
                  {clearSmsApiKey ? 'کلید ذخیره‌شده با ذخیرهٔ تنظیمات حذف می‌شود.' : readiness.smsStoredKeyConfigured ? 'کلید ذخیره شده است. خالی گذاشتن این فیلد آن را حفظ می‌کند.' : draft.smsProvider === 'kavenegar' && readiness.smsEnvironmentKeyConfigured ? 'کلید کاوه‌نگار از تنظیمات سرور خوانده می‌شود. می‌توانید اینجا کلید دیگری ذخیره کنید.' : 'کلید پس از ذخیره نمایش داده نمی‌شود.'}
                </small>
              </div>
              {readiness.smsStoredKeyConfigured && <button type="button" className={localStyles.removeSecret} disabled={!!busy} onClick={() => { setClearSmsApiKey(!clearSmsApiKey); setSmsApiKey(''); setNotice('') }}>
                {clearSmsApiKey ? <RefreshCw size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
                {clearSmsApiKey ? 'حفظ کلید ذخیره‌شده' : 'حذف کلید ذخیره‌شده'}
              </button>}
              {!readiness.settingsEncryptionConfigured && <p className={styles.error}>برای ذخیرهٔ کلید، متغیر <bdi>REGISTRATION_SETTINGS_SECRET</bdi> یا <bdi>AUTH_SECRET</bdi> را با حداقل ۳۲ نویسه در سرور تنظیم کنید.</p>}
              {!readiness.smsSecretsReadable && <p className={styles.error}>کلید یا هدرهای ذخیره‌شده قابل خواندن نیستند. کلید رمزگذاری قبلی سرور را بازیابی یا مشخصات سرویس را دوباره وارد کنید.</p>}
            </div>

            {draft.smsProvider === 'custom' ? <>
              <div className={styles.field}>
                <label htmlFor="registration-sms-api-url">آدرس API</label>
                <input id="registration-sms-api-url" type="url" className="input-field" dir="ltr" value={draft.smsApiUrl} disabled={!!busy} maxLength={2048} placeholder="https://sms.example.com/v1/verify" onChange={event => setField('smsApiUrl', event.target.value)} />
                <small className={styles.paletteHelp}>آدرس عمومی سرویس را با HTTPS وارد کنید. برای کلید داخل آدرس از <bdi>{'{{apiKey}}'}</bdi> استفاده کنید.</small>
              </div>
              <div className={styles.twoFields}>
                <div className={styles.field}>
                  <label htmlFor="registration-sms-method">روش درخواست</label>
                  <EnhancedSelect id="registration-sms-method" dir="ltr" value={draft.smsMethod} disabled={!!busy} onChange={event => setField('smsMethod', event.target.value as Draft['smsMethod'])}>
                    <option value="POST">POST</option><option value="GET">GET</option>
                  </EnhancedSelect>
                </div>
                {draft.smsMethod === 'POST' && <div className={styles.field}>
                  <label htmlFor="registration-sms-format">قالب بدنهٔ درخواست</label>
                  <EnhancedSelect id="registration-sms-format" dir="ltr" value={draft.smsBodyFormat} disabled={!!busy} onChange={event => setField('smsBodyFormat', event.target.value as Draft['smsBodyFormat'])}>
                    <option value="json">JSON</option><option value="form">Form URL encoded</option>
                  </EnhancedSelect>
                </div>}
              </div>

              <div className={localStyles.headerSection}>
                <div className={localStyles.headerTitle}><h3>هدرهای درخواست</h3>
                  <button type="button" className={localStyles.addHeader} disabled={!!busy || draft.smsHeaders.length >= 20} onClick={() => setField('smsHeaders', [...draft.smsHeaders, { id: Math.max(-1, ...draft.smsHeaders.map(header => header.id)) + 1, name: '', value: '', configured: false }])}>
                    <Plus size={15} aria-hidden="true" />افزودن هدر
                  </button>
                </div>
                <p className={styles.paletteHelp}>مثلاً نام <bdi>Authorization</bdi> و مقدار <bdi>{'Bearer {{apiKey}}'}</bdi>. مقدار هدرهای ذخیره‌شده با خالی گذاشتن فیلد حفظ می‌شود.</p>
                {draft.smsHeaders.map((header, index) => (
                  <div key={header.id} className={localStyles.headerRow}>
                    <div className={localStyles.headerFields}>
                      <div className={styles.field}>
                        <label htmlFor={`registration-header-name-${header.id}`}>نام هدر {(index + 1).toLocaleString('fa-IR')}</label>
                        <input id={`registration-header-name-${header.id}`} className="input-field" dir="ltr" value={header.name} disabled={!!busy} maxLength={100} autoComplete="off" placeholder="Authorization" onChange={event => changeHeader(header.id, 'name', event.target.value)} />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor={`registration-header-value-${header.id}`}>مقدار هدر</label>
                        <input id={`registration-header-value-${header.id}`} type="password" className="input-field" dir="ltr" value={header.value} disabled={!!busy || !readiness.settingsEncryptionConfigured} maxLength={4000} autoComplete="new-password" placeholder={header.configured ? 'مقدار ذخیره شده است' : 'Bearer {{apiKey}}'} onChange={event => changeHeader(header.id, 'value', event.target.value)} />
                      </div>
                    </div>
                    <button type="button" className={localStyles.removeHeader} disabled={!!busy} aria-label={`حذف هدر ${(index + 1).toLocaleString('fa-IR')}`} onClick={() => setField('smsHeaders', draft.smsHeaders.filter(item => item.id !== header.id))}><X size={16} aria-hidden="true" /></button>
                  </div>
                ))}
              </div>

              {draft.smsMethod === 'POST' && <div className={styles.field}>
                <label htmlFor="registration-sms-body">بدنهٔ درخواست</label>
                <textarea id="registration-sms-body" className={`input-field ${localStyles.templateInput}`} dir="ltr" value={draft.smsBodyTemplate} disabled={!!busy} maxLength={16384} spellCheck={false} onChange={event => setField('smsBodyTemplate', event.target.value)} />
                <small className={styles.paletteHelp}>ساختار را به‌صورت یک شیء JSON وارد کنید. در حالت Form، همین فیلدها به فرم تبدیل می‌شوند.</small>
              </div>}
              <p className={localStyles.templateHelp}>جای‌گذاری‌ها در آدرس، هدرها و بدنه قابل استفاده‌اند. <bdi>{'{{phone}}'}</bdi> شمارهٔ موبایل، <bdi>{'{{code}}'}</bdi> کد تأیید، <bdi>{'{{template}}'}</bdi> نام الگو و <bdi>{'{{apiKey}}'}</bdi> کلید ذخیره‌شده است.</p>

              <div className={styles.twoFields}>
                <div className={styles.field}>
                  <label htmlFor="registration-sms-success-path">مسیر نتیجهٔ موفق در پاسخ (اختیاری)</label>
                  <input id="registration-sms-success-path" className="input-field" dir="ltr" value={draft.smsSuccessPath} disabled={!!busy} maxLength={200} placeholder="return.status" onChange={event => setField('smsSuccessPath', event.target.value)} />
                </div>
                <div className={styles.field}>
                  <label htmlFor="registration-sms-success-value">مقدار مورد انتظار</label>
                  <input id="registration-sms-success-value" className="input-field" dir="ltr" value={draft.smsSuccessValue} disabled={!!busy || !draft.smsSuccessPath.trim()} maxLength={500} placeholder="200" onChange={event => setField('smsSuccessValue', event.target.value)} />
                </div>
              </div>
              <p className={styles.paletteHelp}>مسیر خالی یعنی پاسخ HTTP از گروه ۲۰۰ موفق است. برای بررسی نتیجهٔ JSON، مثلاً مسیر <bdi>return.status</bdi> و مقدار <bdi>200</bdi> را وارد کنید. مقدار متنی باید داخل علامت نقل‌قول باشد.</p>
            </> : <p className={styles.paletteHelp}>در الگوی تأیید کاوه‌نگار، <bdi>%token</bdi> را برای کد قرار دهید. کلید را می‌توانید در همین صفحه ذخیره کنید.</p>}
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
