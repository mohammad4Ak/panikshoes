import type { Prisma, PrismaClient, StockMovement } from '@prisma/client'
import { ApiInputError, integerField, textField } from './api-input'
import { InventoryError, inventoryKey } from './inventory'
import { toAsciiDigits } from './localized-input'
import { recordStockMovement } from './stock-movements'

export const warehouseOperationTypes = ['RECEIPT', 'ADJUSTMENT', 'RETURN_SELLABLE', 'RETURN_DAMAGED', 'DAMAGE', 'REPAIR', 'DISPOSAL'] as const
type OperationType = typeof warehouseOperationTypes[number]
const movementTypes = ['OPENING', ...warehouseOperationTypes, 'RESERVE', 'RELEASE', 'SALE', 'VARIANT_STATUS', 'SHIPMENT'] as const
const MAX = 2_147_483_647
const PAGE_SIZE = 20
const isReturn = (type: OperationType) => type === 'RETURN_SELLABLE' || type === 'RETURN_DAMAGED'
type WarehouseClient = Pick<PrismaClient, 'product' | 'productVariant' | 'orderItem' | 'stockMovement'>

export type StockOperation = {
  productId: string; variantId: string; inventoryVersion: number; type: OperationType
  quantity: number; note: string; requestKey: string; orderId?: string
}

function identifier(value: unknown, label: string) {
  const result = textField(value, label, 128)
  if (/[\s\u0000-\u001f\u007f]/.test(result)) throw new ApiInputError(`${label} نامعتبر است`)
  return result
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ApiInputError('فیلدهای درخواست نامعتبر است')
  return value as Record<string, unknown>
}

export function parseStockOperation(body: unknown): StockOperation {
  const input = object(body, ['productId', 'variantId', 'inventoryVersion', 'type', 'quantity', 'note', 'requestKey', 'orderId'])
  if (!warehouseOperationTypes.includes(input.type as OperationType)) throw new ApiInputError('نوع عملیات انبار نامعتبر است')
  const type = input.type as OperationType
  const note = textField(input.note, 'دلیل یا توضیح عملیات', 500)
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(note)) throw new ApiInputError('توضیح عملیات نامعتبر است')
  const requestKey = identifier(input.requestKey, 'شناسهٔ درخواست')
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey)) throw new ApiInputError('شناسهٔ درخواست نامعتبر است')
  const orderId = isReturn(type) ? identifier(input.orderId, 'شمارهٔ کامل سفارش مرجوعی') : undefined
  if (!isReturn(type) && input.orderId) throw new ApiInputError('شمارهٔ سفارش فقط برای ثبت مرجوعی قابل استفاده است')
  return {
    productId: identifier(input.productId, 'محصول'), variantId: identifier(input.variantId, 'رنگ و سایز'),
    inventoryVersion: integerField(input.inventoryVersion, 'نسخهٔ موجودی'), type,
    quantity: integerField(input.quantity, type === 'ADJUSTMENT' ? 'موجودی جدید' : 'تعداد', type === 'ADJUSTMENT' ? 0 : 1),
    note, requestKey, ...(orderId ? { orderId } : {}),
  }
}

function replay(existing: StockMovement | null, fingerprint: string) {
  if (!existing) return null
  if (existing.fingerprint !== fingerprint) throw new InventoryError('این شناسهٔ درخواست قبلاً با اطلاعات دیگری استفاده شده است.', 409, 'WAREHOUSE_REQUEST_CONFLICT')
  return { movement: existing, replayed: true }
}

