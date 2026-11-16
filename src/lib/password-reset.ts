import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import bcrypt from 'bcryptjs'
import type { Prisma } from '@prisma/client'
import { ApiInputError, emailField, passwordField } from './api-input'
import { caseInsensitiveEmailFilter, normalizeContactDigits, normalizeLoginPhone } from './customer-contact'
import { prisma } from './prisma'
import { sendPasswordResetCode } from './registration-delivery'
import { getRegistrationOtpSecret, readRegistrationSettings, type RegistrationChannel, type RegistrationSettings } from './registration-settings'
import { getPasswordResetAvailability, lockPasswordResetSettings, readPasswordResetSettings, type PasswordResetSettings } from './password-reset-settings'
import { isSameOriginRequest } from './request-origin'

const hour = 60 * 60 * 1000
const maxBodyBytes = 8 * 1024
const maxVersion = 2_147_483_647
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const emailLocalPart = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/
const emailDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const unavailable = 'بازیابی رمز عبور با این روش در حال حاضر در دسترس نیست.'
export const passwordResetRequestMessage = 'اگر حساب فعالی با این مشخصات وجود داشته باشد، کد بازیابی برای آن ارسال می‌شود.'

class InvalidPasswordResetCodeError extends ApiInputError {
  readonly code = 'INVALID_PASSWORD_RESET_CODE'
  constructor() { super('کد بازیابی نامعتبر است یا اعتبار آن به پایان رسیده است.') }
}

class PasswordResetRateError extends ApiInputError {
  constructor(readonly retryAt: Date) { super('تعداد درخواست‌ها بیش از حد مجاز است. بعداً دوباره تلاش کنید.', 429) }
}

export function passwordResetResponse(body: object, status = 200, retryAt?: Date) {
  const now = new Date()
  const headers = new Headers({ 'Cache-Control': 'private, no-store', Vary: 'Cookie', Date: now.toUTCString(), 'X-Content-Type-Options': 'nosniff' })
  if (retryAt) headers.set('Retry-After', String(Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000))))
  return Response.json(body, { status, headers })
}

export function passwordResetErrorResponse(error: unknown) {
  if (error instanceof InvalidPasswordResetCodeError) return passwordResetResponse({ error: error.message, code: error.code }, error.status)
  if (error instanceof PasswordResetRateError) return passwordResetResponse({ error: error.message, retryAt: error.retryAt.toISOString() }, error.status, error.retryAt)
  if (error instanceof ApiInputError) return passwordResetResponse({ error: error.message }, error.status)
  return passwordResetResponse({ error: 'بازیابی رمز عبور انجام نشد؛ دوباره تلاش کنید.' }, 500)
}

export async function readPasswordResetBody(request: Request): Promise<Record<string, unknown>> {
  if (!isSameOriginRequest(request)) throw new ApiInputError('مبدأ درخواست نامعتبر است.', 403)
  if (Number(request.headers.get('content-length')) > maxBodyBytes) throw new ApiInputError('حجم درخواست بیش از حد مجاز است.', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBodyBytes) { void reader.cancel().catch(() => undefined); throw new ApiInputError('حجم درخواست بیش از حد مجاز است.', 413) }
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiInputError) throw error
    throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')
  } finally { reader.releaseLock() }
}

function destinationFor(channel: RegistrationChannel, value: unknown): string {
  if (channel === 'email') {
    const email = emailField(value)
    const [local, domain] = email.split('@')
    if (local.length > 64 || !emailLocalPart.test(local) || !emailDomain.test(domain)) throw new ApiInputError('ایمیل نامعتبر است.')
    return email
  }
  const phone = normalizeLoginPhone(value)
  if (!phone) throw new ApiInputError('شمارهٔ موبایل نامعتبر است.')
  return phone
}

function digest(secret: string, ...parts: string[]): string {
  return createHmac('sha256', secret).update(JSON.stringify(['password-reset:v1', ...parts])).digest('hex')
}

function networkKey(request: Request): string {
  // Only the provider-overwritten Vercel header is trusted. Other hosts share a
  // fallback quota rather than allowing arbitrary forwarding headers to evade it.
  const ip = process.env.VERCEL === '1' ? request.headers.get('x-vercel-forwarded-for')?.trim() : ''
  return ip && isIP(ip) ? ip.toLowerCase() : 'unattributed'
}

