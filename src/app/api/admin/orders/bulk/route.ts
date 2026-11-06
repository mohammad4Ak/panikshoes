import { NextResponse } from 'next/server'
import { confirmBulkOrderStatus, previewBulkOrderStatus, readBulkOrderJson } from '@/lib/admin-order-bulk'
import { AdminOrdersValidationError } from '@/lib/admin-orders'
import { ApiInputError } from '@/lib/api-input'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { isSameOriginRequest } from '@/lib/request-origin'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید.' }, { status: 401, headers })
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
    if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
    const body = await readBulkOrderJson(request)
    const actor = { id: session.user.id, name: session.user.name }
    if (body.action === 'preview') return NextResponse.json(await previewBulkOrderStatus(prisma, body, actor.id), { headers })
    if (body.action === 'confirm') return NextResponse.json(await confirmBulkOrderStatus(prisma, body, actor), { headers })
    throw new ApiInputError('عملیات گروهی معتبر نیست.')
  } catch (error) {
    if (error instanceof ApiInputError || error instanceof AdminOrdersValidationError) {
      return NextResponse.json({ error: error.message }, { status: error instanceof ApiInputError ? error.status : 400, headers })
    }
    return NextResponse.json({ error: 'تغییر گروهی وضعیت انجام نشد؛ فهرست سفارش‌ها را دوباره بارگذاری کنید.' }, { status: 500, headers })
  }
}
