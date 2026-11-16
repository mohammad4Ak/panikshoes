'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, Mail, RefreshCw, Save, Smartphone } from 'lucide-react'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import type { PasswordResetAdminSnapshot, PasswordResetSettings } from '@/lib/password-reset-settings'
import admin from '@/components/admin/admin.module.css'
import styles from './password-reset.module.css'

const limits = [
  { key: 'expiryMinutes', label: 'اعتبار کد (دقیقه)', minimum: 1, maximum: 10, help: 'بین ۱ تا ۱۰ دقیقه' },
  { key: 'maxAttempts', label: 'حداکثر تلاش برای هر کد', minimum: 1, maximum: 10, help: 'بین ۱ تا ۱۰ تلاش' },
  { key: 'resendSeconds', label: 'فاصلهٔ ارسال دوباره (ثانیه)', minimum: 15, maximum: 300, help: 'بین ۱۵ تا ۳۰۰ ثانیه' },
  { key: 'destinationHourlyLimit', label: 'درخواست ساعتی برای هر مقصد', minimum: 1, maximum: 20, help: 'بین ۱ تا ۲۰ درخواست برای هر ایمیل یا شماره' },
  { key: 'ipHourlyLimit', label: 'درخواست ساعتی برای هر IP', minimum: 1, maximum: 100, help: 'بین ۱ تا ۱۰۰ درخواست برای هر آدرس شبکه' },
] as const
type LimitKey = typeof limits[number]['key']
type Draft = Omit<PasswordResetSettings, LimitKey> & Record<LimitKey, string>
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function validSnapshot(value: unknown): value is PasswordResetAdminSnapshot {
  if (!record(value) || !record(value.settings) || !record(value.readiness)) return false
  const { settings, readiness } = value
  return Number.isSafeInteger(settings.version) && Number(settings.version) >= 0 &&
    ['enabled', 'emailEnabled', 'smsEnabled'].every(key => typeof settings[key] === 'boolean') &&
    limits.every(({ key, minimum, maximum }) => Number.isInteger(settings[key]) && Number(settings[key]) >= minimum && Number(settings[key]) <= maximum) &&
    ['emailConfigured', 'smsConfigured', 'otpConfigured'].every(key => typeof readiness[key] === 'boolean')
}
function makeDraft(settings: PasswordResetSettings): Draft {
  return { ...settings, expiryMinutes: String(settings.expiryMinutes), maxAttempts: String(settings.maxAttempts), resendSeconds: String(settings.resendSeconds), destinationHourlyLimit: String(settings.destinationHourlyLimit), ipHourlyLimit: String(settings.ipHourlyLimit) }
}

