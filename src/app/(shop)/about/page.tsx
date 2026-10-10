import { SneakerIcon } from '@/components/ui/BrandIcons'
import Link from 'next/link'
import { ArrowLeft, ArrowUpLeft, ChevronLeft, Heart, SlidersHorizontal, Sparkles } from 'lucide-react'
import styles from '@/components/shop/account.module.css'
import { getSiteSettings } from '@/lib/site-settings'

const values = [
  { Icon: SneakerIcon, title: 'راحتی، اولِ مسیر', text: 'برای رفت‌وآمدهای هر روز، پیاده‌روی یا یک مسیر تازه؛ انتخاب خوب از شناخت نیازت شروع می‌شه.' },
  { Icon: Sparkles, title: 'استایل به سلیقهٔ تو', text: 'از کتانی‌های روزمره تا کفش‌های رسمی و کوهنوردی؛ مدلی رو پیدا کن که به حال‌وهوای تو نزدیک‌تره.' },
  { Icon: SlidersHorizontal, title: 'انتخاب با خیال راحت', text: 'مدل‌ها، سایزها و رنگ‌ها رو کنار هم ببین و قبل از انتخاب، هر سؤالی داری از ما بپرس.' },
]

export default async function AboutPage() {
  const settings = await getSiteSettings()
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه"><Link href="/">خانه</Link><ChevronLeft size={13} /><span>دربارهٔ ما</span></nav>
        <header className={styles.hero} data-reveal>
          <div><p className={styles.eyebrow}>داستان {settings.storeName}</p><h1>همراهِ قدم‌های تو.</h1><p>ما به حس خوبِ یک جفت کفش مناسب فکر می‌کنیم؛<br />همونی که دوست داری هر روز باهاش از خونه بزنی بیرون.</p></div>
          <div className={styles.heroIcon} aria-hidden="true"><SneakerIcon /></div>
          <span className={styles.heroWord} dir="ltr" aria-hidden="true">KEEP GOING.</span>
        </header>
        <section className={styles.storyGrid} aria-labelledby="story-title">
          <div className={styles.panel} data-reveal>
            <p className={styles.eyebrow}>از یک انتخاب ساده شروع می‌شه</p>
            <h2 id="story-title">هر روز، یه مسیر.<br />هر مسیر، یه همراه.</h2>
            <p>کفش فقط آخرین تکهٔ استایلت نیست؛ همراهِ ساعت‌های طولانی بیرون از خونه، قرارهای مهم و ماجراجویی‌های آخر هفته‌ته.</p>
            <p>در {settings.storeName} می‌خوایم پیدا کردن این همراه ساده‌تر باشه. مدل‌ها رو با توجه به سبک زندگی و سلیقه‌ات ببین، مشخصاتشون رو بررسی کن و جفتی رو انتخاب کن که مالِ خودِ توئه.</p>
          </div>
          <div className={`${styles.panel} ${styles.statement}`} data-reveal data-reveal-delay="1">
            <p className={styles.eyebrow}><Heart size={16} /> چیزی که برامون مهمه</p>
            <h2>خوب بپوش.<br />راحت قدم بردار.<br />خودت باش.</h2>
            <p>استایل خوب از حس خوب شروع می‌شه.</p>
          </div>
        </section>
        <section className={styles.values} aria-label="نگاه ما به انتخاب کفش">
          {values.map(({ Icon, title, text }, index) => <article className={styles.value} key={title} data-reveal data-reveal-delay={index}><div className={styles.valueIcon}><Icon size={24} /></div><h3>{title}</h3><p>{text}</p></article>)}
        </section>
        <section className={styles.endStrip} data-reveal>
          <div><h2>جفت بعدی‌ات رو پیدا کن.</h2><p>یه نگاه به ویترین بنداز؛ شاید انتخابت همین‌جا باشه.</p></div>
          <Link href="/products" className={styles.pillLink} data-motion="action">دیدن محصولات <ArrowLeft size={18} /></Link>
          <Link href="/contact" className={styles.softLink} data-motion="action">با ما در تماس باش <ArrowUpLeft size={17} /></Link>
        </section>
      </div>
    </div>
  )
}
