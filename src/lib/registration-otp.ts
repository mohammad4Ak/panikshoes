import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import bcrypt from 'bcryptjs'
import type { Prisma } from '@prisma/client'
import { ApiInputError, emailField, passwordField, textField } from './api-input'
import { caseInsensitiveEmailFilter, normalizeContactDigits, normalizeLoginPhone } from './customer-contact'
import { customerPhoneField, customerPostalCodeField } from './customer-contact-input'
import { prisma } from './prisma'
import { sendRegistrationCode } from './registration-delivery'
import {
  getRegistrationAvailability, getRegistrationOtpSecret, readRegistrationSettings,
  type RegistrationChannel, type RegistrationSettings,
} from './registration-settings'
import { isSameOriginRequest } from './request-origin'

const hour = 60 * 60 * 1000
const retention = 24 * hour
const maxBodySize = 8 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const emailLocalPart = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/
const emailDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const unavailable = 'این روش ثبت‌نام در حال حاضر در دسترس نیست.'
const existingAccount = 'برای این ایمیل یا شمارهٔ موبایل حساب وجود دارد. وارد حساب شوید.'

class InvalidRegistrationCodeError extends ApiInputError {
  readonly code = 'INVALID_REGISTRATION_CODE'

  constructor() {
    super('کد تأیید نامعتبر است یا اعتبار آن به پایان رسیده است.')
  }
}

class RegistrationError extends ApiInputError {
  constructor(message: string, status: number, readonly retryAt: Date) {
    super(message, status)
  }
}

export function registrationResponse(body: object, status = 200, retryAt?: Date) {
  const now = new Date()
  const headers = new Headers({ 'Cache-Control': 'private, no-store', Date: now.toUTCString() })
  if (retryAt) headers.set('Retry-After', String(Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000))))
  return Response.json(body, { status, headers })
}

export function registrationErrorResponse(error: unknown) {
  if (error instanceof InvalidRegistrationCodeError) {
    return registrationResponse({ error: error.message, code: error.code }, error.status)
  }
  if (error instanceof RegistrationError) {
    return registrationResponse({ error: error.message, retryAt: error.retryAt }, error.status, error.retryAt)
  }
  if (error instanceof ApiInputError) return registrationResponse({ error: error.message }, error.status)
  return registrationResponse({ error: 'خطا در ثبت‌نام. دوباره تلاش کنید.' }, 500)
}

export async function readRegistrationBody(request: Request): Promise<Record<string, unknown>> {
  if (!isSameOriginRequest(request)) throw new ApiInputError('مبدأ درخواست نامعتبر است.', 403)
  const reader = request.body?.getReader()
  if (!reader) throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')

  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodySize) {
        void reader.cancel().catch(() => undefined)
        throw new ApiInputError('حجم درخواست بیش از حد مجاز است.', 413)
      }
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiInputError) throw error
    throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')
  } finally {
    reader.releaseLock()
  }
}

function destinationFor(channel: RegistrationChannel, value: unknown): string {
  if (channel === 'email') {
    const email = emailField(value)
    const [local, domain] = email.split('@')
    // Submit a single mailbox address to the provider and rate-limit that same address.
    if (local.length > 64 || !emailLocalPart.test(local) || !emailDomain.test(domain)) {
      throw new ApiInputError('ایمیل نامعتبر است.')
    }
    return email
  }
  const phone = normalizeLoginPhone(value)
  if (!phone) throw new ApiInputError('شمارهٔ موبایل نامعتبر است.')
  return phone
}

function digest(secret: string, ...parts: string[]): string {
  return createHmac('sha256', secret).update(JSON.stringify(['registration-otp:v1', ...parts])).digest('hex')
}

async function lockRegistrationDestination(tx: Prisma.TransactionClient, secret: string, channel: RegistrationChannel, destination: string) {
  const key = digest(secret, 'send-destination', channel, destination)
  // Serialize code issuance and account creation for the same normalized identity.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  return key
}

function findRegistrationAccount(tx: Prisma.TransactionClient, channel: RegistrationChannel, destination: string) {
  return tx.user.findFirst({
    where: channel === 'email' ? { email: caseInsensitiveEmailFilter(destination) } : { loginPhone: destination },
    select: { id: true },
  })
}

