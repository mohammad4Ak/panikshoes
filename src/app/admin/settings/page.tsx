'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUpLeft, Check, ImagePlus, LoaderCircle, RefreshCw, RotateCcw, Save } from 'lucide-react'
import PanikMark from '@/components/ui/PanikMark'
import HomeHeroSettings from '@/components/admin/HomeHeroSettings'
import { initialSiteSettings, isSiteSettings, isHomeHeroProductIds, isHomeHeroIntervalSeconds, type SiteSettings, type SiteSettingsValues } from '@/lib/site-settings-contract'
import { settingsSections, getSettingsSection, type SettingsSectionId } from '@/lib/admin-settings-sections'
import adminStyles from '@/components/admin/admin.module.css'
import styles from './settings.module.css'

const REQUEST_TIMEOUT = 20_000
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const BUILT_IN_BANNER = '/brand/panik-trail-banner.png'
const COLOR_PALETTES = [
  { value: 'forest', name: 'سبز جنگلی', description: 'سبز عمیق، مریم‌گلی و لیمویی' },
  { value: 'honey', name: 'عسلی و کرم', description: 'عسلی گرم، کرم و قهوه‌ای' },
] as const
type ImageField = 'logoUrl' | 'logoLightUrl' | 'homeBannerImageUrl'

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null)
  return typeof data?.error === 'string' ? data.error : fallback
}

const validSettings = isSiteSettings
const settingsValueEqual = (left: SiteSettings[keyof SiteSettings] | undefined, right: SiteSettings[keyof SiteSettings] | undefined) => Array.isArray(left) && Array.isArray(right) ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right

