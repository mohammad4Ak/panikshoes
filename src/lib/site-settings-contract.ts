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

export const defaultSiteSettings = {
  colorTheme: 'forest' as SiteColorTheme,
  storeName: 'کفش لند',
  tagline: 'برای روزهایی که یک‌جا بند نمی‌شی.',
  logoUrl: null as string | null,
  logoLightUrl: null as string | null,
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
  seoTitle: 'کفش لند - فروشگاه آنلاین کفش',
  seoDescription: 'فروشگاه تخصصی کفش کتانی و رسمی',
}

export type SiteSettingsValues = typeof defaultSiteSettings
export type SiteSettings = SiteSettingsValues & { version: number }
export const initialSiteSettings: SiteSettings = { ...defaultSiteSettings, version: 0 }

const nullableSettingsKeys = new Set(['logoUrl', 'logoLightUrl', 'announcementLink',
  'homeBannerImageUrl', 'homeBannerLink', 'instagramUrl', 'telegramUrl'])

export function isSiteSettings(value: unknown): value is SiteSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return isSiteColorTheme(record.colorTheme) && isHomeHeroProductIds(record.homeHeroProductIds)
    && isHomeHeroIntervalSeconds(record.homeHeroIntervalSeconds) && Number.isSafeInteger(record.version) && Number(record.version) >= 0
    && Object.entries(defaultSiteSettings).every(([key, fallback]) => nullableSettingsKeys.has(key)
      ? record[key] === null || typeof record[key] === 'string'
      : typeof record[key] === typeof fallback)
}
