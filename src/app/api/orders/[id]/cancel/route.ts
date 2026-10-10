import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { cancelUnpaidOrder, PaymentError, privatePaymentHeaders, requireSameOrigin } from '@/lib/payments'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers: privatePaymentHeaders })
  const { id } = await params
  try {
    requireSameOrigin(request)
    const order = await cancelUnpaidOrder(id, session.user.id)
    return NextResponse.json({ order, serverTime: new Date().toISOString() }, { headers: privatePaymentHeaders })
  } catch (error) {
    if (error instanceof PaymentError) return NextResponse.json({
      error: error.message, ...(error.code ? { code: error.code } : {}),
    }, { status: error.status, headers: privatePaymentHeaders })
    return NextResponse.json({ error: 'انصراف از پرداخت انجام نشد. دوباره تلاش کنید.' }, { status: 500, headers: privatePaymentHeaders })
  }
}