export default function AdminSettingsPage() {
  const router = useRouter()
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('branding')
  const focusFieldRef = useRef<string | null>(null)
  const [form, setForm] = useState<SiteSettings>(initialSiteSettings)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<ImageField | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const baselineRef = useRef<SiteSettings | null>(null)
  const mountedRef = useRef(true)
  const busy = loading || saving || uploading !== null
  const dirty = !!baselineRef.current && Object.keys(initialSiteSettings).some((key) => key !== 'version' && !settingsValueEqual(form[key as keyof SiteSettings], baselineRef.current?.[key as keyof SiteSettings]))

  const selectedSection = settingsSections.find((section) => section.id === activeSection) ?? settingsSections[0]
  useEffect(() => {
    const syncSection = () => setActiveSection(getSettingsSection(window.location.hash))
    syncSection()
    window.addEventListener('hashchange', syncSection)
    window.addEventListener('popstate', syncSection)
    return () => {
      window.removeEventListener('hashchange', syncSection)
      window.removeEventListener('popstate', syncSection)
    }
  }, [])

  useEffect(() => {
    if (!focusFieldRef.current) return
    document.getElementById(focusFieldRef.current)?.focus()
    focusFieldRef.current = null
  }, [activeSection, error])

  const validationError = (message: string, section: SettingsSectionId, fieldId: string) => {
    focusFieldRef.current = fieldId
    setActiveSection(section)
    if (window.location.hash !== '#' + section) window.location.hash = section
    setError(message)
  }

  const sectionProps = (id: SettingsSectionId, headingId = 'settings-heading-' + id) => ({
    id: 'settings-panel-' + id,
    'data-settings-section': id,
    'aria-labelledby': headingId,
    hidden: activeSection !== id,
  })

  const load = useCallback(async () => {
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT)
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/site-settings', { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(await responseError(response, 'تنظیمات فروشگاه بارگذاری نشد.'))
      const data: unknown = await response.json()
      if (!validSettings(data)) throw new Error('پاسخ تنظیمات فروشگاه معتبر نیست.')
      if (!mountedRef.current || controller.signal.aborted) return
      const previous = baselineRef.current
      setForm((draft) => {
        if (!previous) return data
        const merged = { ...data }
        for (const key of Object.keys(initialSiteSettings) as (keyof SiteSettings)[]) {
          if (key !== 'version' && !settingsValueEqual(draft[key], previous[key])) Object.assign(merged, { [key]: draft[key] })
        }
        return merged
      })
      baselineRef.current = data
      setLoaded(true)
      setConflict(false)
      if (previous) setNotice('آخرین نسخه دریافت شد؛ تغییرات ذخیره‌نشدهٔ شما حفظ شدند. فرم را بررسی کنید و سپس ذخیره کنید.')
    } catch (cause) {
      if (mountedRef.current && (!controller.signal.aborted || timedOut)) setError(timedOut ? 'دریافت تنظیمات طول کشید. دوباره تلاش کنید.' : cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد.')
    } finally {
      clearTimeout(timer)
      if (requestRef.current === controller) {
        requestRef.current = null
        if (mountedRef.current) setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void load()
    return () => { mountedRef.current = false; requestRef.current?.abort(); requestRef.current = null }
  }, [load])

  const setField = <K extends keyof SiteSettingsValues>(key: K, value: SiteSettingsValues[K]) => {
    if (requestRef.current || !loaded) return
    setForm((previous) => ({ ...previous, [key]: value }))
    setNotice('')
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (requestRef.current || !loaded || conflict) return
    setError('')
    setNotice('')
    if (!form.storeName.trim()) return validationError('نام فروشگاه را وارد کنید.', 'branding', 'settings-storeName')
    if (!form.seoTitle.trim() || !form.seoDescription.trim()) return validationError('عنوان و توضیح کوتاه سایت را وارد کنید.', 'seo', !form.seoTitle.trim() ? 'settings-seoTitle' : 'settings-seoDescription')
    if (form.announcementEnabled && !form.announcementText.trim()) return validationError('برای فعال کردن اطلاعیه، متن آن را وارد کنید.', 'announcement', 'settings-announcementText')
    if (form.announcementLink && !form.announcementLinkLabel.trim()) return validationError('برای لینک اطلاعیه، عنوان دکمه را وارد کنید.', 'announcement', 'settings-announcementLinkLabel')
    if (!isHomeHeroIntervalSeconds(form.homeHeroIntervalSeconds)) return validationError('زمان نمایش هر محصول باید عدد صحیح بین ۵ تا ۱۲۰ ثانیه باشد.', 'homepage', 'settings-homeHeroIntervalSeconds')
    if (!isHomeHeroProductIds(form.homeHeroProductIds)) return validationError('حداکثر ۱۰ محصول متفاوت برای بخش اصلی انتخاب کن.', 'homepage', 'settings-homeHeroProductIds')
    if (form.homeBannerEnabled && !form.homeBannerTitle.trim()) return validationError('برای نمایش بنر صفحهٔ اول، عنوان آن را وارد کنید.', 'homepage', 'settings-homeBannerTitle')
    if (form.homeBannerLink && !form.homeBannerLinkLabel.trim()) return validationError('برای لینک بنر صفحهٔ اول، عنوان دکمه را وارد کنید.', 'homepage', 'settings-homeBannerLinkLabel')
    // Hidden panels still belong to the shared draft. Check every input before
    // sending it, then reveal the invalid field so the browser can focus it.
    const invalidControl = event.currentTarget?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:invalid, textarea:invalid')
    if (invalidControl) {
      const section = invalidControl.closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection
      return validationError(invalidControl.validationMessage, getSettingsSection('#' + section), invalidControl.id)
    }
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT)
    setSaving(true)
    try {
      const response = await fetch('/api/admin/site-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(form) })
      if (response.status === 409) {
        if (mountedRef.current && !controller.signal.aborted) setConflict(true)
        throw new Error('این تنظیمات هم‌زمان تغییر کرده‌اند. آخرین نسخه را دریافت کنید؛ تغییرات شما در فرم حفظ می‌شوند و بعد از بررسی می‌توانید دوباره ذخیره کنید.')
      }
      if (!response.ok) throw new Error(await responseError(response, 'تنظیمات ذخیره نشد. دوباره تلاش کنید.'))
      const data: unknown = await response.json()
      if (!validSettings(data)) throw new Error('پاسخ ذخیره‌سازی معتبر نیست. آخرین نسخه را دریافت کنید و وضعیت را بررسی کنید.')
      if (!mountedRef.current || controller.signal.aborted) return
      baselineRef.current = data
      setForm(data)
      setNotice('تنظیمات ذخیره شد و در فروشگاه اعمال می‌شود.')
      router.refresh()
    } catch (cause) {
      if (mountedRef.current && (!controller.signal.aborted || timedOut)) setError(timedOut ? 'پاسخ ذخیره‌سازی دیر رسید؛ ممکن است تغییرات ذخیره شده باشند. آخرین نسخه را دریافت کنید و وضعیت را بررسی کنید.' : cause instanceof Error ? cause.message : 'ارتباط با سرور برقرار نشد؛ تغییرات شما در فرم حفظ شده‌اند.')
    } finally {
      clearTimeout(timer)
      if (requestRef.current === controller) {
        requestRef.current = null
        if (mountedRef.current) setSaving(false)
      }
    }
  }

  const upload = async (key: ImageField, file?: File) => {
    if (!file || requestRef.current || !loaded) return
    setError('')
    setNotice('')
    if (!IMAGE_TYPES.includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) return setError('یک تصویر PNG، JPG، WebP یا GIF غیرخالی و حداکثر ۵ مگابایت انتخاب کنید.')
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT)
    setUploading(key)
    try {
      const body = new FormData()
      body.append('file', file)
      const response = await fetch('/api/upload', { method: 'POST', signal: controller.signal, body })
      if (!response.ok) throw new Error(await responseError(response, 'تصویر بارگذاری نشد.'))
      const data = await response.json()
      if (typeof data?.url !== 'string' || !data.url) throw new Error('آدرس تصویر از سرور دریافت نشد.')
      if (!mountedRef.current || controller.signal.aborted) return
      setForm((previous) => ({ ...previous, [key]: data.url }))
      setNotice('تصویر بارگذاری شد؛ برای نمایش در سایت، تنظیمات را ذخیره کنید.')
    } catch (cause) {
      if (mountedRef.current && (!controller.signal.aborted || timedOut)) setError(timedOut ? 'بارگذاری تصویر طول کشید. دوباره تلاش کنید.' : cause instanceof Error ? cause.message : 'تصویر بارگذاری نشد. دوباره تلاش کنید.')
    } finally {
      clearTimeout(timer)
      if (requestRef.current === controller) {
        requestRef.current = null
        if (mountedRef.current) setUploading(null)
      }
    }
  }

  const input = (key: keyof SiteSettingsValues, label: string, maxLength: number, options: { multiline?: boolean; direction?: 'ltr'; placeholder?: string; required?: boolean; type?: string } = {}) => {
    const props = { id: `settings-${key}`, className: 'input-field', maxLength, disabled: busy || !loaded, value: String(form[key] ?? ''), dir: options.direction, placeholder: options.placeholder, required: options.required, onChange: (event: { target: { value: string } }) => setField(key, event.target.value || (initialSiteSettings[key] === null ? null : '')) }
    return <div className={styles.field}><label htmlFor={props.id}>{label}</label>{options.multiline ? <textarea {...props} /> : <input {...props} type={options.type ?? 'text'} />}</div>
  }

  const logo = (key: 'logoUrl' | 'logoLightUrl', title: string, dark: boolean) => {
    const url = key === 'logoLightUrl' ? form.logoLightUrl || form.logoUrl : form.logoUrl
    return <article className={styles.logoPanel}>
      <div className={`${styles.logoPreview} ${dark ? styles.darkPreview : ''}`} aria-label={`پیش‌نمایش ${title}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload(key, event.dataTransfer.files?.[0]) }}>
        <span className={styles.logoMark}>{url ? <Image src={url} width={100} height={100} unoptimized alt={`لوگوی ${form.storeName}`} /> : <PanikMark size={100} variant={dark ? 'light' : 'dark'} />}</span>
        <strong>{form.storeName || 'نام فروشگاه'}</strong><small>{form.tagline || 'شعار فروشگاه'}</small>
      </div>
      <div className={styles.logoControls}><h3>{title}</h3><p>{dark ? 'برای فوتر و زمینه‌های تیره؛ اگر انتخاب نشود، لوگوی اصلی نمایش داده می‌شود.' : 'برای سربرگ و زمینه‌های روشن؛ تصویر با زمینهٔ شفاف پیشنهاد می‌شود.'}</p>
        <div className={styles.uploadActions}><label className={styles.uploadButton} aria-disabled={busy || !loaded} htmlFor={`settings-upload-${key}`}>
          {uploading === key ? <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" /> : <ImagePlus size={17} aria-hidden="true" />}{uploading === key ? 'در حال بارگذاری...' : 'انتخاب تصویر'}
          <input id={`settings-upload-${key}`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || !loaded} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void upload(key, file) }} />
        </label>
          {form[key] && <button type="button" className={styles.resetButton} disabled={busy || !loaded} onClick={() => setField(key, null)}><RotateCcw size={15} aria-hidden="true" />{dark ? 'استفاده از لوگوی اصلی' : 'بازگشت به لوگوی پیش‌فرض'}</button>}
        </div><small>تصویر را انتخاب کنید یا روی پیش‌نمایش رها کنید.<br />PNG، JPG، WebP یا GIF · حداکثر ۵ مگابایت · اعمال پس از ذخیره</small>
      </div>
    </article>
  }

  return <div>
    <div className={adminStyles.pageHeader}><div><span className={adminStyles.eyebrow}>{selectedSection.label}</span><h1>تنظیمات عمومی</h1><p>{selectedSection.description}</p></div><Link href="/" className={adminStyles.headerLink}>مشاهده فروشگاه <ArrowUpLeft size={17} aria-hidden="true" /></Link></div>
    {!loaded ? <div className={styles.empty}>{loading ? <p role="status">در حال دریافت تنظیمات فروشگاه...</p> : <><p role="alert">{error || 'تنظیمات در دسترس نیست.'}</p><button type="button" className="btn-outline" onClick={() => void load()}><RefreshCw size={17} aria-hidden="true" /> تلاش دوباره</button></>}</div> : <form noValidate onSubmit={save} className={styles.form} aria-busy={busy}>
      <section className={styles.panel} {...sectionProps('branding')}><div className={styles.sectionTitle}><span>۰۱</span><div><h2 id="settings-heading-branding">برندینگ فروشگاه</h2><p>نام و لوگویی که مشتری در بخش‌های مختلف سایت می‌بیند.</p></div></div><div className={styles.twoFields}>{input('storeName', 'نام فروشگاه', 80, { required: true })}{input('tagline', 'شعار کوتاه برند', 200)}</div><div className={styles.logos}>{logo('logoUrl', 'لوگوی اصلی', false)}{logo('logoLightUrl', 'لوگو برای زمینهٔ تیره', true)}</div>
      </section>
      <section className={styles.panel} {...sectionProps('appearance')}>
        <div className={styles.sectionTitle}><span>۰۲</span><div><h2 id="settings-heading-appearance">رنگ‌بندی فروشگاه</h2><p>ترکیب رنگ هماهنگ برای صفحات فروشگاه و پنل مدیریت.</p></div></div>
        <fieldset className={styles.paletteFieldset} disabled={busy || !loaded} aria-describedby="settings-colorTheme-help">
          <legend>رنگ‌بندی فروشگاه</legend>
          <p id="settings-colorTheme-help" className={styles.paletteHelp}>رنگ‌بندی انتخابی پس از ذخیره در صفحات فروشگاه اعمال می‌شود. هر زمان بخواهید می‌توانید به رنگ قبلی برگردید.</p>
          <div className={styles.paletteChoices}>
            {COLOR_PALETTES.map((palette) => <label key={palette.value} className={styles.paletteCard} data-palette={palette.value} data-selected={form.colorTheme === palette.value} htmlFor={`settings-colorTheme-${palette.value}`}>
              <div className={styles.palettePreview} aria-hidden="true"><div className={styles.palettePreviewHeader}><span>{form.storeName || 'نام فروشگاه'}</span><i /><i /></div><div className={styles.palettePreviewBody}><div className={styles.palettePreviewCopy}><i /><i /><span /></div><div className={styles.palettePreviewProduct}><i /></div></div></div>
              <div className={styles.paletteCardHeading}><input id={`settings-colorTheme-${palette.value}`} name="colorTheme" type="radio" value={palette.value} checked={form.colorTheme === palette.value} disabled={busy || !loaded} onChange={() => setField('colorTheme', palette.value)} /><strong>{palette.name}</strong><span className={styles.paletteSelected}>{form.colorTheme === palette.value ? 'انتخاب شده' : 'انتخاب'}</span></div>
              <p>{palette.description}</p><div className={styles.paletteSwatches} aria-hidden="true"><i /><i /><i /><i /></div>
            </label>)}
          </div>
        </fieldset>
      </section>
      <section className={styles.panel} {...sectionProps('homepage')}>
        <div className={styles.sectionTitle}><span>۰۳</span><div><h2 id="settings-heading-homepage">صفحهٔ اول</h2><p>محصولات بخش اصلی بالای صفحه و بنر معرفی مجموعه‌ها را از اینجا تنظیم کن.</p></div></div>
        <HomeHeroSettings productIds={form.homeHeroProductIds} intervalSeconds={form.homeHeroIntervalSeconds} onProductIdsChange={value => setField('homeHeroProductIds', value)} onIntervalChange={value => setField('homeHeroIntervalSeconds', value)} disabled={busy || !loaded} active={activeSection === 'homepage'} />
        <div className={styles.heroDivider} />
        <div className={styles.sectionTitle}><div><h2 id="settings-banner-heading">بنر عریض صفحهٔ اول</h2><p>یک تصویر عریض با پیام و لینک دلخواه برای معرفی مجموعه‌ها یا خبرهای تازه.</p></div></div>
        <label className={styles.toggleRow} htmlFor="settings-homeBannerEnabled"><span><strong>نمایش بنر در صفحهٔ اول</strong><small>می‌توانید محتوا را آماده کنید و هر زمان خواستید نمایش آن را فعال کنید.</small></span><input id="settings-homeBannerEnabled" type="checkbox" role="switch" checked={form.homeBannerEnabled} disabled={busy} onChange={(event) => setField('homeBannerEnabled', event.target.checked)} /></label>
        <div className={styles.bannerPreview} aria-label="پیش‌نمایش بنر صفحهٔ اول" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void upload('homeBannerImageUrl', event.dataTransfer.files?.[0]) }}>
          <div className={styles.bannerPreviewVisual}><Image src={form.homeBannerImageUrl || BUILT_IN_BANNER} width={1440} height={720} unoptimized alt={form.homeBannerImageAlt} className={styles.bannerImage} /></div>
          <div className={styles.bannerPreviewContent}><small>{form.homeBannerEyebrow}</small><strong>{form.homeBannerTitle || 'عنوان بنر'}</strong><p>{form.homeBannerDescription}</p>{form.homeBannerLink && form.homeBannerLinkLabel && <span className={styles.bannerPreviewButton}>{form.homeBannerLinkLabel}<ArrowUpLeft size={16} aria-hidden="true" /></span>}</div>
          <span className={styles.bannerPreviewBadge}>{form.homeBannerEnabled ? 'پیش‌نمایش بنر' : 'پیش‌نمایش · نمایش در سایت خاموش است'}</span>
        </div>
        <div className={styles.bannerUploadControls}><div className={styles.uploadActions}>
          <label className={styles.uploadButton} aria-disabled={busy || !loaded} htmlFor="settings-upload-homeBannerImageUrl">{uploading === 'homeBannerImageUrl' ? <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" /> : <ImagePlus size={17} aria-hidden="true" />}{uploading === 'homeBannerImageUrl' ? 'در حال بارگذاری...' : 'انتخاب تصویر بنر'}<input id="settings-upload-homeBannerImageUrl" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || !loaded} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void upload('homeBannerImageUrl', file) }} /></label>
          {form.homeBannerImageUrl && <button type="button" className={styles.resetButton} disabled={busy || !loaded} onClick={() => setField('homeBannerImageUrl', null)}><RotateCcw size={15} aria-hidden="true" />بازگشت به تصویر پیش‌فرض بنر</button>}
        </div><small>تصویر افقی را انتخاب کنید یا روی پیش‌نمایش رها کنید. PNG، JPG، WebP یا GIF · حداکثر ۵ مگابایت · اعمال پس از ذخیره</small></div>
        <div className={styles.twoFields}>{input('homeBannerEyebrow', 'متن کوتاه بالای عنوان (اختیاری)', 80)}{input('homeBannerTitle', 'عنوان بنر', 140, { required: form.homeBannerEnabled })}</div>
        {input('homeBannerDescription', 'توضیح بنر (اختیاری)', 500, { multiline: true })}
        <div className={styles.twoFields}>{input('homeBannerLinkLabel', 'عنوان دکمهٔ بنر', 80, { required: !!form.homeBannerLink, placeholder: 'مشاهده مجموعه' })}{input('homeBannerLink', 'آدرس لینک بنر (اختیاری)', 2048, { direction: 'ltr', placeholder: '/products یا https://...' })}</div>
        {input('homeBannerImageAlt', 'توضیح تصویر برای دسترس‌پذیری', 200, { placeholder: 'مثلاً: کفش طبیعت‌گردی روی یک مسیر سنگی' })}
      </section>
      <section className={styles.panel} {...sectionProps('announcement')}><div className={styles.sectionTitle}><span>۰۴</span><div><h2 id="settings-heading-announcement">اطلاعیهٔ فروشگاه</h2><p>یک پیام کوتاه برای تخفیف، تغییر زمان ارسال یا خبرهای مهم.</p></div></div><label className={styles.toggleRow} htmlFor="settings-announcementEnabled"><span><strong>نمایش اطلاعیه در سایت</strong><small>پس از ذخیره، اطلاعیه در بالای صفحات فروشگاه نمایش داده می‌شود.</small></span><input id="settings-announcementEnabled" type="checkbox" role="switch" checked={form.announcementEnabled} disabled={busy} onChange={(event) => setField('announcementEnabled', event.target.checked)} /></label>{input('announcementText', 'متن اطلاعیه', 500, { multiline: true, required: form.announcementEnabled, placeholder: 'مثلاً: سفارش‌های این هفته با ارسال رایگان...' })}<div className={styles.twoFields}>{input('announcementLinkLabel', 'عنوان لینک (اختیاری)', 80, { placeholder: 'مشاهده محصولات' })}{input('announcementLink', 'آدرس لینک (اختیاری)', 2048, { direction: 'ltr', placeholder: '/products یا https://...' })}</div>{form.announcementEnabled && form.announcementText && <div className={styles.announcementPreview}><small>پیش‌نمایش اطلاعیه</small><p>{form.announcementText}</p>{form.announcementLink && form.announcementLinkLabel && <span>{form.announcementLinkLabel} ↗</span>}</div>}</section>
      <section className={styles.panel} {...sectionProps('contact')}><div className={styles.sectionTitle}><span>۰۵</span><div><h2 id="settings-heading-contact">ارتباط و پشتیبانی</h2><p>اطلاعات نمایش داده‌شده در صفحهٔ تماس و فوتر سایت.</p></div></div><div className={styles.twoFields}>{input('phone', 'شماره تماس', 40, { direction: 'ltr', type: 'tel' })}{input('email', 'ایمیل', 254, { direction: 'ltr', type: 'email' })}{input('address', 'نشانی فروشگاه', 500, { multiline: true })}{input('supportHours', 'ساعت پاسخگویی', 500, { multiline: true })}{input('instagramUrl', 'لینک اینستاگرام (اختیاری)', 2048, { direction: 'ltr', placeholder: 'https://www.instagram.com/...' })}{input('telegramUrl', 'لینک تلگرام (اختیاری)', 2048, { direction: 'ltr', placeholder: 'https://t.me/...' })}</div></section>
      <section className={styles.panel} {...sectionProps('seo')}><div className={styles.sectionTitle}><span>۰۶</span><div><h2 id="settings-heading-seo">نمایش در موتورهای جستجو</h2><p>عنوان و توضیح پیش‌فرض سایت برای مرورگر و موتورهای جست‌وجو.</p></div></div>{input('seoTitle', 'عنوان سایت', 120, { required: true })}{input('seoDescription', 'توضیح کوتاه سایت', 300, { multiline: true, required: true })}</section>
      <div className={styles.savePanel}>{uploading && <p role="status" className={styles.uploadStatus}><LoaderCircle size={15} className={styles.spinner} aria-hidden="true" />در حال بارگذاری تصویر؛ می‌توانید بخش‌های دیگر تنظیمات را ببینید.</p>}{error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}><Check size={17} aria-hidden="true" />{notice}</p>}<div className={styles.saveActions}><div><strong>{dirty ? 'تغییرات ذخیره‌نشده دارید' : 'تنظیمات فروشگاه'}</strong><p>تغییرات همهٔ بخش‌ها با همین دکمه ذخیره می‌شوند؛ جابه‌جایی بین زیرمنوها آن‌ها را پاک نمی‌کند.</p></div><div className={styles.buttons}><button type="button" className={`btn-outline ${styles.reload}`} disabled={busy} onClick={() => void load()}><RefreshCw size={17} aria-hidden="true" />{loading ? 'در حال دریافت...' : 'دریافت آخرین نسخه'}</button><button type="submit" className={`btn-primary ${styles.save}`} disabled={busy || conflict || !dirty}>{saving ? <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}{saving ? 'در حال ذخیره...' : 'ذخیره تنظیمات'}</button></div></div></div>
    </form>}
  </div>
}
