'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  User,
  MapPin,
  Package,
  Plus,
  Star,
  ChevronDown,
  Check,
  X,
  LogOut,
  KeyRound,
  ArrowLeft,
  ChevronLeft,
} from 'lucide-react'
import { signOutWithSessionLock as signOut } from '@/lib/session-actions'
import Link from 'next/link'
import { formatPrice } from '@/lib/utils'
import type { InvoiceMetadata } from '@/lib/invoice'
import InvoiceDownload from './InvoiceDownload'
import styles from './account.module.css'

interface SessionUser {
  name: string
  email: string
  role: string
}

interface Address {
  id: string
  title: string | null
  address: string
  phone: string
  isDefault: boolean
}

interface OrderItem {
  id: string
  quantity: number
  size: number
  color: string
  price: number
  productName?: string | null
  product: { name: string }
}

interface Order {
  id: string
  total: number
  shippingMethodName: string | null
  shippingCost: number
  status: string
  verified: boolean
  paymentMethod?: string | null
  paymentStatus?: string
  recipientName: string | null
  address: string
  phone: string
  createdAt: string
  invoice?: InvoiceMetadata | null
  items: OrderItem[]
}

const statusLabels: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'در انتظار پرداخت', color: 'bg-yellow-100 text-yellow-700' },
  PROCESSING: { label: 'در حال پردازش', color: 'bg-blue-100 text-blue-700' },
  SHIPPED: { label: 'ارسال شده', color: 'bg-purple-100 text-purple-700' },
  DELIVERED: { label: 'تحویل شده', color: 'bg-green-100 text-green-700' },
  CANCELLED: { label: 'لغو شده', color: 'bg-red-100 text-red-700' },
}

const paymentLabels: Record<string, string> = {
  AWAITING_RECEIPT: 'در انتظار ارسال رسید',
  AWAITING_REVIEW: 'در انتظار تأیید پرداخت توسط ادمین',
  REJECTED: 'رسید نیاز به اصلاح دارد',
  PAID: 'پرداخت تأییدشده',
  EXPIRED: 'مهلت پرداخت تمام شده',
  UNPAID: 'هنوز تأیید نشده',
}

const emptyAddrForm = { title: '', address: '', phone: '' }