/** Must run inside a transaction; every writer locks the parent product first. */
export async function applyStockOperation(tx: Prisma.TransactionClient, input: StockOperation, actor: { id: string; name?: string | null }) {
  const requestKey = `manual:${actor.id}:${input.requestKey}`
  const fingerprint = JSON.stringify([input.productId, input.variantId, input.type, input.quantity, input.note, input.orderId ?? null])
  const previous = replay(await tx.stockMovement.findUnique({ where: { requestKey } }), fingerprint)
  if (previous) return previous
  // Lock without incrementing a revision: a lost-response retry must not
  // change even the version. Re-read the key after a concurrent writer commits.
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Product" WHERE "id" = ${input.productId} FOR UPDATE`
  if (!locked.length) throw new ApiInputError('محصول یافت نشد', 404)
  const afterLock = replay(await tx.stockMovement.findUnique({ where: { requestKey } }), fingerprint)
  if (afterLock) return afterLock
  if (input.inventoryVersion >= MAX) throw new InventoryError('نسخهٔ موجودی از سقف مجاز گذشته است.', 409, 'PRODUCT_INVENTORY_CHANGED')
  const claimed = await tx.product.updateMany({ where: { id: input.productId, inventoryVersion: input.inventoryVersion }, data: { inventoryVersion: { increment: 1 } } })
  if (claimed.count !== 1) {
    throw new InventoryError('موجودی هم‌زمان تغییر کرده است؛ اطلاعات تازه را دریافت و پیش از ثبت بررسی کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  }
  const product = await tx.product.findUniqueOrThrow({ where: { id: input.productId } })
  if (!product.inventoryConfigured) throw new InventoryError('ابتدا موجودی رنگ و سایز را در بخش محصولات تنظیم کنید.', 409, 'INVENTORY_NOT_CONFIGURED')
  const variant = await tx.productVariant.findUnique({ where: { id: input.variantId } })
  if (!variant || variant.productId !== product.id) throw new ApiInputError('رنگ و سایز این محصول یافت نشد', 404)
  const aggregate = await tx.productVariant.aggregate({ where: { productId: product.id, isActive: true }, _sum: { stock: true } })
  if ((aggregate._sum.stock ?? 0) !== product.stock) throw new InventoryError('مجموع موجودی محصول نیاز به بررسی دارد.', 409, 'INVENTORY_CONFLICT')

  if (isReturn(input.type)) {
    const order = await tx.order.findUnique({ where: { id: input.orderId! }, include: { items: true } })
    if (!order || !['SHIPPED', 'DELIVERED'].includes(order.status)) throw new InventoryError('فقط کالای سفارش ارسال‌شده یا تحویل‌شده را می‌توان مرجوع کرد.', 409, 'RETURN_NOT_SHIPPED')
    const shipped = order.items.filter(item => item.productId === product.id && item.size === variant.size && item.color === variant.color && (!item.variantId || item.variantId === variant.id)).reduce((sum, item) => sum + item.quantity, 0)
    const returned = await tx.stockMovement.aggregate({ where: { orderId: order.id, productId: product.id, size: variant.size, color: variant.color, type: { in: ['RETURN_SELLABLE', 'RETURN_DAMAGED'] } }, _sum: { quantity: true } })
    if (!shipped || input.quantity > shipped - (returned._sum.quantity ?? 0)) throw new InventoryError('تعداد مرجوعی از تعداد ارسال‌شده و مرجوع‌نشدهٔ همین رنگ و سایز بیشتر است.', 409, 'RETURN_QUANTITY_EXCEEDED')
  }

  let stockAfter = variant.stock, damagedAfter = variant.damagedStock
  switch (input.type) {
    case 'RECEIPT': case 'RETURN_SELLABLE': stockAfter += input.quantity; break
    case 'ADJUSTMENT': stockAfter = input.quantity; break
    case 'RETURN_DAMAGED': damagedAfter += input.quantity; break
    case 'DAMAGE': stockAfter -= input.quantity; damagedAfter += input.quantity; break
    case 'REPAIR': damagedAfter -= input.quantity; stockAfter += input.quantity; break
    case 'DISPOSAL': damagedAfter -= input.quantity; break
  }
  const productAfter = product.stock + (variant.isActive ? stockAfter - variant.stock : 0)
  if ([stockAfter, damagedAfter, productAfter].some(count => !Number.isSafeInteger(count) || count < 0 || count > MAX)) throw new InventoryError('تعداد واردشده از موجودی قابل برداشت یا سقف مجاز بیشتر است.', 409, 'WAREHOUSE_BALANCE_INVALID')
  await tx.productVariant.update({ where: { id: variant.id }, data: { stock: stockAfter, damagedStock: damagedAfter } })
  if (productAfter !== product.stock) await tx.product.update({ where: { id: product.id }, data: { stock: productAfter } })
  const movement = await recordStockMovement(tx, {
    product, variant, type: input.type,
    quantity: input.type === 'ADJUSTMENT' ? Math.abs(stockAfter - variant.stock) : input.quantity,
    stockBefore: variant.stock, stockAfter, damagedBefore: variant.damagedStock, damagedAfter,
    context: { actorId: actor.id, actorName: actor.name || 'مدیر فروشگاه', orderId: input.orderId, note: input.note, requestKey, fingerprint },
  })
  return { movement, replayed: false }
}

export async function updateLowStockThreshold(tx: Prisma.TransactionClient, body: unknown) {
  const input = object(body, ['productId', 'variantId', 'inventoryVersion', 'lowStockThreshold'])
  const productId = identifier(input.productId, 'محصول'), variantId = identifier(input.variantId, 'رنگ و سایز')
  const version = integerField(input.inventoryVersion, 'نسخهٔ موجودی'), threshold = integerField(input.lowStockThreshold, 'حد هشدار موجودی')
  if (version >= MAX) throw new InventoryError('نسخهٔ موجودی از سقف مجاز گذشته است.', 409, 'PRODUCT_INVENTORY_CHANGED')
  const claimed = await tx.product.updateMany({ where: { id: productId, inventoryVersion: version }, data: { inventoryVersion: { increment: 1 } } })
  if (claimed.count !== 1) throw new InventoryError('موجودی یا تنظیم هشدار هم‌زمان تغییر کرده است؛ اطلاعات تازه را دریافت کنید.', 409, 'PRODUCT_INVENTORY_CHANGED')
  const variant = await tx.productVariant.findUnique({ where: { id: variantId } })
  if (!variant || variant.productId !== productId) throw new ApiInputError('رنگ و سایز این محصول یافت نشد', 404)
  return tx.productVariant.update({ where: { id: variantId }, data: { lowStockThreshold: threshold } })
}

function pageNumber(query: URLSearchParams) {
  const value = query.get('page') ?? '1'
  if (!/^\d{1,7}$/.test(value) || Number(value) < 1) throw new ApiInputError('شمارهٔ صفحه نامعتبر است')
  return Number(value)
}
function pagination(page: number, total: number) { return { page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), pageSize: PAGE_SIZE } }

function productSearch(query: string): Prisma.ProductWhereInput {
  const ascii = toAsciiDigits(query)
  const alternatives = new Set([
    query, ascii,
    ascii.replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]),
    ascii.replace(/\d/g, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]),
  ])
  // PostgreSQL contains uses LIKE, so keep wildcard characters literal.
  return { OR: [
    { code: { contains: ascii.toUpperCase().replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } },
    ...[...alternatives].map(value => ({ name: { contains: value.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const } })),
  ] }
}

