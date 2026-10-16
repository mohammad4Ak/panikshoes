import type { Metadata } from 'next'
import type { ComponentProps } from 'react'
import { redirect } from 'next/navigation'
import PaymentResult from '@/components/shop/PaymentResult'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const metadata: Metadata = {
  title: 'نتیجهٔ پرداخت',
  robots: { index: false, follow: false },
}

type SearchParams = Record<string, string | string[] | undefined>

async function readPaymentResult(orderId: string): Promise<ComponentProps<typeof PaymentResult> & { transferOrderId?: string }> {
  try {
    const session = await auth()
    if (!session?.user?.id) return { status: 'unknown', requiresLogin: true }

    // Never use callback/query-string status, amount or reference values as proof of payment.
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: session.user.id },
      select: { id: true, total: true, verified: true, status: true, createdAt: true, shippingMethodName: true, shippingCost: true, paymentMethod: true, subtotal: true, productDiscount: true, couponDiscount: true, couponCode: true },
    })
    if (!order) return { status: 'unknown' }
    if (order.paymentMethod === 'bank_transfer') return { status: 'pending', transferOrderId: order.id }

    return {
      status: order.verified ? 'success' : order.status === 'CANCELLED' ? 'failed' : 'pending',
      order: {
        id: order.id, amount: order.total, createdAt: order.createdAt.toISOString(),
        shippingMethodName: order.shippingMethodName, shippingCost: order.shippingCost,
        subtotal: order.subtotal, productDiscount: order.productDiscount, couponDiscount: order.couponDiscount, couponCode: order.couponCode,
        status: order.status,
      },
    }
  } catch {
    return { status: 'unknown', unavailable: true }
  }
}

export default async function PaymentResultPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const preview = params.preview

  // Local design previews never query or change real orders and are disabled in production.
  if (process.env.NODE_ENV === 'development' &&
    (preview === 'success' || preview === 'failed' || preview === 'pending')) {
    return <PaymentResult status={preview} isPreview order={{
      id: 'DEMO-24018', amount: 5200000, createdAt: '2026-09-29T10:30:00.000Z',
    }} />
  }

  const orderId = typeof params.orderId === 'string' ? params.orderId.trim() : ''
  if (!orderId || orderId.length > 128) return <PaymentResult status="unknown" />

  const result = await readPaymentResult(orderId)
  if (result.transferOrderId) redirect(`/payment/transfer/${encodeURIComponent(result.transferOrderId)}`)
  return <PaymentResult {...result} />
}
