import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ApiInputError, booleanField, integerField, optionalText } from './api-input'
import { prisma } from './prisma'
import { validateCustomSmsConfiguration } from './registration-sms'

export type RegistrationChannel = 'email' | 'sms'
export interface RegistrationSmsHeader { name: string; value: string }

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
  smsProvider: 'kavenegar' | 'custom'
  smsApiUrl: string
  smsMethod: 'POST' | 'GET'
  smsBodyFormat: 'json' | 'form'
  smsBodyTemplate: string
  smsHeaders: RegistrationSmsHeader[]
  smsHeadersEncrypted: string | null
  smsApiKeyEncrypted: string | null
  smsSuccessPath: string
  smsSuccessValue: string
}

export type RegistrationPublicSettings = Omit<RegistrationSettings, 'smsApiKeyEncrypted' | 'smsHeadersEncrypted' | 'smsHeaders'> & {
  smsHeaders: (RegistrationSmsHeader & { configured: boolean })[]
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
  smsProvider: 'kavenegar',
  smsApiUrl: '',
  smsMethod: 'POST',
  smsBodyFormat: 'json',
  smsBodyTemplate: '{"mobile":"{{phone}}","code":"{{code}}"}',
  smsHeaders: [],
  smsHeadersEncrypted: null,
  smsApiKeyEncrypted: null,
  smsSuccessPath: '',
  smsSuccessValue: '200',
}

const SMS_TEMPLATE = /^[a-zA-Z0-9_-]{1,100}$/

function isEmailSender(value: unknown): value is RegistrationSettings['emailSender'] {
  return value === 'auth' || value === 'order' || value === 'noreply'
}

export function getRegistrationOtpSecret(): string {
  return process.env.REGISTRATION_OTP_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || ''
}

function settingsEncryptionKey(): Buffer | null {
  const secret = process.env.REGISTRATION_SETTINGS_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || ''
  return secret.length >= 32 ? createHash('sha256').update(`registration-settings:v1\0${secret}`).digest() : null
}

function encryptSetting(value: string, purpose: string): string {
  const key = settingsEncryptionKey()
  if (!key) throw new ApiInputError('برای ذخیرهٔ اطلاعات محرمانه، کلید رمزنگاری تنظیمات را در محیط سرور تنظیم کنید.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(purpose))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

function decryptSetting(value: string, purpose: string): string | null {
  const key = settingsEncryptionKey()
  if (!key) return null
  try {
    const [version, encodedIv, encodedTag, encodedValue, extra] = value.split('.')
    if (version !== 'v1' || extra !== undefined || !encodedIv || !encodedTag || !encodedValue) return null
    const iv = Buffer.from(encodedIv, 'base64url'), tag = Buffer.from(encodedTag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(encodedValue, 'base64url')), decipher.final()]).toString('utf8')
  } catch { return null }
}

function decryptedSmsHeaders(settings: RegistrationSettings): RegistrationSmsHeader[] | null {
  if (!settings.smsHeadersEncrypted) return settings.smsHeaders ?? []
  const value = decryptSetting(settings.smsHeadersEncrypted, 'sms-headers')
  if (value === null) return null
  try {
    const headers: unknown = JSON.parse(value)
    if (!Array.isArray(headers) || !headers.every(header => header && typeof header.name === 'string' && typeof header.value === 'string')) return null
    return headers
  } catch { return null }
}

export function readRegistrationSmsHeaders(settings: RegistrationSettings): RegistrationSmsHeader[] {
  return decryptedSmsHeaders(settings) ?? []
}

export function resolveRegistrationSmsApiKey(settings: RegistrationSettings): string {
  if (settings.smsApiKeyEncrypted) return decryptSetting(settings.smsApiKeyEncrypted, 'sms-api-key') ?? ''
  return (settings.smsProvider ?? 'kavenegar') === 'kavenegar' ? process.env.REGISTRATION_KAVENEGAR_API_KEY?.trim() ?? '' : ''
}

function smsSecretsReadable(settings: RegistrationSettings): boolean {
  return (!settings.smsApiKeyEncrypted || decryptSetting(settings.smsApiKeyEncrypted, 'sms-api-key') !== null)
    && decryptedSmsHeaders(settings) !== null
}

function customSmsConfigured(settings: RegistrationSettings): boolean {
  try {
    validateCustomSmsConfiguration(settings)
    const fields = [settings.smsApiUrl, settings.smsBodyTemplate, ...readRegistrationSmsHeaders(settings).map(header => header.value)]
    return !fields.some(value => value.includes('{{apiKey}}')) || Boolean(resolveRegistrationSmsApiKey(settings))
  } catch { return false }
}

