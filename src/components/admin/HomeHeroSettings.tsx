'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ImageIcon, RefreshCw, Search, X } from 'lucide-react'
import { homeHeroLimits } from '@/lib/site-settings-contract'
import styles from './home-hero-settings.module.css'

type HeroProduct = { id: string; name: string; stock: number; images: string[]; category?: { name: string } }
type Props = {
  productIds: string[]
  intervalSeconds: number
  onProductIdsChange: (value: string[]) => void
  onIntervalChange: (value: number) => void
  disabled: boolean
  active: boolean
}
const number = (value: number) => new Intl.NumberFormat('fa-IR').format(value)
const hasPhoto = (product: HeroProduct) => !!product.images[0]?.trim()
const availability = (product: HeroProduct) => !hasPhoto(product) ? 'بدون عکس؛ برای نمایش، تصویر محصول را اضافه کن.' : product.stock <= 0 ? 'ناموجود · قابل نمایش برای معرفی' : 'موجود · آمادهٔ نمایش'

export default function HomeHeroSettings({ productIds, intervalSeconds, onProductIdsChange, onIntervalChange, disabled, active }: Props) {
  const [products, setProducts] = useState<HeroProduct[]>([])
  const [loading, setLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let disposed = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
    async function loadProducts() {
      setLoading(true); setError('')
      try {
        const response = await fetch('/api/products', { cache: 'no-store', signal: controller.signal })
        const data: unknown = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'فهرست محصولات دریافت نشد.')
        if (!Array.isArray(data) || data.some(product => !product || typeof product.id !== 'string' || typeof product.name !== 'string' || !Number.isSafeInteger(product.stock) || !Array.isArray(product.images) || product.images.some((image: unknown) => typeof image !== 'string'))) throw new Error('پاسخ فهرست محصولات معتبر نیست.')
        if (!disposed && !controller.signal.aborted) { setProducts(data); setHasLoaded(true) }
      } catch (cause) {
        if (!disposed && (!controller.signal.aborted || timedOut)) setError(timedOut ? 'دریافت محصولات طول کشید. دوباره تلاش کن.' : cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
      } finally {
        clearTimeout(timer)
        if (!disposed) setLoading(false)
      }
    }
    void loadProducts()
    return () => { disposed = true; clearTimeout(timer); controller.abort() }
  }, [active, reload])

  const search = query.trim().toLocaleLowerCase('fa-IR')
  const filtered = products.filter(product => [product.name, product.category?.name ?? ''].some(value => value.toLocaleLowerCase('fa-IR').includes(search)))
  const selectProduct = (product: HeroProduct, checked: boolean) => {
    if (disabled) return
    if (!checked) return onProductIdsChange(productIds.filter(id => id !== product.id))
    if (!hasPhoto(product) || productIds.length >= homeHeroLimits.maxProducts || productIds.includes(product.id)) return
    onProductIdsChange([...productIds, product.id])
  }
  const move = (index: number, offset: number) => {
    const destination = index + offset
    if (disabled || destination < 0 || destination >= productIds.length) return
    const next = [...productIds]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    onProductIdsChange(next)
  }
  const thumbnail = (product?: HeroProduct) => <span className={styles.thumbnail}>{product && hasPhoto(product) ? <Image src={product.images[0]} alt="" width={50} height={56} unoptimized /> : <ImageIcon size={20} aria-hidden="true" />}</span>

  return <div className={styles.editor} aria-labelledby="settings-hero-heading">
    <div className={styles.intro}><h3 id="settings-hero-heading">محصولات اصلی بالای صفحه</h3><p>چند مدل از هر دسته‌بندی انتخاب کن تا تصویرشان به‌ترتیب در بخش اصلی صفحهٔ اول جابه‌جا شود. این بخش جدا از بنر عریض پایین صفحه است.</p></div>
    <div className={styles.interval}><label htmlFor="settings-homeHeroIntervalSeconds">زمان نمایش هر محصول</label><div><input id="settings-homeHeroIntervalSeconds" type="number" inputMode="numeric" min={homeHeroLimits.minIntervalSeconds} max={homeHeroLimits.maxIntervalSeconds} step={1} required disabled={disabled} value={Number.isFinite(intervalSeconds) ? intervalSeconds : ''} onChange={event => { if (!disabled) onIntervalChange(event.target.value === '' ? Number.NaN : Number(event.target.value)) }} aria-describedby="settings-hero-interval-help" /><span>ثانیه</span></div><small id="settings-hero-interval-help">عدد صحیح از ۵ تا ۱۲۰ ثانیه؛ جابه‌جایی خودکار وقتی چند محصول قابل نمایش باشند فعال می‌شود.</small></div>
    <div className={styles.columns}>
      <div className={styles.catalog}>
        <div className={styles.title}><h4>انتخاب محصولات</h4><span>{number(productIds.length)} از ۱۰</span></div>
        <label className={styles.search}><Search size={17} aria-hidden="true" /><input id="settings-hero-search" aria-label="جستجوی محصولات بخش اصلی" placeholder="نام محصول یا دسته‌بندی" value={query} maxLength={100} disabled={disabled} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} /></label>
        {loading ? <p className={styles.feedback} role="status">در حال دریافت محصولات…</p> : error ? <div className={styles.failure} role="alert"><p>{error}</p><button type="button" disabled={disabled} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />تلاش دوباره</button></div> : <div className={styles.choices} role="group" aria-label="محصولات قابل انتخاب">
          {filtered.map(product => { const checked = productIds.includes(product.id); return <label key={product.id} className={styles.choice} data-selected={checked}>
            <input type="checkbox" aria-label={'انتخاب ' + product.name + ' برای بخش اصلی'} checked={checked} disabled={disabled || (!checked && (productIds.length >= homeHeroLimits.maxProducts || !hasPhoto(product)))} onChange={event => selectProduct(product, event.target.checked)} />
            {thumbnail(product)}<span className={styles.copy}><strong>{product.name}</strong><small>{product.category?.name}</small><span data-unavailable={product.stock <= 0 || !hasPhoto(product)}>{availability(product)}</span></span>
          </label> })}
          {filtered.length === 0 && <p className={styles.feedback}>{query ? 'محصولی با این جستجو پیدا نشد.' : 'هنوز محصولی ثبت نشده است.'}</p>}
        </div>}
        <p className={styles.hint}>محصول ناموجود هم قابل نمایش است؛ نمایش آن امکان خرید را فعال نمی‌کند و موجودی را تغییر نمی‌دهد. برای انتخاب هر محصول، حداقل یک عکس لازم است.</p>
      </div>
      <div className={styles.selection}>
        <div className={styles.title}><h4>ترتیب نمایش</h4><button type="button" disabled={disabled || productIds.length === 0} onClick={() => { if (!disabled) onProductIdsChange([]) }}>انتخاب خودکار</button></div>
        <div id="settings-homeHeroProductIds" tabIndex={-1} aria-label="ترتیب محصولات بخش اصلی">
          {productIds.length === 0 ? <div className={styles.automatic}><ImageIcon size={26} aria-hidden="true" /><strong>انتخاب خودکار فروشگاه</strong><p>تا وقتی محصولی انتخاب نکنی، تصویر بخش اصلی مثل قبل به‌صورت خودکار از مدل‌های موجود انتخاب می‌شود.</p></div> : <ol className={styles.selectedList}>
            {productIds.map((id, index) => { const product = products.find(item => item.id === id); return <li key={id}>
              <span className={styles.position}>{number(index + 1)}</span>{thumbnail(product)}<span className={styles.copy}><strong>{product?.name ?? (hasLoaded ? 'محصول حذف‌شده' : 'در حال دریافت اطلاعات محصول…')}</strong><span data-unavailable={!product || product.stock <= 0 || !hasPhoto(product)}>{product ? availability(product) : hasLoaded ? 'برای ادامه، این مورد را از انتخاب‌ها حذف کن.' : error ? 'جزئیات محصول دریافت نشد؛ می‌توانی آن را حذف کنی.' : 'انتخاب ذخیره‌شده'}</span></span>
              <div className={styles.actions}><button type="button" aria-label={'بالا بردن محصول ' + (index + 1)} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} aria-hidden="true" /></button><button type="button" aria-label={'پایین بردن محصول ' + (index + 1)} disabled={disabled || index === productIds.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} aria-hidden="true" /></button><button type="button" aria-label={'حذف محصول ' + (index + 1) + ' از بخش اصلی'} disabled={disabled} onClick={() => { if (!disabled) onProductIdsChange(productIds.filter(value => value !== id)) }}><X size={15} aria-hidden="true" /></button></div>
            </li> })}
          </ol>}
        </div>
        <p className={styles.hint}>ردیف اول، اولین تصویر است. محصولات انتخاب‌شده و دارای عکس نمایش داده می‌شوند. تغییرات پس از ذخیرهٔ تنظیمات اعمال می‌شوند.</p>
      </div>
    </div>
  </div>
}
