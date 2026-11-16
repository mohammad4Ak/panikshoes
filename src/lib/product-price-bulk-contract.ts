/** Public request/response types; keep signing and persistence on the server. */
export const PRODUCT_PRICE_BULK_LIMIT = 200

export type ProductPriceBulkSettings = {
  operation: 'increase' | 'decrease'
  unit: 'amount' | 'percent'
  value: number
  includeSalePrice: boolean
}

export type ProductPriceSnapshot = {
  price: number
  salePrice: number | null
  saleStartsAt: string | null
  saleEndsAt: string | null
  pricingVersion: number
}

export type ProductPriceBulkPreviewRow = {
  id: string
  code: string | null
  name: string | null
  eligible: boolean
  reason?: string
  before: ProductPriceSnapshot | null
  after: ProductPriceSnapshot | null
}

export type ProductPriceBulkPreview = {
  token: string | null
  batchId: string
  expiresAt: string
  settings: ProductPriceBulkSettings
  reason: string
  rows: ProductPriceBulkPreviewRow[]
  limit: number
}

export type ProductPriceBulkResult = {
  id: string
  outcome: 'updated' | 'already_applied' | 'skipped'
  code?: string
  reason?: string
  before?: ProductPriceSnapshot
  after?: ProductPriceSnapshot
  auditId?: string
}
