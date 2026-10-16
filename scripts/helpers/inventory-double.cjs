// Contract double for existing suites focused on auth, discounts and shipping.
// Real variant allocation/locking is exercised by test-inventory and its DB suite.
class InventoryError extends Error {
  constructor(message, status = 409, code = 'STOCK_UNAVAILABLE', details = {}) { super(message); Object.assign(this, { status, code, details }) }
}
const inventoryKey = (productId, size, color) => JSON.stringify([productId, size, color])
function totals(items) {
  const result = new Map()
  for (const item of items) result.set(item.productId, (result.get(item.productId) ?? 0) + item.quantity)
  return [...result].sort(([a], [b]) => a.localeCompare(b))
}
async function reserveInventory(tx, items) {
  for (const [productId, quantity] of totals(items)) {
    const changed = await tx.product.updateMany({ where: { id: productId, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } })
    if (changed.count !== 1) {
      const product = await tx.product.findUnique({ where: { id: productId } })
      throw new InventoryError('متأسفیم، موجودی برای این سفارش کافی نیست.', 409, 'STOCK_UNAVAILABLE', {
        outOfStockDetails: [{ productId, name: product?.name ?? 'محصول', availableQuantity: product?.stock ?? 0 }],
      })
    }
  }
  return new Map(items.map(item => [inventoryKey(item.productId, item.size, item.color), `variant:${inventoryKey(item.productId, item.size, item.color)}`]))
}
async function releaseInventory(tx, items) {
  for (const [productId, quantity] of totals(items)) await tx.product.update({ where: { id: productId }, data: { stock: { increment: quantity } } })
}
module.exports = { InventoryError, inventoryKey, reserveInventory, releaseInventory }
