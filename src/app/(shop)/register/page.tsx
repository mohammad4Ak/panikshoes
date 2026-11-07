'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signInWithSessionLock as signIn } from '@/lib/session-actions'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AuthShell from '@/components/shop/AuthShell'
import styles from '@/components/shop/account.module.css'
import { requestSession } from '@/lib/session-client'
import { isValidCustomerPhone, isValidPostalCode, normalizeContactDigits, normalizeLoginPhone, normalizePhone, normalizePostalCode } from '@/lib/customer-contact'

type Channel = 'email' | 'sms'
interface Availability { emailEnabled: boolean; smsEnabled: boolean }
interface Challenge { id: string; destination: string; expiresAt: number }

const channelLabels = { email: 'ایمیل', sms: 'شماره موبایل' }
const autoLoginError = 'حسابت ساخته شد، اما ورود خودکار کامل نشد. از صفحه ورود وارد حسابت شو.'
const codeLength = 6

function codeDigits(value: string) {
  return normalizeContactDigits(value).replace(/\D/g, '')
}

function countdown(seconds: number) {
  const minutes = Math.floor(seconds / 60).toLocaleString('fa-IR')
  const remainder = (seconds % 60).toLocaleString('fa-IR', { minimumIntegerDigits: 2 })
  return `${minutes}:${remainder}`
}

