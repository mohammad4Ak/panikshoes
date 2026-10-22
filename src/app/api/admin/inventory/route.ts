import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiError, readJsonObject } from '@/lib/api-input'
import { isSameOriginRequest } from '@/lib/request-origin'
import { InventoryError } from '@/lib/inventory'
import { applyStockOperation, parseStockOperation, readWarehouseOverview, updateLowStockThreshold } from '@/lib/warehouse'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  try {
    const data = await prisma.$transaction(tx => readWarehouseOverview(tx, new URL(request.url).searchParams), { isolationLevel: 'RepeatableRead', timeout: 15000 })
    return NextResponse.json(data, { headers })
  }
  catch (error) { return apiError(error, 'دریافت اطلاعات انبار انجام نشد.') }
}

async function mutate(request: Request, threshold: boolean) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر ارسال شده است.' }, { status: 403, headers })
  try {
    const body = await readJsonObject(request)
    const operation = threshold ? null : parseStockOperation(body)
    const result = await prisma.$transaction(async tx => threshold ? await updateLowStockThreshold(tx, body) : await applyStockOperation(tx, operation!, { id: session.user.id, name: session.user.name }), { maxWait: 5000, timeout: 15000 })
    return NextResponse.json(result, { headers })
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers })
    return apiError(error, 'عملیات انبار ثبت نشد؛ وضعیت موجودی را تازه کنید و دوباره بررسی کنید.')
  }
}
export async function POST(request: Request) { return mutate(request, false) }
export async function PATCH(request: Request) { return mutate(request, true) }
