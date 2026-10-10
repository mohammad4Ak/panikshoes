import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const methods = await prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, name: true, description: true, baseCost: true, additionalItemCost: true,
        freeShippingThreshold: true, isActive: true, sortOrder: true,
      },
    })
    return NextResponse.json(methods, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'دریافت روش‌های ارسال ممکن نشد' }, { status: 500 })
  }
}
