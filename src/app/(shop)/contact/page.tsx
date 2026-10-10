import { ConversationIcon } from '@/components/ui/BrandIcons'
import Link from 'next/link'
import { ArrowUpLeft, Camera, ChevronLeft, Clock3, Mail, MapPin, Phone, Send } from 'lucide-react'
import styles from '@/components/shop/account.module.css'
import { getSiteSettings } from '@/lib/site-settings'

export default async function ContactPage() {
  const settings = await getSiteSettings()
  const hasContactDetails = settings.phone || settings.email || settings.address || settings.instagramUrl || settings.telegramUrl
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه"><Link href="/">خانه</Link><ChevronLeft size={13} /><span>تماس با ما</span></nav>
        <header className={styles.hero} data-reveal>
          <div><p className={styles.eyebrow}>اینجاییم تا کمکت کنیم</p><h1>یه سؤال، یه گفت‌وگو.</h1><p>برای انتخاب مدل و سایز، یا پیگیری سفارش؛<br />از همین‌جا با ما در تماس باش.</p></div>
          <div className={styles.heroIcon} aria-hidden="true"><ConversationIcon /></div>
          <span className={styles.heroWord} dir="ltr" aria-hidden="true">LET’S TALK.</span>
        </header>
        <div className={styles.contactGrid}>
          <section className={styles.panel} aria-labelledby="contact-title" data-reveal>
            <h2 id="contact-title">راه‌های ارتباط با ما</h2>
            <div className={styles.contactList}>
              {settings.phone && <a href={`tel:${settings.phone}`} className={styles.contactItem} data-motion="action">
                <div className={styles.valueIcon}><Phone size={21} /></div><div><span>تماس تلفنی</span><p dir="ltr">{settings.phone.replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)])}</p></div><ArrowUpLeft size={18} />
              </a>}
              {settings.email && <a href={`mailto:${settings.email}`} className={styles.contactItem} data-motion="action">
                <div className={styles.valueIcon}><Mail size={21} /></div><div><span>ایمیل</span><p dir="ltr">{settings.email}</p></div><ArrowUpLeft size={18} />
              </a>}
              {settings.address && <div className={styles.contactItem}>
                <div className={styles.valueIcon}><MapPin size={21} /></div><div><span>نشانی</span><p className="whitespace-pre-line">{settings.address}</p></div>
              </div>}
              {settings.instagramUrl && <a href={settings.instagramUrl} target="_blank" rel="noopener noreferrer" className={styles.contactItem} data-motion="action">
                <div className={styles.valueIcon}><Camera size={21} /></div><div><span>شبکه‌های اجتماعی</span><p>اینستاگرام {settings.storeName}</p></div><ArrowUpLeft size={18} />
              </a>}
              {settings.telegramUrl && <a href={settings.telegramUrl} target="_blank" rel="noopener noreferrer" className={styles.contactItem} data-motion="action">
                <div className={styles.valueIcon}><Send size={21} /></div><div><span>شبکه‌های اجتماعی</span><p>تلگرام {settings.storeName}</p></div><ArrowUpLeft size={18} />
              </a>}
              {!hasContactDetails && <p>راه‌های ارتباط با فروشگاه به‌زودی در این قسمت اعلام می‌شود.</p>}
            </div>
            {settings.supportHours && <div className={styles.hours}>
              <h3><Clock3 size={19} /> ساعات پاسخ‌گویی</h3>
              <p className="whitespace-pre-line">{settings.supportHours}</p>
            </div>}
          </section>
          <div>
            {settings.email && <section className={`${styles.panel} ${styles.supportPanel}`} aria-labelledby="email-title" data-reveal data-reveal-delay="1">
              <p className={styles.eyebrow}>با حوصله برامون بنویس</p>
              <h2 id="email-title">جزئیات بیشتر، راهنمایی بهتر.</h2>
              <p>نام مدل یا شمارهٔ سفارشت رو همراه سؤالت بفرست تا راحت‌تر راهنمایی‌ات کنیم.</p>
              <a href={`mailto:${settings.email}?subject=${encodeURIComponent(`پشتیبانی ${settings.storeName}`)}`} className={styles.pillLink} data-motion="action">نوشتن ایمیل <ArrowUpLeft size={18} /></a>
              <p className="!text-[10px] !mt-3">این دکمه برنامهٔ ایمیل دستگاهت رو باز می‌کنه.</p>
            </section>}
            <section className={`${styles.panel} ${styles.faq}`} aria-labelledby="help-title" data-reveal>
              <h2 id="help-title">شاید جواب سؤالت اینجا باشه</h2>
              <details><summary>چطور سفارشم رو پیگیری کنم؟</summary><p>از بخش «سفارش‌های من» در <Link href="/profile">حساب کاربری</Link>، وضعیت و جزئیات هر سفارش رو ببین.</p></details>
              <details><summary>برای انتخاب سایز از کجا شروع کنم؟</summary><p>سایزهای موجود رو در صفحهٔ هر محصول ببین. اگر بین دو سایز موندی، نام مدل رو برای ما بفرست تا راهنمایی‌ات کنیم.</p></details>
              <details><summary>چطور آدرس‌هام رو مدیریت کنم؟</summary><p>در <Link href="/profile">حساب کاربری</Link>، تب «آدرس‌های من» رو انتخاب کن. می‌تونی آدرس تازه اضافه کنی یا آدرس پیش‌فرضت رو تغییر بدی.</p></details>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
