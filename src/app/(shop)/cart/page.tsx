'use client'

import { SneakerIcon } from '@/components/ui/BrandIcons'

import Link from 'next/link'
import Image from 'next/image'
import { useCart } from '@/lib/cart'
import { formatPrice } from '@/lib/utils'
import { ArrowLeft, ChevronLeft, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react'
import styles from '@/components/shop/commerce.module.css'

export default function CartPage() {
  const { items, removeItem, updateQuantity, getTotal } = useCart()
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
        <div className={styles.cartItems}>{items.map((item) => <article key={`${item.productId}-${item.size}-${item.color}`} className={styles.cartItem}>
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
          </div>
          <div className={styles.cartActions}>
            <button onClick={() => removeItem(item.productId, item.size, item.color)} aria-label={`حذف ${item.name}`} className={styles.remove}><Trash2 size={17} /></button>
            <div className={styles.quantity}>
              <button onClick={() => updateQuantity(item.productId, item.size, item.color, item.quantity - 1)} aria-label={`کاهش تعداد ${item.name}`}><Minus size={14} /></button>
              <span aria-live="polite">{formatPrice(item.quantity)}</span>
              <button onClick={() => updateQuantity(item.productId, item.size, item.color, item.quantity + 1)} aria-label={`افزایش تعداد ${item.name}`}><Plus size={14} /></button>
            </div>
          </div>
        </article>)}</div>
        <Link href="/products" className={styles.continue}>ادامهٔ گشت‌وگذار در ویترین <ArrowLeft size={17} /></Link>
      </div>
      <aside className={styles.summary} aria-label="خلاصه سفارش">
        <h2>خلاصهٔ سفارش</h2>
        <div className={styles.summaryRow}><span>تعداد محصولات</span><strong>{formatPrice(count)} عدد</strong></div>
        {productDiscount > 0 && <><div className={styles.summaryRow}><span>قیمت اصلی محصولات</span><strong>{formatPrice(originalTotal)} تومان</strong></div><div className={`${styles.summaryRow} ${styles.savings}`}><span>تخفیف محصولات</span><strong>{formatPrice(productDiscount)} تومان</strong></div></>}
        <div className={styles.summaryRow}><span>هزینهٔ ارسال</span><strong>در مرحلهٔ بعد محاسبه می‌شود</strong></div>
        <div className={styles.summaryTotal}><span>مجموع محصولات</span><span className={styles.price}>{formatPrice(total)} <small>تومان</small></span></div>
        <Link href="/checkout" className="btn-primary">ادامهٔ خرید <ArrowLeft size={18} /></Link>
        <p className={styles.summaryNote}>کد تخفیف را در مرحلهٔ بعد وارد کن. قیمت نهایی هنگام ثبت سفارش دوباره بررسی می‌شود.</p>
      </aside>
    </div>
  </div>
}
