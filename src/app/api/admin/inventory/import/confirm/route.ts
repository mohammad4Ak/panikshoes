import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ApiInputError, apiError } from '@/lib/api-input'
import { InventoryError } from '@/lib/inventory'
import { isSameOriginRequest } from '@/lib/request-origin'
import {
  MAX_WAREHOUSE_IMPORT_CONFIRM_BYTES, confirmWarehouseImportProduct, readWarehouseImportJson,
  verifyWarehouseImportPreview, warehouseImportFailure, warehouseImportProduct,
} from '@/lib/warehouse-import'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
  try {
    const body = await readWarehouseImportJson(request, MAX_WAREHOUSE_IMPORT_CONFIRM_BYTES)
    if (Object.keys(body).some(key => key !== 'token' && key !== 'productId')) throw new ApiInputError('فقط یک محصول از پیش‌نمایش را انتخاب کنید.')
    // Expiry is enforced after ledger replay, so a lost response stays recoverable.
    const claims = verifyWarehouseImportPreview(body.token, session.user.id, { allowExpired: true })
    warehouseImportProduct(claims, body.productId)
    const productId = body.productId as string
    try {
      const result = await prisma.$transaction(tx => confirmWarehouseImportProduct(tx, claims, productId, { id: session.user.id, name: session.user.name }), { maxWait: 5000, timeout: 30000 })
      return NextResponse.json(result, { headers })
    } catch (error) {
      // These are deliberate in-transaction rejections, therefore the entire
      // product group rolled back. Infrastructure/commit failures remain 5xx.
      if (error instanceof ApiInputError || error instanceof InventoryError) return NextResponse.json(warehouseImportFailure(claims, productId, error.message), { headers })
      throw error
    }
  } catch (error) {
    const response = apiError(error, 'نتیجهٔ ثبت مشخص نیست؛ همین پیش‌نمایش و محصول را دوباره بررسی کنید.')
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
    return response
  }
}
