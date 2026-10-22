import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ApiInputError, apiError } from '@/lib/api-input'
import { InventoryError } from '@/lib/inventory'
import { isSameOriginRequest } from '@/lib/request-origin'
import { confirmShipmentRow, readShipmentJson, shipmentChoices, verifyShipmentPreview } from '@/lib/shipment-import'

export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
  try {
    const body = await readShipmentJson(request, 1_600_000)
    const claims = verifyShipmentPreview(body.token, session.user.id)
    const choices = shipmentChoices(body, claims)
    const results = []
    // Independent rows have independent transactions. One ambiguous/stale order
    // does not discard valid rows, and every outcome is returned to the admin.
    for (const choice of choices) {
      try {
        results.push(await prisma.$transaction(tx => confirmShipmentRow(tx, claims, choice, { id: session.user.id, name: session.user.name }), { maxWait: 5000, timeout: 10000 }))
      } catch (error) {
        results.push({ rowNumber: choice.rowNumber, orderId: choice.orderId, status: 'error', error: error instanceof ApiInputError || error instanceof InventoryError ? error.message : 'ثبت انجام نشد؛ دوباره پیش‌نمایش بگیرید و وضعیت سفارش را بررسی کنید.' })
      }
    }
    return NextResponse.json({ results }, { headers })
  } catch (error) { return apiError(error, 'ثبت کدهای رهگیری انجام نشد.') }
}