export default function AdminPasswordResetPage() {
  const [snapshot, setSnapshot] = useState<PasswordResetAdminSnapshot | null>(null)
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
      const response = await fetch('/api/admin/password-reset-settings', {
        method: form ? 'PATCH' : 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        ...(form && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          version: form.version, enabled: form.enabled, emailEnabled: form.emailEnabled, smsEnabled: form.smsEnabled,
          ...Object.fromEntries(limits.map(({ key }) => [key, Number(form[key])])),
        }) }),
      })
      const data: unknown = await response.json().catch(() => null)
      if (!mounted.current || request.current !== controller) return
      controller.signal.throwIfAborted()
      if (!response.ok) { if (response.status === 409 || form && response.status >= 500) setConflict(true); throw new Error(record(data) && typeof data.error === 'string' ? data.error : 'تنظیمات بازیابی دریافت یا ذخیره نشد.') }
      if (!validSnapshot(data)) { if (form) setConflict(true); throw new Error('پاسخ کامل تنظیمات دریافت نشد. آخرین تنظیمات را دوباره بگیر.') }
      setSnapshot(data); setDraft(makeDraft(data.settings)); setConflict(false)
      if (form) setNotice('تنظیمات بازیابی رمز عبور ذخیره شد.')
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
    for (const { key, minimum, maximum, label } of limits) {
      if (!/^\d+$/.test(draft[key]) || Number(draft[key]) < minimum || Number(draft[key]) > maximum) { setError(`${label} خارج از محدودهٔ مجاز است.`); return }
    }
    await requestSettings(draft)
  }
  function status(channel: 'email' | 'sms') {
    if (!draft || !snapshot) return ''
    const ready = snapshot.readiness.otpConfigured && (channel === 'email' ? snapshot.readiness.emailConfigured : snapshot.readiness.smsConfigured)
    const active = snapshot.settings.enabled && (channel === 'email' ? snapshot.settings.emailEnabled : snapshot.settings.smsEnabled) && ready
    if (!draft.enabled || !(channel === 'email' ? draft.emailEnabled : draft.smsEnabled)) return active ? 'پس از ذخیره غیرفعال می‌شود' : 'غیرفعال'
    return ready ? active ? 'فعال در سایت' : 'پس از ذخیره فعال می‌شود' : 'نیاز به تنظیم سرویس'
  }

  return <div>
    <div className={admin.pageHeader}><div><span className={admin.eyebrow}>امنیت حساب مشتریان</span><h1>بازیابی رمز عبور</h1><p>روش دریافت کد و محدودیت‌های بازیابی را مدیریت کن.</p></div><Link href="/admin/registration" className="btn-outline">تنظیم سرویس ایمیل و پیامک</Link></div>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {busy === 'loading' && !draft ? <p role="status" className={styles.loading}>در حال دریافت تنظیمات بازیابی…</p> : !draft || !snapshot ? <button type="button" className="btn-outline" disabled={busy !== null} onClick={() => void requestSettings()}><RefreshCw size={16} />تلاش دوباره</button> : <form onSubmit={submit} className={styles.form}>
      <section className={styles.section} aria-labelledby="recovery-policy-title"><div className={styles.heading}><KeyRound size={22} /><div><h2 id="recovery-policy-title">دسترسی کاربران به بازیابی</h2><p>پس از تغییر این تنظیمات، کاربران برای ادامه باید کد تازه‌ای دریافت کنند.</p></div></div>
        <label className={styles.toggle}><span><strong>بازیابی رمز توسط کاربر</strong><small>با خاموش‌کردن این گزینه، دریافت کد و ثبت رمز جدید از مسیر بازیابی متوقف می‌شود.</small></span><input type="checkbox" role="switch" aria-label="بازیابی رمز توسط کاربر" checked={draft.enabled} disabled={busy !== null} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /></label>
        {!snapshot.readiness.otpConfigured && <p className={styles.warning}>تنظیم امنیتی سرور کامل نیست؛ تا تکمیل آن، بازیابی رمز در سایت فعال نمی‌شود.</p>}
        <div className={styles.channels}>
          <label className={styles.channel}><div className={styles.channelHeading}><Mail size={21} /><strong>بازیابی با ایمیل</strong><input type="checkbox" aria-label="بازیابی با ایمیل" checked={draft.emailEnabled} disabled={busy !== null} onChange={event => setDraft({ ...draft, emailEnabled: event.target.checked })} /></div><span className={styles.badge}>{status('email')}</span><p>کد به ایمیل ثبت‌شدهٔ حساب ارسال می‌شود. تنظیم سرویس و فرستنده از بخش ثبت‌نام و تأیید حساب خوانده می‌شود.</p></label>
          <label className={styles.channel}><div className={styles.channelHeading}><Smartphone size={21} /><strong>بازیابی با پیامک</strong><input type="checkbox" aria-label="بازیابی با پیامک" checked={draft.smsEnabled} disabled={busy !== null} onChange={event => setDraft({ ...draft, smsEnabled: event.target.checked })} /></div><span className={styles.badge}>{status('sms')}</span><p>فقط شمارهٔ موبایل تأییدشده برای ورود قابل استفاده است؛ شمارهٔ تماس سفارش به‌تنهایی برای بازیابی کافی نیست.</p></label>
        </div>
        <p className={styles.help}>فعال‌بودن روش‌های بازیابی مستقل از فعال‌بودن ثبت‌نام است. پیامک تا تکمیل سرویس و فعال‌سازی در همین صفحه در دسترس کاربران قرار نمی‌گیرد.</p>
      </section>
      <section className={styles.section} aria-labelledby="recovery-limits-title"><h2 id="recovery-limits-title">اعتبار کد و محدودیت درخواست‌ها</h2><div className={styles.limitGrid}>{limits.map(({ key, label, minimum, maximum, help }) => <div className={styles.field} key={key}><label htmlFor={`recovery-setting-${key}`}>{label}</label><FormattedNumberInput id={`recovery-setting-${key}`} value={draft[key]} min={minimum} max={maximum} required disabled={busy !== null} onValueChange={value => setDraft({ ...draft, [key]: value })} className="input-field" /><small>{help}</small></div>)}</div><p className={styles.help}>کدها یک‌بارمصرف هستند و محدودیت‌ها در سرور بررسی می‌شوند. تغییر موفق رمز، همهٔ نشست‌های قبلی حساب را می‌بندد.</p></section>
      {conflict && <div role="status" className={styles.warning}>ممکن است نسخهٔ ذخیره‌شده تغییر کرده باشد. برای ادامه، آخرین تنظیمات را دریافت کن؛ پیش‌نویس این صفحه با نسخهٔ ذخیره‌شده جایگزین می‌شود.</div>}
      <div className={styles.actions}><button type="submit" className="btn-primary" disabled={busy !== null || conflict}><Save size={17} />{busy === 'saving' ? 'در حال ذخیره…' : 'ذخیره تنظیمات بازیابی'}</button><button type="button" className="btn-outline" disabled={busy !== null} onClick={() => void requestSettings()}><RefreshCw size={17} />دریافت آخرین تنظیمات</button></div>
    </form>}
  </div>
}
