import type { Prisma } from '@prisma/client'
import { ApiInputError, integerField, textField } from './api-input'
import { inventoryKey } from './inventory-contract'
export { inventoryKey } from './inventory-contract'

export class InventoryError extends Error {
  constructor(message: string, public status = 409, public code = 'STOCK_UNAVAILABLE', public details: {
    outOfStockDetails?: { productId: string; name: string; size: number; color: string; availableQuantity: number }[]
  } = {}) { super(message); this.name = 'InventoryError' }
}

export interface InventoryItem { productId: string; size: number; color: string; quantity: number; variantId?: string | null }
export interface InventoryRow { size: number; color: string; stock: number }
const MAX_AMOUNT = 2_147_483_647

export function parseInventoryRows(value: unknown, sizes: number[], colors: string[]): InventoryRow[] {
  const choices = colors.length ? colors : ['-']
  const expectedCount = sizes.length * choices.length
  if (expectedCount > 500 || !Array.isArray(value) || value.length !== expectedCount || value.length > 500) {
    throw new ApiInputError('برای هر ترکیب رنگ و سایز یک موجودی ثبت کنید (حداکثر ۵۰۰ ترکیب)')
  }
  const seen = new Set<string>()
  const rows = value.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiInputError('موجودی ترکیب نامعتبر است')
    const row = { size: integerField(input.size, 'سایز', 1), color: textField(input.color, 'رنگ', 100), stock: integerField(input.stock, 'موجودی ترکیب') }
    const key = inventoryKey('', row.size, row.color)
    if (!sizes.includes(row.size) || !choices.includes(row.color) || seen.has(key)) throw new ApiInputError('ترکیب رنگ و سایز تکراری یا نامعتبر است')
    seen.add(key)
    return row
  })
  if (rows.reduce((sum, row) => sum + row.stock, 0) > MAX_AMOUNT) throw new ApiInputError('مجموع موجودی از سقف مجاز بیشتر است')
  return rows
}

function groups(items: InventoryItem[]) {
  const products = new Map<string, Map<string, InventoryItem>>()
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_AMOUNT || !Number.isSafeInteger(item.size) || item.size < 1 || !item.color) throw new InventoryError('مشخصات موجودی معتبر نیست', 400)
    const entries = products.get(item.productId) ?? new Map<string, InventoryItem>()
    const key = inventoryKey(item.productId, item.size, item.color)
    const previous = entries.get(key)
    const quantity = (previous?.quantity ?? 0) + item.quantity
    if (quantity > MAX_AMOUNT || (previous?.variantId && item.variantId && previous.variantId !== item.variantId)) throw new InventoryError('مشخصات موجودی معتبر نیست', 400)
    entries.set(key, { ...item, variantId: previous?.variantId ?? item.variantId, quantity })
    products.set(item.productId, entries)
  }
  return [...products].sort(([left], [right]) => left.localeCompare(right))
}

function unavailable(productId: string, name: string, item: InventoryItem, availableQuantity = 0) {
  return new InventoryError(`متأسفیم، موجودی «${name}» در رنگ ${item.color === '-' ? 'انتخاب‌شده' : item.color} و سایز ${item.size.toLocaleString('fa-IR')} کافی نیست.`, 409, 'STOCK_UNAVAILABLE', {
    outOfStockDetails: [{ productId, name, size: item.size, color: item.color, availableQuantity }],
  })
}

export function assertInventoryAvailable(product: { id: string; name: string; inventoryConfigured: boolean; variants: { id: string; size: number; color: string; stock: number; isActive: boolean }[] }, items: InventoryItem[]) {
  if (!product.inventoryConfigured) throw new InventoryError('موجودی رنگ و سایز این محصول هنوز توسط فروشگاه تنظیم نشده است.', 409, 'INVENTORY_NOT_CONFIGURED')
  for (const [, entries] of groups(items)) for (const item of entries.values()) {
    const variant = product.variants.find(row => row.size === item.size && row.color === item.color && row.isActive)
    if (!variant || variant.stock < item.quantity) throw unavailable(product.id, product.name, item, variant?.stock ?? 0)
  }
}

