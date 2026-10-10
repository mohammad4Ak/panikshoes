import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { parseShippingMethodInput, ShippingValidationError } from '@/lib/shipping'

type Context = { params: Promise<{ id: string }> }

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
}

function methodError(error: unknown) {
  if (error instanceof ShippingValidationError) return NextResponse.json({ error: error.message }, { status: 400 })
  if (typeof error === 'object' && error && 'code' in error) {
    if (error.code === 'P2025') return NextResponse.json({ error: 'روش ارسال یافت نشد' }, { status: 404 })
    if (error.code === 'P2002') return NextResponse.json({ error: 'روش ارسال با این نام از قبل وجود دارد' }, { status: 409 })
  }
  return NextResponse.json({ error: 'تغییر روش ارسال ممکن نشد' }, { status: 500 })
}

export async function PUT(request: Request, { params }: Context) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'اطلاعات درخواست معتبر نیست' }, { status: 400 })
  }
  try {
    const method = await prisma.shippingMethod.update({ where: { id }, data: parseShippingMethodInput(body) })
    return NextResponse.json(method)
  } catch (error) { return methodError(error) }
}

export async function DELETE(_request: Request, { params }: Context) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  try {
    // The relation becomes null; name and fee snapshots remain on historical orders.
    await prisma.shippingMethod.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch (error) { return methodError(error) }
}
