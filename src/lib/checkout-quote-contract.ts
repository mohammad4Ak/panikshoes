export interface CheckoutQuote {
  grossSubtotal: number
  subtotal: number
  productDiscount: number
  couponDiscount: number
  couponCode: string | null
  shippingCost: number
  total: number
  productPrices: { productId: string; price: number; originalPrice: number }[]
}

export function isCheckoutQuote(value: unknown): value is CheckoutQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const q = value as Record<string, unknown>
  const money = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647
  return [q.grossSubtotal, q.subtotal, q.productDiscount, q.couponDiscount, q.shippingCost, q.total].every(money)
    && (q.couponCode === null || typeof q.couponCode === 'string')
    && Number(q.grossSubtotal) - Number(q.productDiscount) === q.subtotal
    && Number(q.subtotal) - Number(q.couponDiscount) + Number(q.shippingCost) === q.total
    && Number(q.couponDiscount) <= Number(q.subtotal)
    && Array.isArray(q.productPrices) && q.productPrices.length <= 100 && q.productPrices.every((p: unknown) => {
      if (!p || typeof p !== 'object') return false
      const item = p as Record<string, unknown>
      return typeof item.productId === 'string' && money(item.price) && money(item.originalPrice) && item.originalPrice >= item.price
    })
}
