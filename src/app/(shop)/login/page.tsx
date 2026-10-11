'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signInWithSessionLock as signIn } from '@/lib/session-actions'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import AuthShell from '@/components/shop/AuthShell'
import styles from '@/components/shop/account.module.css'
import { requestSession } from '@/lib/session-client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submitting = useRef(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setLoading(true)
    setError('')

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })

      if (result?.error) {
        setError('ایمیل یا رمز عبور اشتباه است')
        return
      }
      if (!result?.ok) {
        setError('ورود کامل نشد. دوباره تلاش کن.')
        return
      }

      // بررسی نقش کاربر برای هدایت
      const session = await requestSession()
      if (!session?.user?.id || session.user.email?.toLowerCase() !== email.trim().toLowerCase()) {
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
    <AuthShell>
      <h1>خوش آمدی.</h1>
      <p className={styles.authIntro}>وارد حسابت شو و خریدت رو از همون‌جا ادامه بده.</p>
      {error && <div role="alert" className={styles.alert}>{error}</div>}
      <form onSubmit={handleSubmit} className={styles.authForm}>
        <div>
          <label htmlFor="login-email">ایمیل</label>
          <input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input-field" dir="ltr" placeholder="email@example.com" required />
        </div>
        <div>
          <label htmlFor="login-password">رمز عبور</label>
          <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-field" dir="ltr" placeholder="••••••••" required />
        </div>
        <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
          {loading ? 'در حال ورود…' : 'ورود به حساب'}<ArrowLeft size={18} />
        </button>
      </form>
      <p className={styles.authFooter}>هنوز حساب نداری؟ <Link href="/register">ساخت حساب جدید</Link></p>
    </AuthShell>
  )
}
