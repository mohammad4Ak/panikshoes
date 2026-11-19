'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { X, ArrowUpDown, Search, SlidersHorizontal } from 'lucide-react'
import ProductCard from '@/components/shop/ProductCard'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import styles from '@/components/shop/commerce.module.css'
import catalogStyles from './products.module.css'

interface ApiProduct {
  id: string
  name: string
  slug: string
  price: number
  salePrice?: number | null
  saleStartsAt?: string | null
  saleEndsAt?: string | null
  images: string[]
  stock: number
  inventoryConfigured?: boolean
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

type CatalogPage = {
  items: ApiProduct[]
  total: number
  page: number
  hasMore: boolean
  lastPageEmpty: boolean
  pricedAt?: number
  nextPriceChangeAt: number | null
  refreshAt: number | null
}

type CatalogView = {
  key: string
  priceRevision: number
  result: CatalogPage | null
  phase: 'ready' | 'error' | 'loading-more' | 'more-error' | 'refresh-error'
  message?: string
}

type CatalogRequest = {
  key: string
  query: string
  priceRevision: number
  controller: AbortController
  result: CatalogPage | null
  targetPage: number
  pending: boolean
}

const catalogNumber = new Intl.NumberFormat('fa-IR')
const keyboardFilters = ['q', 'min', 'max']
const filterKeys: FilterParam[] = ['cat', 'q', 'sort', 'min', 'max', 'stock']

// Native history keeps the filters shareable and leaves the toolbar mounted.
function updateFilters(changes: Partial<Record<FilterParam, string>>) {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
}

function catalogQuery(searchParams: Pick<URLSearchParams, 'get'>) {
  const query = new URLSearchParams()
  for (const key of filterKeys) {
    const value = searchParams.get(key)?.trim()
    if (!value) continue
    if ((key === 'cat' && value === 'ALL') || (key === 'sort' && value === 'newest') || (key === 'stock' && value !== '1')) continue
    query.set(key, value)
  }
  return query.toString()
}

async function getCatalogJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, cache: 'no-store' })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'دریافت ویترین انجام نشد. دوباره تلاش کن.')
  return data
}

async function getCatalogPage(query: string, page: number, signal: AbortSignal): Promise<CatalogPage> {
  const params = new URLSearchParams(query)
  params.set('page', String(page))
  const data = await getCatalogJson(`/api/catalog/products?${params}`, signal)
  if (!Array.isArray(data?.items) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || typeof data.hasMore !== 'boolean') {
    throw new Error('پاسخ ویترین معتبر نیست. دوباره تلاش کن.')
  }
  const now = Date.now()
  const next = typeof data.nextPriceChangeAt === 'string' ? Date.parse(data.nextPriceChangeAt) : NaN
  const snapshot = typeof data.pricedAt === 'string' ? Date.parse(data.pricedAt) : NaN
  const pricedAt = Number.isFinite(snapshot) ? snapshot : undefined
  const snapshotTime = pricedAt ?? now
  const nextPriceChangeAt = Number.isFinite(next) && next > snapshotTime ? next : null
  // Convert the server's discount deadline into a browser-clock deadline.
  const refreshAt = nextPriceChangeAt === null ? null : now + nextPriceChangeAt - snapshotTime
  return { items: data.items, total: data.total, page, hasMore: data.hasMore, lastPageEmpty: data.items.length === 0, pricedAt, nextPriceChangeAt, refreshAt }
}

function appendPage(current: CatalogPage, next: CatalogPage): CatalogPage {
  const items = new Map(current.items.map(product => [product.id, product]))
  for (const product of next.items) items.set(product.id, product)
  const refreshAt = Math.min(current.refreshAt ?? Infinity, next.refreshAt ?? Infinity)
  const nextPriceChangeAt = Math.min(current.nextPriceChangeAt ?? Infinity, next.nextPriceChangeAt ?? Infinity)
  return {
    ...next,
    items: [...items.values()],
    pricedAt: current.pricedAt ?? next.pricedAt,
    nextPriceChangeAt: Number.isFinite(nextPriceChangeAt) ? nextPriceChangeAt : null,
    refreshAt: Number.isFinite(refreshAt) ? refreshAt : null,
  }
}

function catalogError(cause: unknown) {
  return cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.'
}