export function getRegistrationDeliveryReadiness(settings: RegistrationSettings) {
  return {
    emailConfigured: isEmailSender(settings.emailSender) && Boolean(process.env.REGISTRATION_EMAIL_API_KEY?.trim()),
    smsConfigured: smsSecretsReadable(settings) && ((settings.smsProvider ?? 'kavenegar') === 'custom'
      ? customSmsConfigured(settings)
      : SMS_TEMPLATE.test(settings.smsTemplate) && Boolean(resolveRegistrationSmsApiKey(settings))),
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
  const { smsApiKeyEncrypted, smsHeadersEncrypted: _encryptedHeaders, smsHeaders: _headers, ...publicSettings } = settings
  return {
    settings: {
      ...publicSettings,
      smsHeaders: readRegistrationSmsHeaders(settings).map(({ name, value }) => ({ name, value: '', configured: Boolean(value) })),
    } satisfies RegistrationPublicSettings,
    readiness: {
      ...getRegistrationDeliveryReadiness(settings),
      otpConfigured: getRegistrationOtpSecret().length >= 32,
      smsKeyConfigured: Boolean(resolveRegistrationSmsApiKey(settings)),
      smsStoredKeyConfigured: Boolean(smsApiKeyEncrypted),
      smsEnvironmentKeyConfigured: Boolean(process.env.REGISTRATION_KAVENEGAR_API_KEY?.trim()),
      settingsEncryptionConfigured: Boolean(settingsEncryptionKey()),
      smsSecretsReadable: smsSecretsReadable(settings),
    },
  }
}

export type RegistrationAdminSnapshot = ReturnType<typeof registrationAdminSnapshot>

export async function readRegistrationSettings(db: Pick<typeof prisma, 'registrationSettings'> = prisma): Promise<RegistrationSettings> {
  const row = await db.registrationSettings.findUnique({ where: { id: 1 } })
  if (!row) return { ...defaults, smsHeaders: [] }
  const { id: _id, updatedAt: _updatedAt, emailSender, ...settings } = row
  const result: RegistrationSettings = {
    ...defaults,
    ...settings,
    emailSender: isEmailSender(emailSender) ? emailSender : defaults.emailSender,
    smsProvider: settings.smsProvider === 'custom' ? 'custom' : 'kavenegar',
    smsMethod: settings.smsMethod === 'GET' ? 'GET' : 'POST',
    smsBodyFormat: settings.smsBodyFormat === 'form' ? 'form' : 'json',
    smsHeaders: [],
  }
  return { ...result, smsHeaders: readRegistrationSmsHeaders(result) }
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number) {
  const number = integerField(value, label, minimum)
  if (number > maximum) throw new ApiInputError(`${label} از حداکثر مجاز بیشتر است.`)
  return number
}

function parseSmsHeaders(value: unknown, current: RegistrationSettings, clear: boolean) {
  if (clear) return { smsHeaders: [], smsHeadersEncrypted: null }
  if (value === undefined) return { smsHeaders: readRegistrationSmsHeaders(current), smsHeadersEncrypted: current.smsHeadersEncrypted }
  if (!Array.isArray(value) || value.length > 20) throw new ApiInputError('حداکثر ۲۰ هدر پیامک قابل تعریف است.')
  const previous = readRegistrationSmsHeaders(current)
  // A lost encryption key must not erase the saved configuration during an unrelated edit.
  if (!value.length && current.smsHeadersEncrypted && decryptedSmsHeaders(current) === null) {
    return { smsHeaders: [], smsHeadersEncrypted: current.smsHeadersEncrypted }
  }
  const names = new Set<string>()
  const forbidden = /^(?:host|cookie|content-length|connection|transfer-encoding|expect|upgrade|te|trailer|forwarded|x-forwarded-.*|proxy-.*|__proto__|constructor|prototype)$/i
  const smsHeaders: RegistrationSmsHeader[] = value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ApiInputError('اطلاعات هدر پیامک نامعتبر است.')
    const name = optionalText(entry.name, 'نام هدر پیامک', 100) ?? ''
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || forbidden.test(name) || names.has(name.toLowerCase())) {
      throw new ApiInputError('نام هدر پیامک نامعتبر، تکراری یا رزروشده است.')
    }
    names.add(name.toLowerCase())
    const incoming = optionalText(entry.value, 'مقدار هدر پیامک', 4_000) ?? ''
    const savedValue = incoming || previous.find(header => header.name.toLowerCase() === name.toLowerCase())?.value
    if (!savedValue || [...savedValue].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new ApiInputError('برای هدر جدید یا تغییرنام‌یافته، مقدار معتبر وارد کنید.')
    }
    return { name, value: savedValue }
  })
  if (JSON.stringify(smsHeaders) === JSON.stringify(previous)) return { smsHeaders, smsHeadersEncrypted: current.smsHeadersEncrypted }
  return { smsHeaders, smsHeadersEncrypted: smsHeaders.length ? encryptSetting(JSON.stringify(smsHeaders), 'sms-headers') : null }
}

