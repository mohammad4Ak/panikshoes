// Public presentation settings only. Payment and shipping rules have separate administration.
export const siteColorThemes = ['forest', 'honey'] as const
export type SiteColorTheme = typeof siteColorThemes[number]

export function isSiteColorTheme(value: unknown): value is SiteColorTheme {
  return typeof value === 'string' && siteColorThemes.some((theme) => theme === value)
}
export const homeHeroLimits = { maxProducts: 10, minIntervalSeconds: 5, maxIntervalSeconds: 120, defaultIntervalSeconds: 10 } as const

export function isHomeHeroProductIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= homeHeroLimits.maxProducts
    && Array.from(value).every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(id))
    && new Set(value).size === value.length
}

export function isHomeHeroIntervalSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= homeHeroLimits.minIntervalSeconds && value <= homeHeroLimits.maxIntervalSeconds
}

export const footerLimits = { maxLinks: 10, maxBadges: 8, maxSocialLinks: 12 } as const
export type FooterLink = { id: string; label: string; href: string }
export type FooterBadge = { id: string; title: string; imageUrl: string; href: string | null; enabled: boolean }
export const footerSocialIcons = ['instagram', 'telegram', 'eitaa', 'whatsapp', 'link', 'custom'] as const
export type FooterSocialIcon = typeof footerSocialIcons[number]
export type FooterSocialLink = { id: string; label: string; href: string; icon: FooterSocialIcon; iconUrl: string | null; enabled: boolean }

function isFooterText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function footerUrl(value: unknown): URL | string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null
  let decoded = value
  try {
    // Reject authority escapes even when nested in percent encoding.
    for (let i = 0; i < 32; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch { return null }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) return null
  if (value.startsWith('/')) return decoded.startsWith('//') ? null : value
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed : null
  } catch { return null }
}

export function isFooterHref(value: unknown): value is string {
  return footerUrl(value) !== null
}

export function isFooterSocialHref(value: unknown): value is string {
  const parsed = footerUrl(value)
  return !!parsed && typeof parsed !== 'string' && typeof value === 'string' && /^https:\/\//i.test(value)
}

export function isFooterSocialIconUrl(value: unknown): value is string {
  const parsed = footerUrl(value)
  if (!parsed) return false
  if (typeof parsed === 'string') return /^\/uploads\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(parsed)
  return !parsed.port && !parsed.search && !parsed.hash
    && /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(parsed.hostname)
    && /^\/(?:products|branding)\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(parsed.pathname)
}

export function isFooterBadgeImageUrl(value: unknown): value is string {
  const parsed = footerUrl(value)
  if (!parsed) return false
  if (typeof parsed === 'string') return /^\/uploads\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(parsed)
  if (parsed.port || parsed.hash) return false
  if (/^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(parsed.hostname)) {
    return !parsed.search && /^\/(?:products|branding)\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(parsed.pathname)
  }
  // Enamad supplies a dynamic verification image rather than a raster filename.
  return parsed.hostname === 'trustseal.enamad.ir' && parsed.pathname === '/logo.aspx'
    && Array.from(parsed.searchParams.keys()).length === 2
    && /^\d{1,20}$/.test(parsed.searchParams.get('id') ?? '')
    && /^[a-z0-9_-]{1,128}$/i.test(parsed.searchParams.get('Code') ?? '')
}

function hasFooterShape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function isFooterLinks(value: unknown): value is FooterLink[] {
  return Array.isArray(value) && value.length <= footerLimits.maxLinks
    && Array.from(value).every((link) => hasFooterShape(link, ['id', 'label', 'href'])
      && typeof link.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(link.id)
      && isFooterText(link.label, 80) && isFooterHref(link.href))
    && new Set(value.map((link) => link.id)).size === value.length
}

export function isFooterBadges(value: unknown): value is FooterBadge[] {
  return Array.isArray(value) && value.length <= footerLimits.maxBadges
    && Array.from(value).every((badge) => hasFooterShape(badge, ['id', 'title', 'imageUrl', 'href', 'enabled'])
      && typeof badge.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(badge.id)
      && isFooterText(badge.title, 80) && isFooterBadgeImageUrl(badge.imageUrl)
      && (badge.href === null || isFooterHref(badge.href)) && typeof badge.enabled === 'boolean')
    && new Set(value.map((badge) => badge.id)).size === value.length
}

export function isFooterSocialLinks(value: unknown): value is FooterSocialLink[] {
  return Array.isArray(value) && value.length <= footerLimits.maxSocialLinks
    && Array.from(value).every((social) => hasFooterShape(social, ['id', 'label', 'href', 'icon', 'iconUrl', 'enabled'])
      && typeof social.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(social.id)
      && typeof social.label === 'string' && social.label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(social.label)
      && isFooterSocialHref(social.href) && footerSocialIcons.some((icon) => icon === social.icon)
      && (social.icon === 'custom' ? isFooterSocialIconUrl(social.iconUrl) : social.iconUrl === null || isFooterSocialIconUrl(social.iconUrl))
      && typeof social.enabled === 'boolean')
    && new Set(value.map((social) => social.id)).size === value.length
}

