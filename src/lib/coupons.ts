import type { Coupon, Prisma, PrismaClient } from '@prisma/client'

export const MAX_COUPON_AMOUNT = 2_147_483_647

export class CouponError extends Error {
  constructor(message: string, public status = 400, public code = 'COUPON_INVALID') {
    super(message)
    this.name = 'CouponError'
  }
}

export interface CouponInput {
  code: string
  name: string
  type: 'PERCENT' | 'FIXED'
  value: number
  maxDiscount: number | null
  minSubtotal: number
  maxUses: number | null
  perUserLimit: number
  startsAt: Date | null
  endsAt: Date | null
  isActive: boolean
}

export interface CouponQuote {
  couponId: string | null
  code: string | null
  discount: number
  version?: number
}

type CouponClient = Pick<PrismaClient, 'coupon' | 'couponRedemption'>

export function normalizeCouponCode(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 128) throw new CouponError('کد تخفیف معتبر نیست')
  const code = value.trim()
  if (!code) return null
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) throw new CouponError('کد تخفیف باید ۳ تا ۳۲ حرف انگلیسی، عدد، خط تیره یا زیرخط باشد')
  return code.toUpperCase()
}

function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > MAX_COUPON_AMOUNT) {
    throw new CouponError(`${label} باید عدد صحیح ${min === 0 ? 'نامنفی' : 'مثبت'} باشد`)
  }
  return value
}

function date(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new CouponError(`${label} معتبر نیست`)
  }
  const parsed = new Date(value)
  const [year, month, day, hour, minute] = value.match(/\d+/g)!.slice(0, 5).map(Number)
  if (!Number.isFinite(parsed.getTime()) || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) throw new CouponError(`${label} معتبر نیست`)
  return parsed
}

export function parseCouponInput(input: unknown): CouponInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CouponError('اطلاعات کد تخفیف معتبر نیست')
  const value = input as Record<string, unknown>
  const code = normalizeCouponCode(value.code)
  if (!code) throw new CouponError('کد تخفیف را وارد کنید')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new CouponError('عنوان کد تخفیف را وارد کنید (حداکثر ۱۲۰ نویسه)')
  if (value.type !== 'PERCENT' && value.type !== 'FIXED') throw new CouponError('نوع تخفیف معتبر نیست')
  const amount = integer(value.value, 'مقدار تخفیف', 1)
  if (value.type === 'PERCENT' && amount > 99) throw new CouponError('درصد تخفیف باید بین ۱ تا ۹۹ باشد')
  const maxDiscount = value.maxDiscount == null ? null : integer(value.maxDiscount, 'سقف تخفیف', 1)
  if (value.type === 'FIXED' && maxDiscount !== null) throw new CouponError('سقف تخفیف فقط برای کد درصدی قابل تنظیم است')
  const minSubtotal = integer(value.minSubtotal ?? 0, 'حداقل خرید')
  if (value.type === 'FIXED' && minSubtotal <= amount) throw new CouponError('حداقل خرید باید بیشتر از مبلغ کد تخفیف باشد تا مبلغ سفارش صفر نشود')
  const maxUses = value.maxUses == null ? null : integer(value.maxUses, 'حداکثر استفاده', 1)
  const perUserLimit = integer(value.perUserLimit ?? 1, 'سقف استفادهٔ هر کاربر', 1)
  const startsAt = date(value.startsAt, 'زمان شروع')
  const endsAt = date(value.endsAt, 'زمان پایان')
  if (startsAt && endsAt && startsAt >= endsAt) throw new CouponError('زمان پایان باید بعد از زمان شروع باشد')
  if (typeof value.isActive !== 'boolean') throw new CouponError('وضعیت فعال بودن کد تخفیف معتبر نیست')
  return { code, name: value.name.trim(), type: value.type, value: amount, maxDiscount, minSubtotal, maxUses, perUserLimit, startsAt, endsAt, isActive: value.isActive }
}

function assertAvailable(coupon: Coupon | null, now: Date): asserts coupon is Coupon {
  if (!coupon || coupon.deletedAt || !coupon.isActive) throw new CouponError('این کد تخفیف فعال نیست یا وجود ندارد')
  if (coupon.startsAt && now < coupon.startsAt) throw new CouponError('زمان استفاده از این کد تخفیف هنوز نرسیده است')
  if (coupon.endsAt && now >= coupon.endsAt) throw new CouponError('مهلت این کد تخفیف تمام شده است')
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) throw new CouponError('ظرفیت استفاده از این کد تخفیف تکمیل شده است', 409, 'COUPON_LIMIT_REACHED')
}

async function assertUserLimit(client: CouponClient, coupon: Coupon, userId: string) {
  const count = await client.couponRedemption.count({ where: { couponId: coupon.id, userId, releasedAt: null } })
  if (count >= coupon.perUserLimit) throw new CouponError('سقف استفادهٔ شما از این کد تخفیف تکمیل شده است', 409, 'COUPON_USER_LIMIT_REACHED')
}