function networkKey(request: Request): string {
  // Vercel overwrites this header with its own client IP. Unconfigured hosts
  // share a fallback bucket, so forwarding headers cannot bypass the limit.
  const ip = process.env.VERCEL === '1' ? request.headers.get('x-vercel-forwarded-for')?.trim() : ''
  return ip && isIP(ip) ? ip.toLowerCase() : 'unattributed'
}

function isChannelEnabled(settings: RegistrationSettings, channel: RegistrationChannel) {
  const availability = getRegistrationAvailability(settings)
  return channel === 'email' ? availability.emailEnabled : availability.smsEnabled
}

async function takeRateLimit(db: Pick<Prisma.TransactionClient, '$queryRaw'>, key: string, limit: number, now: Date) {
  const cutoff = new Date(now.getTime() - hour)
  const [row] = await db.$queryRaw<{ count: number; windowStartedAt: Date }[]>`
    INSERT INTO "RegistrationRateLimit" ("key", "windowStartedAt", "count")
    VALUES (${key}, ${now}, 1)
    ON CONFLICT ("key") DO UPDATE SET
      "windowStartedAt" = CASE WHEN "RegistrationRateLimit"."windowStartedAt" <= ${cutoff}
        THEN EXCLUDED."windowStartedAt" ELSE "RegistrationRateLimit"."windowStartedAt" END,
      "count" = CASE WHEN "RegistrationRateLimit"."windowStartedAt" <= ${cutoff}
        THEN 1 ELSE LEAST("RegistrationRateLimit"."count" + 1, ${limit + 1}) END
    RETURNING "count", "windowStartedAt"
  `
  if (row.count > limit) {
    throw new RegistrationError('تعداد درخواست‌ها بیش از حد مجاز است. بعداً دوباره تلاش کنید.', 429,
      new Date(row.windowStartedAt.getTime() + hour))
  }
  return row.count
}

async function cleanExpiredRecords(now: Date) {
  const cutoff = new Date(now.getTime() - retention)
  // Run at most once per active sending window. Cleanup is independent of the current request.
  await Promise.allSettled([
    prisma.registrationChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.registrationRateLimit.deleteMany({ where: { windowStartedAt: { lt: cutoff } } }),
  ])
}

export async function requestRegistrationCode(request: Request, body: Record<string, unknown>) {
  const channel = body.channel
  if (channel !== 'email' && channel !== 'sms') throw new ApiInputError('روش دریافت کد نامعتبر است.')
  const destination = destinationFor(channel, body.destination)
  const settings = await readRegistrationSettings()
  if (!isChannelEnabled(settings, channel)) throw new ApiInputError(unavailable, 503)
  const secret = getRegistrationOtpSecret()
  const now = new Date()
  await takeRateLimit(prisma, digest(secret, 'send-network', networkKey(request)), settings.ipHourlyLimit, now)
  const sends = await takeRateLimit(prisma, digest(secret, 'send-global'), 300, now)
  if (sends === 1) await cleanExpiredRecords(now)

  const issued = await prisma.$transaction(async (tx) => {
    const destinationKey = await lockRegistrationDestination(tx, secret, channel, destination)
    const createdAt = new Date()
    await takeRateLimit(tx, destinationKey, settings.destinationHourlyLimit, createdAt)
    // Return from the transaction so a duplicate lookup still consumes the destination quota.
    if (await findRegistrationAccount(tx, channel, destination)) return null
    const where = { channel_destination: { channel, destination } }
    const previous = await tx.registrationChallenge.findUnique({ where, select: { resendAt: true } })
    if (previous && previous.resendAt > createdAt) {
      throw new RegistrationError('برای درخواست مجدد کد کمی صبر کنید.', 429, previous.resendAt)
    }
    const id = randomUUID()
    const code = randomInt(1_000_000).toString().padStart(6, '0')
    const challenge = {
      id, codeDigest: digest(secret, 'code', id, channel, destination, code), createdAt,
      expiresAt: new Date(createdAt.getTime() + settings.expiryMinutes * 60_000),
      resendAt: new Date(createdAt.getTime() + settings.resendSeconds * 1000),
      attempts: 0, consumedAt: null,
    }
    await tx.registrationChallenge.upsert({ where, create: { ...challenge, channel, destination }, update: challenge })
    return { id, code, expiresAt: challenge.expiresAt, resendAt: challenge.resendAt }
  })
  if (!issued) throw new ApiInputError(existingAccount, 409)
  const { id, code, expiresAt, resendAt } = issued

  try {
    await sendRegistrationCode(settings, { channel, destination, code, expiresInMinutes: settings.expiryMinutes })
  } catch {
    await prisma.registrationChallenge.updateMany({
      where: { id, consumedAt: null }, data: { consumedAt: new Date() },
    }).catch(() => undefined)
    throw new RegistrationError('ارسال کد انجام نشد. پس از پایان مهلت دوباره تلاش کنید.', 502, resendAt)
  }
  return { challengeId: id, expiresAt, resendAt }
}

