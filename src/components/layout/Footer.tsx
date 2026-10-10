'use client'

import Link from 'next/link'
import { ArrowUpLeft } from 'lucide-react'
import BrandLogo from '@/components/ui/BrandLogo'
import { useSiteSettings } from './SiteSettingsProvider'

export default function Footer() {
  const settings = useSiteSettings()
  return (
    <footer className="home-footer">
      <div className="home-footer-top">
        <div className="home-footer-intro min-w-0" data-reveal>
          <Link href="/" className="home-footer-brand min-w-0 max-w-full">
            <span className="home-footer-mark" aria-hidden="true"><BrandLogo variant="light" /></span>
            <span className="min-w-0 break-words">{settings.storeName}</span>
          </Link>
          {settings.tagline && <p>{settings.tagline}</p>}
          <span className="home-footer-signature" dir="ltr">MADE FOR YOUR NEXT MOVE.</span>
          {(settings.instagramUrl || settings.telegramUrl) && <div className="mt-5 flex flex-wrap gap-4 text-xs text-white/80">
            {settings.instagramUrl && <a href={settings.instagramUrl} target="_blank" rel="noopener noreferrer">اینستاگرام</a>}
            {settings.telegramUrl && <a href={settings.telegramUrl} target="_blank" rel="noopener noreferrer">تلگرام</a>}
          </div>}
        </div>
        <div className="home-footer-links" data-reveal data-reveal-delay="1">
          <nav aria-label="پیوندهای پایین صفحه">
            <span className="home-footer-label">{settings.storeName}</span>
            <Link href="/products">همهٔ محصولات</Link>
            <Link href="/about">دربارهٔ ما</Link>
            <Link href="/contact">تماس با ما</Link>
          </nav>
          <nav aria-label="خرید و حساب کاربری">
            <span className="home-footer-label">همراه خریدت</span>
            <Link href="/profile">پیگیری سفارش</Link>
            <Link href="/profile">حساب من</Link>
            <Link href="/cart">سبد خرید</Link>
          </nav>
        </div>
        <Link href="/products" className="home-footer-shop" data-motion="action">
          یه قدم تازه بردار
          <ArrowUpLeft aria-hidden="true" size={20} />
        </Link>
      </div>
      <div className="home-footer-bottom">
        <span>{settings.storeName} · تمامی حقوق محفوظ است.</span>
        <span dir="ltr">KEEP MOVING</span>
      </div>
    </footer>
  )
}
