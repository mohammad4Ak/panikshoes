export interface OrderDiscountAmounts {
  total: number
  shippingCost?: number
  subtotal?: number | null
  productDiscount?: number
  couponDiscount?: number
  couponCode?: string | null
  items?: { price: number; originalPrice?: number | null; quantity: number; couponDiscount?: number }[]
}

/** Read immutable order amounts; never recalculate a historical order from today's catalog. */
export function getOrderTotals(order: OrderDiscountAmounts) {
  const shipping = order.shippingCost ?? 0
  const productDiscount = order.productDiscount ?? 0
  const couponDiscount = order.couponDiscount ?? 0
  const merchandise = order.total - shipping
  return {
    subtotal: order.subtotal ?? merchandise + productDiscount + couponDiscount,
    productDiscount,
    couponDiscount,
    discount: productDiscount + couponDiscount,
    couponCode: order.couponCode ?? null,
    merchandise,
    shipping,
    total: order.total,
  }
}

export function orderItemNetAmount(item: { price: number; quantity: number; couponDiscount?: number }): number {
  return item.price * item.quantity - (item.couponDiscount ?? 0)
}
