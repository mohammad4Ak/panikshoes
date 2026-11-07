import { ApiInputError, booleanField, integerField, optionalText } from './api-input'
import { prisma } from './prisma'

export type RegistrationChannel = 'email' | 'sms'

export interface RegistrationSettings {
  version: number
  emailEnabled: boolean
  smsEnabled: boolean
  expiryMinutes: number
  maxAttempts: number
  resendSeconds: number
  destinationHourlyLimit: number
  ipHourlyLimit: number
  emailSender: 'auth' | 'order' | 'noreply'
  smsTemplate: string
}

const defaults: RegistrationSettings = {
  version: 0,
  emailEnabled: false,
  smsEnabled: false,
  expiryMinutes: 5,
  maxAttempts: 5,
  resendSeconds: 60,
  destinationHourlyLimit: 5,
  ipHourlyLimit: 30,
  emailSender: 'auth',
  smsTemplate: '',
}

const SMS_TEMPLATE = /^[a-zA-Z0-9_-]{1,100}$/

function isEmailSender(value: unknown): value is RegistrationSettings['emailSender'] {
  return value === 'auth' || value === 'order' || value === 'noreply'
}

export function getRegistrationOtpSecret(): string {
  return process.env.REGISTRATION_OTP_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || ''
}

export function getRegistrationDeliveryReadiness(settings: RegistrationSettings) {
  return {
    emailConfigured: isEmailSender(settings.emailSender) && Boolean(process.env.REGISTRATION_EMAIL_API_KEY?.trim()),
    smsConfigured: SMS_TEMPLATE.test(settings.smsTemplate) && Boolean(process.env.REGISTRATION_KAVENEGAR_API_KEY?.trim()),
  }
}

export function getRegistrationAvailability(settings: RegistrationSettings) {
  const { emailConfigured, smsConfigured } = getRegistrationDeliveryReadiness(settings)
  const otpConfigured = getRegistrationOtpSecret().length >= 32
  return {
    emailEnabled: otpConfigured && settings.emailEnabled && emailConfigured,
    smsEnabled: otpConfigured && settings.smsEnabled && smsConfigured,
  }
}

export function registrationAdminSnapshot(settings: RegistrationSettings) {
  return {
    settings,
    readiness: {
      ...getRegistrationDeliveryReadiness(settings),
      otpConfigured: getRegistrationOtpSecret().length >= 32,
      smsKeyConfigured: Boolean(process.env.REGISTRATION_KAVENEGAR_API_KEY?.trim()),
    },
  }
}

export type RegistrationAdminSnapshot = ReturnType<typeof registrationAdminSnapshot>

export async function readRegistrationSettings(db: Pick<typeof prisma, 'registrationSettings'> = prisma): Promise<RegistrationSettings> {
  const row = await db.registrationSettings.findUnique({ where: { id: 1 } })
  if (!row) return { ...defaults }
  const { id: _id, updatedAt: _updatedAt, emailSender, ...settings } = row
  return { ...settings, emailSender: isEmailSender(emailSender) ? emailSender : defaults.emailSender }
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number) {
  const number = integerField(value, label, minimum)
  if (number > maximum) throw new ApiInputError(`${label} از حداکثر مجاز بیشتر است.`)
  return number
}

export function parseRegistrationSettings(body: Record<string, unknown>): RegistrationSettings {
  const emailSender = body.emailSender
  if (!isEmailSender(emailSender)) throw new ApiInputError('فرستندهٔ ایمیل نامعتبر است.')
  const smsTemplate = optionalText(body.smsTemplate, 'نام الگوی کاوه‌نگار', 100) ?? ''
  if (smsTemplate && !SMS_TEMPLATE.test(smsTemplate)) throw new ApiInputError('نام الگوی کاوه‌نگار باید با حروف و اعداد انگلیسی، خط تیره یا زیرخط نوشته شود.')

  const settings: RegistrationSettings = {
    version: integerField(body.version, 'نسخهٔ تنظیمات'),
    emailEnabled: booleanField(body.emailEnabled, 'وضعیت ثبت‌نام با ایمیل'),
    smsEnabled: booleanField(body.smsEnabled, 'وضعیت ثبت‌نام با پیامک'),
    expiryMinutes: boundedInteger(body.expiryMinutes, 'اعتبار کد (دقیقه)', 1, 10),
    maxAttempts: boundedInteger(body.maxAttempts, 'تعداد تلاش برای ورود کد', 1, 10),
    resendSeconds: boundedInteger(body.resendSeconds, 'فاصلهٔ ارسال مجدد (ثانیه)', 15, 300),
    destinationHourlyLimit: boundedInteger(body.destinationHourlyLimit, 'حد ارسال ساعتی برای هر مقصد', 1, 20),
    ipHourlyLimit: boundedInteger(body.ipHourlyLimit, 'حد ارسال ساعتی برای هر IP', 1, 100),
    emailSender,
    smsTemplate,
  }
  const availability = getRegistrationAvailability(settings)
  if ((settings.emailEnabled || settings.smsEnabled) && getRegistrationOtpSecret().length < 32) {
    throw new ApiInputError('برای فعال‌سازی ثبت‌نام، ابتدا کلید تأیید کد را در محیط سرور تنظیم کنید.')
  }
  if (settings.emailEnabled && !availability.emailEnabled) throw new ApiInputError('برای فعال‌سازی ایمیل، ابتدا کلید سرویس ایمیل را در محیط سرور تنظیم کنید.')
  if (settings.smsEnabled && !availability.smsEnabled) throw new ApiInputError('برای فعال‌سازی پیامک، کلید کاوه‌نگار و نام الگو را تنظیم کنید.')
  return settings
}

export async function saveRegistrationSettings(settings: RegistrationSettings): Promise<RegistrationSettings> {
  const { version, ...values } = settings
  return prisma.$transaction(async (tx) => {
    if (version === 0) await tx.registrationSettings.createMany({ data: { id: 1 }, skipDuplicates: true })
    const updated = await tx.registrationSettings.updateMany({
      where: { id: 1, version },
      data: { ...values, version: { increment: 1 } },
    })
    if (updated.count !== 1) throw new ApiInputError('تنظیمات هم‌زمان تغییر کرده است. آخرین نسخه را دریافت کنید.', 409)
    return readRegistrationSettings(tx)
  })
}
