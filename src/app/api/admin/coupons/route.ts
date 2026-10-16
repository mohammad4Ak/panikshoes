import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { CouponError, parseCouponInput } from '@/lib/coupons'
import { isSameOriginRequest } from '@/lib/request-origin'

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
}

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  try {
    const coupons = await prisma.coupon.findMany({ where: { deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })
    return NextResponse.json(coupons, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'دریافت کدهای تخفیف ممکن نشد' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'مبدأ درخواست معتبر نیست' }, { status: 403 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'اطلاعات درخواست معتبر نیست' }, { status: 400 }) }
  try {
    const coupon = await prisma.coupon.create({ data: parseCouponInput(body) })
    return NextResponse.json(coupon, { status: 201 })
  } catch (error) {
    if (error instanceof CouponError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') return NextResponse.json({ error: 'این کد قبلاً ثبت شده است؛ کد دیگری انتخاب کنید' }, { status: 409 })
    return NextResponse.json({ error: 'ذخیرهٔ کد تخفیف ممکن نشد' }, { status: 500 })
  }
}
