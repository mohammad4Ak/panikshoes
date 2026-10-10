import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { isValidCardNumber, normalizePaymentDigits } from '@/lib/payment-contract'
import { methodAvailability, nextOrderVersion, PaymentError, privatePaymentHeaders, requireSameOrigin } from '@/lib/payments'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403 })
  const { id } = await params
  try {
    requireSameOrigin(request)
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      body = parsed as Record<string, unknown>
    } catch { throw new PaymentError('اطلاعات تنظیمات معتبر نیست.', 400) }
    const existing = await prisma.paymentMethod.findUnique({ where: { id } })
    if (!existing || !['bank_transfer', 'zarinpal'].includes(id)) throw new PaymentError('روش پرداخت یافت نشد.', 404)
    const data: { name?: string; description?: string | null; isActive?: boolean; cardNumber?: string | null; cardholderName?: string | null; bankName?: string | null; sortOrder?: number } = {}
    for (const [key, max] of [['name', 80], ['description', 500], ['cardholderName', 100], ['bankName', 80]] as const) {
      if (!(key in body)) continue
      if (typeof body[key] !== 'string' && !(body[key] === null && key !== 'name')) throw new PaymentError('متن تنظیمات معتبر نیست.', 400)
      const value = typeof body[key] === 'string' ? body[key].trim() : ''
      if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (key === 'name' && !value)) throw new PaymentError('طول متن تنظیمات معتبر نیست.', 400)
      if (key === 'name') data.name = value
      else data[key] = value || null
    }
    if ('cardNumber' in body) {
      if (typeof body.cardNumber !== 'string' && body.cardNumber !== null) throw new PaymentError('شماره کارت معتبر نیست.', 400)
      const card = normalizePaymentDigits((body.cardNumber as string | null) ?? '').replace(/[\s-]/g, '')
      if (card && !isValidCardNumber(card)) throw new PaymentError('شماره کارت ۱۶ رقمی معتبر وارد کنید.', 400)
      data.cardNumber = card || null
    }
    if ('isActive' in body) {
      if (typeof body.isActive !== 'boolean') throw new PaymentError('وضعیت روش پرداخت معتبر نیست.', 400)
      data.isActive = body.isActive
    }
    if ('sortOrder' in body) {
      if (!Number.isInteger(body.sortOrder) || (body.sortOrder as number) < 0 || (body.sortOrder as number) > 999) throw new PaymentError('ترتیب نمایش معتبر نیست.', 400)
      data.sortOrder = body.sortOrder as number
    }
    const next = { ...existing, ...data }
    if (next.isActive && !methodAvailability(next).available) throw new PaymentError(methodAvailability(next).unavailableReason!, 400)
    const method = await prisma.$transaction(async (tx) => {
      const changed = await tx.paymentMethod.updateMany({ where: { id, updatedAt: existing.updatedAt }, data: { ...data, updatedAt: nextOrderVersion(existing.updatedAt) } })
      if (changed.count !== 1) throw new PaymentError('تنظیمات هم‌زمان تغییر کرده است؛ صفحه را تازه کنید.')
      return tx.paymentMethod.findUniqueOrThrow({ where: { id } })
    })
    return NextResponse.json({ ...method, ...methodAvailability(method) }, { headers: privatePaymentHeaders })
  } catch (error) {
    if (error instanceof PaymentError) return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: 'ذخیره تنظیمات پرداخت انجام نشد.' }, { status: 500 })
  }
}
