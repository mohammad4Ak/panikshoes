'use client'

import Image from 'next/image'
import { ArrowDown, ArrowUp, ImagePlus, Link2, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { EitaaIcon, InstagramIcon, TelegramIcon, WhatsAppIcon } from '@/components/ui/SocialIcons'
import { footerLimits, footerSocialIcons, isFooterBadgeImageUrl, isFooterSocialIconUrl, type FooterBadge, type FooterLink, type FooterSocialIcon, type FooterSocialLink, type SiteSettingsValues } from '@/lib/site-settings-contract'
import styles from './footer-settings.module.css'

type FooterFields = Pick<SiteSettingsValues, 'footerDescription' | 'footerCopyright' | 'footerLinks' | 'footerBadges' | 'footerSocialLinks'>
type Props = {
  values: FooterFields
  onChange: <K extends keyof FooterFields>(key: K, value: SiteSettingsValues[K]) => void
  onBadgeUpload: (id: string, file: File) => void
  uploadingBadgeId: string | null
  onSocialUpload: (id: string, file: File) => void
  uploadingSocialId: string | null
  disabled: boolean
}

function move<T>(items: T[], index: number, offset: number): T[] {
  const next = [...items]
  ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
  return next
}

function createId() {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `footer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const socialLabels: Record<FooterSocialIcon, string> = { instagram: 'اینستاگرام', telegram: 'تلگرام', eitaa: 'ایتا', whatsapp: 'واتس‌اپ', link: 'لینک عمومی', custom: 'تصویر دلخواه' }
const socialGlyphs = { instagram: InstagramIcon, telegram: TelegramIcon, eitaa: EitaaIcon, whatsapp: WhatsAppIcon, link: Link2 }

export default function FooterSettings({ values, onChange, onBadgeUpload, uploadingBadgeId, onSocialUpload, uploadingSocialId, disabled }: Props) {
  const updateLink = (id: string, patch: Partial<FooterLink>) => onChange('footerLinks', values.footerLinks.map((item) => item.id === id ? { ...item, ...patch } : item))
  const updateBadge = (id: string, patch: Partial<FooterBadge>) => onChange('footerBadges', values.footerBadges.map((item) => item.id === id ? { ...item, ...patch } : item))
  const updateSocial = (id: string, patch: Partial<FooterSocialLink>) => onChange('footerSocialLinks', values.footerSocialLinks.map((item) => item.id === id ? { ...item, ...patch } : item))
  const orderButtons = (kind: 'link' | 'badge' | 'social', index: number, title: string) => {
    const count = kind === 'link' ? values.footerLinks.length : kind === 'badge' ? values.footerBadges.length : values.footerSocialLinks.length
    const reorder = (offset: number) => kind === 'link'
      ? onChange('footerLinks', move(values.footerLinks, index, offset))
      : kind === 'badge' ? onChange('footerBadges', move(values.footerBadges, index, offset)) : onChange('footerSocialLinks', move(values.footerSocialLinks, index, offset))
    const remove = () => kind === 'link'
      ? onChange('footerLinks', values.footerLinks.filter((_, itemIndex) => itemIndex !== index))
      : kind === 'badge' ? onChange('footerBadges', values.footerBadges.filter((_, itemIndex) => itemIndex !== index)) : onChange('footerSocialLinks', values.footerSocialLinks.filter((_, itemIndex) => itemIndex !== index))
    return <div className={styles.rowActions}>
      <button type="button" disabled={disabled || index === 0} aria-label={`انتقال ${title} به بالا`} onClick={() => reorder(-1)}><ArrowUp size={16} aria-hidden="true" /></button>
      <button type="button" disabled={disabled || index === count - 1} aria-label={`انتقال ${title} به پایین`} onClick={() => reorder(1)}><ArrowDown size={16} aria-hidden="true" /></button>
      <button type="button" className={styles.remove} disabled={disabled} aria-label={`حذف ${title}`} onClick={remove}><Trash2 size={16} aria-hidden="true" /></button>
    </div>
  }
  return <div className={styles.root}>
    <div className={styles.twoFields}>
      <div className={styles.field}><label htmlFor="settings-footerDescription">معرفی کوتاه در فوتر</label><textarea id="settings-footerDescription" className="input-field" maxLength={800} value={values.footerDescription} disabled={disabled} placeholder="اگر خالی باشد، شعار کوتاه برند نمایش داده می‌شود." onChange={(event) => onChange('footerDescription', event.target.value)} /></div>
      <div className={styles.field}><label htmlFor="settings-footerCopyright">متن حقوق سایت (اختیاری)</label><input id="settings-footerCopyright" className="input-field" maxLength={200} value={values.footerCopyright} disabled={disabled} placeholder="اگر خالی باشد، نام فروشگاه و متن حقوق سایت نمایش داده می‌شود." onChange={(event) => onChange('footerCopyright', event.target.value)} /></div>
    </div>
    <fieldset className={styles.group} disabled={disabled}><legend>شبکه‌های اجتماعی</legend><p>شبکه یا لینک دلخواه را با آیکون آماده یا تصویر خودتان اضافه کنید. نام نمایشی اختیاری است؛ اگر خالی باشد، فقط آیکون نمایش داده می‌شود. حداکثر {footerLimits.maxSocialLinks.toLocaleString('fa-IR')} لینک.</p>
      <div className={styles.list}>{values.footerSocialLinks.map((item, index) => {
        const Glyph = item.icon === 'custom' ? ImagePlus : socialGlyphs[item.icon]
        const displayLabel = item.label.trim()
        return <article key={item.id} className={styles.socialCard}>
          <div className={styles.badgeHeading}><div className={styles.socialHeading}><span className={styles.socialPreview} aria-label="پیش‌نمایش آیکون">{item.icon === 'custom' && isFooterSocialIconUrl(item.iconUrl) ? <Image src={item.iconUrl} width={28} height={28} unoptimized alt="" /> : <Glyph size={24} aria-hidden="true" />}</span><div><strong>{displayLabel || socialLabels[item.icon]}</strong><small>{displayLabel ? 'آیکون همراه با نام' : 'فقط آیکون'}</small></div></div>{orderButtons('social', index, `شبکهٔ اجتماعی ${index + 1}`)}</div>
          <div className={styles.twoFields}>
            <div className={styles.field}><label htmlFor={`settings-footer-social-label-${item.id}`}>نام نمایشی (اختیاری)</label><input id={`settings-footer-social-label-${item.id}`} className="input-field" maxLength={80} value={item.label} disabled={disabled} placeholder="نام خالی = فقط آیکون" onChange={(event) => updateSocial(item.id, { label: event.target.value })} /></div>
            <div className={styles.field}><label htmlFor={`settings-footer-social-icon-${item.id}`}>آیکون</label><EnhancedSelect id={`settings-footer-social-icon-${item.id}`} value={item.icon} disabled={disabled} onChange={(event) => updateSocial(item.id, { icon: event.target.value as FooterSocialIcon, iconUrl: event.target.value === 'custom' ? item.iconUrl : null })}>{footerSocialIcons.map((icon) => <option key={icon} value={icon}>{socialLabels[icon]}</option>)}</EnhancedSelect></div>
            <div className={`${styles.field} ${styles.socialHref}`}><label htmlFor={`settings-footer-social-href-${item.id}`}>آدرس شبکه یا لینک</label><input id={`settings-footer-social-href-${item.id}`} className="input-field" type="url" dir="ltr" maxLength={2048} required value={item.href} disabled={disabled} placeholder="https://..." onChange={(event) => updateSocial(item.id, { href: event.target.value })} /></div>
          </div>
          {item.icon === 'custom' && <div className={styles.socialUpload}><label htmlFor={`settings-footer-social-upload-${item.id}`} className={styles.uploadButton} aria-disabled={disabled}>{uploadingSocialId === item.id ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <ImagePlus size={16} aria-hidden="true" />}{uploadingSocialId === item.id ? 'در حال بارگذاری...' : item.iconUrl ? 'تغییر تصویر آیکون' : 'انتخاب تصویر آیکون'}<input id={`settings-footer-social-upload-${item.id}`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onSocialUpload(item.id, file) }} /></label><small>PNG، JPG، WebP یا GIF · حداکثر ۵ مگابایت · تصویر مربع با زمینهٔ شفاف مناسب‌تر است.</small></div>}
          <label className={`${styles.toggle} ${styles.socialToggle}`} htmlFor={`settings-footer-social-enabled-${item.id}`}><input id={`settings-footer-social-enabled-${item.id}`} type="checkbox" role="switch" checked={item.enabled} disabled={disabled} onChange={(event) => updateSocial(item.id, { enabled: event.target.checked })} /><span>نمایش این لینک در فوتر</span></label>
        </article>
      })}</div>
      {!values.footerSocialLinks.length && <div className={styles.empty}>هنوز شبکه‌ای اضافه نشده است. لینک‌های دلخواه خود را اینجا تعریف کنید.</div>}
      <button id="settings-footerSocialLinks" type="button" className={styles.addButton} disabled={disabled || values.footerSocialLinks.length >= footerLimits.maxSocialLinks} onClick={() => onChange('footerSocialLinks', [...values.footerSocialLinks, { id: createId(), label: '', href: '', icon: 'link', iconUrl: null, enabled: true }])}><Plus size={17} aria-hidden="true" />افزودن شبکه یا لینک</button>
    </fieldset>
    <fieldset className={styles.group} disabled={disabled}><legend>لینک‌های دسترسی سریع</legend><p>عنوان، مقصد و ترتیب لینک‌های فوتر را تنظیم کنید. حداکثر {footerLimits.maxLinks.toLocaleString('fa-IR')} لینک.</p>
      <div className={styles.list}>{values.footerLinks.map((item, index) => <article key={item.id} className={styles.linkRow}>
        <div className={styles.field}><label htmlFor={`settings-footer-link-label-${item.id}`}>{`عنوان لینک ${index + 1}`}</label><input id={`settings-footer-link-label-${item.id}`} className="input-field" maxLength={80} required value={item.label} disabled={disabled} onChange={(event) => updateLink(item.id, { label: event.target.value })} /></div>
        <div className={styles.field}><label htmlFor={`settings-footer-link-href-${item.id}`}>آدرس مقصد</label><input id={`settings-footer-link-href-${item.id}`} className="input-field" dir="ltr" maxLength={2048} required value={item.href} disabled={disabled} placeholder="/products یا https://..." onChange={(event) => updateLink(item.id, { href: event.target.value })} /></div>
        {orderButtons('link', index, `لینک ${index + 1}`)}
      </article>)}</div>
      {!values.footerLinks.length && <p className={styles.empty}>هنوز لینکی برای فوتر تعریف نکرده‌اید.</p>}
      <button id="settings-footerLinks" type="button" className={styles.addButton} disabled={disabled || values.footerLinks.length >= footerLimits.maxLinks} onClick={() => onChange('footerLinks', [...values.footerLinks, { id: createId(), label: '', href: '' }])}><Plus size={17} aria-hidden="true" />افزودن لینک</button>
    </fieldset>
    <fieldset className={styles.group} disabled={disabled}><legend>نشان‌های اعتماد و روش‌های پرداخت</legend><p>برای اینماد، اسنپ‌پی، دیجی‌پی، ترب‌پی یا نشان دلخواه، تصویر نشان و لینک رسمی آن را اضافه کنید. برای اینماد می‌توانید آدرس تصویر نشان صادرشده و لینک تأیید آن را وارد کنید. حداکثر {footerLimits.maxBadges.toLocaleString('fa-IR')} نشان.</p>
      <div className={styles.list}>{values.footerBadges.map((item, index) => <article key={item.id} className={styles.badgeCard}>
        <div className={styles.badgeHeading}><strong>{item.title || `نشان ${index + 1}`}</strong>{orderButtons('badge', index, `نشان ${index + 1}`)}</div>
        <div className={styles.badgeBody}>
          <div className={styles.badgeVisual}><div className={styles.badgePreview}>{isFooterBadgeImageUrl(item.imageUrl) ? <Image src={item.imageUrl} width={100} height={100} unoptimized alt={item.title || 'پیش‌نمایش نشان'} /> : <ImagePlus size={28} aria-hidden="true" />}</div>
            <label htmlFor={`settings-footer-badge-upload-${item.id}`} className={styles.uploadButton} aria-disabled={disabled}>{uploadingBadgeId === item.id ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <ImagePlus size={16} aria-hidden="true" />}{uploadingBadgeId === item.id ? 'در حال بارگذاری...' : 'انتخاب تصویر'}<input id={`settings-footer-badge-upload-${item.id}`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onBadgeUpload(item.id, file) }} /></label><small>PNG، JPG، WebP یا GIF<br />حداکثر ۵ مگابایت</small>
          </div>
          <div className={styles.badgeFields}>
            <div className={styles.field}><label htmlFor={`settings-footer-badge-title-${item.id}`}>نام نشان</label><input id={`settings-footer-badge-title-${item.id}`} className="input-field" maxLength={80} required value={item.title} disabled={disabled} placeholder="مثلاً اینماد یا اسنپ‌پی" onChange={(event) => updateBadge(item.id, { title: event.target.value })} /></div>
            <div className={styles.field}><label htmlFor={`settings-footer-badge-image-${item.id}`}>آدرس تصویر نشان</label><input id={`settings-footer-badge-image-${item.id}`} className="input-field" dir="ltr" maxLength={2048} required value={item.imageUrl} disabled={disabled} placeholder="تصویر بارگذاری‌شده یا آدرس رسمی تصویر اینماد" onChange={(event) => updateBadge(item.id, { imageUrl: event.target.value })} /></div>
            <div className={styles.field}><label htmlFor={`settings-footer-badge-href-${item.id}`}>لینک تأیید یا اطلاعات نشان (اختیاری)</label><input id={`settings-footer-badge-href-${item.id}`} className="input-field" dir="ltr" maxLength={2048} value={item.href || ''} disabled={disabled} placeholder="https://..." onChange={(event) => updateBadge(item.id, { href: event.target.value || null })} /></div>
            <label className={styles.toggle} htmlFor={`settings-footer-badge-enabled-${item.id}`}><input id={`settings-footer-badge-enabled-${item.id}`} type="checkbox" role="switch" checked={item.enabled} disabled={disabled} onChange={(event) => updateBadge(item.id, { enabled: event.target.checked })} /><span>نمایش این نشان در فوتر</span></label>
          </div>
        </div>
      </article>)}</div>
      {!values.footerBadges.length && <div className={styles.empty}>هنوز نشانی اضافه نشده است. هر زمان نشان رسمی یا روش پرداخت جدیدی داشتید، تصویر و لینک آن را اینجا ثبت کنید.</div>}
      <button id="settings-footerBadges" type="button" className={styles.addButton} disabled={disabled || values.footerBadges.length >= footerLimits.maxBadges} onClick={() => onChange('footerBadges', [...values.footerBadges, { id: createId(), title: '', imageUrl: '', href: null, enabled: true }])}><Plus size={17} aria-hidden="true" />افزودن نشان</button>
    </fieldset>
  </div>
}
