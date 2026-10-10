import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { privatePaymentHeaders } from '@/lib/payments'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; receiptId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401 })
  const { id, receiptId } = await params
  try {
    const receipt = await prisma.paymentReceipt.findFirst({ where: {
      id: receiptId, orderId: id,
      ...(session.user.role === 'ADMIN' ? {} : { order: { userId: session.user.id } }),
    }, select: { data: true, mimeType: true } })
    if (!receipt) return NextResponse.json({ error: 'رسید یافت نشد.' }, { status: 404, headers: privatePaymentHeaders })
    const extension = receipt.mimeType === 'image/png' ? 'png' : receipt.mimeType === 'image/webp' ? 'webp' : 'jpg'
    return new Response(new Uint8Array(receipt.data), { headers: {
      ...privatePaymentHeaders, 'Content-Type': receipt.mimeType,
      'Content-Length': String(receipt.data.byteLength),
      'Content-Disposition': `inline; filename="receipt.${extension}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } })
  } catch { return NextResponse.json({ error: 'دریافت رسید انجام نشد.' }, { status: 500 }) }
}
