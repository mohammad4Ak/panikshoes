import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { CouponError, parseCouponInput } from '@/lib/coupons'
import { isSameOriginRequest } from '@/lib/request-origin'

type Context = { params: Promise<{ id: string }> }

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
}

function versionFrom(input: unknown) {
  if (!input || typeof input !== 'object' || !('expectedVersion' in input) || typeof input.expectedVersion !== 'number' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new CouponError('نسخهٔ کد تخفیف معتبر نیست؛ صفحه را تازه‌سازی کنید')
  }
  return input.expectedVersion
}

function responseError(error: unknown) {
  if (error instanceof CouponError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: 'این کد قبلاً ثبت شده است؛ کد دیگری انتخاب کنید' }, { status: 409 })
  return NextResponse.json({ error: 'تغییر کد تخفیف ممکن نشد' }, { status: 500 })
}

export async function PUT(request: Request, { params }: Context) {
  const denied = await requireAdmin()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'مبدأ درخواست معتبر نیست' }, { status: 403 })
  const { id } = await params
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'اطلاعات درخواست معتبر نیست' }, { status: 400 }) }
  try {
    const expectedVersion = versionFrom(body)
    const input = parseCouponInput(body)
    const coupon = await prisma.$transaction(async tx => {
      const current = await tx.coupon.findUnique({ where: { id } })
      if (!current || current.deletedAt) throw new CouponError('کد تخفیف یافت نشد', 404)
      if (input.maxUses !== null && input.maxUses < current.usedCount) throw new CouponError('حداکثر استفاده نمی‌تواند کمتر از استفاده‌ها و رزروهای فعلی باشد')
      const changed = await tx.coupon.updateMany({
        where: { id, version: expectedVersion, deletedAt: null, ...(input.maxUses === null ? {} : { usedCount: { lte: input.maxUses } }) },
        data: { ...input, version: { increment: 1 } },
      })
      if (changed.count !== 1) throw new CouponError('این کد هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی و دوباره ویرایش کنید', 409, 'COUPON_CHANGED')
      return tx.coupon.findUnique({ where: { id } })
    })
    return NextResponse.json(coupon)
  } catch (error) { return responseError(error) }
}

export async function DELETE(request: Request, { params }: Context) {
  const denied = await requireAdmin()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'مبدأ درخواست معتبر نیست' }, { status: 403 })
  const { id } = await params
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'اطلاعات درخواست معتبر نیست' }, { status: 400 }) }
  try {
    const expectedVersion = versionFrom(body)
    await prisma.$transaction(async tx => {
      const current = await tx.coupon.findUnique({ where: { id } })
      if (!current || current.deletedAt) throw new CouponError('کد تخفیف یافت نشد', 404)
      const changed = await tx.coupon.updateMany({
        where: { id, version: expectedVersion, deletedAt: null },
        data: { isActive: false, deletedAt: new Date(), version: { increment: 1 } },
      })
      if (changed.count !== 1) throw new CouponError('این کد هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کنید', 409, 'COUPON_CHANGED')
    })
    return NextResponse.json({ success: true })
  } catch (error) { return responseError(error) }
}
