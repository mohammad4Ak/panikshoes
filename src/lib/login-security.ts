import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import bcrypt from 'bcryptjs'
import ipaddr from 'ipaddr.js'
import type { LoginAttemptWindow, Prisma } from '@prisma/client'
import { caseInsensitiveEmailFilter, normalizeLoginPhone } from './customer-contact'
import { prisma } from './prisma'
import { readLoginSecuritySettings } from './login-security-settings'

const minute = 60_000
// Same cost as stored passwords. Missing/disabled accounts still do one compare.
const dummyHash = '$2b$10$HuSHySqaNCJ9jzitgUyDleDFjjzB7Oa661SvcGqpgsNcHRdBgd0BO'
let nextCleanupAt = 0

export class LoginRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super('Password sign-in temporarily limited') }
}

function digest(secret: string, kind: string, value: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(['login-security:v1', kind, value])).digest('hex')
}

function networkIdentity(request: Request): string {
  // Never trust client-supplied X-Forwarded-For or X-Real-IP. On other hosts use
  // one shared bucket until an explicit trusted proxy adapter is implemented.
  const value = process.env.VERCEL === '1' ? request.headers.get('x-vercel-forwarded-for')?.trim() : ''
  if (!value || !isIP(value)) return 'unattributed'
  return ipaddr.process(value).toString() // Canonicalizes IPv6 and mapped IPv4.
}

function retryAt(row: LoginAttemptWindow | null, now: Date): number {
  return row?.blockedUntil && row.blockedUntil > now ? row.blockedUntil.getTime() : 0
}

async function recordFailure(tx: Prisma.TransactionClient, key: string, row: LoginAttemptWindow | null,
  now: Date, windowMinutes: number, limit: number, lockMinutes: number): Promise<number> {
  // Expired locks start a fresh allowance even if the counting window is longer.
  const fresh = !row || (row.blockedUntil !== null && row.blockedUntil <= now)
    || now.getTime() - row.windowStartedAt.getTime() >= windowMinutes * minute
  const failures = fresh ? 1 : row.failures + 1
  const blockedUntil = failures >= limit ? new Date(now.getTime() + lockMinutes * minute) : null
  const data = { windowStartedAt: fresh ? now : row!.windowStartedAt, failures, blockedUntil, updatedAt: now }
  await tx.loginAttemptWindow.upsert({ where: { key }, create: { key, ...data }, update: data })
  return blockedUntil?.getTime() ?? 0
}

async function cleanExpiredWindows(): Promise<void> {
  const now = Date.now()
  if (now < nextCleanupAt) return
  nextCleanupAt = now + 60 * minute
  try {
    // Both window and lock are capped at one hour. Retain inactive records for
    // one day, and never delete a current lock (including after settings edits).
    await prisma.loginAttemptWindow.deleteMany({ where: {
      updatedAt: { lt: new Date(now - 24 * 60 * minute) },
      OR: [{ blockedUntil: null }, { blockedUntil: { lte: new Date(now) } }],
    } })
  } catch { nextCleanupAt = now + minute } // Cleanup availability must not change authentication.
}

export async function authorizePasswordLogin(credentials: Partial<Record<string, unknown>>, request: Request) {
  const rawEmail = credentials.email
  const rawPhone = credentials.loginPhone
  const password = credentials.password
  if ((rawEmail != null && typeof rawEmail !== 'string') || (rawPhone != null && typeof rawPhone !== 'string')
    || (typeof rawEmail === 'string' && rawEmail.length > 254) || (typeof rawPhone === 'string' && rawPhone.length > 64)
    || typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) return null
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
  const phone = normalizeLoginPhone(rawPhone)
  if ((email && rawPhone) || (!email && !phone) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null
  const secret = process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim() || ''
  if (secret.length < 32) throw new Error('Login security secret is not configured')
  const ipKey = digest(secret, 'network', networkIdentity(request))

  const result = await prisma.$transaction(async tx => {
    const policy = await readLoginSecuritySettings(tx)
    // Every caller locks network then account. Account locks are shared across
    // networks and login aliases; there is no process-local allowance to bypass.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${ipKey}, 0))`
    const network = await tx.loginAttemptWindow.findUnique({ where: { key: ipKey } })
    let now = new Date()
    if (retryAt(network, now)) return { retry: retryAt(network, now), user: null }
    const user = phone ? await tx.user.findUnique({ where: { loginPhone: phone } })
      : await tx.user.findFirst({ where: { email: caseInsensitiveEmailFilter(email) } })
    const accountKey = user ? digest(secret, 'account', user.id)
      : digest(secret, phone ? 'unknown-phone' : 'unknown-email', phone || email)
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${accountKey}, 0))`
    const account = await tx.loginAttemptWindow.findUnique({ where: { key: accountKey } })
    now = new Date()
    if (retryAt(account, now)) return { retry: retryAt(account, now), user: null }
    const eligible = !!user && user.isActive !== false && (!phone || !!user.phoneVerifiedAt)
    const matches = await bcrypt.compare(password, eligible ? user.password : dummyHash)
    if (eligible && matches) {
      await tx.loginAttemptWindow.deleteMany({ where: { key: accountKey } })
      return { retry: 0, user: { id: user.id, email: user.email, name: user.name, role: user.role, authVersion: user.authVersion } }
    }
    now = new Date()
    const networkRetry = await recordFailure(tx, ipKey, network, now, policy.windowMinutes, policy.ipMaxAttempts, policy.lockMinutes)
    const accountRetry = await recordFailure(tx, accountKey, account, now, policy.windowMinutes, policy.maxAttempts, policy.lockMinutes)
    return { retry: Math.max(networkRetry, accountRetry), user: null }
  }, { maxWait: 10_000, timeout: 15_000 })
  // Throw after commit: throwing inside the transaction would roll back the
  // very failure counter that is supposed to prevent another password guess.
  await cleanExpiredWindows()
  if (result.retry) throw new LoginRateLimitError(Math.max(1, Math.ceil((result.retry - Date.now()) / 1000)))
  return result.user
}