/** Parent product locks serialize all edits/movements; variant guards prevent overselling a combination. */
export async function reserveInventory(tx: Prisma.TransactionClient, items: InventoryItem[], options: { allowLegacy?: boolean } = {}): Promise<Map<string, string>> {
  const variants = new Map<string, string>()
  for (const [productId, entries] of groups(items)) {
    // An increment both locks and invalidates every stale admin inventory form.
    const locked = await tx.product.update({ where: { id: productId }, data: { inventoryVersion: { increment: 1 } } }).catch(error => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') throw unavailable(productId, 'محصول', entries.values().next().value!)
      throw error
    })
    const quantity = [...entries.values()].reduce((sum, item) => sum + item.quantity, 0)
    if (!Number.isSafeInteger(quantity) || quantity > MAX_AMOUNT) throw new InventoryError('تعداد سفارش از سقف مجاز بیشتر است', 400)
    if (!locked.inventoryConfigured) {
      if (!options.allowLegacy) throw new InventoryError('موجودی رنگ و سایز این محصول هنوز توسط فروشگاه تنظیم نشده است.', 409, 'INVENTORY_NOT_CONFIGURED')
      const changed = await tx.product.updateMany({ where: { id: productId, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } })
      if (changed.count !== 1) throw unavailable(productId, locked.name, entries.values().next().value!)
      continue
    }
    for (const [key, item] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
      const variant = await tx.productVariant.findUnique({ where: { productId_size_color: { productId, size: item.size, color: item.color } } })
      if (!variant || !variant.isActive || (item.variantId && variant.id !== item.variantId)) throw unavailable(productId, locked.name, item)
      const changed = await tx.productVariant.updateMany({ where: { id: variant.id, isActive: true, stock: { gte: item.quantity } }, data: { stock: { decrement: item.quantity } } })
      if (changed.count !== 1) throw unavailable(productId, locked.name, item, variant.stock)
      variants.set(key, variant.id)
    }
    const changed = await tx.product.updateMany({ where: { id: productId, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } })
    if (changed.count !== 1) throw new InventoryError('مجموع موجودی محصول نیاز به بررسی دارد.', 409, 'INVENTORY_CONFLICT')
  }
  return variants
}

/** Retired variants keep their own returned units; they do not inflate sellable stock. */
export async function releaseInventory(tx: Prisma.TransactionClient, items: InventoryItem[]): Promise<void> {
  for (const [productId, entries] of groups(items)) {
    const product = await tx.product.update({ where: { id: productId }, data: { inventoryVersion: { increment: 1 } } })
    let available = 0
    if (!product.inventoryConfigured) available = [...entries.values()].reduce((sum, item) => sum + item.quantity, 0)
    else for (const item of entries.values()) {
      // Resolve after the parent lock: a legacy order snapshot may predate the
      // administrator's conversion to variants in a concurrent transaction.
      const variant = await tx.productVariant.findUnique({ where: { productId_size_color: { productId, size: item.size, color: item.color } } })
      if (!variant || (item.variantId && item.variantId !== variant.id)) throw new InventoryError('ترکیب تاریخی سفارش یافت نشد؛ موجودی نیاز به بررسی دارد.', 409, 'INVENTORY_CONFLICT')
      if (variant.stock > MAX_AMOUNT - item.quantity) throw new InventoryError('موجودی ترکیب از سقف مجاز بیشتر می‌شود.', 409, 'INVENTORY_CONFLICT')
      await tx.productVariant.update({ where: { id: variant.id }, data: { stock: { increment: item.quantity } } })
      if (variant.isActive) available += item.quantity
    }
    if (product.stock > MAX_AMOUNT - available) throw new InventoryError('مجموع موجودی از سقف مجاز بیشتر می‌شود.', 409, 'INVENTORY_CONFLICT')
    if (available) await tx.product.update({ where: { id: productId }, data: { stock: { increment: available } } })
  }
}

/** Explicit admin allocation; historical rows/identities are never deleted or renamed. */
export async function configureInventory(tx: Prisma.TransactionClient, productId: string, rows: InventoryRow[], expectedVersion: number, dimensions: { sizes: number[]; colors: string[] }) {
  const claimed = await tx.product.updateMany({ where: { id: productId, inventoryVersion: expectedVersion }, data: {
    inventoryVersion: { increment: 1 }, inventoryConfigured: true, stock: rows.reduce((sum, row) => sum + row.stock, 0), ...dimensions,
  } })
  if (claimed.count !== 1) throw new InventoryError('موجودی رنگ یا سایز هم‌زمان تغییر کرده است؛ اطلاعات تازه را دریافت و بررسی کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  await tx.productVariant.updateMany({ where: { productId }, data: { isActive: false } })
  for (const row of rows) await tx.productVariant.upsert({
    where: { productId_size_color: { productId, size: row.size, color: row.color } },
    create: { productId, ...row, isActive: true }, update: { stock: row.stock, isActive: true },
  })
  const historical = await tx.orderItem.findMany({ where: { productId, variantId: null }, select: { size: true, color: true }, distinct: ['size', 'color'] })
  for (const item of historical) {
    const variant = await tx.productVariant.upsert({
      where: { productId_size_color: { productId, size: item.size, color: item.color } },
      create: { productId, size: item.size, color: item.color, stock: 0, isActive: false }, update: {},
    })
    await tx.orderItem.updateMany({ where: { productId, size: item.size, color: item.color, variantId: null }, data: { variantId: variant.id } })
  }
}
