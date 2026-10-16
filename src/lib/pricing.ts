/** Shared by the catalogue and checkout. All money is integer toman. */
export interface PricingProduct {
  price: number
  salePrice?: number | null
  saleStartsAt?: Date | string | null
  saleEndsAt?: Date | string | null
}

export interface ProductPricing {
  originalPrice: number
  effectivePrice: number
  discountAmount: number
  discountPercent: number
  isDiscounted: boolean
}

function timestamp(value: Date | string | null | undefined): number | null {
  return value == null ? null : new Date(value).getTime()
}

export function productPricing(product: PricingProduct, now = new Date()): ProductPricing {
  const originalPrice = product.price
  if (!Number.isSafeInteger(originalPrice) || originalPrice < 0) throw new RangeError('Invalid product price')
  const startsAt = timestamp(product.saleStartsAt)
  const endsAt = timestamp(product.saleEndsAt)
  const current = now.getTime()
  const salePrice = product.salePrice
  const isDiscounted = typeof salePrice === 'number' && Number.isSafeInteger(salePrice) &&
    salePrice >= 1 && salePrice < originalPrice && Number.isFinite(current) &&
    (startsAt === null || Number.isFinite(startsAt) && current >= startsAt) &&
    (endsAt === null || Number.isFinite(endsAt) && current < endsAt) &&
    (startsAt === null || endsAt === null || startsAt < endsAt)
  const effectivePrice = isDiscounted ? salePrice : originalPrice
  const discountAmount = originalPrice - effectivePrice
  return {
    originalPrice, effectivePrice, discountAmount,
    discountPercent: isDiscounted ? Math.floor(discountAmount * 100 / originalPrice) : 0,
    isDiscounted,
  }
}

/** Largest-remainder allocation preserves every toman, including very large baskets. */
export function allocateDiscount(lineTotals: number[], amount: number): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || lineTotals.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('Invalid discount allocation')
  }
  const total = lineTotals.reduce((sum, value) => sum + BigInt(value), BigInt(0))
  if (BigInt(amount) > total) throw new RangeError('Discount exceeds basket total')
  if (amount === 0) return lineTotals.map(() => 0)
  const shares = lineTotals.map((value, index) => {
    const weighted = BigInt(value) * BigInt(amount)
    return { index, value: Number(weighted / total), remainder: weighted % total }
  })
  let remaining = amount - shares.reduce((sum, share) => sum + share.value, 0)
  const priority = [...shares].sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index : left.remainder > right.remainder ? -1 : 1)
  for (const share of priority) {
    if (remaining === 0) break
    share.value++
    remaining--
  }
  return shares.map(share => share.value)
}
