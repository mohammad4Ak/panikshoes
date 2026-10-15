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
    id: 'daily', slug: 'sneaker', number: '۰۱', word: 'DAILY',
    collection: 'کتانی زنانه', query: '', action: 'دیدن کتانی‌ها',
    title: 'همراهِ روزهای شلوغ',
    description: 'برای استایل روزمره، کتانی را با جین یا شلوار پارچه‌ای ست کن. هنگام پرو، فضای جلوی انگشت‌ها و فیت پاشنه را بررسی کن.',
    focus: 'فضای پنجه و قالب کفش',
    note: 'قالب همهٔ مدل‌ها یکسان نیست؛ راهنمای سایز همان محصول را بخوان و فقط به شمارهٔ سایز اکتفا نکن.',
  },
  {
    id: 'loafer', slug: 'formal', number: '۰۲', word: 'LOAFER',
    collection: 'لوفر زنانه', query: 'لوفر', action: 'دیدن لوفرها',
    title: 'مرتب، به سبک هر روز',
    description: 'برای استایل کاری و نیمه‌رسمی، لوفر انتخابی ساده برای ست‌کردن است. چون بند ندارد، به فیت کفش دور پا و پشت پاشنه دقت کن.',
    focus: 'فیت پاشنه و ارتفاع لژ',
    note: 'هنگام راه‌رفتن، پاشنهٔ پا نباید از کفش بیرون بیاید. ارتفاع لژ و جنس رویه را در مشخصات هر مدل ببین.',
  },
  {
    id: 'occasion', slug: 'formal', number: '۰۳', word: 'DRESS',
    collection: 'کفش مجلسی', query: 'مجلسی', action: 'دیدن مدل‌های مجلسی',
    title: 'برای قرارهای خاص',
    description: 'کفش مجلسی را با لباس و مدت استفاده‌ات انتخاب کن. ارتفاع و پهنای پاشنه، فضای پنجه و امکان تنظیم بند را کنار ظاهر کفش بسنج.',
    focus: 'پاشنه، پنجه و تنظیم بند',
    note: 'در مدل‌های بنددار، بند باید بدون فشار روی پا بسته شود. پیش از انتخاب، عکس‌های واقعی و مشخصات مدل را بررسی کن.',
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
          <h2 id="home-guide-title">کفشِ مناسبِ روز تو.</h2>
        </div>
        <p className={styles.sectionIntro}>کتانی، لوفر یا مجلسی؟ برای انتخاب از مدل‌های پانیک، به کاربرد، قالب و جزئیات هر کفش دقت کن.</p>
      </div>
      <div className={styles.guideGrid}>
        {guides.map((guide, index) => (
          <article key={guide.id} className={styles.guideCard} data-reveal data-reveal-delay={index}>
            <div className={styles.guideTop}>
              <span className={styles.guideNumber}>{guide.number}</span>
              <span className={styles.guideWord} dir="ltr" aria-hidden="true">{guide.word}</span>
            </div>
            <p className={styles.guideCollection}>{guide.collection}</p>
            <h3>{guide.title}</h3>
            <p className={styles.guideDescription}>{guide.description}</p>
            <div className={styles.guideFocus}><span>ویژگی‌های مهم</span><strong>{guide.focus}</strong><p>{guide.note}</p></div>
            <Link href={`/products?cat=${encodeURIComponent(guide.category.id)}${guide.query ? `&q=${encodeURIComponent(guide.query)}` : ''}`} className={styles.guideAction} data-motion="action">
              <span>{guide.action}</span><ArrowUpLeft size={19} />
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
