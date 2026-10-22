const clone = value => structuredClone(value)
function memoryInventory(initial) {
  let state = clone({ products: [], variants: [], items: [], stockMovements: [], users: [], ...initial }), queue = Promise.resolve()
  function match(row, where) {
    return Object.entries(where ?? {}).every(([key, value]) => {
      if (key === 'productId_size_color') return match(row, value)
      if (value instanceof Date) return row[key]?.getTime() === value.getTime()
      if (value && typeof value === 'object') {
        if ('gte' in value) return row[key] >= value.gte
        if ('in' in value) return value.in.includes(row[key])
      }
      return row[key] === value
    })
  }
  function apply(row, data) {
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && !(value instanceof Date) && ('increment' in value || 'decrement' in value) ? (row[key] ?? 0) + (value.increment ?? 0) - (value.decrement ?? 0) : clone(value)
  }
  function client(current) {
    const product = row => row && ({ ...clone(row), variants: clone(current().variants.filter(v => v.productId === row.id)), _count: { orderItems: current().items.filter(item => item.productId === row.id).length, stockMovements: current().stockMovements.filter(item => item.productId === row.id).length } })
    const table = (name, decorate = clone) => ({
      findUnique: async ({ where }) => decorate(current()[name].find(row => match(row, where)) ?? null),
      findUniqueOrThrow: async ({ where }) => { const row = current()[name].find(row => match(row, where)); if (!row) throw { code: 'P2025' }; return decorate(row) },
      findMany: async ({ where } = {}) => current()[name].filter(row => match(row, where)).map(row => decorate(row)),
      create: async ({ data }) => { const row = { ...(name === 'products' ? { stock:0, inventoryVersion:0, inventoryConfigured:false } : name === 'variants' ? { damagedStock:0, lowStockThreshold:2 } : {}), id: `${name}-${current()[name].length}`, ...clone(data) }; current()[name].push(row); return decorate(row) },
      update: async ({ where, data }) => { const row = current()[name].find(row => match(row, where)); if (!row) throw { code: 'P2025' }; apply(row, data); return decorate(row) },
      updateMany: async ({ where, data }) => { const rows = current()[name].filter(row => match(row, where)); rows.forEach(row => apply(row, data)); return { count: rows.length } },
      upsert: async ({ where, create, update }) => { let row = current()[name].find(row => match(row, where)); if (row) apply(row, update); else { row = { ...(name === 'variants' ? { damagedStock:0, lowStockThreshold:2 } : {}), id: `${name}-${current()[name].length}`, ...clone(create) }; current()[name].push(row) }; return decorate(row) },
    })
    return { product: table('products', product), productVariant: table('variants'), orderItem: table('items'), stockMovement: table('stockMovements'), user: table('users') }
  }
  const prisma = new Proxy({}, { get: (_, key) => key !== '$transaction' ? client(() => state)[key] : async callback => {
    let unlock; const previous = queue; queue = new Promise(resolve => { unlock = resolve }); await previous
    const draft = clone(state)
    try { const result = await callback(client(() => draft)); state = draft; return result } finally { unlock() }
  } })
  return { prisma, state: () => clone(state) }
}
module.exports = { memoryInventory }
