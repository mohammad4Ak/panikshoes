import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { methodAvailability, privatePaymentHeaders } from '@/lib/payments'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
  try {
    const methods = await prisma.paymentMethod.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })
    return NextResponse.json(methods.map((method) => ({ ...method, ...methodAvailability(method) })), { headers: privatePaymentHeaders })
  } catch { return NextResponse.json({ error: 'خطا در دریافت تنظیمات پرداخت' }, { status: 500 }) }
}
