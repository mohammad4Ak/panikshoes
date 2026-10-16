export interface InventoryVariant {
  id: string
  size: number
  color: string
  stock: number
  isActive: boolean
}

export const inventoryKey = (productId: string, size: number, color: string) => JSON.stringify([productId, size, color])

export function productInventory<T extends { stock: number; inventoryConfigured: boolean; variants: InventoryVariant[] }>(product: T, admin = false) {
  const variants = (product.variants ?? []).filter(variant => admin || variant.isActive)
  return { ...product, variants, stock: product.inventoryConfigured ? product.stock : 0,
    ...(admin && !product.inventoryConfigured ? { legacyStock: product.stock } : {}),
  }
}
