'use client'

import { SneakerIcon } from '@/components/ui/BrandIcons'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useState } from 'react'
import { useCart } from '@/lib/cart'
import type { CartItem, ProductVariant } from '@/types'
import { formatPrice } from '@/lib/utils'
import { ArrowLeft, ChevronLeft, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import styles from '@/components/shop/commerce.module.css'

interface CatalogStock { id: string; inventoryConfigured?: boolean; variants?: ProductVariant[]; price: number; effectivePrice?: number; originalPrice?: number }

export default function CartPage() {
  const { items, removeItem, updateQuantity, getTotal, syncPrices } = useCart()
  const [catalog, setCatalog] = useState<{ key: string; products: CatalogStock[]; error: string }>({ key: '', products: [], error: '' })
  const [revision, setRevision] = useState(0)
  const catalogKey = JSON.stringify([...new Set(items.map(item => item.productId))].sort())
  const inventoryLoading = catalog.key !== catalogKey
  const inventoryError = !inventoryLoading ? catalog.error : ''
  useEffect(() => {
    const ids: string[] = JSON.parse(catalogKey)
    if (!ids.length) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      setCatalog({ key: catalogKey, products: [], error: 'دریافت موجودی بیش از حد طول کشید. دوباره تلاش کن.' })
    }, 20_000)
    void Promise.all(ids.map(async id => {
      const response = await fetch(`/api/products/${encodeURIComponent(id)}`, { cache: 'no-store', signal: controller.signal })
      if (response.status === 404) return null
      const product = await response.json()
      if (!response.ok || !product || product.id !== id || !Number.isSafeInteger(product.price)) throw new Error('دریافت موجودی انجام نشد. دوباره تلاش کن.')
      return product as CatalogStock
    })).then(products => {
      if (controller.signal.aborted) return
      const available = products.filter((product): product is CatalogStock => product !== null)
      syncPrices(available.map(product => ({ productId: product.id, price: product.effectivePrice ?? product.price, originalPrice: product.originalPrice ?? product.price })))
      setCatalog({ key: catalogKey, products: available, error: '' })
    }).catch(() => { if (!controller.signal.aborted) setCatalog({ key: catalogKey, products: [], error: 'موجودی رنگ و سایزها دریافت نشد. دوباره تلاش کن.' }) }).finally(() => clearTimeout(timer))
    return () => { clearTimeout(timer); controller.abort() }
  }, [catalogKey, revision, syncPrices])
  const availableFor = (item: CartItem): number | null => {
    if (inventoryLoading || inventoryError) return null
    const product = catalog.products.find(product => product.id === item.productId)
    if (product?.inventoryConfigured !== true) return 0
    const variant = product.variants?.find(variant => variant.isActive && variant.size === item.size && variant.color === item.color)
    return variant?.stock ?? 0
  }
  const inventoryValid = !inventoryLoading && !inventoryError && items.every(item => item.quantity <= (availableFor(item) ?? 0))
  const total = getTotal()
  const count = items.reduce((sum, item) => sum + item.quantity, 0)
  const originalTotal = items.reduce((sum, item) => sum + Math.max(item.originalPrice ?? item.price, item.price) * item.quantity, 0)
  const productDiscount = originalTotal - total

  if (items.length === 0) {
    return <div className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="مسیر صفحه"><Link href="/">خانه</Link><span>/</span><span>سبد خرید</span></nav>
      <div className={styles.empty}>
        <span className={styles.emptyIcon}><ShoppingBag size={36} /></span>
        <h1>جای جفت بعدی‌ات خالیه.</h1>
        <p>هنوز محصولی به سبد خرید اضافه نکرده‌ای.<br />از ویترین شروع کن و مدل دلخواهت رو پیدا کن.</p>
        <Link href="/products" className="btn-primary">بریم سراغ مدل‌ها <ArrowLeft size={18} /></Link>
      </div>
    </div>
  }

  return <div className={styles.page}>
    <nav className={styles.breadcrumb} aria-label="مسیر صفحه"><Link href="/">خانه</Link><span>/</span><span>سبد خرید</span></nav>
    <section className={styles.intro}>
      <div><p className={styles.eyebrow}>انتخاب‌های تو</p><h1>یه قدم تا همراه تازه‌ات.</h1><p>{formatPrice(count)} محصول در سبد خریدت آمادهٔ بررسیه.</p></div>
      <span className={styles.introMark} aria-hidden="true"><ShoppingBag /></span>
    </section>
    <nav className={styles.steps} aria-label="مراحل خرید"><span className={styles.stepActive} aria-current="step"><b>۱</b>سبد خرید</span><ChevronLeft size={14} /><span><b>۲</b>اطلاعات ارسال</span><ChevronLeft size={14} /><span><b>۳</b>ثبت سفارش</span></nav>
    <div className={styles.orderGrid}>
      <div>
        <div className={styles.cartItems}>{items.map((item) => {
          const available = availableFor(item)
          return <article key={`${item.productId}-${item.size}-${item.color}`} className={styles.cartItem}>
          <Link href={`/products/${encodeURIComponent(item.productId)}`} className={styles.cartImage}>
            {item.image ? <Image src={item.image} alt={item.name} fill sizes="120px" unoptimized={item.image.startsWith('http')} /> : <span className={styles.placeholder}><SneakerIcon /></span>}
          </Link>
          <div className={styles.cartCopy}>
            <h2><Link href={`/products/${encodeURIComponent(item.productId)}`}>{item.name}</Link></h2>
            <p><span>سایز {formatPrice(item.size)}</span><span>{item.color}</span></p>
            <div className={styles.priceStack}>
              {(item.originalPrice ?? item.price) > item.price && <del className={styles.originalPrice}>{formatPrice(item.originalPrice!)} تومان</del>}
              <div className={styles.price}>{formatPrice(item.price)} <small>تومان</small></div>
            </div>
            {available !== null && item.quantity > available && <p className={styles.variantNotice} role="alert">{available === 0 ? 'این رنگ و سایز فعلاً موجود نیست؛ آن را حذف کن یا انتخاب دیگری داشته باش.' : `از این رنگ و سایز فقط ${formatPrice(available)} جفت موجود است.`}{available > 0 && <button type="button" onClick={() => updateQuantity(item.productId, item.size, item.color, available)}>تنظیم تعداد به موجودی</button>}</p>}
          </div>
          <div className={styles.cartActions}>
            <button onClick={() => removeItem(item.productId, item.size, item.color)} aria-label={`حذف ${item.name}`} className={styles.remove}><Trash2 size={17} /></button>
            <div className={styles.quantity}>
              <button onClick={() => updateQuantity(item.productId, item.size, item.color, item.quantity - 1)} aria-label={`کاهش تعداد ${item.name}`}><Minus size={14} /></button>
              <span aria-live="polite">{formatPrice(item.quantity)}</span>
              <button disabled={available === null || item.quantity >= available} onClick={() => { if (available !== null && item.quantity < available) updateQuantity(item.productId, item.size, item.color, item.quantity + 1) }} aria-label={`افزایش تعداد ${item.name}`}><Plus size={14} /></button>
            </div>
          </div>
        </article>})}</div>
        <Link href="/products" className={styles.continue}>ادامهٔ گشت‌وگذار در ویترین <ArrowLeft size={17} /></Link>
      </div>
      <aside className={styles.summary} aria-label="خلاصه سفارش">
        <h2>خلاصهٔ سفارش</h2>
        <div className={styles.summaryRow}><span>تعداد محصولات</span><strong>{formatPrice(count)} عدد</strong></div>
        {productDiscount > 0 && <><div className={styles.summaryRow}><span>قیمت اصلی محصولات</span><strong>{formatPrice(originalTotal)} تومان</strong></div><div className={`${styles.summaryRow} ${styles.savings}`}><span>تخفیف محصولات</span><strong>{formatPrice(productDiscount)} تومان</strong></div></>}
        <div className={styles.summaryRow}><span>هزینهٔ ارسال</span><strong>در مرحلهٔ بعد محاسبه می‌شود</strong></div>
        <div className={styles.summaryTotal}><span>مجموع محصولات</span><span className={styles.price}>{formatPrice(total)} <small>تومان</small></span></div>
        {inventoryLoading && <p className={styles.summaryNote} role="status">در حال بررسی موجودی رنگ و سایزها…</p>}
        {inventoryError && <div className={styles.variantNotice} role="alert">{inventoryError}<button type="button" onClick={() => { setCatalog(previous => ({ ...previous, key: '' })); setRevision(previous => previous + 1) }}>بررسی دوبارهٔ موجودی</button></div>}
        {inventoryValid ? <Link href="/checkout" className="btn-primary">ادامهٔ خرید <ArrowLeft size={18} /></Link> : <button type="button" className="btn-primary disabled:opacity-50" disabled>ادامهٔ خرید <ArrowLeft size={18} /></button>}
        <p className={styles.summaryNote}>کد تخفیف را در مرحلهٔ بعد وارد کن. قیمت نهایی هنگام ثبت سفارش دوباره بررسی می‌شود.</p>
      </aside>
    </div>
  </div>
}
