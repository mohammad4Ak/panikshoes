import { cache } from 'react'
import { connection } from 'next/server'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { defaultSiteSettings, isSiteColorTheme, isHomeHeroProductIds, isHomeHeroIntervalSeconds, type SiteSettings, type SiteSettingsValues } from '@/lib/site-settings-contract'

export const siteSettingsSelect = {
  version: true, colorTheme: true, storeName: true, tagline: true, logoUrl: true, logoLightUrl: true,
  announcementEnabled: true, announcementText: true, announcementLink: true,
  announcementLinkLabel: true, homeHeroProductIds: true, homeHeroIntervalSeconds: true, homeBannerEnabled: true, homeBannerImageUrl: true,
  homeBannerEyebrow: true, homeBannerTitle: true, homeBannerDescription: true,
  homeBannerLink: true, homeBannerLinkLabel: true, homeBannerImageAlt: true,
  phone: true, email: true, address: true, supportHours: true,
  instagramUrl: true, telegramUrl: true, seoTitle: true, seoDescription: true,
} as const

// This reader also accepts a transaction client when snapshotting an invoice.
export async function readSiteSettings(client: Pick<PrismaClient, 'siteSettings'> = prisma): Promise<SiteSettings> {
  const settings = await client.siteSettings.findUnique({ where: { id: 1 }, select: siteSettingsSelect })
  return settings ?? { ...defaultSiteSettings, version: 0 }
}

// React cache shares one read within a render, never across visitors or requests.
export const getSiteSettings = cache(async (): Promise<SiteSettings> => {
  await connection()
  return readSiteSettings()
})

export function publicSiteSettings(settings: SiteSettings): SiteSettings {
  const values = Object.fromEntries(Object.keys(siteSettingsSelect).map((key) => [key, settings[key as keyof SiteSettings]])) as SiteSettings
  if (!values.announcementEnabled) {
    values.announcementText = ''
    values.announcementLink = null
    values.announcementLinkLabel = ''
  }
  if (!values.homeBannerEnabled) {
    values.homeBannerImageUrl = null
    values.homeBannerEyebrow = ''
    values.homeBannerTitle = ''
    values.homeBannerDescription = ''
    values.homeBannerLink = null
    values.homeBannerLinkLabel = ''
    values.homeBannerImageAlt = ''
  }
  return values
}

export class SiteSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function text(value: unknown, label: string, maximum: number, required = false, multiline = false): string {
  if (typeof value !== 'string') throw new SiteSettingsError(`${label} معتبر نیست.`)
  const normalized = value.trim()
  const controls = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/
  if (normalized.length > maximum || controls.test(value) || (required && !normalized)) {
    throw new SiteSettingsError(`${label} معتبر نیست یا طول آن بیش از حد مجاز است.`)
  }
  return normalized
}

function optionalUrl(value: unknown, label: string): string | null {
  if (value === null) return null
  const normalized = text(value, label, 2048)
  return normalized || null
}

function absoluteUrl(value: string, label: string): URL {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new SiteSettingsError(`${label} معتبر نیست.`) }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\s\\]/.test(value)) {
    throw new SiteSettingsError(`${label} معتبر نیست.`)
  }
  return parsed
}

function announcementUrl(value: unknown, label = 'لینک اطلاعیه'): string | null {
  const normalized = optionalUrl(value, label)
  if (!normalized) return null
  let decoded = normalized
  try {
    // Reject encoded control characters and authority/path escapes as well.
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch { throw new SiteSettingsError(`${label} معتبر نیست.`) }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) throw new SiteSettingsError(`${label} معتبر نیست.`)
  if (normalized.startsWith('/')) {
    if (decoded.startsWith('//')) throw new SiteSettingsError(`${label} باید مسیر داخل سایت باشد.`)
    return normalized
  }
  absoluteUrl(normalized, label)
  return normalized
}

function uploadedImageUrl(value: unknown, label = 'تصویر لوگو'): string | null {
  const normalized = optionalUrl(value, label)
  if (!normalized) return null
  const imagePath = /^[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i
  if (normalized.startsWith('/uploads/')) {
    if (!imagePath.test(normalized.slice('/uploads/'.length))) throw new SiteSettingsError(`برای ${label} از تصویر آپلودشده استفاده کنید.`)
    return normalized
  }
  const parsed = absoluteUrl(normalized, label)
  if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i.test(parsed.hostname) || parsed.port || parsed.search || parsed.hash ||
    !/^\/(?:products|branding)\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(parsed.pathname)) {
    throw new SiteSettingsError(`برای ${label} از تصویر آپلودشده استفاده کنید.`)
  }
  return normalized
}

