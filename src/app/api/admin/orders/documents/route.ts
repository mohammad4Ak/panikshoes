import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ApiInputError } from '@/lib/api-input'
import { AdminOrdersValidationError } from '@/lib/admin-orders'
import { parseOrderDocumentScope, prepareOrderDocuments, readOrderDocumentJson } from '@/lib/admin-order-print'
import { isSameOriginRequest } from '@/lib/request-origin'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' }

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید.' }, { status: 401, headers })
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
    if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
    const body = await readOrderDocumentJson(request)
    const now = new Date()
    const scope = parseOrderDocumentScope(body, now)
    // Raw persisted fields only: public-settings defaults contain sample contact
    // details and must never become a parcel's invented sender address.
    const settings = scope.kind === 'invoice' ? null : await prisma.siteSettings.findUnique({ where: { id: 1 }, select: { storeName: true, phone: true, address: true } })
    const result = await prepareOrderDocuments(prisma, body, { name: settings?.storeName ?? '', phone: settings?.phone ?? '', address: settings?.address ?? '' }, now)
    return NextResponse.json(result, { headers })
  } catch (error) {
    const known = error instanceof ApiInputError || error instanceof AdminOrdersValidationError
    return NextResponse.json({ error: known ? error.message : 'آماده‌سازی مدارک انجام نشد؛ دوباره تلاش کنید.' }, { status: error instanceof ApiInputError ? error.status : known ? 400 : 500, headers })
  }
}
