import type { PrismaClient } from '@prisma/client'
import { ApiInputError, integerField } from './api-input'
import { prisma } from './prisma'

export interface LoginSecuritySettings {
  version: number
  maxAttempts: number
  windowMinutes: number
  lockMinutes: number
  ipMaxAttempts: number
}

const defaults: LoginSecuritySettings = {
  version: 0, maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ipMaxAttempts: 30,
}
const select = { version: true, maxAttempts: true, windowMinutes: true, lockMinutes: true, ipMaxAttempts: true } as const

export async function readLoginSecuritySettings(db: Pick<PrismaClient, 'loginSecuritySettings'> = prisma): Promise<LoginSecuritySettings> {
  return await db.loginSecuritySettings.findUnique({ where: { id: 1 }, select }) ?? { ...defaults }
}

export function parseLoginSecuritySettings(input: Record<string, unknown>, current: LoginSecuritySettings): LoginSecuritySettings {
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new ApiInputError('تنظیمات امنیت ورود نامعتبر است.')
  const version = integerField(input.version, 'نسخهٔ تنظیمات')
  if (version !== current.version) throw new ApiInputError('تنظیمات هم‌زمان تغییر کرده است. آخرین نسخه را دریافت کنید.', 409)
  function bounded(key: keyof Omit<LoginSecuritySettings, 'version'>, label: string, min: number, max: number) {
    const value = integerField(input[key] === undefined ? current[key] : input[key], label, min)
    if (value > max) throw new ApiInputError(`${label} از حداکثر مجاز بیشتر است.`)
    return value
  }
  const settings = {
    version,
    maxAttempts: bounded('maxAttempts', 'حد تلاش برای هر حساب', 3, 20),
    windowMinutes: bounded('windowMinutes', 'بازهٔ شمارش تلاش‌ها', 1, 60),
    lockMinutes: bounded('lockMinutes', 'مدت انتظار', 1, 60),
    ipMaxAttempts: bounded('ipMaxAttempts', 'حد تلاش برای هر آدرس شبکه', 10, 200),
  }
  if (settings.ipMaxAttempts < settings.maxAttempts) throw new ApiInputError('حد تلاش شبکه نباید کمتر از حد تلاش هر حساب باشد.')
  return settings
}

export async function saveLoginSecuritySettings(settings: LoginSecuritySettings): Promise<LoginSecuritySettings> {
  if (settings.version === 2_147_483_647) throw new ApiInputError('نسخهٔ تنظیمات به سقف مجاز رسیده است.', 409)
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('login-security-settings:v1', 0))`
    if (settings.version === 0) await tx.loginSecuritySettings.createMany({ data: { id: 1 }, skipDuplicates: true })
    const { version, ...values } = settings
    const updated = await tx.loginSecuritySettings.updateMany({ where: { id: 1, version }, data: { ...values, version: { increment: 1 } } })
    if (updated.count !== 1) throw new ApiInputError('تنظیمات هم‌زمان تغییر کرده است. آخرین نسخه را دریافت کنید.', 409)
    return readLoginSecuritySettings(tx)
  })
}
