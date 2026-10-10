import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, ArrowUpLeft } from 'lucide-react'
import type { SiteSettings } from '@/lib/site-settings-contract'
import styles from './HomeContent.module.css'

type HomeCategory = { id: string; name: string; slug: string }
type HomeShippingMethod = { name: string; description?: string | null }
type HomePaymentMethod = { id: string; name: string }

export function HomeBanner({ settings }: { settings: SiteSettings }) {
  if (!settings.homeBannerEnabled || !settings.homeBannerTitle.trim()) return null

  return (
    <section className={styles.banner} aria-labelledby="home-banner-title" data-reveal>
      <div className={styles.bannerMedia}>
        <Image
          src={settings.homeBannerImageUrl || '/brand/panik-trail-banner.png'}
          alt={settings.homeBannerImageAlt}
          fill
          sizes="(max-width: 700px) 100vw, (max-width: 1440px) 94vw, 1360px"
          unoptimized={Boolean(settings.homeBannerImageUrl)}
          className={styles.bannerImage}
        />
      </div>
      <div className={styles.bannerCopy}>
        {settings.homeBannerEyebrow.trim() && <p className={styles.bannerEyebrow}><span />{settings.homeBannerEyebrow}</p>}
        <h2 id="home-banner-title">{settings.homeBannerTitle}</h2>
        {settings.homeBannerDescription.trim() && <p className={styles.bannerDescription}>{settings.homeBannerDescription}</p>}
        {settings.homeBannerLink && settings.homeBannerLinkLabel.trim() && (
          <Link href={settings.homeBannerLink} className={styles.bannerAction} data-motion="action">
            <span>{settings.homeBannerLinkLabel}</span><ArrowLeft size={18} />
          </Link>
        )}
      </div>
    </section>
  )
}

const selectionGuides = [
  {
    slug: 'sneaker', number: '۰۱', word: 'DAY',
    title: 'همراهِ هر روز',
    description: 'برای رفت‌وآمد و پیاده‌روی معمول، وزن کفش و انعطاف جلوی پا را بررسی کن.',
    focus: 'سبکی و انعطاف',
    note: 'فضای پنجه و جنس رویه را با استفادهٔ روزانه‌ات بسنج.',
  },
  {
    slug: 'waterproofs', number: '۰۲', word: 'OUT',
    title: 'بزن به دلِ طبیعت',
    description: 'روی خاک و مسیرهای ناهموار، به آج زیره و پوشش رویه توجه کن.',
    focus: 'آج زیره و پوشش رویه',
    note: 'مقاومت در برابر آب را در مشخصات هر مدل بررسی کن.',
  },
  {
    slug: 'hiking', number: '۰۳', word: 'UP',
    title: 'یک مسیر بالاتر',
    description: 'برای شیب و مسیرهای سنگی، ساختار زیره و نگهداری پا اهمیت بیشتری دارد.',
    focus: 'ساختار زیره و ثبات',
    note: 'مدل را متناسب با سختی مسیر و مدت برنامه انتخاب کن.',
  },
] as const

export function HomeSelectionGuide({ categories }: { categories: HomeCategory[] }) {
  const guides = selectionGuides.flatMap((guide) => {
    const category = categories.find((item) => item.slug === guide.slug)
    return category ? [{ ...guide, category }] : []
  })
  if (!guides.length) return null

  return (
    <section className={styles.guideSection} aria-labelledby="home-guide-title">
      <div className={styles.sectionHeading} data-reveal>
        <div>
          <p className={styles.sectionEyebrow}><span /> راهنمای انتخاب</p>
          <h2 id="home-guide-title">اول مسیرت، بعد کفشت.</h2>
        </div>
        <p className={styles.sectionIntro}>چند نکتهٔ ساده برای پیدا کردن مدلی که به کارت می‌آید.</p>
      </div>
      <div className={styles.guideGrid}>
        {guides.map((guide, index) => (
          <article key={guide.slug} className={styles.guideCard} data-reveal data-reveal-delay={index}>
            <div className={styles.guideTop}>
              <span className={styles.guideNumber}>{guide.number}</span>
              <span className={styles.guideWord} dir="ltr" aria-hidden="true">{guide.word}</span>
            </div>
            <p className={styles.guideCollection}>{guide.category.name}</p>
            <h3>{guide.title}</h3>
            <p className={styles.guideDescription}>{guide.description}</p>
            <div className={styles.guideFocus}><span>ویژگی‌های مهم</span><strong>{guide.focus}</strong><p>{guide.note}</p></div>
            <Link href={`/products?cat=${encodeURIComponent(guide.category.id)}&stock=1`} className={styles.guideAction} data-motion="action">
              <span>مدل‌های {guide.category.name}</span><ArrowUpLeft size={19} />
            </Link>
          </article>
        ))}
      </div>
    </section>
  )
}