function socialUrl(value: unknown, kind: 'instagram' | 'telegram'): string | null {
  const normalized = optionalUrl(value, 'لینک شبکه اجتماعی')
  if (!normalized) return null
  const parsed = absoluteUrl(normalized, 'لینک شبکه اجتماعی')
  const correctHost = kind === 'instagram' ? /^(?:[a-z0-9-]+\.)*instagram\.com$/i.test(parsed.hostname) : ['t.me', 'telegram.me'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' || parsed.port || !correctHost) throw new SiteSettingsError('آدرس شبکه اجتماعی معتبر نیست.')
  return normalized
}

export function parseSiteSettings(body: unknown): { values: SiteSettingsValues; version: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SiteSettingsError('اطلاعات تنظیمات معتبر نیست.')
  const input = body as Record<string, unknown>
  if (Object.keys(input).some((key) => !Object.hasOwn(siteSettingsSelect, key)) || !Number.isInteger(input.version) || (input.version as number) < 1 || (input.version as number) >= 2_147_483_647) {
    throw new SiteSettingsError('نسخه یا فیلدهای تنظیمات معتبر نیست.')
  }
  if (!isSiteColorTheme(input.colorTheme)) throw new SiteSettingsError('رنگ‌بندی سایت معتبر نیست.')
  if (!isHomeHeroProductIds(input.homeHeroProductIds)) throw new SiteSettingsError('محصولات بخش اصلی صفحهٔ اول باید حداکثر ۱۰ محصول متفاوت باشند.')
  if (!isHomeHeroIntervalSeconds(input.homeHeroIntervalSeconds)) throw new SiteSettingsError('زمان تعویض محصولات باید عدد صحیح بین ۵ تا ۱۲۰ ثانیه باشد.')
  if (typeof input.announcementEnabled !== 'boolean') throw new SiteSettingsError('وضعیت اطلاعیه معتبر نیست.')
  if (typeof input.homeBannerEnabled !== 'boolean') throw new SiteSettingsError('وضعیت بنر صفحهٔ اول معتبر نیست.')
  const phone = text(input.phone, 'شماره تماس', 40).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632)).replace(/[ ()-]/g, '')
  if (phone && !/^\+?\d{7,15}$/.test(phone)) throw new SiteSettingsError('شماره تماس معتبر نیست.')
  const email = text(input.email, 'ایمیل', 254).toLowerCase()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SiteSettingsError('ایمیل معتبر نیست.')
  const values: SiteSettingsValues = {
    colorTheme: input.colorTheme,
    storeName: text(input.storeName, 'نام فروشگاه', 80, true),
    tagline: text(input.tagline, 'شعار برند', 200),
    logoUrl: uploadedImageUrl(input.logoUrl), logoLightUrl: uploadedImageUrl(input.logoLightUrl),
    announcementEnabled: input.announcementEnabled,
    announcementText: text(input.announcementText, 'متن اطلاعیه', 500, false, true),
    announcementLink: announcementUrl(input.announcementLink),
    announcementLinkLabel: text(input.announcementLinkLabel, 'عنوان لینک اطلاعیه', 80),
    homeHeroProductIds: [...input.homeHeroProductIds],
    homeHeroIntervalSeconds: input.homeHeroIntervalSeconds,
    homeBannerEnabled: input.homeBannerEnabled,
    homeBannerImageUrl: uploadedImageUrl(input.homeBannerImageUrl, 'تصویر بنر'),
    homeBannerEyebrow: text(input.homeBannerEyebrow, 'روتیتر بنر', 80),
    homeBannerTitle: text(input.homeBannerTitle, 'عنوان بنر', 140),
    homeBannerDescription: text(input.homeBannerDescription, 'توضیح بنر', 500, false, true),
    homeBannerLink: announcementUrl(input.homeBannerLink, 'لینک بنر'),
    homeBannerLinkLabel: text(input.homeBannerLinkLabel, 'عنوان لینک بنر', 80),
    homeBannerImageAlt: text(input.homeBannerImageAlt, 'توضیح تصویر بنر', 200),
    phone, email, address: text(input.address, 'نشانی', 500, false, true),
    supportHours: text(input.supportHours, 'ساعات پاسخ‌گویی', 500, false, true),
    instagramUrl: socialUrl(input.instagramUrl, 'instagram'), telegramUrl: socialUrl(input.telegramUrl, 'telegram'),
    seoTitle: text(input.seoTitle, 'عنوان سایت', 120, true),
    seoDescription: text(input.seoDescription, 'توضیحات سایت', 300, true),
  }
  if (values.announcementEnabled && !values.announcementText) throw new SiteSettingsError('برای فعال کردن اطلاعیه، متن آن را وارد کنید.')
  if (values.announcementLink && !values.announcementLinkLabel) throw new SiteSettingsError('عنوان لینک اطلاعیه را وارد کنید.')
  if (values.homeBannerEnabled && !values.homeBannerTitle) throw new SiteSettingsError('برای فعال کردن بنر، عنوان آن را وارد کنید.')
  if (values.homeBannerLink && !values.homeBannerLinkLabel) throw new SiteSettingsError('عنوان لینک بنر را وارد کنید.')
  return { values, version: input.version as number }
}
