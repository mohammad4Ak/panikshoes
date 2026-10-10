'use client'

import { SneakerIcon } from '@/components/ui/BrandIcons'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useCart } from '@/lib/cart'
import { formatPrice } from '@/lib/utils'
import { calculateShippingCost, type ShippingMethodOption } from '@/lib/shipping'
import { useAppSession } from '@/components/auth/SessionActivityProvider'
import { Star, Plus, ShoppingBag, ArrowLeft, ChevronLeft, MapPin, ClipboardCheck } from 'lucide-react'
import styles from '@/components/shop/commerce.module.css'
import shippingStyles from '@/components/shop/shipping.module.css'

interface SavedAddress {
  id: string
  title: string | null
  address: string
  phone: string
  isDefault: boolean
}

interface PaymentMethodOption {
  id: string
  name: string
  description: string | null
}

function shippingQuote(method: ShippingMethodOption, subtotal: number, itemCount: number): number | null {
  try {
    return calculateShippingCost(method, subtotal, itemCount)
  } catch {
    return null
  }
}

export default function CheckoutPage() {
  const { items, getTotal, clearCart, syncPrices, beginCheckout } = useCart()
  const submitting = useRef(false)
  const addressEdited = useRef(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const subtotal = getTotal()
  const itemCount = items.reduce((count, item) => count + item.quantity, 0)
  const router = useRouter()
  const { session } = useAppSession()
  const userId = session?.user.id ?? null
  const isLoggedIn = userId !== null

  const [formData, setFormData] = useState({
    address: '',
    phone: '',
    name: '',
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [stockUnavailable, setStockUnavailable] = useState(false)
  const [existingOrderId, setExistingOrderId] = useState('')
  const [shippingMethods, setShippingMethods] = useState<ShippingMethodOption[]>([])
  const [selectedShippingId, setSelectedShippingId] = useState('')
  const [shippingLoading, setShippingLoading] = useState(true)
  const [shippingError, setShippingError] = useState('')
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodOption[]>([])
  const [selectedPaymentId, setSelectedPaymentId] = useState('')
  const [paymentLoading, setPaymentLoading] = useState(true)
  const [paymentError, setPaymentError] = useState('')

  const selectedShipping = shippingMethods.find((method) => method.id === selectedShippingId)
  const selectedPayment = paymentMethods.find((method) => method.id === selectedPaymentId)
  const shippingCost = selectedShipping ? shippingQuote(selectedShipping, subtotal, itemCount) : null
  const total = subtotal + (shippingCost ?? 0)

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  const loadShippingMethods = useCallback((signal?: AbortSignal) => fetch('/api/shipping-methods', { cache: 'no-store', signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('Shipping methods request failed')
      return response.json() as Promise<ShippingMethodOption[]>
    })
    .then((methods) => {
      if (signal?.aborted) return
      const activeMethods = methods.filter((method) => method.isActive)
      setShippingMethods(activeMethods)
      setSelectedShippingId((previous) => activeMethods.some((method) => method.id === previous) ? previous : (activeMethods[0]?.id ?? ''))
      setShippingError('')
    })
    .catch(() => {
      if (!signal?.aborted) setShippingError('روش‌های ارسال بارگذاری نشدند. دوباره تلاش کن.')
    })
    .finally(() => {
      if (!signal?.aborted) setShippingLoading(false)
    }), [setSelectedShippingId])

  useEffect(() => {
    const controller = new AbortController()
    void loadShippingMethods(controller.signal)
    return () => controller.abort()
  }, [loadShippingMethods])

  const retryShippingMethods = () => {
    setShippingLoading(true)
    setShippingError('')
    void loadShippingMethods()
  }

  const loadPaymentMethods = useCallback((signal?: AbortSignal) => fetch('/api/payment-methods', { cache: 'no-store', signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('Payment methods request failed')
      const methods: unknown = await response.json()
      if (!Array.isArray(methods) || !methods.every((method) => method !== null && typeof method === 'object'
        && typeof method.id === 'string' && method.id.length > 0 && typeof method.name === 'string' && method.name.trim().length > 0
        && (method.description === null || typeof method.description === 'string'))) throw new Error('Invalid payment methods response')
      return methods as PaymentMethodOption[]
    })
    .then((methods) => {
      if (signal?.aborted) return
      setPaymentMethods(methods)
      setSelectedPaymentId((previous) => methods.some((method) => method.id === previous) ? previous : (methods[0]?.id ?? ''))
      setPaymentError('')
    })
    .catch(() => {
      if (!signal?.aborted) setPaymentError('روش‌های پرداخت بارگذاری نشدند. دوباره تلاش کن.')
    })
    .finally(() => {
      if (!signal?.aborted) setPaymentLoading(false)
    }), [setSelectedPaymentId])

  useEffect(() => {
    const controller = new AbortController()
    void loadPaymentMethods(controller.signal)
    return () => controller.abort()
  }, [loadPaymentMethods])

  const retryPaymentMethods = () => {
    setPaymentLoading(true)
    setPaymentError('')
    void loadPaymentMethods()
  }

  // آدرسهای ذخیرهشده پروفایل
  const [addressState, setAddressState] = useState<{ userId: string | null; list: SavedAddress[] }>({ userId: null, list: [] })
  const savedAddresses = userId && addressState.userId === userId ? addressState.list : []
  const [selectedAddrId, setSelectedAddrId] = useState<string>('')
  const [newAddressMode, setNewAddressMode] = useState(false)
  const [saveToProfile, setSaveToProfile] = useState(true)

  // دریافت آدرسهای پروفایل (اگر لاگین باشد)
  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    fetch('/api/addresses', { cache: 'no-store', signal: controller.signal })
      .then(async (r) => {
        if (controller.signal.aborted) return []
        if (!r.ok) return []
        return r.json()
      })
      .then((list: SavedAddress[]) => {
        if (controller.signal.aborted) return
        setAddressState({ userId, list })
        if (addressEdited.current) {
          setNewAddressMode(true)
        } else if (list.length > 0) {
          setSelectedAddrId(list[0].id)
          setFormData((f) => ({
            ...f,
            address: list[0].address,
            phone: list[0].phone,
          }))
        }
      })
      .catch(() => {})
    return () => controller.abort()
  }, [userId])

  const selectAddress = (addr: SavedAddress) => {
    addressEdited.current = true
    setSelectedAddrId(addr.id)
    setNewAddressMode(false)
    setFormData((f) => ({ ...f, address: addr.address, phone: addr.phone }))
  }

  const startNewAddress = () => {
    addressEdited.current = true
    setSelectedAddrId('')
    setNewAddressMode(true)
    setFormData((f) => ({ ...f, address: '', phone: '' }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    setStockUnavailable(false)
    if (loading || shippingLoading || shippingError || !selectedShipping || shippingCost === null) {
      setError('برای ثبت سفارش، یک روش ارسال در دسترس انتخاب کن.')
      return
    }
    if (paymentLoading || paymentError || !selectedPayment) {
      setError('برای ثبت سفارش، یک روش پرداخت در دسترس انتخاب کن.')
      return
    }
    setLoading(true)
    submitting.current = true
    setError('')
    setExistingOrderId('')

    try {
      const payload = {
        recipientName: formData.name.trim(),
        address: formData.address.trim(),
        phone: formData.phone.trim(),
        shippingMethodId: selectedShipping.id,
        paymentMethodId: selectedPayment.id,
        expectedShippingCost: shippingCost,
        expectedSubtotal: subtotal,
        items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, size: item.size, color: item.color })),
      }
      const checkoutKey = await beginCheckout()
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, checkoutKey }),
      })

      const data = await res.json()

      if (res.status === 401) {
        setError('برای ثبت سفارش ابتدا باید وارد حساب خود شوید')
        setLoading(false)
        return
      }

      if (!res.ok) {
        if (res.status === 409 && data.code === 'CHECKOUT_KEY_REUSED' && typeof data.existingOrderId === 'string') {
          setExistingOrderId(data.existingOrderId)
          setError('این سبد قبلاً با اطلاعات دیگری ثبت شده است. ابتدا سفارش ثبت‌شده را بررسی کن؛ سفارش تکراری ساخته نشد.')
          return
        }
        if (res.status === 409 && ['PAYMENT_METHOD_UNAVAILABLE', 'PAYMENT_METHOD_CHANGED'].includes(data.code)) {
          setPaymentLoading(true)
          await loadPaymentMethods()
          setError(data.error || 'روش پرداخت تغییر کرده است. روش‌های در دسترس را بررسی کن.')
          return
        }
        if (res.status === 409 && ['SHIPPING_METHOD_UNAVAILABLE', 'SHIPPING_QUOTE_CHANGED', 'ORDER_PRICES_CHANGED'].includes(data.code)) {
          if (Array.isArray(data.productPrices)) syncPrices(data.productPrices)
          setShippingLoading(true)
          await loadShippingMethods()
          setError(data.error || 'روش یا هزینهٔ ارسال تغییر کرده است. انتخاب و مبلغ جدید را بررسی کن و دوباره سفارش را ثبت کن.')
          setLoading(false)
          return
        }
        const outOfStock: string[] = Array.isArray(data.outOfStock)
          ? data.outOfStock.filter((id: unknown): id is string => typeof id === 'string')
          : []
        if (data.code === 'STOCK_UNAVAILABLE' || outOfStock.length > 0) {
          const productNames = [...new Set(items.filter((item) => outOfStock.includes(item.productId)).map((item) => item.name))]
          const products = productNames.length ? `«${productNames.join('» و «')}»` : 'بعضی از محصولات انتخابی'
          const exhausted = Array.isArray(data.outOfStockDetails) && outOfStock.length > 0 && outOfStock.every((id) =>
            data.outOfStockDetails.some((detail: { productId?: unknown; availableQuantity?: unknown } | null) =>
              detail?.productId === id && detail.availableQuantity === 0))
          setStockUnavailable(true)
          setError(`متأسفیم، موجودی ${products} ${exhausted ? 'فعلاً به پایان رسیده است' : 'در حال حاضر برای تعداد انتخابی تو کافی نیست'}. سبد خریدت حفظ شده؛ می‌توانی آن را بازبینی کنی یا محصول دیگری انتخاب کنی.`)
          return
        }

        setError(data.error || 'خطا در ثبت سفارش')
        return
      }

      // ذخیره آدرس جدید در پروفایل در صورت انتخاب کاربر
      if ((newAddressMode || savedAddresses.length === 0) && saveToProfile && isLoggedIn && formData.address.trim()) {
        // Saving an optional address must not consume the payment reservation
        // while the customer waits to reach the bank details page.
        void fetch('/api/addresses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: 'آدرس من',
              address: formData.address,
              phone: formData.phone,
            }),
          }).catch(() => {})
      }

      clearCart()
      router.push(data.paymentMethod === 'bank_transfer'
        ? `/payment/transfer/${encodeURIComponent(data.id)}`
        : `/payment/result?orderId=${encodeURIComponent(data.id)}`)
    } catch {
      setError('خطای ارتباط با سرور')
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><ShoppingBag size={36} /></span>
          <h1>اول، جفت دلخواهت رو انتخاب کن.</h1>
          <p>برای تکمیل خرید، یک محصول به سبدت اضافه کن.</p>
          <Link href="/products" className="btn-primary">مشاهدهٔ محصولات <ArrowLeft size={18} /></Link>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه">
          <Link href="/" className="hover:text-brand">خانه</Link>
          <span>/</span>
          <Link href="/cart" className="hover:text-brand">سبد خرید</Link>
          <span>/</span>
          <span className="text-night">تکمیل خرید</span>
        </nav>

        <section className={styles.intro}>
          <div><p className={styles.eyebrow}>تکمیل خرید</p><h1>قدم آخر، تا یه شروع تازه.</h1><p>اطلاعات ارسال رو وارد کن و سفارشت رو نهایی کن.</p></div>
          <span className={styles.introMark} aria-hidden="true"><MapPin /></span>
        </section>
        <nav className={styles.steps} aria-label="مراحل خرید"><Link href="/cart"><b>۱</b>سبد خرید</Link><ChevronLeft size={14} /><span className={styles.stepActive} aria-current="step"><b>۲</b>اطلاعات ارسال</span><ChevronLeft size={14} /><span><b>۳</b>ثبت سفارش</span></nav>
        <div className={styles.orderGrid}>

        {/* Order Summary */}
        <aside className={`${styles.summary} ${styles.checkoutSummary}`} aria-label="خلاصه سفارش">
          <h2>انتخاب‌های تو</h2>
          <div>
            {items.map((item) => (
              <div key={`${item.productId}-${item.size}-${item.color}`} className={styles.orderLine}>
                <div className={styles.orderLineImage}>{item.image ? <Image src={item.image} alt={item.name} fill sizes="65px" unoptimized={item.image.startsWith('http')} /> : <span className={styles.placeholder}><SneakerIcon /></span>}</div>
                <div><h3>{item.name}</h3><p>{formatPrice(item.quantity)} عدد · سایز {formatPrice(item.size)} · {item.color}</p><p>{formatPrice(item.price * item.quantity)} تومان</p></div>
              </div>
            ))}
          </div>
          <div className={`${styles.summaryRow} mt-5`}><span>مجموع محصولات</span><strong>{formatPrice(subtotal)} تومان</strong></div>
          <div className={styles.summaryRow}><span>روش ارسال</span><strong>{shippingLoading ? 'در حال بارگذاری…' : selectedShipping?.name ?? 'انتخاب نشده'}</strong></div>
          <div className={styles.summaryRow}><span>روش پرداخت</span><strong>{paymentLoading ? 'در حال بارگذاری…' : selectedPayment?.name ?? 'انتخاب نشده'}</strong></div>
          <div className={styles.summaryRow}><span>هزینهٔ ارسال</span><strong>{shippingLoading || shippingError || shippingCost === null ? '—' : shippingCost === 0 ? 'رایگان' : `${formatPrice(shippingCost)} تومان`}</strong></div>
          <div className={styles.summaryTotal}>
            <span>مجموع سفارش</span>
            <span className={styles.price} aria-live="polite">{shippingLoading || shippingError || shippingCost === null ? '—' : <>{formatPrice(total)} <small>تومان</small></>}</span>
          </div>
          <Link href="/cart" className="text-brand text-xs">بازبینی سبد خرید <ArrowLeft size={15} /></Link>
        </aside>

        {/* Checkout Form */}
        <form onSubmit={handleSubmit} className={`${styles.checkoutForm} space-y-6`}>
          <h2 className={styles.formTitle}><MapPin size={22} />سفارش رو کجا بفرستیم؟</h2>
          {error && (
            <div ref={errorRef} role="alert" tabIndex={-1} className={`border px-4 py-3 rounded-2xl text-sm leading-7 ${stockUnavailable ? 'bg-amber-50 border-amber-200 text-amber-950' : 'bg-red-50 border-red-200 text-red-700'}`}>
              {error}{' '}
              {stockUnavailable && (
                <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2">
                  <Link href="/cart" className="underline font-bold">بازبینی سبد خرید</Link>
                  <Link href="/products" className="underline font-bold">دیدن محصولات دیگر</Link>
                </div>
              )}
              {existingOrderId && <Link href={`/payment/result?orderId=${encodeURIComponent(existingOrderId)}`} onClick={clearCart} className="underline font-bold">مشاهدهٔ سفارش ثبت‌شده</Link>}
              {error.includes('وارد') && (
                <Link href="/login" className="underline font-bold">
                  ورود به حساب
                </Link>
              )}
            </div>
          )}

          <div>
            <label htmlFor="checkout-name" className="block font-bold mb-2">نام و نام خانوادگی</label>
            <input
              id="checkout-name"
              autoComplete="name"
              type="text"
              required
              maxLength={120}
              className="input-field"
              placeholder="مثال: محمد محمدی"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>

          {/* Address selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="block font-bold text-sm">آدرس تحویل سفارش *</p>
              {newAddressMode && savedAddresses.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectAddress(savedAddresses[0])}
                  className="text-xs font-bold text-brand hover:underline"
                >
                  انتخاب از آدرسهای ذخیرهشده
                </button>
              )}
            </div>

            {savedAddresses.length > 0 && !newAddressMode ? (
              <>
                <div className="space-y-2.5">
                  {savedAddresses.map((addr) => (
                    <button
                      key={addr.id}
                      type="button"
                      onClick={() => selectAddress(addr)}
                      aria-pressed={selectedAddrId === addr.id}
                      className={`w-full text-right p-4 rounded-2xl border-2 transition-all ${
                        selectedAddrId === addr.id
                          ? 'border-brand bg-brand/5'
                          : 'border-line hover:border-brand/40'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-bold text-sm flex items-center gap-1.5">
                          {addr.title || 'آدرس'}
                          {addr.isDefault && (
                            <span className="bg-brand/10 text-brand text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1">
                              <Star className="w-3 h-3" />
                              پیشفرض
                            </span>
                          )}
                        </span>
                        <span dir="ltr" className="text-xs text-mist">
                          {addr.phone}
                        </span>
                      </span>
                      <span className="block text-sm text-night mt-1 leading-relaxed">
                        {addr.address}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={startNewAddress}
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-brand hover:underline"
                >
                  <Plus className="w-4 h-4" />
                  افزودن آدرس جدید
                </button>
              </>
            ) : (
              <div className="space-y-4">
                <div>
                  <label htmlFor="checkout-address" className="block font-bold mb-2">آدرس کامل *</label>
                  <textarea
                    id="checkout-address"
                    autoComplete="street-address"
                    required
                    maxLength={3000}
                    className="input-field"
                    placeholder="شهر، خیابان، پلاک، کدپستی"
                    rows={3}
                    value={formData.address}
                    onChange={(e) => { addressEdited.current = true; setFormData({ ...formData, address: e.target.value }) }}
                  />
                </div>

                <div>
                  <label htmlFor="checkout-phone" className="block font-bold mb-2">شماره تماس *</label>
                  <input
                    id="checkout-phone"
                    autoComplete="tel"
                    type="tel"
                    required
                    maxLength={50}
                    dir="ltr"
                    className="input-field"
                    placeholder="0912 345 6789"
                    value={formData.phone}
                    onChange={(e) => { addressEdited.current = true; setFormData({ ...formData, phone: e.target.value }) }}
                  />
                </div>

                {isLoggedIn && (
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveToProfile}
                      onChange={(e) => setSaveToProfile(e.target.checked)}
                      className="w-5 h-5 accent-brand"
                    />
                    <span className="font-medium text-sm">این آدرس در پروفایلم ذخیره شود</span>
                  </label>
                )}
              </div>
            )}
          </div>

          <fieldset className={shippingStyles.section} disabled={loading || shippingLoading}>
            <legend>روش ارسال</legend>
            <p className={shippingStyles.hint}>روش دلخواهت رو انتخاب کن؛ هزینهٔ ارسال در مبلغ نهایی محاسبه می‌شود.</p>
            {shippingLoading ? (
              <p className={shippingStyles.state} role="status">در حال دریافت روش‌های ارسال…</p>
            ) : shippingError ? (
              <div className={shippingStyles.state} role="alert"><p>{shippingError}</p><button type="button" onClick={retryShippingMethods}>تلاش دوباره</button></div>
            ) : shippingMethods.length === 0 ? (
              <div className={shippingStyles.state} role="status"><p>در حال حاضر روش ارسال فعالی وجود ندارد. برای تکمیل خرید با پشتیبانی تماس بگیر.</p><Link href="/contact">ارتباط با پشتیبانی</Link><button type="button" onClick={retryShippingMethods}>بررسی دوباره</button></div>
            ) : (
              <div className={shippingStyles.choices}>
                {shippingMethods.map((method) => {
                  const cost = shippingQuote(method, subtotal, itemCount)
                  return (
                    <label key={method.id} className={`${shippingStyles.choice} ${selectedShippingId === method.id ? shippingStyles.selected : ''}`}>
                      <input type="radio" name="shipping-method" value={method.id} required disabled={cost === null} checked={selectedShippingId === method.id} onChange={() => setSelectedShippingId(method.id)} />
                      <span className={shippingStyles.copy}><strong>{method.name}</strong>{method.description && <span>{method.description}</span>}{method.freeShippingThreshold !== null && method.freeShippingThreshold > 0 && <small>ارسال رایگان برای خرید از {formatPrice(method.freeShippingThreshold)} تومان</small>}</span>
                      <span className={shippingStyles.cost}>{cost === null ? 'قابل محاسبه نیست' : cost === 0 ? 'رایگان' : <>{formatPrice(cost)} <small>تومان</small></>}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </fieldset>

          <fieldset className={shippingStyles.section} disabled={loading || paymentLoading}>
            <legend>روش پرداخت</legend>
            <p className={shippingStyles.hint}>پس از ثبت سفارش، برای پرداخت و ارسال رسید به صفحهٔ پرداخت هدایت می‌شوی.</p>
            {paymentLoading ? (
              <p className={shippingStyles.state} role="status">در حال دریافت روش‌های پرداخت…</p>
            ) : paymentError ? (
              <div className={shippingStyles.state} role="alert"><p>{paymentError}</p><button type="button" onClick={retryPaymentMethods}>تلاش دوباره</button></div>
            ) : paymentMethods.length === 0 ? (
              <div className={shippingStyles.state} role="status"><p>در حال حاضر روش پرداخت فعالی وجود ندارد. برای تکمیل خرید با پشتیبانی تماس بگیر.</p><Link href="/contact">ارتباط با پشتیبانی</Link><button type="button" onClick={retryPaymentMethods}>بررسی دوباره</button></div>
            ) : (
              <div className={shippingStyles.choices}>
                {paymentMethods.map((method) => (
                  <label key={method.id} className={`${shippingStyles.choice} ${selectedPaymentId === method.id ? shippingStyles.selected : ''}`}>
                    <input type="radio" name="payment-method" value={method.id} required checked={selectedPaymentId === method.id} onChange={() => setSelectedPaymentId(method.id)} />
                    <span className={shippingStyles.copy}><strong>{method.name}</strong>{method.description && <span>{method.description}</span>}{method.id === 'bank_transfer' && <small>۱۰ دقیقه مهلت پرداخت و ثبت رسید؛ تأیید پس از بررسی ادمین</small>}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className={styles.checkoutNotice}>
            <ClipboardCheck size={25} className="shrink-0" />
            <p><strong>یه بررسی نهایی</strong>قبل از ثبت سفارش، آدرس، شمارهٔ تماس و سایز محصولات رو بررسی کن.</p>
          </div>

          <button
            type="submit"
            disabled={loading || shippingLoading || Boolean(shippingError) || !selectedShipping || shippingCost === null || paymentLoading || Boolean(paymentError) || !selectedPayment}
            className="btn-primary w-full text-sm py-4 disabled:opacity-50"
          >
            {loading ? 'در حال ثبت سفارش...' : 'ثبت سفارش و ادامهٔ پرداخت'}
          </button>
        </form>
        </div>
      </div>
    </div>
  )
}
