import type { Metadata } from 'next'
import BankTransferPayment from '@/components/shop/BankTransferPayment'

export const metadata: Metadata = {
  title: 'پرداخت و ارسال رسید',
  robots: { index: false, follow: false },
}

export default async function BankTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <BankTransferPayment key={id} orderId={id} />
}