function identityWhere(channel: RegistrationChannel, destination: string): Prisma.UserWhereInput {
  return channel === 'email' ? { email: caseInsensitiveEmailFilter(destination) }
    : { loginPhone: destination, phoneVerifiedAt: { not: null } }
}

function channelEnabled(settings: PasswordResetSettings, delivery: RegistrationSettings, channel: RegistrationChannel) {
  const availability = getPasswordResetAvailability(settings, delivery)
  return channel === 'email' ? availability.emailEnabled : availability.smsEnabled
}

async function lockDestination(tx: Prisma.TransactionClient, secret: string, channel: RegistrationChannel, destination: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${digest(secret, 'destination-lock', channel, destination)}, 0))`
}

type RateResult = { allowed: boolean; retryAt: Date; count: number }
async function takeRate(db: Pick<Prisma.TransactionClient, '$queryRaw'>, key: string, limit: number, now: Date): Promise<RateResult> {
  const cutoff = new Date(now.getTime() - hour)
  const [row] = await db.$queryRaw<{ count: number; windowStartedAt: Date }[]>`
    INSERT INTO "PasswordResetRateLimit" ("key", "windowStartedAt", "count")
    VALUES (${key}, ${now}, 1)
    ON CONFLICT ("key") DO UPDATE SET
      "windowStartedAt" = CASE WHEN "PasswordResetRateLimit"."windowStartedAt" <= ${cutoff}
        THEN EXCLUDED."windowStartedAt" ELSE "PasswordResetRateLimit"."windowStartedAt" END,
      "count" = CASE WHEN "PasswordResetRateLimit"."windowStartedAt" <= ${cutoff}
        THEN 1 ELSE LEAST("PasswordResetRateLimit"."count" + 1, ${limit + 1}) END
    RETURNING "count", "windowStartedAt"
  `
  return { allowed: row.count <= limit, retryAt: new Date(row.windowStartedAt.getTime() + hour), count: row.count }
}

function requireRate(result: RateResult) { if (!result.allowed) throw new PasswordResetRateError(result.retryAt) }

async function networkRates(request: Request, secret: string, settings: PasswordResetSettings, purpose: 'send' | 'verify') {
  const now = new Date()
  requireRate(await takeRate(prisma, digest(secret, `${purpose}-network`, networkKey(request)), settings.ipHourlyLimit * (purpose === 'verify' ? settings.maxAttempts : 1), now))
  const global = await takeRate(prisma, digest(secret, `${purpose}-global`), purpose === 'verify' ? 1500 : 300, now)
  requireRate(global)
  if (purpose === 'send' && global.count === 1) {
    const cutoff = new Date(now.getTime() - 24 * hour)
    await Promise.allSettled([
      prisma.passwordResetChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      prisma.passwordResetRateLimit.deleteMany({ where: { windowStartedAt: { lt: cutoff } } }),
    ])
  }
}

export async function passwordResetCapabilities() {
  const [settings, delivery] = await Promise.all([readPasswordResetSettings(), readRegistrationSettings()])
  return { ...getPasswordResetAvailability(settings, delivery), expiryMinutes: settings.expiryMinutes, resendSeconds: settings.resendSeconds }
}

export async function requestPasswordResetCode(request: Request, body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !['channel', 'destination'].includes(key))) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  const { channel } = body
  if (channel !== 'email' && channel !== 'sms') throw new ApiInputError('روش دریافت کد نامعتبر است.')
  const deliveryChannel: RegistrationChannel = channel
  const destination = destinationFor(channel, body.destination)
  const [settings, delivery] = await Promise.all([readPasswordResetSettings(), readRegistrationSettings()])
  if (!channelEnabled(settings, delivery, channel)) throw new ApiInputError(unavailable, 503)
  const secret = getRegistrationOtpSecret()
  await networkRates(request, secret, settings, 'send')
  const issued = await prisma.$transaction(async tx => {
    await lockPasswordResetSettings(tx)
    const currentSettings = await readPasswordResetSettings(tx)
    const currentDelivery = await readRegistrationSettings(tx)
    if (!channelEnabled(currentSettings, currentDelivery, channel)) return { outcome: 'disabled' } as const
    await lockDestination(tx, secret, channel, destination)
    const now = new Date()
    const rate = await takeRate(tx, digest(secret, 'send-destination', channel, destination), currentSettings.destinationHourlyLimit, now)
    // Expected failures return rather than throw so their quota increments commit.
    if (!rate.allowed) return { outcome: 'rate', retryAt: rate.retryAt } as const
    const where = { channel_destination: { channel, destination } }
    const previous = await tx.passwordResetChallenge.findUnique({ where, select: { resendAt: true } })
    if (previous && previous.resendAt > now) return { outcome: 'rate', retryAt: previous.resendAt } as const
    const user = await tx.user.findFirst({ where: { ...identityWhere(channel, destination), isActive: true }, select: { id: true, authVersion: true } })
    const id = randomUUID()
    const code = randomInt(1_000_000).toString().padStart(6, '0')
    const values = {
      id, codeDigest: digest(secret, 'code', id, channel, destination, code), userId: user?.id ?? null, authVersion: user?.authVersion ?? null,
      settingsVersion: currentSettings.version, deliveryVersion: currentDelivery.version, attempts: 0,
      expiresAt: new Date(now.getTime() + currentSettings.expiryMinutes * 60_000), resendAt: new Date(now.getTime() + currentSettings.resendSeconds * 1000),
      consumedAt: null, deliveredAt: null, createdAt: now,
    }
    await tx.passwordResetChallenge.upsert({ where, create: { ...values, channel, destination }, update: values })
    return { outcome: 'issued', values, code, currentSettings, currentDelivery } as const
  }, { maxWait: 5000, timeout: 10000 })
  if (issued.outcome === 'disabled') throw new ApiInputError(unavailable, 503)
  if (issued.outcome === 'rate') throw new PasswordResetRateError(issued.retryAt)
  const { values, code, currentSettings, currentDelivery } = issued
  let deliveryStarted = false
  // A tracked Next after callback is scheduled for every issued response. The
  // response never waits for a provider, so provider timing cannot reveal users.
  async function deliver() {
    if (deliveryStarted) return
    deliveryStarted = true
    try {
      if (!values.userId) return
      const live = await prisma.$transaction(async tx => {
        await lockPasswordResetSettings(tx)
        const [reset, transport] = await Promise.all([readPasswordResetSettings(tx), readRegistrationSettings(tx)])
        if (reset.version !== values.settingsVersion || transport.version !== values.deliveryVersion || !channelEnabled(reset, transport, deliveryChannel)) return false
        const challenge = await tx.passwordResetChallenge.findUnique({ where: { id: values.id } })
        if (!challenge || challenge.consumedAt || challenge.deliveredAt || challenge.expiresAt <= new Date()) return false
        return !!await tx.user.findFirst({ where: { id: values.userId!, authVersion: values.authVersion!, isActive: true, ...identityWhere(deliveryChannel, destination) }, select: { id: true } })
      }, { maxWait: 5000, timeout: 10000 })
      if (!live) return
      await sendPasswordResetCode(currentDelivery, { channel: deliveryChannel, destination, code, expiresInMinutes: currentSettings.expiryMinutes })
      await prisma.passwordResetChallenge.updateMany({ where: { id: values.id, consumedAt: null, deliveredAt: null, expiresAt: { gt: new Date() } }, data: { deliveredAt: new Date() } })
    } catch {
      // Provider exceptions may contain credentials or recipients. Neither they
      // nor a delivery failure become an account-existence signal to the caller.
      await prisma.passwordResetChallenge.updateMany({ where: { id: values.id, consumedAt: null }, data: { consumedAt: new Date() } }).catch(() => undefined)
    }
  }
  return { result: { challengeId: values.id, expiresAt: values.expiresAt.toISOString(), resendAt: values.resendAt.toISOString(), message: passwordResetRequestMessage }, deliver }
}

export async function completePasswordReset(request: Request, body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !['challengeId', 'code', 'newPassword', 'confirmPassword'].includes(key))) throw new ApiInputError('اطلاعات درخواست نامعتبر است.')
  const code = typeof body.code === 'string' ? normalizeContactDigits(body.code.trim()) : ''
  const { challengeId } = body
  if (typeof challengeId !== 'string' || !uuid.test(challengeId) || !/^\d{6}$/.test(code)) throw new InvalidPasswordResetCodeError()
  const newPassword = passwordField(body.newPassword, 'رمز جدید')
  if (body.confirmPassword !== newPassword) throw new ApiInputError('تکرار رمز عبور با رمز جدید یکسان نیست.')
  const [settings, delivery] = await Promise.all([readPasswordResetSettings(), readRegistrationSettings()])
  const availability = getPasswordResetAvailability(settings, delivery)
  if (!availability.emailEnabled && !availability.smsEnabled) throw new ApiInputError(unavailable, 503)
  const secret = getRegistrationOtpSecret()
  await networkRates(request, secret, settings, 'verify')
  const outcome = await prisma.$transaction(async tx => {
    await lockPasswordResetSettings(tx)
    const currentSettings = await readPasswordResetSettings(tx)
    const currentDelivery = await readRegistrationSettings(tx)
    const initial = await tx.passwordResetChallenge.findUnique({ where: { id: challengeId } })
    if (!initial || (initial.channel !== 'email' && initial.channel !== 'sms')) return { outcome: 'invalid' } as const
    const channel = initial.channel
    await lockDestination(tx, secret, channel, initial.destination)
    const challenge = await tx.passwordResetChallenge.findUnique({ where: { id: challengeId } })
    const now = new Date()
    if (!challenge) return { outcome: 'invalid' } as const
    const rate = await takeRate(tx, digest(secret, 'verify-destination', channel, challenge.destination), currentSettings.destinationHourlyLimit * currentSettings.maxAttempts, now)
    if (!rate.allowed) return { outcome: 'rate', retryAt: rate.retryAt } as const
    const live = { id: challengeId, codeDigest: challenge.codeDigest, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: currentSettings.maxAttempts } }
    const expected = Buffer.from(challenge.codeDigest, 'hex')
    const received = Buffer.from(digest(secret, 'code', challengeId, channel, challenge.destination, code), 'hex')
    const digestMatches = expected.length === received.length && timingSafeEqual(expected, received)
    // Existing opaque challenges follow the same quota/hash/CAS path even when
    // consumed or delivery failed. A failed provider must not turn verification
    // latency into an account-existence oracle.
    const liveSettings = challenge.settingsVersion === currentSettings.version && challenge.deliveryVersion === currentDelivery.version && channelEnabled(currentSettings, currentDelivery, channel)
    if (!liveSettings || challenge.consumedAt || challenge.expiresAt <= now || challenge.attempts >= currentSettings.maxAttempts ||
        !digestMatches || !challenge.deliveredAt || !challenge.userId || challenge.authVersion === null) {
      await tx.passwordResetChallenge.updateMany({ where: live, data: { attempts: { increment: 1 } } })
      return { outcome: 'invalid' } as const
    }
    const user = await tx.user.findFirst({ where: { id: challenge.userId, isActive: true, authVersion: challenge.authVersion, ...identityWhere(channel, challenge.destination) }, select: { id: true, password: true, authVersion: true } })
    if (!user || user.authVersion >= maxVersion) {
      await tx.passwordResetChallenge.updateMany({ where: live, data: { consumedAt: now } })
      return { outcome: 'invalid' } as const
    }
    if (await bcrypt.compare(newPassword, user.password).catch(() => false)) return { outcome: 'same' } as const
    const hashed = await bcrypt.hash(newPassword, 10)
    const claimedAt = new Date()
    const claimed = await tx.passwordResetChallenge.updateMany({ where: { ...live, expiresAt: { gt: claimedAt }, deliveredAt: { not: null } }, data: { consumedAt: claimedAt } })
    if (claimed.count !== 1) return { outcome: 'invalid' } as const
    const updated = await tx.user.updateMany({ where: { id: user.id, password: user.password, authVersion: challenge.authVersion, isActive: true, ...identityWhere(channel, challenge.destination) }, data: { password: hashed, authVersion: { increment: 1 } } })
    if (updated.count !== 1) return { outcome: 'invalid' } as const
    await tx.passwordResetChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: claimedAt } })
    return { outcome: 'success' } as const
  }, { maxWait: 5000, timeout: 10000 })
  if (outcome.outcome === 'rate') throw new PasswordResetRateError(outcome.retryAt)
  if (outcome.outcome === 'same') throw new ApiInputError('رمز جدید نباید با رمز فعلی یکسان باشد.')
  if (outcome.outcome !== 'success') throw new InvalidPasswordResetCodeError()
  return { success: true }
}
