import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiError } from '@/lib/api-input'
import { isSameOriginRequest } from '@/lib/request-origin'
import { previewShipmentImport, readShipmentJson } from '@/lib/shipment-import'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
  try {
    const body = await readShipmentJson(request, 512_000)
    const result = await prisma.$transaction(tx => previewShipmentImport(tx, body, session.user.id), { isolationLevel: 'RepeatableRead', timeout: 15000 })
    return NextResponse.json(result, { headers })
  } catch (error) { return apiError(error, 'بررسی سفارش‌ها انجام نشد.') }
}
