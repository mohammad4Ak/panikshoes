export const ADMIN_ORDER_BULK_LIMIT = 100
export const ADMIN_ORDER_BULK_BATCH_SIZE = 20

export interface AdminOrderBulkPreviewRow {
  id: string
  status: string | null
  eligible: boolean
  reason?: string
}

export interface AdminOrderBulkResult {
  id: string
  outcome: 'updated' | 'skipped' | 'error'
  reason?: string
}