type LegacySocialSettings = { instagramUrl?: string | null; telegramUrl?: string | null; eitaaUrl?: string | null; whatsappUrl?: string | null; footerSocialLinks?: unknown }

export function resolveFooterSocialLinks(settings: LegacySocialSettings): FooterSocialLink[] {
  if (settings.footerSocialLinks !== undefined) return isFooterSocialLinks(settings.footerSocialLinks) ? settings.footerSocialLinks : []
  // Only legacy shapes without the new field inherit their old links. An
  // explicitly empty list means the administrator removed all footer socials.
  return ([
    { id: 'instagram', label: 'اینستاگرام', href: settings.instagramUrl, icon: 'instagram' },
    { id: 'telegram', label: 'تلگرام', href: settings.telegramUrl, icon: 'telegram' },
    { id: 'eitaa', label: 'ایتا', href: settings.eitaaUrl, icon: 'eitaa' },
    { id: 'whatsapp', label: 'واتساپ', href: settings.whatsappUrl, icon: 'whatsapp' },
  ] as const).flatMap((social) => isFooterSocialHref(social.href) ? [{ ...social, href: social.href, iconUrl: null, enabled: true }] : [])
}

export const defaultFooterLinks: FooterLink[] = [
  { id: 'products', label: 'همهٔ محصولات', href: '/products' },
  { id: 'about', label: 'دربارهٔ ما', href: '/about' },
  { id: 'contact', label: 'تماس با ما', href: '/contact' },
  { id: 'tracking', label: 'پیگیری سفارش', href: '/profile' },
  { id: 'account', label: 'حساب کاربری', href: '/profile' },
  { id: 'cart', label: 'سبد خرید', href: '/cart' },
]

export const defaultSiteSettings = {
  colorTheme: 'forest' as SiteColorTheme,
  storeName: 'کفش لند',
  tagline: 'برای روزهایی که یک‌جا بند نمی‌شی.',
  logoUrl: null as string | null,
  logoLightUrl: null as string | null,
  footerDescription: '',
  footerCopyright: '',
  footerLinks: defaultFooterLinks,
  footerBadges: [] as FooterBadge[],
  footerSocialLinks: [] as FooterSocialLink[],
  announcementEnabled: false,
  announcementText: '',
  announcementLink: null as string | null,
  announcementLinkLabel: '',
  homeHeroProductIds: [] as string[],
  homeHeroIntervalSeconds: homeHeroLimits.defaultIntervalSeconds as number,
  homeBannerEnabled: true,
  homeBannerImageUrl: null as string | null,
  homeBannerEyebrow: 'از شهر تا مسیرهای تازه',
  homeBannerTitle: 'مسیر بعدی‌ات از اینجا شروع می‌شه.',
  homeBannerDescription: 'برای قدم‌های هر روز و ماجراجویی‌های آخر هفته، همراهت رو پیدا کن.',
  homeBannerLink: '/products?stock=1' as string | null,
  homeBannerLinkLabel: 'کشف مدل‌های موجود',
  homeBannerImageAlt: 'کفش طبیعت‌گردی در یک مسیر کوهستانی',
  phone: '02112345678',
  email: 'info@shoeland.ir',
  address: 'تهران، خیابان ولیعصر، پلاک ۱۲۳۴',
  supportHours: 'شنبه تا چهارشنبه: ۹ صبح تا ۹ شب\nپنجشنبه: ۹ صبح تا ۵ عصر\nجمعه: تعطیل',
  instagramUrl: null as string | null,
  telegramUrl: null as string | null,
  eitaaUrl: null as string | null,
  whatsappUrl: null as string | null,
  seoTitle: 'کفش لند - فروشگاه آنلاین کفش',
  seoDescription: 'فروشگاه تخصصی کفش کتانی و رسمی',
}

export type SiteSettingsValues = typeof defaultSiteSettings
export type SiteSettings = SiteSettingsValues & { version: number }
export const initialSiteSettings: SiteSettings = { ...defaultSiteSettings, version: 0 }

const nullableSettingsKeys = new Set(['logoUrl', 'logoLightUrl', 'announcementLink',
  'homeBannerImageUrl', 'homeBannerLink', 'instagramUrl', 'telegramUrl', 'eitaaUrl', 'whatsappUrl'])

export function isSiteSettings(value: unknown): value is SiteSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return isSiteColorTheme(record.colorTheme) && isHomeHeroProductIds(record.homeHeroProductIds)
    && isFooterLinks(record.footerLinks) && isFooterBadges(record.footerBadges) && isFooterSocialLinks(record.footerSocialLinks)
    && isHomeHeroIntervalSeconds(record.homeHeroIntervalSeconds) && Number.isSafeInteger(record.version) && Number(record.version) >= 0
    && Object.entries(defaultSiteSettings).every(([key, fallback]) => nullableSettingsKeys.has(key)
      ? record[key] === null || typeof record[key] === 'string'
      : typeof record[key] === typeof fallback)
}
