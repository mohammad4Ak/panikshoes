import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { methodAvailability } from '@/lib/payments'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const methods = await prisma.paymentMethod.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })
    return NextResponse.json(methods.filter((method) => methodAvailability(method).available)
      .map(({ id, name, description }) => ({ id, name, description })), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'خطا در دریافت روش‌های پرداخت' }, { status: 500 })
  }
}