export function parseRegistrationSettings(body: Record<string, unknown>, current: RegistrationSettings = defaults): RegistrationSettings {
  const emailSender = body.emailSender
  if (!isEmailSender(emailSender)) throw new ApiInputError('فرستندهٔ ایمیل نامعتبر است.')
  const smsTemplate = optionalText(body.smsTemplate, 'نام الگوی کاوه‌نگار', 100) ?? ''
  if (smsTemplate && !SMS_TEMPLATE.test(smsTemplate)) throw new ApiInputError('نام الگوی کاوه‌نگار باید با حروف و اعداد انگلیسی، خط تیره یا زیرخط نوشته شود.')
  const smsProvider = body.smsProvider ?? current.smsProvider ?? 'kavenegar'
  const smsMethod = body.smsMethod ?? current.smsMethod ?? 'POST'
  const smsBodyFormat = body.smsBodyFormat ?? current.smsBodyFormat ?? 'json'
  if (smsProvider !== 'kavenegar' && smsProvider !== 'custom') throw new ApiInputError('سرویس پیامک نامعتبر است.')
  if (smsMethod !== 'POST' && smsMethod !== 'GET') throw new ApiInputError('روش ارسال پیامک نامعتبر است.')
  if (smsBodyFormat !== 'json' && smsBodyFormat !== 'form') throw new ApiInputError('قالب درخواست پیامک نامعتبر است.')
  const clearKey = body.clearSmsApiKey === undefined ? false : booleanField(body.clearSmsApiKey, 'حذف کلید پیامک')
  const clearHeaders = body.clearSmsHeaders === undefined ? false : booleanField(body.clearSmsHeaders, 'حذف هدرهای پیامک')
  const apiKey = body.smsApiKey === undefined ? '' : optionalText(body.smsApiKey, 'کلید API پیامک', 2_048) ?? ''
  if (clearKey && apiKey) throw new ApiInputError('برای جایگزینی کلید، گزینهٔ حذف کلید را غیرفعال کنید.')
  const smsApiKeyEncrypted = clearKey ? null : apiKey ? encryptSetting(apiKey, 'sms-api-key') : current.smsApiKeyEncrypted
  const headers = parseSmsHeaders(body.smsHeaders, current, clearHeaders)

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
    smsProvider,
    smsApiUrl: optionalText(body.smsApiUrl ?? current.smsApiUrl, 'نشانی API پیامک', 2_048) ?? '',
    smsMethod,
    smsBodyFormat,
    smsBodyTemplate: optionalText(body.smsBodyTemplate ?? current.smsBodyTemplate, 'بدنهٔ درخواست پیامک', 16_384) ?? '{}',
    ...headers,
    smsApiKeyEncrypted,
    smsSuccessPath: optionalText(body.smsSuccessPath ?? current.smsSuccessPath, 'مسیر پاسخ موفق', 200) ?? '',
    smsSuccessValue: optionalText(body.smsSuccessValue ?? current.smsSuccessValue, 'مقدار پاسخ موفق', 500) ?? '',
  }
  const resolvedKey = resolveRegistrationSmsApiKey(settings)
  if (resolvedKey.length >= 8 && [settings.smsApiUrl, settings.smsBodyTemplate].some(value => value.includes(resolvedKey))) {
    throw new ApiInputError('کلید API را در فیلد کلید وارد کنید و در نشانی یا بدنه از {{apiKey}} استفاده کنید.')
  }
  if (smsProvider === 'custom' && (settings.smsApiUrl || settings.smsEnabled)) {
    try { validateCustomSmsConfiguration(settings) }
    catch { throw new ApiInputError('تنظیمات API پیامک معتبر نیست. نشانی امن، قالب درخواست، هدرها و شرط موفقیت را بررسی کنید.') }
  }
  const availability = getRegistrationAvailability(settings)
  if ((settings.emailEnabled || settings.smsEnabled) && getRegistrationOtpSecret().length < 32) {
    throw new ApiInputError('برای فعال‌سازی ثبت‌نام، ابتدا کلید تأیید کد را در محیط سرور تنظیم کنید.')
  }
  if (settings.emailEnabled && !availability.emailEnabled) throw new ApiInputError('برای فعال‌سازی ایمیل، ابتدا کلید سرویس ایمیل را در محیط سرور تنظیم کنید.')
  if (settings.smsEnabled && !availability.smsEnabled) throw new ApiInputError('برای فعال‌سازی پیامک، تنظیمات سرویس، اطلاعات محرمانه و الگوی ارسال را کامل کنید.')
  return settings
}

export async function saveRegistrationSettings(settings: RegistrationSettings): Promise<RegistrationSettings> {
  const { version, smsHeaders: _headers, ...values } = settings
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
