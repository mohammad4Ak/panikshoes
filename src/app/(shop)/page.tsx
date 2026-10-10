import { SneakerIcon } from '@/components/ui/BrandIcons'
import Image from 'next/image'
import Link from 'next/link'
import { connection } from 'next/server'
import { ArrowLeft, ArrowUpLeft, Mountain, SlidersHorizontal } from 'lucide-react'
import { prisma } from '@/lib/prisma'
import { expireUnpaidOrders, methodAvailability } from '@/lib/payments'
import { HomeBanner, HomeSelectionGuide, HomePurchaseInfo } from '@/components/shop/HomeContent'
import { getSiteSettings } from '@/lib/site-settings'
import { resolveHomeHeroSlides } from '@/lib/home-hero'
import HomeHeroCarousel from '@/components/shop/HomeHeroCarousel'
import styles from './home.module.css'

const numbers = new Intl.NumberFormat('fa-IR')
const categoryNotes: Record<string, string> = {
  sneaker: 'ریتم هر روزت', formal: 'استایلِ قرارهای خاص',
  waterproofs: 'بزن به دل طبیعت', hiking: 'یک قدم بالاتر',
}
const productHref = (slug: string) => `/products/${encodeURIComponent(slug)}`

export default async function HomePage() {
  // Prices and low-stock labels must reflect the current catalog after deployment.
  await connection()
  await expireUnpaidOrders()
  const [products, heroProduct, categories, settings, shippingMethods, paymentCandidates] = await Promise.all([
    prisma.product.findMany({
      where: { stock: { gt: 0 } }, include: { category: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 4,
    }),
    prisma.product.findFirst({
      where: { stock: { gt: 0 }, category: { slug: 'sneaker' }, NOT: { images: { isEmpty: true } } },
      include: { category: { select: { name: true } } },
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.category.findMany({
      include: {
        _count: { select: { products: true } },
        products: { select: { images: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    }),
    getSiteSettings(),
    prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { name: true, description: true },
    }),
    prisma.paymentMethod.findMany({
      where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, cardNumber: true, cardholderName: true },
    }),
  ])
  const paymentMethods = paymentCandidates.filter((method) => methodAvailability(method).available)
    .map(({ id, name }) => ({ id, name }))
  const categoryHref = (slug: string) => {
    const category = categories.find((item) => item.slug === slug)
    return category ? `/products?cat=${encodeURIComponent(category.id)}` : '/products'
  }
  const selectedHeroProducts = settings.homeHeroProductIds.length ? await prisma.product.findMany({
    where: { id: { in: settings.homeHeroProductIds } }, include: { category: { select: { name: true } } },
  }) : []
  const heroSlides = resolveHomeHeroSlides(settings.homeHeroProductIds, selectedHeroProducts,
    heroProduct?.images[0]?.trim() ? heroProduct : products.find((product) => product.images[0]?.trim()), settings.storeName)

  return (
    <div className={`${styles.home} home-page`}>
      <div className={styles.container}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className={styles.heroCopy} data-reveal>
            <p className={styles.eyebrow}><span /> حرکت، به سبک خودت</p>
            <h1 id="home-title">یه قدم جلوتر،<br /><span>یه حس بهتر.</span></h1>
            <p className={styles.heroDescription}>از کتونیِ هر روزت تا همراهِ ماجراجویی‌هات؛<br />جفت بعدی‌ات اینجاست.</p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryLink} href={categoryHref('sneaker')} data-motion="action">کتونی‌ها رو ببین <ArrowLeft size={20} /></Link>
              <Link className={styles.secondaryLink} href="/products" data-motion="action">همهٔ محصولات <ArrowUpLeft size={18} /></Link>
            </div>
            <div className={styles.heroNote}><SneakerIcon size={19} /><span>برای روزهایی که قرار نیست یک‌جا بمانی.</span></div>
          </div>
          <div className={styles.heroVisual} data-reveal data-reveal-delay="1">
            {heroSlides.length ? <HomeHeroCarousel products={heroSlides} intervalSeconds={settings.homeHeroIntervalSeconds} />
              : <div className={styles.heroFallback}><SneakerIcon size={90} /><span>جفت تازه، مسیر تازه</span></div>}
          </div>
        </section>

        {categories.length > 0 && <section className={styles.categorySection} aria-labelledby="collections-title">
          <div className={styles.categoryHeading} data-reveal><h2 id="collections-title">حال‌وهوای امروزت چیه؟</h2><span>از اینجا شروع کن</span></div>
          <div className={styles.categories}>
            {categories.map((category, index) => {
              const src = category.image || category.products[0]?.images[0]
              return <Link key={category.id} href={`/products?cat=${encodeURIComponent(category.id)}`} className={`${styles.category} ${styles[`categoryTone${index % 4}`]}`} data-reveal data-reveal-delay={index % 4}>
                <div className={styles.categoryImage}>{src ? <Image src={src} alt="" fill sizes="90px" unoptimized={src.startsWith('http')} /> : <SneakerIcon size={30} />}</div>
                <div><h3>{category.name}</h3><p>{categoryNotes[category.slug] ?? `${numbers.format(category._count.products)} مدل برای انتخاب`}</p></div>
                <ArrowUpLeft className={styles.categoryArrow} size={19} />
              </Link>
            })}
          </div>
        </section>}

        <HomeBanner settings={settings} />

        <section className={styles.productSection} aria-labelledby="selection-title">
          <div className={styles.sectionHeading} data-reveal>
            <div><p className={styles.sectionLabel}><span /> تازه رسیده‌ها</p><h2 id="selection-title">جفت بعدیِ تو کدومه؟</h2></div>
            <Link className={styles.allLink} href="/products?stock=1" data-motion="action">همهٔ مدل‌های موجود <ArrowLeft size={18} /></Link>
          </div>
          {products.length ? <div className={styles.products}>
            {products.map((product, index) => <Link key={product.id} href={productHref(product.slug)} className={styles.product} data-reveal data-reveal-delay={index % 4}>
              <div className={styles.productPhoto}>
                {product.images[0] ? <Image src={product.images[0]} alt={product.name} fill sizes="(max-width: 700px) 50vw, 25vw" unoptimized={product.images[0].startsWith('http')} /> : <SneakerIcon className={styles.productPlaceholder} size={50} />}
                <span className={styles.productTag}>{product.category.name}</span>
                {product.stock === 1 && <span className={styles.lastPair}>آخرین جفت</span>}
              </div>
              <div className={styles.productInfo}>
                <p className={styles.productSizes}>{product.sizes.length ? `سایز ${product.sizes.map((size) => numbers.format(size)).join('، ')}` : 'مشاهدهٔ مشخصات'}</p>
                <h3>{product.name}</h3>
                <div className={styles.productBottom}><p className={styles.price}>{numbers.format(product.price)} <span>تومان</span></p><span className={styles.productArrow}><ArrowUpLeft size={20} /></span></div>
              </div>
            </Link>)}
          </div> : <p className={styles.empty}>مدل‌های تازه به‌زودی به ویترین اضافه می‌شوند.</p>}
        </section>

        <HomeSelectionGuide categories={categories} />

        <section className={styles.edits} aria-label="مجموعه‌های پیشنهادی">
          <Link href={categoryHref('sneaker')} className={styles.cityEdit} data-reveal>
            <span className={styles.editLabel}><SneakerIcon size={17} /> استایلِ هر روز</span>
            <h2>شهر، زمینِ<br />بازیِ توئه.</h2>
            <p>کتانی‌هایی برای ریتم زندگی تو.</p>
            <span className={styles.editAction}>کشف کتانی‌ها <ArrowLeft size={18} /></span>
            <span className={styles.cityWord} aria-hidden="true" dir="ltr">GO!</span>
            <div className={styles.cityRings} aria-hidden="true" />
          </Link>
          <Link href={categoryHref('hiking')} className={styles.outdoorEdit} data-reveal data-reveal-delay="1">
            <Image src="/uploads/1787512292121-lf4d3b0r.webp" alt="کفش کوهنوردی روی صخره در ارتفاعات" fill sizes="(max-width: 700px) 100vw, 50vw" />
            <div className={styles.outdoorCopy}><span className={styles.editLabel}><Mountain size={17} /> وقتِ ماجراجوییه</span><h2>از مسیر همیشگی<br />بزن بیرون.</h2><span className={styles.editAction}>مجموعهٔ کوهنوردی <ArrowLeft size={18} /></span></div>
          </Link>
        </section>

        <HomePurchaseInfo shippingMethods={shippingMethods} paymentMethods={paymentMethods} storeName={settings.storeName} />

        <section className={styles.help} aria-labelledby="help-title" data-reveal>
          <span className={styles.helpIcon}><SlidersHorizontal size={26} /></span>
          <div><h2 id="help-title">بین چند مدل موندی؟</h2><p>برای انتخاب مدل و سایز مناسب، روی راهنمایی ما حساب کن.</p></div>
          <Link href="/contact" className={styles.allLink} data-motion="action">با ما در تماس باش <ArrowUpLeft size={20} /></Link>
        </section>
      </div>
    </div>
  )
}
