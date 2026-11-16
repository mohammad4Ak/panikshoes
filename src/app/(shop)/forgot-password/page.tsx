'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, Clock3, Mail, PencilLine, RotateCw, Smartphone } from 'lucide-react'
import AuthShell from '@/components/shop/AuthShell'
import { normalizeContactDigits, normalizeLoginPhone } from '@/lib/customer-contact'
import styles from '@/components/shop/account.module.css'
import local from './recovery.module.css'

type Channel = 'email' | 'sms'
type Availability = { enabled: boolean; emailEnabled: boolean; smsEnabled: boolean; expiryMinutes: number; resendSeconds: number }
type Challenge = { id: string; destination: string; expiresAt: number }
const labels = { email: 'ایمیل', sms: 'شمارهٔ موبایل' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const genericNotice = 'اگر حساب فعالی با این مشخصات وجود داشته باشد، کد بازیابی برای آن ارسال می‌شود.'
const digits = (value: string) => normalizeContactDigits(value).replace(/\D/g, '')
const countdown = (seconds: number) => `${Math.floor(seconds / 60).toLocaleString('fa-IR')}:${(seconds % 60).toLocaleString('fa-IR', { minimumIntegerDigits: 2 })}`
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function validAvailability(value: unknown): value is Availability {
  return record(value) && ['enabled', 'emailEnabled', 'smsEnabled'].every(key => typeof value[key] === 'boolean') &&
    Number.isInteger(value.expiryMinutes) && Number(value.expiryMinutes) >= 1 && Number(value.expiryMinutes) <= 10 &&
    Number.isInteger(value.resendSeconds) && Number(value.resendSeconds) >= 15 && Number(value.resendSeconds) <= 300
}
function deadline(value: unknown, offset: number, now: number, maximum: number): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(now, Math.min(parsed + offset, now + maximum))
}

