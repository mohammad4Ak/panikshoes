import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiError } from '@/lib/api-input'
import { readWarehouseImportProducts } from '@/lib/warehouse-import-products'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  try {
    const data = await prisma.$transaction(tx => readWarehouseImportProducts(tx, new URL(request.url).searchParams), {
      isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000,
    })
    return NextResponse.json(data, { headers })
  } catch (error) {
    const response = apiError(error, 'دریافت محصولات برای ورود موجودی انجام نشد.')
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
    return response
  }
}
