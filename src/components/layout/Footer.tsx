'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowUpLeft, Clock3, Link2, Mail, MapPin, Phone } from 'lucide-react'
import BrandLogo from '@/components/ui/BrandLogo'
import { EitaaIcon, InstagramIcon, TelegramIcon, WhatsAppIcon } from '@/components/ui/SocialIcons'
import { defaultSiteSettings, resolveFooterSocialLinks } from '@/lib/site-settings-contract'
import { useSiteSettings } from './SiteSettingsProvider'
import styles from './footer.module.css'

const socialIcons = { instagram: InstagramIcon, telegram: TelegramIcon, eitaa: EitaaIcon, whatsapp: WhatsAppIcon, link: Link2, custom: Link2 }
const socialNames = { instagram: 'اینستاگرام', telegram: 'تلگرام', eitaa: 'ایتا', whatsapp: 'واتساپ' }

export default function Footer() {
  const settings = useSiteSettings()
  const [failedImages, setFailedImages] = useState<Record<string, string>>({})
  const description = settings.footerDescription?.trim() || settings.tagline
  const links = settings.footerLinks ?? defaultSiteSettings.footerLinks
  const badges = (settings.footerBadges ?? []).filter((badge) => badge.enabled)
  const socialLinks = resolveFooterSocialLinks(settings).filter((social) => social.enabled)

  return (
    <footer className={`home-footer ${styles.footer}`}>
      <div className={`${styles.top} ${!links.length ? styles.withoutLinks : ''}`}>
        <div className={styles.intro}>
          <Link href="/" className={styles.brand}>
            <span className={styles.mark} aria-hidden="true"><BrandLogo variant="light" /></span>
            <span>{settings.storeName}</span>
          </Link>
          {description && <p className={styles.description}>{description}</p>}
          {socialLinks.length > 0 && <div className={styles.socials} aria-label="شبکه‌های اجتماعی فروشگاه">
            {socialLinks.map((social) => {
              const label = social.label.trim()
              const name = label || (social.icon in socialNames ? socialNames[social.icon as keyof typeof socialNames] : new URL(social.href).hostname)
              const Icon = socialIcons[social.icon]
              return <a key={social.id} className={!label ? styles.socialIconOnly : undefined} href={social.href} target="_blank" rel="noopener noreferrer" aria-label={`${name} ${settings.storeName}`} title={!label ? name : undefined}>
                {social.icon === 'custom' && social.iconUrl && failedImages[`social:${social.id}`] !== social.iconUrl
                  ? <Image className={styles.socialImage} src={social.iconUrl} alt="" width={20} height={20} unoptimized onError={() => setFailedImages((current) => ({ ...current, [`social:${social.id}`]: social.iconUrl! }))} />
                  : <Icon size={19} />}
                {label && <span>{label}</span>}
              </a>
            })}
          </div>}
        </div>

        {links.length > 0 && <nav className={styles.navigation} aria-label="پیوندهای پایین صفحه">
          <h2 className={styles.heading}>دسترسی سریع</h2>
          <ul>{links.map((link) => <li key={link.id}>
            <Link href={link.href} {...(!link.href.startsWith('/') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{link.label}</Link>
          </li>)}</ul>
        </nav>}

        <div className={styles.contact}>
          <h2 className={styles.heading}>در ارتباط باشیم</h2>
          <ul>
            {settings.phone && <li><Phone size={17} aria-hidden="true" /><a href={`tel:${settings.phone}`} dir="ltr">{settings.phone.replace(/\d/g, (digit) => String.fromCharCode(1776 + Number(digit)))}</a></li>}
            {settings.email && <li><Mail size={17} aria-hidden="true" /><a href={`mailto:${settings.email}`} dir="ltr">{settings.email}</a></li>}
            {settings.address && <li><MapPin size={17} aria-hidden="true" /><span>{settings.address}</span></li>}
            {settings.supportHours && <li><Clock3 size={17} aria-hidden="true" /><span>{settings.supportHours}</span></li>}
          </ul>
          <Link className={styles.contactAction} href="/contact">ارتباط با فروشگاه<ArrowUpLeft size={17} aria-hidden="true" /></Link>
        </div>
      </div>

      {badges.length > 0 && <section className={styles.badgeSection} aria-label="نشان‌ها و خدمات فروشگاه">
        <div className={styles.badgeIntro}><h2 className={styles.heading}>نشان‌ها و خدمات</h2>{badges.some((badge) => badge.href) && <p>برای مشاهدهٔ جزئیات، نشان را انتخاب کن.</p>}</div>
        <ul className={styles.badges}>{badges.map((badge) => {
          const content = <>
            <span className={styles.badgeImage}>{failedImages[badge.id] === badge.imageUrl
              ? <span className={styles.badgeFallback}>{badge.title}</span>
              : <Image src={badge.imageUrl} alt={badge.title} width={112} height={112} unoptimized loading="lazy" referrerPolicy="origin" onError={() => setFailedImages((current) => ({ ...current, [badge.id]: badge.imageUrl }))} />}</span>
            <span className={styles.badgeTitle}>{badge.title}</span>
          </>
          return <li key={badge.id}>{badge.href
            ? <a className={styles.badge} href={badge.href} target="_blank" rel="noopener noreferrer" aria-label={`مشاهدهٔ ${badge.title}`}>{content}</a>
            : <div className={styles.badge}>{content}</div>}</li>
        })}</ul>
      </section>}

      <div className={styles.bottom}>
        <span>{settings.footerCopyright?.trim() || `${settings.storeName} · تمامی حقوق محفوظ است.`}</span>
        <Link href="/products">دیدن همهٔ مدل‌ها<ArrowUpLeft size={15} aria-hidden="true" /></Link>
      </div>
    </footer>
  )
}
