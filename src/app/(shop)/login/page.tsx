'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signInWithSessionLock as signIn } from '@/lib/session-actions'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AuthShell from '@/components/shop/AuthShell'
import styles from '@/components/shop/account.module.css'
import { requestSession } from '@/lib/session-client'
import { normalizeLoginPhone } from '@/lib/customer-contact'

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submitting = useRef(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    const email = identifier.includes('@') ? identifier.trim().toLowerCase() : ''
    const loginPhone = email ? '' : normalizeLoginPhone(identifier)
    if (!email && !loginPhone) {
      setError('ایمیل یا شمارهٔ موبایل معتبر وارد کن.')
      return
    }
    submitting.current = true
    setLoading(true)
    setError('')

    try {
      const result = await signIn('credentials', {
        ...(loginPhone ? { loginPhone } : { email }),
        password,
        redirect: false,
      })

      if (result?.error) {
        const retry = /^login_throttled_([1-9]\d{0,3})$/.exec(result.code ?? '')
        const seconds = retry ? Number(retry[1]) : 0
        setError(seconds > 0 && seconds <= 3600
          ? `تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً ${Math.ceil(seconds / 60).toLocaleString('fa-IR')} دقیقه دیگر دوباره تلاش کنید. برای بازیابی رمز می‌توانید از «فراموشی رمز عبور» استفاده کنید.`
          : 'اطلاعات ورود یا رمز عبور اشتباه است.')
        return
      }
      if (!result?.ok) {
        setError('ورود کامل نشد. دوباره تلاش کن.')
        return
      }

      // بررسی نقش کاربر برای هدایت
      const session = await requestSession()
      const sessionMatches = loginPhone ? session?.user?.loginPhone === loginPhone : session?.user?.email?.toLowerCase() === email
      if (!session?.user?.id || !sessionMatches) {
        setError('ورود کامل نشد. دوباره تلاش کن.')
        return
      }

      const callbackUrl = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('callbackUrl')
      if (callbackUrl && (/^\/payment\/transfer\/[a-zA-Z0-9_-]+$/.test(callbackUrl) || /^\/products\/[^/?#]+(?:#product-reviews)?$/.test(callbackUrl))) {
        router.push(callbackUrl)
      } else if (session?.user?.role === 'ADMIN') {
        router.push('/admin')
      } else {
        router.push('/profile')
      }
      router.refresh()
    } catch {
      setError('خطای ارتباط با سرور')
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }

  return (
    <AuthShell login>
      <div className={styles.loginHeading}>
        <h1>خوش آمدید.</h1>
        <p className={styles.loginSignup}>حساب ندارید؟ <Link href="/register">ایجاد حساب</Link></p>
      </div>
      <p className={styles.authIntro}>برای ادامهٔ خرید، وارد حساب خود شوید.</p>
      {error && <div role="alert" className={styles.alert}>{error}</div>}
      <form onSubmit={handleSubmit} className={styles.authForm}>
        <div>
          <label htmlFor="login-identifier">ایمیل یا شمارهٔ موبایل</label>
          <input id="login-identifier" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} value={identifier} onChange={(e) => setIdentifier(e.target.value)} className="input-field" dir="ltr" required />
        </div>
        <div>
          <label htmlFor="login-password">رمز عبور</label>
          <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-field" dir="ltr" placeholder="••••••••" required />
          <Link href="/forgot-password" className={`${styles.loginRecovery} text-sm font-semibold text-brand underline underline-offset-4`}>فراموشی رمز عبور</Link>
        </div>
        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'در حال ورود…' : 'ورود به حساب'}<ArrowLeft size={18} />
        </button>
      </form>
    </AuthShell>
  )
}
