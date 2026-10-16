'use client'

import { SneakerIcon } from '@/components/ui/BrandIcons'

import { useState, useEffect, useMemo, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { X, ArrowUpDown, Search, SlidersHorizontal } from 'lucide-react'
import ProductCard from '@/components/shop/ProductCard'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import { productPricing } from '@/lib/pricing'
import styles from '@/components/shop/commerce.module.css'

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
  stock: number
  categoryId: string
  category: { name: string }
  ratingAverage?: number
  ratingCount?: number
  viewCount?: number
}

interface Category {
  id: string
  name: string
}

type SortKey = 'newest' | 'cheap' | 'expensive' | 'popular' | 'views'
type FilterParam = 'cat' | 'q' | 'sort' | 'min' | 'max' | 'stock'

// The URL is the filter state. Native history updates notify useSearchParams
// without an extra server request or competing state-synchronization effects.
function updateFilters(changes: Partial<Record<FilterParam, string>>) {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
}

function ProductsContent() {
  const settings = useSiteSettings()
  const searchParams = useSearchParams()

  const [products, setProducts] = useState<ApiProduct[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [pricingNow, setPricingNow] = useState(() => Date.now())

  const activeCat = searchParams.get('cat') || 'ALL'
  const query = searchParams.get('q') ?? ''
  const sortParam = searchParams.get('sort')
  const sort: SortKey = sortParam === 'cheap' || sortParam === 'expensive' || sortParam === 'popular' || sortParam === 'views' ? sortParam : 'newest'
  const minPrice = searchParams.get('min') ?? ''
  const maxPrice = searchParams.get('max') ?? ''
  const inStockOnly = searchParams.get('stock') === '1'

  useEffect(() => {
    const controller = new AbortController()
    async function loadList(url: string) {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'دریافت ویترین انجام نشد. دوباره تلاش کن.')
      if (!Array.isArray(data)) throw new Error('پاسخ ویترین معتبر نیست. دوباره تلاش کن.')
      return data
    }
    async function load() {
      try {
        const [items, groups] = await Promise.all([loadList('/api/products'), loadList('/api/categories')])
        if (!controller.signal.aborted) {
          setProducts(items)
          setPricingNow(Date.now())
          setCategories(groups)
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setLoadError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [reloadKey])

  useEffect(() => {
    const now = Date.now()
    const next = products.flatMap(product => [product.saleStartsAt, product.saleEndsAt]).map(value => value ? Date.parse(value) : NaN).filter(value => Number.isFinite(value) && value > pricingNow)
    if (!next.length) return
    const timer = setTimeout(() => setPricingNow(Date.now()), Math.max(0, Math.min(Math.min(...next) - now + 20, 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [products, pricingNow])

  const filtered = useMemo(() => {
    const min = minPrice === '' ? null : Number(minPrice)
    const max = maxPrice === '' ? null : Number(maxPrice)
    const searchQuery = query.trim().toLocaleLowerCase()
    const priceOf = (product: ApiProduct) => productPricing(product, new Date(pricingNow)).effectivePrice

    const list = products.filter((p) => {
      if (activeCat !== 'ALL' && p.categoryId !== activeCat) return false
      if (searchQuery && ![p.name, p.slug, p.description].some((text) => text?.toLocaleLowerCase().includes(searchQuery))) return false
      if (min !== null && !isNaN(min) && priceOf(p) < min) return false
      if (max !== null && !isNaN(max) && priceOf(p) > max) return false
      if (inStockOnly && p.stock <= 0) return false
      return true
    })

    switch (sort) {
      case 'cheap':
        return [...list].sort((a, b) => priceOf(a) - priceOf(b))
      case 'expensive':
        return [...list].sort((a, b) => priceOf(b) - priceOf(a))
      case 'popular':
        return [...list].sort((a, b) => (b.ratingAverage ?? 0) - (a.ratingAverage ?? 0) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0))
      case 'views':
        return [...list].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0) || (b.ratingAverage ?? 0) - (a.ratingAverage ?? 0) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0))
      default:
        return list // جدیدترین = ترتیب API بر اساس createdAt desc
    }
  }, [products, activeCat, query, sort, minPrice, maxPrice, inStockOnly, pricingNow])

  const activeCategoryName = categories.find((c) => c.id === activeCat)?.name

  const hasActiveFilters =
    activeCat !== 'ALL' || query !== '' || sort !== 'newest' || minPrice !== '' || maxPrice !== '' || inStockOnly

  const clearAllFilters = () => {
    updateFilters({ cat: '', q: '', sort: '', min: '', max: '', stock: '' })
  }

  return (
    <div className={styles.page}>
      <div>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه">
          <Link href="/" className="hover:text-brand">خانه</Link>
          <span>/</span>
          <span className="text-night">محصولات</span>
        </nav>

        <section className={styles.intro} data-reveal>
          <div>
            <p className={styles.eyebrow}>ویترین {settings.storeName}</p>
            <h1>جفت بعدی‌ات رو پیدا کن.</h1>
            <p>برای هر مسیر و هر استایل؛ از اینجا انتخاب کن.</p>
          </div>
          <span className={styles.introMark} aria-hidden="true"><SneakerIcon /></span>
        </section>

        {/* Toolbar: دسته بندیها (راست) + مرتبسازی/قیمت/موجودی (چپ) */}
        <div className={styles.toolbar}>
          <div className={styles.filterTop}>
          {/* Category chips */}
          <div className={styles.chips} aria-label="دسته‌بندی محصولات">
            <button
              onClick={() => updateFilters({ cat: '' })}
              className={`${styles.chip} ${activeCat === 'ALL' ? styles.chipActive : ''}`}
              aria-pressed={activeCat === 'ALL'}
            >
              همه
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => updateFilters({ cat: activeCat === c.id ? '' : c.id })}
                className={`${styles.chip} ${activeCat === c.id ? styles.chipActive : ''}`}
                aria-pressed={activeCat === c.id}
              >
                {c.name}
              </button>
            ))}
          </div>
          <div className={styles.search}><Search size={17} /><input value={query} onChange={(e) => updateFilters({ q: e.target.value })} placeholder="دنبال کدوم مدل می‌گردی؟" aria-label="جستجوی محصولات" />{query && <button onClick={() => updateFilters({ q: '' })} aria-label="پاک کردن جستجو"><X size={15} /></button>}</div>
          </div>
          <div className={styles.filterBottom}>

          {/* Sort & Price & Stock */}
          <div className={styles.filterControls}>
            <EnhancedSelect
              compact
              icon={<ArrowUpDown size={15} />}
              value={sort}
              onChange={(e) => updateFilters({ sort: e.target.value === 'newest' ? '' : e.target.value })}
              aria-label="مرتب‌سازی محصولات"
            >
              <option value="newest">جدیدترین</option>
              <option value="popular">محبوب‌ترین</option>
              <option value="views">پربازدیدترین</option>
              <option value="cheap">ارزان‌ترین</option>
              <option value="expensive">گران‌ترین</option>
            </EnhancedSelect>

            <div className={styles.priceRange}>
              <span className="text-xs text-mist">قیمت:</span>
              <input
                type="number"
                min={0}
                placeholder="از"
                dir="ltr"
                aria-label="حداقل قیمت"
                className="input-field !py-2 text-xs"
                value={minPrice}
                onChange={(e) => updateFilters({ min: e.target.value })}
              />
              <span className="text-mist">—</span>
              <input
                type="number"
                min={0}
                placeholder="تا"
                dir="ltr"
                aria-label="حداکثر قیمت"
                className="input-field !py-2 text-xs"
                value={maxPrice}
                onChange={(e) => updateFilters({ max: e.target.value })}
              />
              <span className="text-xs text-mist">تومان</span>
            </div>

            <label className={styles.stockCheck}>
              <input
                type="checkbox"
                checked={inStockOnly}
                onChange={(e) => updateFilters({ stock: e.target.checked ? '1' : '' })}
              />
              <span>فقط مدل‌های موجود</span>
            </label>
          </div>
          {hasActiveFilters && <button onClick={clearAllFilters} className={styles.clear}><X size={14} /> پاکسازی فیلترها</button>}
          </div>
        </div>

        <div className={styles.results}><h2>{activeCategoryName || 'همهٔ مدل‌ها'}</h2><span aria-live="polite">{loading ? 'در حال بارگذاری مدل‌ها...' : loadError ? 'ویترین دریافت نشد' : `${new Intl.NumberFormat('fa-IR').format(filtered.length)} مدل${query ? ` برای «${query}»` : ''}`}</span></div>

        {/* Products Grid */}
        {loading ? (
          <div className={styles.grid} aria-label="در حال بارگذاری محصولات" aria-busy="true">
            {[...Array(4)].map((_, i) => (
              <div key={i} className={styles.skeleton}>
                <div className={styles.skeletonPhoto} />
                <div className={styles.skeletonText} />
                <div className={styles.skeletonText} />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}><SlidersHorizontal size={33} /></span>
            <h2>ویترین فعلاً در دسترس نیست.</h2>
            <p role="alert" className="text-mist mb-6">{loadError}</p>
            <button className="btn-primary" onClick={() => { setLoading(true); setLoadError(''); setReloadKey((value) => value + 1) }}>تلاش دوباره</button>
          </div>
        ) : filtered.length > 0 ? (
          <div className={styles.grid}>
            {filtered.map((product, index) => (
              <ProductCard
                key={product.id}
                revealDelay={(index % 4) as 0 | 1 | 2 | 3}
                product={{
                  id: product.id,
                  name: product.name,
                  slug: product.slug,
                  price: product.price,
                  salePrice: product.salePrice,
                  saleStartsAt: product.saleStartsAt,
                  saleEndsAt: product.saleEndsAt,
                  image: product.images[0],
                  category: product.category?.name ?? '',
                  stock: product.stock,
                  ratingAverage: product.ratingAverage ?? 0,
                  ratingCount: product.ratingCount ?? 0,
                }}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}><SlidersHorizontal size={33} /></span>
            <h2>این ترکیب، نتیجه‌ای نداشت.</h2>
            <p className="text-mist mb-6">
              {products.length === 0
                ? 'هنوز محصولی ثبت نشده است'
                : activeCategoryName
                  ? `در دسته‌بندی «${activeCategoryName}» با این فیلترها محصولی نیست. فیلترها را تغییر بده.`
                  : 'با تغییر فیلترها، مدل‌های بیشتری رو ببین.'}
            </p>
            {hasActiveFilters && products.length > 0 && (
              <button onClick={clearAllFilters} className="btn-primary">
                پاکسازی فیلترها
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<div className={styles.page}><div className={styles.empty} role="status">در حال آماده‌سازی ویترین...</div></div>}>
      <ProductsContent />
    </Suspense>
  )
}
