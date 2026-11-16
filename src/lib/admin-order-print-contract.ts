import type { InvoiceSnapshot } from '@/lib/invoice'

export const ADMIN_ORDER_PRINT_LIMIT = 100
export const ADMIN_ORDER_DOCUMENT_KINDS = ['invoice', 'packing', 'shipping-label'] as const
export type AdminOrderDocumentKind = typeof ADMIN_ORDER_DOCUMENT_KINDS[number]

export interface AdminOrderInvoiceDocument {
  kind: 'invoice'
  orderId: string
  status: string
  invoice: { id: number; issuedAt: string; number: string; snapshot: InvoiceSnapshot }
}

export interface AdminOrderFulfillmentDocument {
  kind: 'packing' | 'shipping-label'
  orderId: string
  status: string
  createdAt: string
  seller: { name: string; phone: string; address: string }
  recipient: { name: string; address: string; phone: string; postalCode: string | null }
  shippingMethodName: string | null
  trackingCode: string | null
  items: { productName: string; quantity: number; size: number; color: string }[]
}

export type AdminOrderPrintDocument = AdminOrderInvoiceDocument | AdminOrderFulfillmentDocument

export interface AdminOrderPrintRow {
  id: string
  status: string | null
  eligible: boolean
  reason?: string
  warnings: string[]
  document: AdminOrderPrintDocument | null
}

export interface AdminOrderPrintResponse {
  kind: AdminOrderDocumentKind
  generatedAt: string
  limit: typeof ADMIN_ORDER_PRINT_LIMIT
  rows: AdminOrderPrintRow[]
}
