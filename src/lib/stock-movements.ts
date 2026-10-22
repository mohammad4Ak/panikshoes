import type { Prisma, StockMovementType } from '@prisma/client'

export type MovementContext = {
  actorId?: string
  actorName?: string
  orderId?: string
  note?: string
  requestKey?: string
  fingerprint?: string
}

type MovementInput = {
  product: { id: string; name: string }
  variant?: { id?: string | null; size?: number | null; color?: string | null; isActive?: boolean }
  type: StockMovementType
  quantity: number
  stockBefore: number
  stockAfter: number
  damagedBefore?: number
  damagedAfter?: number
  activeBefore?: boolean
  activeAfter?: boolean
  context?: MovementContext
}

/** Append inside the same transaction as the guarded inventory change. */
export function recordStockMovement(tx: Prisma.TransactionClient, input: MovementInput) {
  const context = input.context ?? {}
  return tx.stockMovement.create({ data: {
    productId: input.product.id, productName: input.product.name,
    variantId: input.variant?.id ?? null, size: input.variant?.size ?? null, color: input.variant?.color ?? null,
    type: input.type, quantity: input.quantity, stockBefore: input.stockBefore, stockAfter: input.stockAfter,
    damagedBefore: input.damagedBefore ?? 0, damagedAfter: input.damagedAfter ?? 0,
    activeBefore: input.activeBefore ?? input.variant?.isActive ?? true,
    activeAfter: input.activeAfter ?? input.variant?.isActive ?? true,
    actorId: context.actorId ?? null, actorName: context.actorName || (context.actorId ? 'کاربر ثبت‌شده' : 'سیستم'), orderId: context.orderId ?? null,
    note: context.note ?? '', requestKey: context.requestKey ?? null, fingerprint: context.fingerprint ?? null,
  } })
}