export async function quoteCoupon(client: CouponClient, code: string | null, userId: string, subtotalAfterProductDiscount: number, now: Date): Promise<CouponQuote> {
  if (!code) return { couponId: null, code: null, discount: 0 }
  integer(subtotalAfterProductDiscount, 'مبلغ خرید', 1)
  const coupon = await client.coupon.findUnique({ where: { code } })
  assertAvailable(coupon, now)
  if (subtotalAfterProductDiscount < coupon.minSubtotal) throw new CouponError(`حداقل خرید برای این کد ${coupon.minSubtotal.toLocaleString('fa-IR')} تومان است`)
  await assertUserLimit(client, coupon, userId)
  let discount = coupon.type === 'PERCENT'
    ? Number(BigInt(subtotalAfterProductDiscount) * BigInt(coupon.value) / BigInt(100))
    : coupon.value
  if (coupon.type === 'PERCENT' && coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount)
  if (discount < 1 || discount >= subtotalAfterProductDiscount) throw new CouponError('این کد برای مبلغ سبد خرید قابل استفاده نیست')
  return { couponId: coupon.id, code: coupon.code, discount, version: coupon.version }
}

/** The coupon row is claimed before counting a user's redemptions, serializing concurrent checkouts. */
async function claimCoupon(tx: Prisma.TransactionClient, coupon: Coupon, now: Date) {
  const claimed = await tx.coupon.updateMany({
    where: {
      id: coupon.id, version: coupon.version, isActive: true, deletedAt: null,
      ...(coupon.maxUses === null ? {} : { usedCount: { lt: coupon.maxUses } }),
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    data: { usedCount: { increment: 1 } },
  })
  if (claimed.count !== 1) throw new CouponError('شرایط یا ظرفیت کد تخفیف تغییر کرده است؛ دوباره بررسی کنید', 409, 'COUPON_CHANGED')
}

export async function reserveCoupon(tx: Prisma.TransactionClient, quote: CouponQuote, userId: string, orderId: string, now: Date): Promise<void> {
  if (!quote.couponId) return
  const coupon = await tx.coupon.findUnique({ where: { id: quote.couponId } })
  assertAvailable(coupon, now)
  if (coupon.version !== quote.version || coupon.code !== quote.code) throw new CouponError('شرایط کد تخفیف تغییر کرده است؛ دوباره بررسی کنید', 409, 'COUPON_CHANGED')
  await claimCoupon(tx, coupon, now)
  await assertUserLimit(tx, coupon, userId)
  await tx.couponRedemption.create({ data: { couponId: coupon.id, userId, orderId } })
}

export async function releaseCouponReservation(tx: Prisma.TransactionClient, orderId: string, now: Date): Promise<void> {
  const redemption = await tx.couponRedemption.findUnique({ where: { orderId } })
  if (!redemption || redemption.releasedAt) return
  // Use the same row-lock order as reservation/reacquisition to avoid deadlocks.
  await tx.coupon.updateMany({ where: { id: redemption.couponId }, data: { usedCount: { increment: 0 } } })
  const released = await tx.couponRedemption.updateMany({ where: { id: redemption.id, releasedAt: null }, data: { releasedAt: now } })
  if (released.count === 1) {
    const decremented = await tx.coupon.updateMany({ where: { id: redemption.couponId, usedCount: { gte: 1 } }, data: { usedCount: { decrement: 1 } } })
    if (decremented.count !== 1) throw new CouponError('شمارندهٔ کد تخفیف نیاز به بررسی دارد', 409, 'COUPON_COUNTER_CONFLICT')
  }
}

/** Late payment keeps the original order discount, but must reclaim a currently available use. */
export async function reacquireCouponReservation(tx: Prisma.TransactionClient, orderId: string, userId: string, now: Date): Promise<void> {
  const redemption = await tx.couponRedemption.findUnique({ where: { orderId } })
  if (!redemption) return
  if (redemption.userId !== userId) throw new CouponError('کاربر سفارش با کد تخفیف مطابقت ندارد', 409)
  if (!redemption.releasedAt) return
  const coupon = await tx.coupon.findUnique({ where: { id: redemption.couponId } })
  assertAvailable(coupon, now)
  await claimCoupon(tx, coupon, now)
  await assertUserLimit(tx, coupon, userId)
  const acquired = await tx.couponRedemption.updateMany({ where: { id: redemption.id, releasedAt: redemption.releasedAt }, data: { releasedAt: null } })
  if (acquired.count !== 1) throw new CouponError('وضعیت استفاده از کد تخفیف هم‌زمان تغییر کرده است؛ دوباره تلاش کنید', 409, 'COUPON_CHANGED')
}