function ProductsContent() {
  const settings = useSiteSettings()
  const searchParams = useSearchParams()

  const [categories, setCategories] = useState<Category[]>([])
  const categoryCache = useRef<Category[] | null>(null)
  const request = useRef<CatalogRequest | null>(null)
  const [view, setView] = useState<CatalogView | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [priceRevision, setPriceRevision] = useState(0)

  const activeCat = searchParams.get('cat')?.trim() || 'ALL'
  const query = searchParams.get('q') ?? ''
  const sortParam = searchParams.get('sort')
  const sort: SortKey = sortParam === 'cheap' || sortParam === 'expensive' || sortParam === 'popular' || sortParam === 'views' ? sortParam : 'newest'
  const minPrice = searchParams.get('min') ?? ''
  const maxPrice = searchParams.get('max') ?? ''
  const inStockOnly = searchParams.get('stock') === '1'
  const filterQuery = catalogQuery(searchParams)
  const requestKey = `${reloadKey}:${filterQuery}`
  const current = view?.key === requestKey ? view : null
  const result = current?.result ?? null
  const loading = current === null
  const loadError = current?.phase === 'error' ? current.message : ''
  const refreshing = result !== null && current?.priceRevision !== priceRevision
  const loadingMore = current?.phase === 'loading-more'
  const listingChanged = result !== null && !result.hasMore
    && (result.items.length !== result.total || (result.page > 1 && result.lastPageEmpty))
  const refreshAt = refreshing || current?.phase === 'refresh-error' ? null : result?.refreshAt
  const searchTerm = query.trim()
  let resultsSummary = `${catalogNumber.format(result?.total ?? 0)} مدل${searchTerm ? ` برای «${searchTerm}»` : ''}`
  if (loading) resultsSummary = 'در حال بارگذاری مدل‌ها...'
  else if (loadError) resultsSummary = 'ویترین دریافت نشد'
  else if (refreshing) resultsSummary = 'در حال به‌روزرسانی مدل‌ها...'
  else if (listingChanged) resultsSummary = 'فهرست محصولات تغییر کرده است.'

  useEffect(() => {
    const previous = request.current
    const scope: CatalogRequest = {
      key: requestKey,
      query: filterQuery,
      priceRevision,
      controller: new AbortController(),
      result: previous?.key === requestKey ? previous.result : null,
      targetPage: previous?.key === requestKey ? previous.targetPage : 1,
      pending: true,
    }
    request.current = scope
    const { signal } = scope.controller

    async function loadCategories(): Promise<Category[]> {
      if (categoryCache.current) return categoryCache.current
      const data = await getCatalogJson('/api/categories', signal)
      if (!Array.isArray(data)) throw new Error('پاسخ دسته‌بندی‌ها معتبر نیست. دوباره تلاش کن.')
      return data
    }

    async function loadPages() {
      let data = await getCatalogPage(filterQuery, 1, signal)
      while (!signal.aborted && data.hasMore && data.page < scope.targetPage) {
        data = appendPage(data, await getCatalogPage(filterQuery, data.page + 1, signal))
      }
      return data
    }

    async function load() {
      try {
        const [data, groups] = await Promise.all([loadPages(), loadCategories()])
        if (signal.aborted) return
        scope.result = data
        scope.targetPage = data.page
        if (categoryCache.current !== groups) {
          categoryCache.current = groups
          setCategories(groups)
        }
        setView({ key: requestKey, priceRevision, result: data, phase: 'ready' })
      } catch (cause) {
        if (signal.aborted) return
        setView({ key: requestKey, priceRevision, result: scope.result, phase: scope.result ? 'refresh-error' : 'error', message: catalogError(cause) })
      } finally {
        scope.pending = false
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const oldParams = new URLSearchParams(previous?.query)
    const newParams = new URLSearchParams(filterQuery)
    const typing = previous && keyboardFilters.some(key => oldParams.get(key) !== newParams.get(key))
    if (typing) timer = setTimeout(() => void load(), 250)
    else void load()

    return () => {
      clearTimeout(timer)
      scope.controller.abort()
    }
  }, [filterQuery, requestKey, priceRevision])

  useEffect(() => {
    if (refreshAt == null) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = (deadline: number) => {
      const remaining = Math.max(0, deadline - Date.now() + 20)
      if (remaining > 2_147_483_647) timer = setTimeout(() => schedule(deadline), 2_147_483_647)
      else timer = setTimeout(() => setPriceRevision(value => value + 1), remaining)
    }
    schedule(refreshAt)
    return () => clearTimeout(timer)
  }, [refreshAt])

  async function loadMore() {
    const scope = request.current
    if (!result?.hasMore || refreshing || current?.phase === 'refresh-error' || !scope || scope.pending) return
    if (scope.result !== result || scope.key !== requestKey || scope.priceRevision !== priceRevision) return
    const { signal } = scope.controller
    if (signal.aborted || catalogQuery(new URLSearchParams(window.location.search)) !== filterQuery) return
    scope.pending = true
    scope.targetPage = result.page + 1
    setView({ key: requestKey, priceRevision, result, phase: 'loading-more' })
    try {
      const next = await getCatalogPage(filterQuery, scope.targetPage, signal)
      if (signal.aborted) return
      if (result.nextPriceChangeAt !== null && next.pricedAt !== undefined && next.pricedAt >= result.nextPriceChangeAt) {
        // The next request was sorted using new prices. Refresh all requested pages together.
        setPriceRevision(value => value + 1)
        return
      }
      const data = appendPage(result, next)
      scope.result = data
      scope.pending = false
      setView({ key: requestKey, priceRevision, result: data, phase: 'ready' })
    } catch (cause) {
      if (signal.aborted) return
      scope.targetPage = result.page
      scope.pending = false
      setView({ key: requestKey, priceRevision, result, phase: 'more-error', message: catalogError(cause) })
    }
  }

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

        <header className={catalogStyles.heading}>
          <h1>محصولات {settings.storeName}</h1>
          <p>از روزمره تا مهمانی؛ مدلی برای استایل تو.</p>
        </header>

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
          <div className={styles.search}><Search size={17} /><input value={query} maxLength={200} onChange={(e) => updateFilters({ q: e.target.value })} placeholder="دنبال کدوم مدل می‌گردی؟" aria-label="جستجوی محصولات" />{query && <button onClick={() => updateFilters({ q: '' })} aria-label="پاک کردن جستجو"><X size={15} /></button>}</div>
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
              <FormattedNumberInput
                min={0}
                grouping={false}
                placeholder="از"
                aria-label="حداقل قیمت"
                className="input-field !py-2 text-xs"
                value={minPrice}
                onValueChange={(value) => updateFilters({ min: value })}
              />
              <span className="text-mist">—</span>
              <FormattedNumberInput
                min={0}
                grouping={false}
                placeholder="تا"
                aria-label="حداکثر قیمت"
                className="input-field !py-2 text-xs"
                value={maxPrice}
                onValueChange={(value) => updateFilters({ max: value })}
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

        <div className={styles.results}>
          <h2>{activeCategoryName || 'همهٔ مدل‌ها'}</h2>
          <span aria-live="polite">{resultsSummary}</span>
        </div>

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
            <button type="button" className="btn-primary" onClick={() => setReloadKey(value => value + 1)}>تلاش دوباره</button>
          </div>
        ) : result && result.items.length > 0 ? (
          <div id="catalog-products" className={styles.grid} aria-busy={refreshing || loadingMore}>
            {result.items.map((product, index) => (
              <ProductCard
                key={product.id}
                pricingAt={result.pricedAt}
                revealDelay={(index % 4) as 0 | 1 | 2 | 3}
                product={{
                  id: product.id,
                  name: product.name,
                  slug: product.slug,
                  price: product.price,
                  salePrice: product.salePrice,
                  saleStartsAt: product.saleStartsAt,
                  saleEndsAt: product.saleEndsAt,
                  image: product.images[0] ?? '',
                  category: product.category?.name ?? '',
                  stock: product.stock,
                  inventoryConfigured: product.inventoryConfigured,
                  ratingAverage: product.ratingAverage ?? 0,
                  ratingCount: product.ratingCount ?? 0,
                }}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}><SlidersHorizontal size={33} /></span>
            <h2>{hasActiveFilters ? 'این ترکیب، نتیجه‌ای نداشت.' : 'هنوز محصولی ثبت نشده است'}</h2>
            <p className="text-mist mb-6">
              {!hasActiveFilters
                ? 'مدل‌های جدید به‌زودی در ویترین قرار می‌گیرند.'
                : activeCategoryName
                  ? `در دسته‌بندی «${activeCategoryName}» با این فیلترها محصولی نیست. فیلترها را تغییر بده.`
                  : 'با تغییر فیلترها، مدل‌های بیشتری رو ببین.'}
            </p>
            {hasActiveFilters && (
              <button onClick={clearAllFilters} className="btn-primary">
                پاکسازی فیلترها
              </button>
            )}
          </div>
        )}

        {result && (result.hasMore || result.page > 1 || listingChanged || current?.phase === 'refresh-error') && (
          <div className={catalogStyles.pagination}>
            {!listingChanged && (result.hasMore || result.page > 1) && (
              <p role="status">نمایش {catalogNumber.format(result.items.length)} از {catalogNumber.format(result.total)} مدل</p>
            )}
            {current?.phase === 'refresh-error' ? (
              <>
                <p className={catalogStyles.paginationError} role="alert">{current.message}</p>
                <button type="button" className="btn-outline" aria-disabled={refreshing} onClick={() => { if (!refreshing) setPriceRevision(value => value + 1) }}>دریافت دوبارهٔ محصولات</button>
              </>
            ) : listingChanged ? (
              <button type="button" className="btn-outline" aria-disabled={refreshing} onClick={() => { if (!refreshing) setPriceRevision(value => value + 1) }}>به‌روزرسانی فهرست</button>
            ) : result.hasMore && (
              <>
                {current?.phase === 'more-error' && <p className={catalogStyles.paginationError} role="alert">{current.message}</p>}
                <button type="button" className="btn-outline" aria-controls="catalog-products" aria-disabled={loadingMore || refreshing} onClick={() => void loadMore()}>
                  {loadingMore ? 'در حال دریافت محصولات...' : 'نمایش محصولات بیشتر'}
                </button>
              </>
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
