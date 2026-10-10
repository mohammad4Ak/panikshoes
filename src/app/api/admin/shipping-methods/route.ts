import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { parseShippingMethodInput, ShippingValidationError } from '@/lib/shipping'

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
}

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  try {
    const methods = await prisma.shippingMethod.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    })
    return NextResponse.json(methods, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'دریافت روش‌های ارسال ممکن نشد' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'اطلاعات درخواست معتبر نیست' }, { status: 400 })
  }
  try {
    const method = await prisma.shippingMethod.create({ data: parseShippingMethodInput(body) })
    return NextResponse.json(method, { status: 201 })
  } catch (error) {
    if (error instanceof ShippingValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'روش ارسال با این نام از قبل وجود دارد' }, { status: 409 })
    }
    return NextResponse.json({ error: 'ذخیرهٔ روش ارسال ممکن نشد' }, { status: 500 })
  }
}
