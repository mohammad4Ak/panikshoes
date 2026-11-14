/** Browser-safe contract for the Excel inventory import workflow. */
export const MAX_WAREHOUSE_IMPORT_FILE_BYTES = 4 * 1024 * 1024
export const MAX_WAREHOUSE_IMPORT_ROWS = 1000
export const MAX_WAREHOUSE_IMPORT_PRODUCT_ROWS = 500
export const MAX_WAREHOUSE_IMPORT_TOKEN_CHARS = 900_000
export const WAREHOUSE_IMPORT_MODES = ['RECEIPT', 'ADJUSTMENT'] as const
export type WarehouseImportMode = typeof WAREHOUSE_IMPORT_MODES[number]
export type WarehouseImportCell = { text: string; error?: string; numeric?: boolean }
export type WarehouseImportSheet = { name: string; columnCount: number; rows: { rowNumber: number; cells: WarehouseImportCell[] }[] }
export type WarehouseImportSourceRow = {
  rowNumber: number; code: string; size: string; color: string; quantity: string; sourceError?: string
}
export type WarehouseImportPreviewInput = { mode: WarehouseImportMode; note: string; rows: WarehouseImportSourceRow[] }
export type WarehouseImportPreviewRow = {
  rowNumber: number; code: string; size: number | null; color: string; quantity: number | null
  productId?: string; variantId?: string; productName?: string; inventoryVersion?: number
  stockBefore?: number; stockAfter?: number; reserved?: number; damaged?: number; isActive?: boolean
  error?: string; warning?: string
}
export type WarehouseImportProduct = { productId: string; productName: string; code: string; inventoryVersion: number; rowNumbers: number[] }
export type WarehouseImportPreview = {
  token: string; expiresAt: number; rows: WarehouseImportPreviewRow[]; products: WarehouseImportProduct[]
  summary: { total: number; valid: number; invalid: number; products: number }
}
export type WarehouseImportConfirmInput = { token: string; productId: string }
export type WarehouseImportResult = {
  rowNumber: number; productId: string; variantId: string; status: 'success' | 'replayed' | 'error'
  stockBefore?: number; stockAfter?: number; error?: string
}
export type WarehouseImportConfirmation = {
  productId: string; results: WarehouseImportResult[]; totals: { success: number; replayed: number; error: number }
}