export default function ProfileClient({ user }: { user: SessionUser }) {
  const [tab, setTab] = useState<'orders' | 'addresses' | 'account'>('orders')

  // حساب من
  const [accForm, setAccForm] = useState({ name: user.name, phone: '' })
  const [accLoading, setAccLoading] = useState(true)
  const [accLoadError, setAccLoadError] = useState('')
  const [accSaving, setAccSaving] = useState(false)
  const [accMsg, setAccMsg] = useState('')
  const accountRequest = useRef<AbortController | null>(null)
  const accountReady = useRef(false)
  const accountSavePending = useRef(false)

  // تغییر رمز عبور
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' })
  const [pwSaving, setPwSaving] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')

  // آدرسها
  const [addresses, setAddresses] = useState<Address[]>([])
  const [addrLoading, setAddrLoading] = useState(true)
  const [addrLoadError, setAddrLoadError] = useState('')
  const [addrModal, setAddrModal] = useState(false)
  const [editingAddrId, setEditingAddrId] = useState<string | null>(null)
  const [addrForm, setAddrForm] = useState(emptyAddrForm)
  const [addrIsDefault, setAddrIsDefault] = useState(false)
  const [addrSaving, setAddrSaving] = useState(false)
  const [addrError, setAddrError] = useState('')
  const addressDialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!addrModal) return
    const previousFocus = document.activeElement as HTMLElement | null
    const dialog = addressDialog.current
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
    focusable()[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddrModal(false)
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      previousFocus?.focus()
    }
  }, [addrModal])

  // سفارشها
  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [ordersError, setOrdersError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadAddresses = useCallback(() => fetch('/api/addresses')
    .then(async (res) => {
      if (!res.ok) throw new Error('Address request failed')
      return res.json() as Promise<Address[]>
    })
    .then((data) => {
      setAddresses(data)
      setAddrLoadError('')
    })
    .catch(() => setAddrLoadError('آدرس‌ها بارگذاری نشدند. دوباره تلاش کن.'))
    .finally(() => setAddrLoading(false)), [])

  const loadOrders = useCallback(() => fetch('/api/orders')
    .then(async (res) => {
      if (!res.ok) throw new Error('Order request failed')
      return res.json() as Promise<Order[]>
    })
    .then((data) => {
      setOrders(data)
      setOrdersError('')
    })
    .catch(() => setOrdersError('سفارش‌ها بارگذاری نشدند. دوباره تلاش کن.'))
    .finally(() => setOrdersLoading(false)), [])

  const loadAccount = useCallback(() => {
    if (accountRequest.current || accountSavePending.current) return
    const controller = new AbortController()
    accountRequest.current = controller
    accountReady.current = false
    return fetch('/api/profile', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Profile request failed')
        return response.json()
      })
      .then((data) => {
        if (typeof data?.name !== 'string' || (data.phone !== null && typeof data.phone !== 'string')) {
          throw new Error('Invalid profile response')
        }
        if (controller.signal.aborted) return
        setAccForm({ name: data.name, phone: data.phone ?? '' })
        accountReady.current = true
      })
      .catch(() => {
        if (!controller.signal.aborted) setAccLoadError('اطلاعات حساب بارگذاری نشد. دوباره تلاش کن.')
      })
      .finally(() => {
        if (accountRequest.current === controller) accountRequest.current = null
        if (!controller.signal.aborted) setAccLoading(false)
      })
  }, [])

  useEffect(() => {
    loadAddresses()
    loadOrders()
  }, [loadAddresses, loadOrders])

  useEffect(() => {
    void loadAccount()
    return () => {
      accountRequest.current?.abort()
      accountRequest.current = null
      accountReady.current = false
    }
  }, [loadAccount])

  /* ---------- Account ---------- */
  const handleAccountSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!accountReady.current || accountSavePending.current) return
    accountSavePending.current = true
    setAccSaving(true)
    setAccMsg('')
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accForm),
      })
      if (res.ok) {
        setAccMsg('اطلاعات حساب ذخیره شد ✓')
        setTimeout(() => setAccMsg(''), 3000)
      } else {
        const d = await res.json()
        setAccMsg(d.error || 'خطا در ذخیره')
      }
    } catch {
      setAccMsg('خطای ارتباط با سرور')
    } finally {
      accountSavePending.current = false
      setAccSaving(false)
    }
  }

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError('')
    setPwSuccess('')

    if (pwForm.next !== pwForm.confirm) {
      setPwError('رمز جدید و تکرار آن یکسان نیستند')
      return
    }

    setPwSaving(true)
    try {
      const res = await fetch('/api/profile/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: pwForm.current,
          newPassword: pwForm.next,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setPwError(data.error || 'خطا در تغییر رمز')
        return
      }

      setPwSuccess('رمز عبور با موفقیت تغییر کرد ✓')
      setPwForm({ current: '', next: '', confirm: '' })
    } catch {
      setPwError('خطای ارتباط با سرور')
    } finally {
      setPwSaving(false)
    }
  }

  const handleLogout = async () => {
    await signOut({ redirectTo: '/' })
  }

  /* ---------- Addresses ---------- */
  const openAddrModal = (addr?: Address) => {
    if (addr) {
      setEditingAddrId(addr.id)
      setAddrForm({ title: addr.title ?? '', address: addr.address, phone: addr.phone })
      setAddrIsDefault(addr.isDefault)
    } else {
      setEditingAddrId(null)
      setAddrForm(emptyAddrForm)
      setAddrIsDefault(addresses.length === 0)
    }
    setAddrError('')
    setAddrModal(true)
  }

  const handleAddrSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setAddrSaving(true)
    setAddrError('')
    try {
      const payload = { ...addrForm, isDefault: addrIsDefault }
      const res = await fetch(editingAddrId ? `/api/addresses/${editingAddrId}` : '/api/addresses', {
        method: editingAddrId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setAddrError(data.error || 'خطا در ذخیره آدرس')
        return
      }
      setAddrModal(false)
      await loadAddresses()
    } catch {
      setAddrError('خطای ارتباط با سرور')
    } finally {
      setAddrSaving(false)
    }
  }

  const handleSetDefault = async (id: string) => {
    await fetch(`/api/addresses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    })
    loadAddresses()
  }

  const handleAddrDelete = async (id: string) => {
    if (!confirm('این آدرس حذف شود؟')) return
    const res = await fetch(`/api/addresses/${id}`, { method: 'DELETE' })
    if (res.ok) setAddresses((prev) => prev.filter((a) => a.id !== id))
  }

  const tabs = [
    { key: 'orders' as const, label: 'سفارش‌های من', Icon: Package, count: orders.length },
    { key: 'addresses' as const, label: 'آدرس‌های من', Icon: MapPin, count: addresses.length },
    { key: 'account' as const, label: 'حساب کاربری', Icon: User },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه"><Link href="/">خانه</Link><ChevronLeft size={13} /><span>حساب کاربری</span></nav>
        {/* Header */}
        <header className={`${styles.hero} ${styles.profileHero}`}>
          <div className={styles.profileIdentity}>
            <div className={styles.profileAvatar}>{user.name.charAt(0) || <User size={32} />}</div>
            <div className="min-w-0">
              <p className={styles.eyebrow}>فضای خودِ تو</p>
              <h1>سلام {user.name || 'دوست عزیز'}!</h1>
              <p dir="ltr">{user.email}</p>
            </div>
          </div>
          <Link href="/products" className={styles.softLink}>یه سر به ویترین بزن <ArrowLeft size={17} /></Link>
        </header>

        {/* Tabs */}
        <div className={styles.profileLayout}>
        <nav className={styles.profileNav} aria-label="بخش‌های حساب کاربری">
          {tabs.map(({ key, label, Icon, count }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              aria-controls="profile-content"
            >
              <Icon className="w-4 h-4" />
              {label}
              {count !== undefined && (
                <span className={styles.tabCount}>
                  {count.toLocaleString('fa-IR')}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div id="profile-content" className={styles.profileContent}>

        {/* ---------- Orders ---------- */}
        {tab === 'orders' && (
          <div className="space-y-4">
            <div className={styles.sectionTop}><div><h2>سفارش‌های من</h2><p>از انتخاب تا رسیدن؛ جزئیات خریدت اینجاست.</p></div></div>
            {ordersLoading ? (
              <div className="card p-10 text-center text-mist" role="status">در حال بارگذاری سفارش‌ها…</div>
            ) : ordersError ? (
              <div className={styles.emptyState} role="alert"><p>{ordersError}</p><button onClick={() => { setOrdersLoading(true); void loadOrders() }} className={styles.pillLink}>تلاش دوباره</button></div>
            ) : orders.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.valueIcon}><Package size={30} /></div>
                <h3>هنوز اولین قدم رو برنداشتی.</h3>
                <p>وقتی خرید کنی، وضعیت و جزئیات سفارش‌هات رو همین‌جا می‌بینی.</p>
                <Link href="/products" className={styles.pillLink}>پیدا کردن جفت بعدی <ArrowLeft size={17} /></Link>
              </div>
            ) : (
              orders.map((order) => (
                <div key={order.id} className="card overflow-hidden">
                  <button
                    onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}
                    aria-expanded={expandedId === order.id}
                    className={`${styles.orderToggle} w-full p-5 flex items-center justify-between gap-3 text-right hover:bg-fog/40 transition-colors`}
                  >
                    <div>
                      <p className="font-bold text-sm">
                        سفارش <span className="font-mono">#{order.id.slice(-6)}</span>
                      </p>
                      <p className="text-xs text-mist mt-1">
                        {new Date(order.createdAt).toLocaleDateString('fa-IR')} ·{' '}
                        {order.items.length} قلم · {formatPrice(order.total)} تومان
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`px-3 py-1.5 rounded-full text-xs font-bold ${statusLabels[order.status]?.color ?? ''}`}>
                        {order.status === 'PENDING' && order.paymentMethod === 'bank_transfer' && order.paymentStatus ? paymentLabels[order.paymentStatus] ?? statusLabels[order.status]?.label : order.status === 'PENDING' && order.verified ? 'در انتظار بررسی' : statusLabels[order.status]?.label ?? order.status}
                      </span>
                      <ChevronDown className={`w-4 h-4 text-mist transition-transform ${expandedId === order.id ? 'rotate-180' : ''}`} />
                    </div>
                  </button>

                  {expandedId === order.id && (
                    <div className="px-5 pb-5 pt-1 border-t border-line/60 space-y-2">
                      {order.items.map((item) => (
                        <div key={item.id} className="flex flex-wrap gap-2 justify-between text-sm py-2">
                          <span className="text-night">
                            {item.productName || item.product.name} — سایز {item.size} × {item.quantity}
                          </span>
                          <span className="text-mist">{formatPrice(item.price * item.quantity)}</span>
                        </div>
                      ))}
                      <div className="text-sm pt-3 border-t border-line/60 space-y-2">
                        <p className="flex justify-between gap-3"><span className="text-mist">پرداخت</span><span>{order.verified ? 'تأییدشده' : paymentLabels[order.paymentStatus ?? ''] ?? 'هنوز تأیید نشده'}</span></p>
                        {order.paymentMethod === 'bank_transfer' && <p className="flex justify-between gap-3"><span className="text-mist">روش پرداخت</span><span>کارت‌به‌کارت / انتقال وجه</span></p>}
                        <p className="flex justify-between gap-3"><span className="text-mist">روش ارسال</span><span>{order.shippingMethodName || 'ثبت نشده'}</span></p>
                        <p className="flex justify-between gap-3"><span className="text-mist">هزینهٔ ارسال</span><span>{order.shippingCost === 0 ? 'رایگان' : `${formatPrice(order.shippingCost)} تومان`}</span></p>
                        <p className="flex justify-between gap-3 font-bold"><span>مجموع سفارش</span><span>{formatPrice(order.total)} تومان</span></p>
                      </div>
                      <p className="text-xs text-mist pt-2 border-t border-line/60">
                        {order.recipientName && <>گیرنده: {order.recipientName}<br /></>}ارسال به: {order.address}
                      </p>
                      {order.paymentMethod === 'bank_transfer' && (
                        <Link href={`/payment/transfer/${encodeURIComponent(order.id)}`} className={styles.pillLink}>
                          {order.verified ? 'مشاهدهٔ پرداخت و رسید' : order.paymentStatus === 'AWAITING_REVIEW' ? 'پیگیری تأیید پرداخت' : order.status === 'CANCELLED' && order.paymentStatus === 'UNPAID' ? 'مشاهدهٔ سفارش لغوشده' : order.status === 'CANCELLED' || order.paymentStatus === 'EXPIRED' ? 'پیگیری واریز پس از پایان مهلت' : 'ادامهٔ پرداخت و ارسال رسید'}<ArrowLeft size={16} />
                        </Link>
                      )}
                      <InvoiceDownload orderId={order.id} status={order.status} invoice={order.invoice} />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------- Addresses ---------- */}
        {tab === 'addresses' && (
          <div>
            <div className={styles.sectionTop}>
              <div><h2>آدرس‌های من</h2><p>مقصدهای همیشگی رو برای خرید بعدی ذخیره کن.</p></div>
              <button onClick={() => openAddrModal()} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> آدرس جدید</button>
            </div>

            {addrLoading ? (
              <div className="card p-10 text-center text-mist" role="status">در حال بارگذاری آدرس‌ها…</div>
            ) : addrLoadError ? (
              <div className={styles.emptyState} role="alert"><p>{addrLoadError}</p><button onClick={() => { setAddrLoading(true); void loadAddresses() }} className={styles.pillLink}>تلاش دوباره</button></div>
            ) : addresses.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.valueIcon}><MapPin size={30} /></div>
                <h3>سفارشت رو کجا بفرستیم؟</h3>
                <p>آدرس خونه یا محل کارت رو اضافه کن تا خرید بعدی راحت‌تر باشه.</p>
                <button onClick={() => openAddrModal()} className={styles.pillLink}><Plus size={17} /> افزودن اولین آدرس</button>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {addresses.map((addr) => (
                  <div key={addr.id} className={`card p-5 ${addr.isDefault ? 'ring-2 ring-brand/40' : ''}`}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-bold flex items-center gap-2">
                        {addr.title || 'آدرس'}
                        {addr.isDefault && (
                          <span className="bg-brand/10 text-brand text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Star className="w-3 h-3" />
                            پیشفرض
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="text-sm text-night leading-relaxed">{addr.address}</p>
                    <p className="text-xs text-mist mt-2" dir="ltr">{addr.phone}</p>

                    <div className="flex items-center gap-2 mt-4 pt-3 border-t border-line/60">
                      {!addr.isDefault && (
                        <button
                          onClick={() => handleSetDefault(addr.id)}
                          className="text-xs font-bold text-mist hover:text-brand flex items-center gap-1 transition-colors"
                        >
                          <Check className="w-3.5 h-3.5" />
                          پیشفرض کن
                        </button>
                      )}
                      <span className="flex-1" />
                      <button
                        onClick={() => openAddrModal(addr)}
                        className="text-xs font-bold text-brand hover:underline"
                      >
                        ویرایش
                      </button>
                      <button
                        onClick={() => handleAddrDelete(addr.id)}
                        className="text-xs font-bold text-red-600 hover:underline"
                      >
                        حذف
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ---------- Account ---------- */}
        {tab === 'account' && (
          <div className={styles.accountForms}>
            <div className={styles.sectionTop}><div><h2>حساب کاربری</h2><p>اطلاعاتت رو به‌روز نگه دار و امنیت حسابت رو مدیریت کن.</p></div></div>
            <form onSubmit={handleAccountSave} className="card p-6 space-y-5" aria-busy={accLoading || accSaving}>
              <h3 className="font-bold text-lg">اطلاعات حساب</h3>

              {accLoading && <p role="status" className="text-sm text-mist">در حال بارگذاری اطلاعات حساب…</p>}
              {accLoadError && (
                <div role="alert" className="space-y-3 text-sm text-red-700">
                  <p>{accLoadError}</p>
                  <button type="button" onClick={() => { setAccLoading(true); setAccLoadError(''); void loadAccount() }} className={styles.pillLink}>تلاش دوباره</button>
                </div>
              )}

              <div>
                <label htmlFor="account-email" className="block font-bold mb-2">ایمیل</label>
                <input id="account-email" disabled dir="ltr" className="input-field bg-fog/60" value={user.email} />
                <p className="text-xs text-mist mt-1">ایمیل قابل تغییر نیست</p>
              </div>

              <div>
                <label htmlFor="account-name" className="block font-bold mb-2">نام</label>
                <input
                  id="account-name"
                  autoComplete="name"
                  required
                  disabled={accLoading || !!accLoadError || accSaving}
                  className="input-field"
                  value={accForm.name}
                  onChange={(e) => setAccForm({ ...accForm, name: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="account-phone" className="block font-bold mb-2">شماره تماس</label>
                <input
                  id="account-phone"
                  autoComplete="tel"
                  type="tel"
                  disabled={accLoading || !!accLoadError || accSaving}
                  dir="ltr"
                  className="input-field"
                  placeholder="09123456789"
                  value={accForm.phone}
                  onChange={(e) => setAccForm({ ...accForm, phone: e.target.value })}
                />
              </div>

              {accMsg && (
                <div className={`px-4 py-3 rounded-lg text-sm border ${
                  accMsg.includes('✓')
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}>
                  {accMsg}
                </div>
              )}

              <button type="submit" disabled={accLoading || !!accLoadError || accSaving} className="btn-primary disabled:opacity-50">
                {accSaving ? 'در حال ذخیره...' : 'ذخیره تغییرات'}
              </button>
            </form>

            {/* Change Password */}
            <form onSubmit={handlePasswordSubmit} className="card p-6 space-y-5">
              <h3 className="font-bold text-lg flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-brand" />
                تغییر رمز عبور
              </h3>

              <div>
                <label htmlFor="account-current-password" className="block font-bold mb-2">رمز عبور فعلی *</label>
                <input
                  id="account-current-password"
                  required
                  type="password"
                  dir="ltr"
                  autoComplete="current-password"
                  className="input-field"
                  placeholder="••••••••"
                  value={pwForm.current}
                  onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="account-new-password" className="block font-bold mb-2">رمز جدید *</label>
                  <input
                    id="account-new-password"
                    required
                    minLength={6}
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    className="input-field"
                    placeholder="••••••••"
                    value={pwForm.next}
                    onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="account-confirm-password" className="block font-bold mb-2">تکرار رمز جدید *</label>
                  <input
                    id="account-confirm-password"
                    required
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    className="input-field"
                    placeholder="••••••••"
                    value={pwForm.confirm}
                    onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
                  />
                </div>
              </div>

              {pwError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {pwError}
                </div>
              )}
              {pwSuccess && (
                <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
                  {pwSuccess}
                </div>
              )}

              <button type="submit" disabled={pwSaving} className="btn-primary disabled:opacity-50">
                {pwSaving ? 'در حال تغییر...' : 'اعمال رمز جدید'}
              </button>
            </form>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="card p-5 w-full flex flex-wrap gap-3 items-center justify-between group hover:border-red-200 transition-colors"
            >
              <span className="flex items-center gap-3 font-bold text-red-600">
                <LogOut className="w-5 h-5 rotate-180" />
                خروج از حساب کاربری
              </span>
              <span className="text-mist text-sm group-hover:text-night transition-colors">
                تا قدم بعدی!
              </span>
            </button>
          </div>
        )}
        </div>
        </div>
      </div>

      {/* Address Modal */}
      {addrModal && (
        <div className={styles.modalBackdrop}>
          <div ref={addressDialog} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="address-modal-title">
            <div className={styles.modalTitle}>
              <h2 id="address-modal-title">
                {editingAddrId ? 'ویرایش آدرس' : 'افزودن آدرس'}
              </h2>
              <button
                onClick={() => setAddrModal(false)}
                aria-label="بستن پنجرهٔ آدرس"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddrSave} className="p-6 space-y-4">
              <div>
                <label htmlFor="address-title" className="block font-bold mb-2">عنوان (اختیاری)</label>
                <input
                  id="address-title"
                  className="input-field"
                  placeholder="خانه، محل کار..."
                  value={addrForm.title}
                  onChange={(e) => setAddrForm({ ...addrForm, title: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="address-street" className="block font-bold mb-2">آدرس کامل *</label>
                <textarea
                  id="address-street"
                  autoComplete="street-address"
                  required
                  rows={3}
                  className="input-field"
                  placeholder="شهر، خیابان، پلاک، کدپستی"
                  value={addrForm.address}
                  onChange={(e) => setAddrForm({ ...addrForm, address: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor="address-phone" className="block font-bold mb-2">شماره تماس *</label>
                <input
                  id="address-phone"
                  autoComplete="tel"
                  required
                  type="tel"
                  dir="ltr"
                  className="input-field"
                  placeholder="09123456789"
                  value={addrForm.phone}
                  onChange={(e) => setAddrForm({ ...addrForm, phone: e.target.value })}
                />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addrIsDefault}
                  onChange={(e) => setAddrIsDefault(e.target.checked)}
                  className="w-5 h-5 accent-brand"
                />
                <span className="font-medium">آدرس پیشفرض من باشد</span>
              </label>

              {addrError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {addrError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={addrSaving} className="btn-primary flex-1 disabled:opacity-50">
                  {addrSaving ? 'در حال ذخیره...' : 'ذخیره آدرس'}
                </button>
                <button type="button" onClick={() => setAddrModal(false)} className="btn-outline flex-1">
                  انصراف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
