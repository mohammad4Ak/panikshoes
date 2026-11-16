import type { Prisma, PrismaClient } from '@prisma/client'
import { ApiInputError, booleanField, integerField } from './api-input'
import { prisma } from './prisma'
import { getRegistrationDeliveryReadiness, getRegistrationOtpSecret, type RegistrationSettings } from './registration-settings'

export interface PasswordResetSettings {
  version: number
  enabled: boolean
  emailEnabled: boolean
  smsEnabled: boolean
  expiryMinutes: number
  maxAttempts: number
  resendSeconds: number
  destinationHourlyLimit: number
  ipHourlyLimit: number
}

export interface PasswordResetAdminSnapshot {
  settings: PasswordResetSettings
  readiness: { emailConfigured: boolean; smsConfigured: boolean; otpConfigured: boolean }
}

const defaults: PasswordResetSettings = {
  version: 0, enabled: true, emailEnabled: true, smsEnabled: false,
  expiryMinutes: 5, maxAttempts: 5, resendSeconds: 60,
  destinationHourlyLimit: 5, ipHourlyLimit: 30,
}

const select = {
  version: true, enabled: true, emailEnabled: true, smsEnabled: true,
  expiryMinutes: true, maxAttempts: true, resendSeconds: true,
  destinationHourlyLimit: true, ipHourlyLimit: true,
} as const

export async function readPasswordResetSettings(db: Pick<PrismaClient, 'passwordResetSettings'> = prisma): Promise<PasswordResetSettings> {
  const settings = await db.passwordResetSettings.findUnique({ where: { id: 1 }, select })
  return settings ?? { ...defaults }
}

export function getPasswordResetAvailability(settings: PasswordResetSettings, delivery: RegistrationSettings) {
  const { emailConfigured, smsConfigured } = getRegistrationDeliveryReadiness(delivery)
  const configured = getRegistrationOtpSecret().length >= 32 && settings.enabled
  const emailEnabled = configured && settings.emailEnabled && emailConfigured
  const smsEnabled = configured && settings.smsEnabled && smsConfigured
  return { enabled: emailEnabled || smsEnabled, emailEnabled, smsEnabled }
}

export function passwordResetAdminSnapshot(settings: PasswordResetSettings, delivery: RegistrationSettings): PasswordResetAdminSnapshot {
  return { settings: { ...settings }, readiness: { ...getRegistrationDeliveryReadiness(delivery), otpConfigured: getRegistrationOtpSecret().length >= 32 } }
}

function bounded(value: unknown, label: string, minimum: number, maximum: number) {
  const result = integerField(value, label, minimum)
  if (result > maximum) throw new ApiInputError(`${label} از حداکثر مجاز بیشتر است.`)
  return result
}

export function parsePasswordResetSettings(input: Record<string, unknown>, current: PasswordResetSettings, delivery: RegistrationSettings): PasswordResetSettings {
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new ApiInputError('تنظیمات بازیابی رمز نامعتبر است.')
  const version = integerField(input.version, 'نسخهٔ تنظیمات')
  if (version !== current.version) throw new ApiInputError('تنظیمات هم‌زمان تغییر کرده است. آخرین نسخه را دریافت کنید.', 409)
  const settings = {
    version,
    enabled: input.enabled === undefined ? current.enabled : booleanField(input.enabled, 'فعال‌سازی بازیابی رمز'),
    emailEnabled: input.emailEnabled === undefined ? current.emailEnabled : booleanField(input.emailEnabled, 'بازیابی با ایمیل'),
    smsEnabled: input.smsEnabled === undefined ? current.smsEnabled : booleanField(input.smsEnabled, 'بازیابی با پیامک'),
    expiryMinutes: bounded(input.expiryMinutes === undefined ? current.expiryMinutes : input.expiryMinutes, 'اعتبار کد', 1, 10),
    maxAttempts: bounded(input.maxAttempts === undefined ? current.maxAttempts : input.maxAttempts, 'تعداد تلاش', 1, 10),
    resendSeconds: bounded(input.resendSeconds === undefined ? current.resendSeconds : input.resendSeconds, 'فاصلهٔ ارسال مجدد', 15, 300),
    destinationHourlyLimit: bounded(input.destinationHourlyLimit === undefined ? current.destinationHourlyLimit : input.destinationHourlyLimit, 'حد ارسال برای هر مقصد', 1, 20),
    ipHourlyLimit: bounded(input.ipHourlyLimit === undefined ? current.ipHourlyLimit : input.ipHourlyLimit, 'حد ارسال برای هر آدرس شبکه', 1, 100),
  }
  if (settings.enabled && (settings.emailEnabled || settings.smsEnabled)) {
    if (getRegistrationOtpSecret().length < 32) throw new ApiInputError('برای فعال‌سازی بازیابی رمز، ابتدا کلید تأیید کد را در محیط سرور تنظیم کنید.')
    const availability = getPasswordResetAvailability(settings, delivery)
    if (settings.emailEnabled && !availability.emailEnabled) throw new ApiInputError('برای بازیابی با ایمیل، ابتدا تنظیمات سرویس ایمیل را کامل کنید.')
    if (settings.smsEnabled && !availability.smsEnabled) throw new ApiInputError('برای بازیابی با پیامک، ابتدا تنظیمات سرویس پیامک را کامل کنید.')
  }
  return settings
}

/** Shared with code issuance and password changes, always acquired first. */
export async function lockPasswordResetSettings(tx: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('password-reset-settings:v1', 0))`
}

export async function savePasswordResetSettings(settings: PasswordResetSettings): Promise<PasswordResetSettings> {
  if (settings.version === 2_147_483_647) throw new ApiInputError('نسخهٔ تنظیمات به سقف مجاز رسیده است.', 409)
  return prisma.$transaction(async tx => {
    await lockPasswordResetSettings(tx)
    if (settings.version === 0) await tx.passwordResetSettings.createMany({ data: { id: 1 }, skipDuplicates: true })
    const { version, ...values } = settings
    const updated = await tx.passwordResetSettings.updateMany({ where: { id: 1, version }, data: { ...values, version: { increment: 1 } } })
    if (updated.count !== 1) throw new ApiInputError('تنظیمات هم‌زمان تغییر کرده است. آخرین نسخه را دریافت کنید.', 409)
    return readPasswordResetSettings(tx)
  })
}
