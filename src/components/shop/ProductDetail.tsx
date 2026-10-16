'use client'

import { SneakerIcon } from '@/components/ui/BrandIcons'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowLeft, Minus, Plus, RotateCcw, ShieldCheck, ShoppingBag, Star, Truck } from 'lucide-react'
import { useCart } from '@/lib/cart'
import { toast } from '@/lib/toast'
import { formatPrice } from '@/lib/utils'
import { productPricing } from '@/lib/pricing'
import styles from './commerce.module.css'
import engagement from './product-engagement.module.css'
import ProductReviews from './ProductReviews'

interface ApiProduct {
  id: string
  name: string
  slug: string
  description: string
  price: number
  salePrice?: number | null
  saleStartsAt?: string | null
  saleEndsAt?: string | null
  images: string[]
  sizes: number[]
  colors: string[]
  stock: number
  specifications?: { name: string; value: string }[]
  ratingAverage?: number
  ratingCount?: number
  category: { name: string }
}

export default function ProductDetail({ slug }: { slug: string }) {
  const [product, setProduct] = useState<ApiProduct | null>(null)
  const [loadedSlug, setLoadedSlug] = useState<string | null>(null)
  const loading = loadedSlug !== slug
  const [selectedSize, setSelectedSize] = useState<number | null>(null)
  const [activeColor, setActiveColor] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [activeImage, setActiveImage] = useState(0)
  const [pricingNow, setPricingNow] = useState(() => Date.now())
  const addItem = useCart((state) => state.addItem)
  const syncRating = useCallback(({ average, count }: { average: number; count: number }) => {
    setProduct((current) => current ? { ...current, ratingAverage: average, ratingCount: count } : current)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/products/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('not found')
        return res.json()
      })
      .then((data: ApiProduct) => {
        if (controller.signal.aborted) return
        setProduct(data)
        setPricingNow(Date.now())
        setQuantity(1)
        setActiveImage(0)
        setSelectedSize(data.sizes?.includes(42) ? 42 : (data.sizes?.[0] ?? null))
        setActiveColor(data.colors?.[0] ?? '-')
      })
      .catch(() => { if (!controller.signal.aborted) setProduct(null) })
      .finally(() => { if (!controller.signal.aborted) setLoadedSlug(slug) })
    return () => controller.abort()
  }, [slug])

  useEffect(() => {
    const now = Date.now()
    const next = [product?.saleStartsAt, product?.saleEndsAt].map(value => value ? Date.parse(value) : NaN).filter(value => Number.isFinite(value) && value > pricingNow)
    if (!next.length) return
    const timer = setTimeout(() => setPricingNow(Date.now()), Math.max(0, Math.min(Math.min(...next) - now + 20, 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [product, pricingNow])

  if (loading) {
    return <div className={styles.page} aria-busy="true" aria-label="در حال بارگذاری محصول"><div className={styles.detailGrid}>
      <div className={styles.skeleton}><div className={styles.skeletonPhoto} /></div>
      <div className={styles.detailInfo}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className={styles.skeletonText} />)}</div>
    </div></div>
  }

  if (!product) {
    return <div className={styles.page}><div className={styles.empty}>
      <span className={styles.emptyIcon}><SneakerIcon size={36} /></span>
      <h1>این مدل رو پیدا نکردیم.</h1><p>مدل‌های دیگهٔ ویترین منتظر انتخاب تو هستند.</p>
      <Link href="/products" className="btn-primary">مشاهدهٔ محصولات <ArrowLeft size={18} /></Link>
    </div></div>
  }

  const outOfStock = product.stock <= 0
  const mainImage = product.images[activeImage] ?? product.images[0]
  const pricing = productPricing(product, new Date(pricingNow))
  const handleAddToCart = () => {
    if (outOfStock || !selectedSize || !product.sizes.includes(selectedSize)) return
    const currentPricing = productPricing(product)
    addItem({ productId: product.id, name: product.name, price: currentPricing.effectivePrice, originalPrice: currentPricing.originalPrice, image: product.images[0], size: selectedSize, color: activeColor, quantity })
    toast('محصول به سبد خرید اضافه شد', product.name)
  }

  return <div className={styles.page}>
    <nav className={styles.breadcrumb} aria-label="مسیر صفحه">
      <Link href="/">خانه</Link><span>/</span><Link href="/products">محصولات</Link><span>/</span><span>{product.name}</span>
    </nav>
    <div className={styles.detailGrid}>
      <div className={styles.gallery} data-reveal>
        <div className={styles.mainImage}>
          {mainImage ? <Image src={mainImage} alt={product.name} fill sizes="(max-width: 900px) 95vw, 48vw" unoptimized={mainImage.startsWith('http')} /> : <span className={styles.placeholder}><SneakerIcon size={75} /></span>}
        </div>
        {product.images.length > 1 && <div className={styles.thumbnails}>
          {product.images.map((src, i) => <button key={i} onClick={() => setActiveImage(i)} aria-label={`نمایش تصویر ${formatPrice(i + 1)}`} aria-pressed={activeImage === i} className={`${styles.thumbnail} ${activeImage === i ? styles.thumbnailActive : ''}`}>
            <Image src={src} alt="" fill sizes="120px" unoptimized={src.startsWith('http')} />
          </button>)}
        </div>}
      </div>
      <div className={styles.detailInfo}>
        <span className={styles.detailCategory}>{product.category?.name}</span>
        <h1>{product.name}</h1>
        <a href="#product-reviews" className={engagement.detailRating}>
          <Star size={16} aria-hidden="true" />
          {(product.ratingCount ?? 0) > 0 ? <><strong>{new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(product.ratingAverage ?? 0)}</strong><span>از ۵ · {formatPrice(product.ratingCount ?? 0)} امتیاز</span></> : <span>اولین امتیاز را ثبت کن</span>}
        </a>
        <div className={styles.detailPrice}>
          <div className={styles.priceStack}>
            {pricing.isDiscounted && <div className={styles.saleLine}><del className={styles.originalPrice}>{formatPrice(pricing.originalPrice)} تومان</del><span className={styles.salePill}>{pricing.discountPercent ? `${formatPrice(pricing.discountPercent)}٪ تخفیف` : 'تخفیف ویژه'}</span></div>}
            <p className={styles.price}>{formatPrice(pricing.effectivePrice)} <small>تومان</small></p>
          </div>
          <span className={styles.stock}>{outOfStock ? 'فعلاً ناموجود' : `${formatPrice(product.stock)} جفت موجود در انبار`}</span>
        </div>
        {product.description && <p className={styles.description}>{product.description}</p>}
        {product.sizes.length > 0 && <div className={styles.options}>
          <h2>سایزت رو انتخاب کن</h2>
          <div className={styles.choices}>{product.sizes.map((size) => <button key={size} onClick={() => setSelectedSize(size)} aria-pressed={selectedSize === size} className={`${styles.choice} ${selectedSize === size ? styles.choiceActive : ''}`}>{formatPrice(size)}</button>)}</div>
        </div>}
        {product.colors.length > 0 && <div className={styles.options}>
          <h2>رنگ دلخواهت</h2>
          <div className={styles.choices}>{product.colors.map((color) => <button key={color} onClick={() => setActiveColor(color)} aria-pressed={activeColor === color} className={`${styles.choice} ${activeColor === color ? styles.choiceActive : ''}`}>{color}</button>)}</div>
        </div>}
        <div className={styles.purchase}>
          <div className={styles.quantity}>
            <button onClick={() => setQuantity(Math.max(1, quantity - 1))} disabled={outOfStock || quantity <= 1} aria-label="کاهش تعداد"><Minus size={15} /></button>
            <span aria-live="polite">{formatPrice(quantity)}</span>
            <button onClick={() => setQuantity(Math.min(Math.max(product.stock, 1), quantity + 1))} disabled={outOfStock || quantity >= product.stock} aria-label="افزایش تعداد"><Plus size={15} /></button>
          </div>
          <button onClick={handleAddToCart} disabled={outOfStock || !selectedSize} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"><ShoppingBag size={18} />{outOfStock ? 'فعلاً ناموجود' : !selectedSize ? 'سایزی برای خرید موجود نیست' : 'افزودن به سبد خرید'}</button>
        </div>
        {!outOfStock && quantity >= product.stock && product.stock > 0 && <p className="text-mist text-xs mt-3">بیشتر از این مقدار موجود نیست</p>}
        <Link href="/cart" className={styles.cartLink}>مشاهدهٔ سبد خرید <ArrowLeft size={16} /></Link>
        <div className={styles.perks}>
          <span><RotateCcw />۷ روز ضمانت بازگشت</span>
          <span><ShieldCheck />ضمانت اصالت کالا</span>
          <span><Truck />ارسال در ۴۸ ساعت</span>
        </div>
      </div>
    </div>
    {product.specifications && product.specifications.length > 0 && <section className={engagement.engagementSection} aria-labelledby="product-specifications-title">
      <header className={engagement.sectionHeading}><div><span className={engagement.eyebrow}>جزئیات این مدل</span><h2 id="product-specifications-title">مشخصات کفش</h2></div></header>
      <table className={engagement.specifications} aria-labelledby="product-specifications-title"><tbody>
        {product.specifications.map((specification, index) => <tr key={`${specification.name}-${index}`}><th scope="row">{specification.name}</th><td>{specification.value}</td></tr>)}
      </tbody></table>
    </section>}
    <ProductReviews key={product.id} productId={product.id} slug={product.slug} initialAverage={product.ratingAverage} initialCount={product.ratingCount} onSummaryChange={syncRating} />
  </div>
}