export async function readWarehouseOverview(client: WarehouseClient, query = new URLSearchParams()) {
  const q = (query.get('q') ?? '').trim()
  if (q.length > 100) throw new ApiInputError('عبارت جستجو بیش از حد طولانی است')
  const filter = query.get('filter') || 'all'
  if (!['all', 'low', 'unconfigured', 'damaged'].includes(filter)) throw new ApiInputError('فیلتر انبار نامعتبر است')
  const low: Prisma.ProductVariantWhereInput = { isActive: true, stock: { lte: client.productVariant.fields.lowStockThreshold }, product: { inventoryConfigured: true } }
  const where: Prisma.ProductWhereInput = {
    ...(q ? productSearch(q) : {}),
    ...(filter === 'unconfigured' ? { inventoryConfigured: false } : {}),
    ...(filter === 'low' ? { variants: { some: low } } : {}),
    ...(filter === 'damaged' ? { variants: { some: { damagedStock: { gt: 0 } } } } : {}),
  }
  const total = await client.product.count({ where })
  const page = Math.min(pageNumber(query), Math.max(1, Math.ceil(total / PAGE_SIZE)))
  const [products, available, damaged, inactive, lowCount, unconfiguredCount, reserved, unallocated] = await Promise.all([
    client.product.findMany({ where, select: { id: true, code: true, name: true, images: true, inventoryVersion: true, inventoryConfigured: true,
      variants: { orderBy: [{ isActive: 'desc' }, { size: 'asc' }, { color: 'asc' }], select: { id: true, size: true, color: true, stock: true, damagedStock: true, isActive: true, lowStockThreshold: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    client.productVariant.aggregate({ where: { isActive: true, product: { inventoryConfigured: true } }, _sum: { stock: true } }),
    client.productVariant.aggregate({ _sum: { damagedStock: true } }),
    client.productVariant.aggregate({ where: { isActive: false }, _sum: { stock: true } }),
    client.productVariant.count({ where: low }), client.product.count({ where: { inventoryConfigured: false } }),
    client.orderItem.aggregate({ where: { order: { status: { in: ['PENDING', 'PROCESSING'] } } }, _sum: { quantity: true } }),
    client.product.aggregate({ where: { inventoryConfigured: false }, _sum: { stock: true } }),
  ])
  const reservedRows = products.length ? await client.orderItem.groupBy({ by: ['productId', 'size', 'color'],
    where: { productId: { in: products.map(product => product.id) }, order: { status: { in: ['PENDING', 'PROCESSING'] } } }, _sum: { quantity: true } }) : []
  const reservations = new Map(reservedRows.map(row => [inventoryKey(row.productId, row.size, row.color), row._sum.quantity ?? 0]))
  return {
    summary: { available: available._sum.stock ?? 0, reserved: reserved._sum.quantity ?? 0, damaged: damaged._sum.damagedStock ?? 0,
      inactive: inactive._sum.stock ?? 0, lowCount, unconfiguredCount, unallocated: unallocated._sum.stock ?? 0 },
    products: products.map(product => ({ ...product, variants: product.variants.map(variant => ({ ...variant, reserved: reservations.get(inventoryKey(product.id, variant.size, variant.color)) ?? 0 })) })),
    pagination: pagination(page, total),
  }
}

export async function readStockMovements(client: Pick<PrismaClient, 'stockMovement'>, query = new URLSearchParams()) {
  const productId = query.get('productId'), type = query.get('type')
  if (productId && (productId.length > 128 || /[\s\u0000-\u001f\u007f]/.test(productId))) throw new ApiInputError('محصول نامعتبر است')
  if (type && !movementTypes.includes(type as typeof movementTypes[number])) throw new ApiInputError('نوع گردش نامعتبر است')
  const where: Prisma.StockMovementWhereInput = { ...(productId ? { productId } : {}), ...(type ? { type: type as typeof movementTypes[number] } : {}) }
  const total = await client.stockMovement.count({ where }), page = Math.min(pageNumber(query), Math.max(1, Math.ceil(total / PAGE_SIZE)))
  const movements = await client.stockMovement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    select: { id: true, productId: true, productName: true, variantId: true, size: true, color: true, type: true, quantity: true,
      stockBefore: true, stockAfter: true, damagedBefore: true, damagedAfter: true, activeBefore: true, activeAfter: true,
      actorId: true, actorName: true, orderId: true, note: true, createdAt: true } })
  return { movements, pagination: pagination(page, total) }
}
