// Shared with clients; this module must not import database or server code.
export const PAYMENT_WINDOW_MS = 10 * 60 * 1000
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024
export const PAYMENT_METHOD_IDS = ['bank_transfer', 'zarinpal'] as const
export type PaymentMethodId = typeof PAYMENT_METHOD_IDS[number]
export const paymentStatusLabels = {
  UNPAID: 'پرداخت‌نشده',
  AWAITING_RECEIPT: 'در انتظار واریز و رسید',
  AWAITING_REVIEW: 'در انتظار تأیید پرداخت',
  REJECTED: 'رسید نیاز به اصلاح دارد',
  PAID: 'پرداخت تأییدشده',
  EXPIRED: 'مهلت پرداخت تمام شده',
} as const
export type PaymentStatus = keyof typeof paymentStatusLabels

export function normalizePaymentDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit >= '۰' ? 1776 : 1632)))
}

export function isValidCardNumber(value: string): boolean {
  if (!/^\d{16}$/.test(value) || /^(\d)\1{15}$/.test(value)) return false
  const sum = [...value].reduce((total, digit, index) => {
    const part = Number(digit) * (index % 2 === 0 ? 2 : 1)
    return total + (part > 9 ? part - 9 : part)
  }, 0)
  return sum % 10 === 0
}

export interface PaymentReceiptMetadata {
  id: string
  orderId: string
  mimeType: string
  payerCardLast4: string | null
  transferReference: string | null
  isLate: boolean
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  reviewNote: string | null
  reviewerId: string | null
  reviewedAt: string | null
  createdAt: string
}
