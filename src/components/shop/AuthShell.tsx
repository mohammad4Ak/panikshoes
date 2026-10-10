'use client'

import { SneakerIcon } from '@/components/ui/BrandIcons'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, MapPin, Package } from 'lucide-react'
import styles from './account.module.css'

export default function AuthShell({ children, register = false }: { children: ReactNode; register?: boolean }) {
  const settings = useSiteSettings()
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه">
          <Link href="/">خانه</Link><ChevronLeft size={13} /><span>{register ? 'ساخت حساب' : 'ورود به حساب'}</span>
        </nav>
        <div className={styles.authLayout}>
          <aside className={styles.authStory} data-reveal>
            <div>
              <p className={styles.eyebrow}>به {settings.storeName} خوش اومدی</p>
              <div className={styles.authMark}><SneakerIcon size={31} /></div>
              <h2>جفت بعدی‌ات،<br /><span>قدم بعدیِ تو.</span></h2>
              <p>حس خوبِ یه انتخاب تازه؛ از پیدا کردن مدل دلخواهت تا رسیدن به دستت.</p>
            </div>
            <div className={styles.authBenefits}>
              <span><Package size={15} /> پیگیری سفارش‌ها</span>
              <span><MapPin size={15} /> آدرس‌های ذخیره‌شده</span>
            </div>
            <div className={styles.authOrbit} aria-hidden="true" />
          </aside>
          <section className={styles.authCard}>{children}</section>
        </div>
      </div>
    </div>
  )
}
