'use client'

import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft, MapPin, Package } from 'lucide-react'
import styles from './account.module.css'

export default function AuthShell({ children, register = false, login = false, breadcrumb }: { children: ReactNode; register?: boolean; login?: boolean; breadcrumb?: string }) {
  const settings = useSiteSettings()
  return (
    <div className={`${styles.page}${login ? ` ${styles.loginPage}` : ''}`}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه">
          <Link href="/">خانه</Link><ChevronLeft size={13} /><span>{breadcrumb ?? (register ? 'ساخت حساب' : 'ورود به حساب')}</span>
        </nav>
        <div className={styles.authLayout}>
          <aside className={styles.authStory} data-reveal>
            <div>
              <p className={styles.eyebrow}>به {settings.storeName} خوش آمدید</p>
              <h2>استایل شما،<br /><span>انتخاب شما.</span></h2>
              <p>از انتخاب کفش دلخواه تا پیگیری سفارش، پانیک همراه شماست.</p>
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