export async function verifyRegistrationCode(request: Request, body: Record<string, unknown>) {
  const { challengeId } = body
  const code = typeof body.code === 'string' ? normalizeContactDigits(body.code.trim()) : ''
  if (typeof challengeId !== 'string' || !uuid.test(challengeId) || !/^\d{6}$/.test(code)) {
    throw new InvalidRegistrationCodeError()
  }
  const name = textField(body.name, 'نام', 200)
  const password = passwordField(body.password)
  const phone = customerPhoneField(body.phone)
  const postalCode = customerPostalCodeField(body.postalCode)
  const settings = await readRegistrationSettings()
  const availability = getRegistrationAvailability(settings)
  if (!availability.emailEnabled && !availability.smsEnabled) throw new ApiInputError(unavailable, 503)
  const secret = getRegistrationOtpSecret()
  const now = new Date()
  await takeRateLimit(prisma, digest(secret, 'verify-network', networkKey(request)), settings.ipHourlyLimit * settings.maxAttempts, now)
  await takeRateLimit(prisma, digest(secret, 'verify-global'), 1500, now)
  const challenge = await prisma.registrationChallenge.findUnique({ where: { id: challengeId } })
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= settings.maxAttempts) {
    throw new InvalidRegistrationCodeError()
  }
  const { channel, destination } = challenge
  if ((channel !== 'email' && channel !== 'sms') || !isChannelEnabled(settings, channel)) {
    throw new InvalidRegistrationCodeError()
  }
  const liveChallenge = (time: Date) => ({
    id: challengeId, codeDigest: challenge.codeDigest, consumedAt: null,
    expiresAt: { gt: time }, attempts: { lt: settings.maxAttempts },
  })
  const expected = Buffer.from(challenge.codeDigest, 'hex')
  const received = Buffer.from(digest(secret, 'code', challengeId, channel, destination, code), 'hex')
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    await prisma.registrationChallenge.updateMany({ where: liveChallenge(new Date()), data: { attempts: { increment: 1 } } })
    throw new InvalidRegistrationCodeError()
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockRegistrationDestination(tx, secret, channel, destination)
    const verifiedAt = new Date()
    const claimed = await tx.registrationChallenge.updateMany({
      where: liveChallenge(verifiedAt), data: { consumedAt: verifiedAt },
    })
    if (claimed.count !== 1) return { outcome: 'invalid' } as const
    if (await findRegistrationAccount(tx, channel, destination)) return { outcome: 'existing' } as const
    const hashedPassword = await bcrypt.hash(password, 10)
    const identity = channel === 'email'
      ? { email: destination, emailVerifiedAt: verifiedAt }
      : { loginPhone: destination, phoneVerifiedAt: verifiedAt }
    // Keep the challenge consumed even if another account write wins the unique constraint.
    const [user] = await tx.user.createManyAndReturn({
      data: { ...identity, name, phone, postalCode, password: hashedPassword, role: 'USER' },
      skipDuplicates: true,
      select: { id: true, name: true, email: true, loginPhone: true },
    })
    return user ? { outcome: 'created', user } as const : { outcome: 'existing' } as const
  })
  if (result.outcome === 'invalid') throw new InvalidRegistrationCodeError()
  if (result.outcome === 'existing') throw new ApiInputError(existingAccount, 409)
  return result.user
}