export default function ForgotPasswordPage() {
  const [availability, setAvailability] = useState<Availability | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [channel, setChannel] = useState<Channel>('email')
  const [destination, setDestination] = useState('')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(0)
  const [code, setCode] = useState('')
  const [caret, setCaret] = useState(0)
  const [codeError, setCodeError] = useState<{ message: string; attempt: number } | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState<'request' | 'reset' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [success, setSuccess] = useState(false)
  const request = useRef<AbortController | null>(null), mounted = useRef(true), revision = useRef(0), attempts = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current?.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = setTimeout(() => controller.abort(), 15000)
    void (async () => {
      try {
        const response = await fetch('/api/auth/password-reset', { cache: 'no-store', signal: controller.signal })
        const data: unknown = await response.json().catch(() => null)
        if (!response.ok || !validAvailability(data)) throw new Error('Invalid recovery methods')
        if (!active || controller.signal.aborted) return
        setAvailability(data); setLoadFailed(false); setChannel(data.emailEnabled ? 'email' : 'sms')
      } catch { if (active && mounted.current) setLoadFailed(true) }
      finally { clearTimeout(timeout) }
    })()
    return () => { active = false; controller.abort(); clearTimeout(timeout) }
  }, [loadAttempt])

  const lastDeadline = Math.max(challenge?.expiresAt ?? 0, resendAt)
  useEffect(() => {
    if (now >= lastDeadline) return
    const timer = window.setTimeout(() => setNow(Date.now()), 1000)
    return () => window.clearTimeout(timer)
  }, [now, lastDeadline])
  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const expirySeconds = Math.max(0, Math.ceil(((challenge?.expiresAt ?? 0) - now) / 1000))
  const available = availability?.enabled && (availability.emailEnabled || availability.smsEnabled)

  function clearSecrets() { setCode(''); setCaret(0); setCodeError(null); setNewPassword(''); setConfirmPassword('') }
  function changeCode(value: string, position: number) { setCode(digits(value).slice(0, 6)); setCaret(digits(value.slice(0, position)).length); setCodeError(null) }
  function editDestination(nextChannel = channel) {
    if (busy === 'reset') return
    revision.current++; request.current?.abort(); request.current = null
    setBusy(null); setChallenge(null); clearSecrets(); setError(''); setNotice(''); setResendAt(0)
    if (nextChannel !== channel) { setChannel(nextChannel); setDestination('') }
  }
  function retryAvailability() {
    if (request.current) return
    setAvailability(null); setLoadFailed(false); setChallenge(null); clearSecrets(); setLoadAttempt(value => value + 1)
  }
  function deactivate() { setChallenge(null); clearSecrets(); setAvailability(null); setLoadFailed(false); setLoadAttempt(value => value + 1) }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault()
    if (request.current || !available || success || resendSeconds > 0) return
    const recipient = challenge?.destination ?? (channel === 'email' ? destination.trim().toLowerCase() : normalizeLoginPhone(destination))
    if (!recipient || (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) { setError(`لطفاً ${labels[channel]} معتبر وارد کن.`); return }
    const controller = new AbortController(), currentRevision = revision.current
    request.current = controller; setBusy('request'); setError(''); setNotice(''); clearSecrets()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/auth/password-reset/code', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, destination: recipient }), signal: controller.signal })
      const data: unknown = await response.json().catch(() => null)
      if (!mounted.current || currentRevision !== revision.current) return
      const localNow = Date.now(), serverNow = Date.parse(response.headers.get('Date') ?? '')
      const offset = Number.isFinite(serverNow) ? localNow - serverNow : 0
      setNow(localNow)
      if (!response.ok) {
        const retryAt = record(data) ? deadline(data.retryAt, offset, localNow, 3601000) : null
        if (retryAt !== null) setResendAt(retryAt)
        if (response.status === 503) deactivate()
        throw new Error(record(data) && typeof data.error === 'string' ? data.error : 'دریافت کد ممکن نشد. دوباره تلاش کن.')
      }
      const expiresAt = record(data) ? deadline(data.expiresAt, offset, localNow, 601000) : null
      const nextSendAt = record(data) ? deadline(data.resendAt, offset, localNow, 301000) : null
      if (!record(data) || typeof data.challengeId !== 'string' || !uuid.test(data.challengeId) || expiresAt === null || nextSendAt === null) throw new Error('پاسخ کامل دریافت نشد؛ دوباره درخواست کد بده.')
      setChallenge({ id: data.challengeId, destination: recipient, expiresAt }); setResendAt(nextSendAt); setNotice(genericNotice)
    } catch (cause) {
      if (mounted.current && currentRevision === revision.current) setError(controller.signal.aborted ? 'دریافت پاسخ بیش از حد طول کشید؛ دوباره درخواست کد بده.' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.')
    } finally {
      clearTimeout(timeout)
      if (request.current === controller) { request.current = null; if (mounted.current) setBusy(null) }
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault()
    if (request.current || !challenge || success || !available || expirySeconds === 0) return
    setError('')
    if (code.length !== 6) { setError('کد بازیابی ۶ رقمی را وارد کن.'); return }
    if (newPassword.length < 6 || new TextEncoder().encode(newPassword).length > 72) { setError('رمز جدید باید حداقل ۶ کاراکتر و حداکثر ۷۲ بایت باشد.'); return }
    if (newPassword !== confirmPassword) { setError('رمز جدید و تکرار آن یکسان نیستند.'); return }
    const controller = new AbortController(), currentRevision = revision.current
    request.current = controller; setBusy('reset'); setCodeError(null)
    const timeout = setTimeout(() => controller.abort(), 15000)
    let uncertain = true, invalidCode = false
    try {
      const response = await fetch('/api/auth/password-reset', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.id, code, newPassword, confirmPassword }), signal: controller.signal })
      const data: unknown = await response.json().catch(() => null)
      if (!mounted.current || currentRevision !== revision.current) return
      if (!response.ok) {
        uncertain = response.status >= 500
        if (record(data) && data.code === 'INVALID_PASSWORD_RESET_CODE') { invalidCode = true; setCodeError({ attempt: ++attempts.current, message: typeof data.error === 'string' ? data.error : 'کد بازیابی نامعتبر است یا اعتبار آن تمام شده است.' }) }
        const localNow = Date.now(), serverNow = Date.parse(response.headers.get('Date') ?? '')
        const retryAt = record(data) ? deadline(data.retryAt, Number.isFinite(serverNow) ? localNow - serverNow : 0, localNow, 3601000) : null
        if (retryAt !== null) { setNow(localNow); setResendAt(retryAt) }
        if (response.status === 503) deactivate()
        throw new Error(record(data) && typeof data.error === 'string' ? data.error : 'بازیابی رمز انجام نشد. دوباره تلاش کن.')
      }
      if (!record(data) || data.success !== true) throw new Error('Incomplete reset response')
      setSuccess(true); setNotice(''); setError(''); setNewPassword(''); setConfirmPassword(''); setCodeError(null)
    } catch (cause) {
      if (mounted.current && currentRevision === revision.current) {
        if (uncertain) { clearSecrets(); setChallenge(previous => previous ? { ...previous, expiresAt: Date.now() } : null); setNow(Date.now()); setError('پاسخ کامل دریافت نشد؛ ممکن است رمز تغییر کرده باشد. با رمز جدید وارد شو یا کد تازه بگیر.') }
        else setError(invalidCode ? '' : cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.')
      }
    } finally { clearTimeout(timeout); if (request.current === controller) { request.current = null; if (mounted.current) setBusy(null) } }
  }

  const slots = <div key={success ? 'accepted' : codeError?.attempt ?? 0} className={styles.codeSlots} data-feedback={success ? 'accepted' : codeError ? 'rejected' : undefined} aria-hidden="true" dir="ltr">{Array.from({ length: 6 }, (_, index) => <span key={index} className={styles.codeSlot} data-current={!success && index === Math.min(caret, 5) || undefined}>{code[index] ?? ''}</span>)}</div>

  return <AuthShell breadcrumb="بازیابی رمز عبور">
    <h1>بازیابی رمز عبور</h1>
    <p className={styles.authIntro}>با کد یک‌بارمصرف، رمز تازه‌ای برای حسابت انتخاب کن.</p>
    {error && <div role="alert" className={styles.alert}>{error}</div>}
    {success ? <div className={local.success} role="status">{slots}<p><Check size={20} aria-hidden="true" />رمز عبورت تغییر کرد.</p><span>برای ادامه با رمز جدید وارد شو. نشست‌های قبلی حسابت بسته شده‌اند.</span><Link href="/login" className="btn-primary w-full">ورود با رمز جدید<ArrowLeft size={18} /></Link></div>
      : loadFailed ? <div role="alert" className={styles.alert}><p>روش‌های بازیابی بارگذاری نشدند.</p><button type="button" className={local.retry} onClick={retryAvailability}>تلاش دوباره</button></div>
        : !availability ? <p role="status" className={styles.authIntro}>در حال بررسی روش‌های بازیابی…</p>
          : !available ? <p role="status" className={styles.authIntro}>بازیابی رمز عبور در حال حاضر در دسترس نیست. کمی بعد دوباره تلاش کن.</p>
            : !challenge ? <form onSubmit={requestCode} className={styles.authForm}>
              {availability.emailEnabled && availability.smsEnabled && <div className={local.channels} role="group" aria-label="روش دریافت کد بازیابی">{(['email', 'sms'] as const).map(method => <button key={method} type="button" aria-pressed={channel === method} disabled={busy !== null} className={channel === method ? styles.pillLink : styles.softLink} onClick={() => editDestination(method)}>{labels[method]}</button>)}</div>}
              <div><label htmlFor="recovery-destination">{labels[channel]}</label><input id="recovery-destination" type={channel === 'email' ? 'email' : 'tel'} autoComplete={channel === 'email' ? 'email' : 'tel'} autoCapitalize="none" spellCheck={false} maxLength={channel === 'email' ? 254 : 30} value={destination} onChange={event => { setDestination(event.target.value); setError('') }} disabled={busy !== null} className="input-field" dir="ltr" placeholder={channel === 'email' ? 'email@example.com' : '09123456789'} required /></div>
              <p className={local.hint}>{channel === 'email' ? 'ایمیلی را وارد کن که با آن حساب ساخته‌ای.' : 'شماره‌ای را وارد کن که با کد پیامکی برای ورود به حسابت تأیید کرده‌ای.'}</p>
              <button type="submit" className="btn-primary w-full" disabled={busy !== null || resendSeconds > 0}>{busy ? 'در حال بررسی…' : resendSeconds > 0 ? <>درخواست دوباره تا <bdi>{countdown(resendSeconds)}</bdi></> : 'دریافت کد بازیابی'}<ArrowLeft size={18} /></button>
            </form> : <form onSubmit={resetPassword} className={styles.authForm}>
              <div className={styles.verificationInfo}><div className={styles.verificationHeading}><p>{channel === 'email' ? <Mail size={16} /> : <Smartphone size={16} />}درخواست کد بازیابی</p><button type="button" className={styles.verificationEdit} disabled={busy === 'reset'} onClick={() => editDestination()} aria-label={`ویرایش ${labels[channel]}`}><PencilLine size={14} />ویرایش</button></div><bdi className={styles.verificationDestination}>{challenge.destination}</bdi><p className={local.genericNotice} role="status">{notice || genericNotice}</p><div className={styles.verificationFooter}><p className={styles.verificationExpiry} data-expired={expirySeconds === 0 || undefined}><Clock3 size={14} /><span>{expirySeconds > 0 ? 'اعتبار کد' : 'اعتبار کد تمام شد'}</span>{expirySeconds > 0 && <bdi>{countdown(expirySeconds)}</bdi>}</p><button type="button" className={styles.verificationResend} disabled={busy !== null || resendSeconds > 0} onClick={() => void requestCode()}><RotateCw size={14} />{resendSeconds > 0 ? <>ارسال دوباره <bdi>{countdown(resendSeconds)}</bdi></> : 'ارسال دوبارهٔ کد'}</button></div></div>
              <div><label htmlFor="recovery-code">کد بازیابی ۶ رقمی</label><div className={styles.codeEntry} dir="ltr">{slots}<input id="recovery-code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => changeCode(event.target.value, event.target.selectionStart ?? event.target.value.length)} onPaste={event => { const pasted = digits(event.clipboardData.getData('text')); if (pasted.length === 6) { event.preventDefault(); changeCode(pasted, 6) } }} onSelect={event => setCaret(event.currentTarget.selectionStart ?? code.length)} onClick={event => { if (event.detail !== 1) return; const input = event.currentTarget, box = input.getBoundingClientRect(); const position = Math.max(0, Math.min(Math.floor((event.clientX - box.left) * 6 / box.width), code.length)); input.setSelectionRange(position, Math.min(position + 1, code.length)); setCaret(position) }} className={styles.codeInput} readOnly={busy !== null} required aria-invalid={!!codeError} aria-describedby={codeError ? 'recovery-code-error' : undefined} /></div>{codeError && <p id="recovery-code-error" className={styles.codeError} role="alert">{codeError.message}</p>}</div>
              <div><label htmlFor="recovery-password">رمز عبور جدید</label><input id="recovery-password" type="password" autoComplete="new-password" minLength={6} value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={busy !== null} className="input-field" dir="ltr" required aria-describedby="recovery-password-hint" /><small id="recovery-password-hint">حداقل ۶ کاراکتر انتخاب کن.</small></div>
              <div><label htmlFor="recovery-confirm">تکرار رمز جدید</label><input id="recovery-confirm" type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={busy !== null} className="input-field" dir="ltr" required /></div>
              <button type="submit" className="btn-primary w-full" disabled={busy !== null || expirySeconds === 0}>{busy === 'reset' ? 'در حال تغییر رمز…' : 'ثبت رمز جدید'}<ArrowLeft size={18} /></button>
            </form>}
    <p className={styles.authFooter}><Link href="/login">بازگشت به ورود</Link></p>
  </AuthShell>
}
