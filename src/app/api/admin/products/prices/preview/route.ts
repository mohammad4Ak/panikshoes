import { NextResponse } from 'next/server'
import { ApiInputError } from '@/lib/api-input'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { previewProductPrices, readProductPriceBulkJson } from '@/lib/product-price-bulk'
import { isSameOriginRequest } from '@/lib/request-origin'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید.' }, { status: 401, headers })
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
    if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
    const body = await readProductPriceBulkJson(request)
    return NextResponse.json(await previewProductPrices(prisma, body, { id: session.user.id, name: session.user.name }), { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof ApiInputError ? error.message : 'پیش‌نمایش تغییر قیمت انجام نشد؛ دوباره تلاش کنید.' }, { status: error instanceof ApiInputError ? error.status : 500, headers })
  }
}