export function HomePurchaseInfo({
  shippingMethods,
  paymentMethods,
  storeName,
}: {
  shippingMethods: HomeShippingMethod[]
  paymentMethods: HomePaymentMethod[]
  storeName: string
}) {
  const hasTransfer = paymentMethods.some((method) => method.id === 'bank_transfer')

  return (
    <section className={styles.purchaseSection} aria-labelledby="home-purchase-title">
      <div className={styles.sectionHeading} data-reveal>
        <div>
          <p className={styles.sectionEyebrow}><span /> قبل از ثبت سفارش</p>
          <h2 id="home-purchase-title">خرید از {storeName}، قدم‌به‌قدم.</h2>
        </div>
        <Link href="/contact" className={styles.contactAction} data-motion="action">سؤالی داری؟ <ArrowUpLeft size={18} /></Link>
      </div>
      <div className={styles.purchaseGrid}>
        <article className={styles.purchaseCard} data-reveal>
          <span className={styles.purchaseNumber}>۰۱ / ارسال</span>
          <h3>روش ارسال را خودت انتخاب کن.</h3>
          {shippingMethods.length ? <>
            <ul className={styles.methodNames} aria-label="روش‌های ارسال فعال">
              {shippingMethods.slice(0, 4).map((method, index) => <li key={`${method.name}-${index}`}>{method.name}</li>)}
            </ul>
            {shippingMethods.length > 4 && <p className={styles.moreMethods}>روش‌های بیشتر را در تسویه‌حساب ببین.</p>}
            <p>هزینهٔ نهایی ارسال با روش انتخابی و تعداد جفت‌ها محاسبه می‌شود و قبل از پرداخت نمایش داده می‌شود.</p>
          </> : <p>در حال حاضر روش ارسال فعالی نداریم. پیش از خرید، برای اطلاع از زمان فعال شدن ارسال با ما تماس بگیر.</p>}
        </article>
        <article className={styles.purchaseCard} data-reveal data-reveal-delay="1">
          <span className={styles.purchaseNumber}>۰۲ / پرداخت</span>
          <h3>مراحل پرداخت را شفاف ببین.</h3>
          {paymentMethods.length ? <>
            <ul className={styles.methodNames} aria-label="روش‌های پرداخت فعال">
              {paymentMethods.map((method) => <li key={method.id}>{method.name}</li>)}
            </ul>
            <p>{hasTransfer
              ? 'برای کارت‌به‌کارت، اطلاعات حساب و مهلت پرداخت را در صفحهٔ پرداخت می‌بینی. رسید را همان‌جا بارگذاری کن؛ پرداخت پس از بررسی فروشگاه تأیید می‌شود.'
              : 'روش پرداخت را هنگام ثبت سفارش انتخاب کن و نتیجهٔ آن را از جزئیات سفارش ببین.'}</p>
          </> : <p>در حال حاضر روش پرداخت فعالی نداریم. برای اطلاع از امکان ثبت سفارش با فروشگاه در تماس باش.</p>}
        </article>
        <article className={styles.purchaseCard} data-reveal data-reveal-delay="2">
          <span className={styles.purchaseNumber}>۰۳ / پیگیری</span>
          <h3>همه‌چیز در حساب کاربری تو.</h3>
          <p>وضعیت سفارش و پرداخت را در حساب کاربری دنبال کن. پس از تأیید سفارش و شروع پردازش، فاکتور از جزئیات سفارش قابل دریافت است.</p>
          <Link href="/profile" className={styles.profileAction} data-motion="action">مشاهدهٔ حساب کاربری <ArrowLeft size={17} /></Link>
        </article>
      </div>
    </section>
  )
}