export default function RegisterPage() {
  const [availability, setAvailability] = useState<Availability | null>(null)
  const [availabilityFailed, setAvailabilityFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [channel, setChannel] = useState<Channel>('email')
  const [destination, setDestination] = useState('')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(0)
  const [code, setCode] = useState('')
  const [codeCaret, setCodeCaret] = useState(0)
  const [codeError, setCodeError] = useState<{ message: string; attempt: number } | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    phone: null as string | null,
    postalCode: '',
    password: '',
    confirmPassword: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [registered, setRegistered] = useState(false)
  const submitting = useRef(false)
  const codeAttempts = useRef(0)
  const router = useRouter()

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/auth/register', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('Registration methods unavailable')
        const data = await response.json()
        if (typeof data.emailEnabled !== 'boolean' || typeof data.smsEnabled !== 'boolean') throw new Error('Invalid registration methods')
        if (controller.signal.aborted) return
        setAvailability(data)
        setChannel(data.emailEnabled ? 'email' : 'sms')
      } catch {
        if (!controller.signal.aborted) setAvailabilityFailed(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [loadAttempt])

  const deadline = Math.max(challenge?.expiresAt ?? 0, resendAt)
  useEffect(() => {
    if (now >= deadline) return
    const timer = window.setTimeout(() => setNow(Date.now()), 1_000)
    return () => window.clearTimeout(timer)
  }, [now, deadline])

  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1_000))
  const expirySeconds = Math.max(0, Math.ceil(((challenge?.expiresAt ?? 0) - now) / 1_000))
  const contactPhone = formData.phone ?? (channel === 'sms' ? challenge?.destination ?? '' : '')

  function changeDestination(value: string) {
    setDestination(value)
    setError('')
    setResendAt(0)
  }

  function changeCode(value: string, caret = 0) {
    setCode(codeDigits(value).slice(0, codeLength))
    setCodeCaret(codeDigits(value.slice(0, caret)).length)
    setCodeError(null)
  }

  async function requestCode(event?: React.FormEvent) {
    event?.preventDefault()
    if (submitting.current || resendSeconds > 0) return
    const recipient = challenge?.destination ?? (channel === 'email' ? destination.trim().toLowerCase() : normalizeLoginPhone(destination))
    if (!recipient) {
      setError(channel === 'email' ? 'ایمیل را وارد کن.' : 'شماره موبایل را به‌درستی وارد کن.')
      return
    }

    submitting.current = true
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/auth/register/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, destination: recipient }),
      })
      const data = await response.json()
      const localTime = Date.now()
      const serverTime = Date.parse(response.headers.get('Date') ?? '')
      const clockOffset = Number.isFinite(serverTime) ? localTime - serverTime : 0
      setNow(localTime)
      if (!response.ok) {
        const retryAt = Date.parse(data.retryAt)
        if (Number.isFinite(retryAt)) setResendAt(retryAt + clockOffset)
        if (response.status === 409) {
          setChallenge(null)
          changeCode('')
        } else if (challenge && response.status === 502) {
          setChallenge({ ...challenge, expiresAt: localTime })
          changeCode('')
        }
        setError(data.error || 'ارسال کد ممکن نشد. دوباره تلاش کن.')
        return
      }
      const expiresAt = Date.parse(data.expiresAt)
      const nextSendAt = Date.parse(data.resendAt)
      if (typeof data.challengeId !== 'string' || !data.challengeId || !Number.isFinite(expiresAt) || !Number.isFinite(nextSendAt)) {
        throw new Error('Invalid registration challenge')
      }
      setChallenge({ id: data.challengeId, destination: recipient, expiresAt: expiresAt + clockOffset })
      setResendAt(nextSendAt + clockOffset)
      changeCode('')
    } catch {
      setError('خطای ارتباط با سرور')
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current || registered || !challenge) return
    setError('')

    if (code.length !== codeLength) {
      setError('کد تأیید ۶ رقمی را وارد کن.')
      return
    }
    if (!isValidCustomerPhone(contactPhone)) {
      setError('شمارهٔ تماس باید یک شمارهٔ معتبر ۱۱ رقمی ایران باشد.')
      return
    }
    if (!isValidPostalCode(formData.postalCode)) {
      setError('کدپستی باید ۱۰ رقم معتبر باشد.')
      return
    }
    if (formData.password !== formData.confirmPassword) {
      setError('رمز عبور و تکرار آن یکسان نیستند')
      return
    }

    if (formData.password.length < 6) {
      setError('رمز عبور باید حداقل ۶ کاراکتر باشد')
      return
    }

    setCodeError(null)
    setLoading(true)
    submitting.current = true
    let accountCreated = false

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.id,
          code,
          name: formData.name,
          phone: normalizePhone(contactPhone),
          postalCode: normalizePostalCode(formData.postalCode),
          password: formData.password,
        }),
      })

      const data = await res.json()

      if (res.status !== 201 || typeof data.id !== 'string' || !data.id) {
        if (res.status === 400 && data.code === 'INVALID_REGISTRATION_CODE') {
          setCodeError({ message: data.error || 'کد تأیید پذیرفته نشد.', attempt: ++codeAttempts.current })
        } else {
          setError(data.error || 'خطا در ثبت‌نام')
        }
        return
      }
      accountCreated = true
      setRegistered(true)
      const feedback = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? Promise.resolve()
        : new Promise<void>((resolve) => window.setTimeout(resolve, 420))

      const result = await signIn('credentials', {
        ...(channel === 'email' ? { email: challenge.destination } : { loginPhone: challenge.destination }),
        password: formData.password,
        redirect: false,
      })
      const session = result?.ok && !result.error ? await requestSession() : null
      if (session?.user?.id !== data.id) {
        setError(autoLoginError)
        return
      }

      await feedback
      router.push('/profile')
      router.refresh()
    } catch {
      setError(accountCreated ? autoLoginError : 'خطای ارتباط با سرور')
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }

  const codeSlots = (
    <div key={codeError?.attempt} className={styles.codeSlots} dir="ltr" aria-hidden="true"
      data-feedback={registered ? 'accepted' : codeError ? 'rejected' : undefined}>
      {Array.from({ length: codeLength }, (_, index) => (
        <span key={index} className={styles.codeSlot} data-current={index === Math.min(codeCaret, codeLength - 1) || undefined}>
          {code[index]}
        </span>
      ))}
    </div>
  )

  return (
    <AuthShell register>
      <h1>شروع یه مسیر تازه.</h1>
      <p className={styles.authIntro}>حسابت رو بساز؛ سفارش‌ها و آدرس‌هات رو یک‌جا داشته باش.</p>
      {error && <div role="alert" className={styles.alert}>{error}</div>}
      {registered ? (
        <div role="status">
          {codeSlots}
          <p className={styles.authIntro}>{loading ? 'کد تأیید شد و حسابت ساخته شد. در حال ورود…' : 'کد تأیید شد و حسابت ساخته شد.'}</p>
          {!loading && <Link href="/login" className="btn-primary w-full">ورود به حساب <ArrowLeft size={18} /></Link>}
        </div>
      ) : availabilityFailed ? (
        <div role="alert" className={styles.alert}>
          <p>روش‌های ثبت‌نام بارگذاری نشد.</p>
          <button type="button" className="font-bold underline" onClick={() => { setAvailabilityFailed(false); setLoadAttempt(loadAttempt + 1) }}>تلاش دوباره</button>
        </div>
      ) : !availability ? (
        <p role="status" className={styles.authIntro}>در حال بارگذاری روش‌های ثبت‌نام…</p>
      ) : !availability.emailEnabled && !availability.smsEnabled ? (
        <p role="status" className={styles.authIntro}>ثبت‌نام جدید در حال حاضر در دسترس نیست.</p>
      ) : !challenge ? (
        <form onSubmit={requestCode} className={styles.authForm}>
          {availability.emailEnabled && availability.smsEnabled && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="روش دریافت کد تأیید">
              {(['email', 'sms'] as const).map((method) => (
                <button key={method} type="button" aria-pressed={channel === method} disabled={loading}
                  className={channel === method ? styles.pillLink : styles.softLink}
                  onClick={() => { if (channel !== method) { setChannel(method); changeDestination('') } }}>
                  {channelLabels[method]}
                </button>
              ))}
            </div>
          )}
          <div>
            <label htmlFor="register-destination">{channelLabels[channel]}</label>
            <input id="register-destination" type={channel === 'email' ? 'email' : 'tel'} autoComplete={channel === 'email' ? 'email' : 'tel'}
              value={destination} onChange={(e) => changeDestination(e.target.value)} className="input-field" dir="ltr"
              placeholder={channel === 'email' ? 'email@example.com' : '09123456789'} maxLength={channel === 'email' ? 254 : 30} disabled={loading} required />
          </div>
          <button type="submit" disabled={loading || resendSeconds > 0} className="btn-primary w-full disabled:opacity-50">
            {loading ? 'در حال ارسال…' : resendSeconds > 0 ? <>ارسال دوباره تا <bdi>{countdown(resendSeconds)}</bdi></> : 'دریافت کد تأیید'}<ArrowLeft size={18} />
          </button>
        </form>
      ) : <form onSubmit={handleSubmit} className={styles.authForm}>
        <div>
          <p className="text-sm break-words">کد تأیید به <bdi className="font-semibold">{challenge.destination}</bdi> ارسال شد.</p>
          <small>{expirySeconds > 0 ? <>اعتبار کد تا <bdi>{countdown(expirySeconds)}</bdi></> : 'مهلت این کد تمام شد. کد جدید بگیر.'}</small>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void requestCode()} disabled={loading || resendSeconds > 0} className={`${styles.softLink} disabled:opacity-50`}>
              {resendSeconds > 0 ? <>ارسال دوباره تا <bdi>{countdown(resendSeconds)}</bdi></> : 'ارسال دوبارهٔ کد'}
            </button>
            <button type="button" disabled={loading} className={styles.softLink} onClick={() => { setChallenge(null); changeCode(''); setError('') }}>
              ویرایش {channelLabels[channel]}
            </button>
          </div>
        </div>
        <div>
          <label htmlFor="register-code">کد تأیید</label>
          <div className={styles.codeEntry} dir="ltr">
            {codeSlots}
            <input id="register-code" type="text" inputMode="numeric" autoComplete="one-time-code" value={code}
              onChange={(event) => changeCode(event.target.value, event.target.selectionStart ?? event.target.value.length)}
              onPaste={(event) => {
                const pasted = codeDigits(event.clipboardData.getData('text'))
                if (pasted.length !== codeLength) return
                event.preventDefault()
                changeCode(pasted, codeLength)
              }}
              onSelect={(event) => setCodeCaret(event.currentTarget.selectionStart ?? code.length)}
              onClick={(event) => {
                if (event.detail !== 1) return
                const input = event.currentTarget
                const box = input.getBoundingClientRect()
                const slot = Math.floor((event.clientX - box.left) * codeLength / box.width)
                const start = Math.max(0, Math.min(slot, code.length))
                input.setSelectionRange(start, Math.min(start + 1, code.length))
                setCodeCaret(start)
              }}
              className={styles.codeInput} readOnly={loading} required
              aria-invalid={!!codeError} aria-describedby={codeError ? 'register-code-error' : undefined} />
          </div>
          {codeError && <p id="register-code-error" className={styles.codeError} role="alert">{codeError.message}</p>}
        </div>
        <div>
          <label htmlFor="register-name">نام و نام خانوادگی</label>
          <input id="register-name" type="text" autoComplete="name" maxLength={200} value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="input-field" placeholder="نام کامل شما" required />
        </div>
        <div>
          <label htmlFor="register-phone">شمارهٔ تماس سفارش</label>
          <input id="register-phone" type="tel" autoComplete="tel" maxLength={30} value={contactPhone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
            className="input-field" dir="ltr" placeholder="09123456789" required />
        </div>
        <div>
          <label htmlFor="register-postal-code">کدپستی</label>
          <input id="register-postal-code" type="text" inputMode="numeric" autoComplete="postal-code" maxLength={16} value={formData.postalCode} onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
            className="input-field" dir="ltr" placeholder="کدپستی ۱۰ رقمی" required />
        </div>
        <div>
          <label htmlFor="register-password">رمز عبور</label>
          <input id="register-password" type="password" autoComplete="new-password" minLength={6} value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} className="input-field" dir="ltr" placeholder="••••••••" aria-describedby="password-hint" required />
          <small id="password-hint">حداقل ۶ کاراکتر انتخاب کن.</small>
        </div>
        <div>
          <label htmlFor="register-confirm">تکرار رمز عبور</label>
          <input id="register-confirm" type="password" autoComplete="new-password" value={formData.confirmPassword} onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })} className="input-field" dir="ltr" placeholder="••••••••" required />
        </div>
        <button type="submit" disabled={loading || expirySeconds === 0} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'در حال ساخت حساب…' : 'ساخت حساب'}<ArrowLeft size={18} />
        </button>
      </form>}
      <p className={styles.authFooter}>قبلاً ثبت‌نام کردی؟ <Link href="/login">وارد حسابت شو</Link></p>
    </AuthShell>
  )
}
