import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiError } from '@/lib/api-input'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  const id = new URL(request.url).searchParams.get('id')
  if (!id || !/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return NextResponse.json({ error: 'شناسهٔ سفارش نامعتبر است.' }, { status: 400, headers })
  try {
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true, phone: true, postalCode: true, trackingCode: true, status: true } })
    if (!order) return NextResponse.json({ error: 'سفارش پیدا نشد.' }, { status: 404, headers })
    return NextResponse.json({ order }, { headers })
  } catch (error) { return apiError(error, 'دریافت سفارش انجام نشد.') }
}
