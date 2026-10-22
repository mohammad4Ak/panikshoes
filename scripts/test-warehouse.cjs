const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const cache = new Map()
  function read(relative) {
    const absolute = path.resolve(__dirname, '..', relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const result = { exports: {} }
    vm.runInNewContext(transformSync(fs.readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
      module: result, Date, URL, URLSearchParams, Response, Request, Buffer, console,
      require(name) {
        if (name in dependencies) return dependencies[name]
        if (name === 'next/server') return { NextResponse: Response }
        if (name.startsWith('node:')) return require(name)
        if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
        if (name.startsWith('./')) return read(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), name + '.ts')))
        throw new Error('Unexpected dependency ' + name)
      },
    })
    cache.set(absolute, result.exports)
    return result.exports
  }
  return read(file)
}

const warehouse = load('src/lib/warehouse.ts')
const valid = {
  productId: 'shoe', variantId: 'shoe-black-38', inventoryVersion: 4,
  type: 'RECEIPT', quantity: 3, note: 'ثبت تولید جدید', requestKey: 'request-warehouse-12345',
}
const plain = value => JSON.parse(JSON.stringify(value))

test('Warehouse accepts all supported positive-unit operations and a zero counted-stock adjustment', () => {
  for (const type of ['RECEIPT', 'DAMAGE', 'REPAIR', 'DISPOSAL']) {
    const input = warehouse.parseStockOperation({ ...valid, type })
    assert.equal(input.type, type)
    assert.equal(input.quantity, 3)
    assert.equal(input.inventoryVersion, 4)
  }
  assert.equal(warehouse.parseStockOperation({ ...valid, type: 'ADJUSTMENT', quantity: 0 }).quantity, 0)
  for (const type of ['RETURN_SELLABLE', 'RETURN_DAMAGED']) assert.equal(warehouse.parseStockOperation({ ...valid, type, orderId: 'shipped-order' }).orderId, 'shipped-order')
})

test('Warehouse input requires a reason, identities and a bounded version without accepting negative, fractional or infinite counts', () => {
  const invalid = [null, [], {}, 'stock', { ...valid, type: 'RESERVATION' }, { ...valid, type: 'UNKNOWN' }]
  for (const field of ['productId', 'variantId', 'note', 'requestKey']) {
    invalid.push({ ...valid, [field]: '' }, { ...valid, [field]: '   ' }, { ...valid, [field]: null })
  }
  invalid.push({ ...valid, stock: 900 }, { ...valid, damagedStock: 900 }, { ...valid, note: 'x'.repeat(501) }, { ...valid, requestKey: 'tiny' }, { ...valid, requestKey: 'invalid:key' }, { ...valid, productId: 'shoe\n38' })
  for (const field of ['quantity', 'inventoryVersion']) {
    for (const value of [-1, 0.5, Infinity, NaN, 2147483648, {}, true]) invalid.push({ ...valid, [field]: value })
  }
  for (const type of ['RECEIPT', 'DAMAGE', 'REPAIR', 'DISPOSAL', 'RETURN_SELLABLE', 'RETURN_DAMAGED']) invalid.push({ ...valid, type, quantity: 0, orderId: 'order' })
  for (const input of invalid) assert.throws(() => warehouse.parseStockOperation(input), { status: 400 })
})

test('Returns require an order, and other operation types cannot accidentally attach a customer return', () => {
  for (const type of ['RETURN_SELLABLE', 'RETURN_DAMAGED']) {
    for (const orderId of [undefined, null, '', '   ']) assert.throws(() => warehouse.parseStockOperation({ ...valid, type, orderId }), { status: 400 })
  }
  // Administrative receipts must not be counted against a shipped order's return allowance.
  assert.throws(() => warehouse.parseStockOperation({ ...valid, orderId: 'unrelated-order' }), { status: 400 })
})

test('Warehouse trims human notes and IDs while retaining the explicit zero counted quantity', () => {
  const input = warehouse.parseStockOperation({ ...valid, productId: ' shoe ', variantId: ' shoe-black-38 ', note: '  شمارش دستی  ', type: 'ADJUSTMENT', quantity: 0 })
  assert.equal(input.productId, 'shoe')
  assert.equal(input.variantId, 'shoe-black-38')
  assert.equal(input.note, 'شمارش دستی')
  assert.equal(input.quantity, 0)
})

test('Threshold updates reject malformed quantities and unknown fields before touching inventory', async () => {
  const threshold = { productId: 'shoe', variantId: 'variant', inventoryVersion: 2, lowStockThreshold: 3 }
  const db = new Proxy({}, { get() { throw new Error('Invalid threshold reached a database write') } })
  for (const input of [{ ...threshold, lowStockThreshold: -1 }, { ...threshold, lowStockThreshold: 0.5 }, { ...threshold, lowStockThreshold: 2147483648 }, { ...threshold, stock: 9 }, { ...threshold, variantId: '' }, { ...threshold, inventoryVersion: -1 }]) {
    await assert.rejects(warehouse.updateLowStockThreshold(db, input), { status: 400 })
  }
})

test('Warehouse read filters reject arbitrary movement types and invalid pagination', async () => {
  const client = { product: { count: async () => 0 }, productVariant: { fields: { lowStockThreshold: 'threshold-field' } }, stockMovement: { count: async () => 0 } }
  for (const query of [new URLSearchParams({ filter: 'unknown' }), new URLSearchParams({ q: 'x'.repeat(101) }), new URLSearchParams({ page: '0' }), new URLSearchParams({ page: '-1' }), new URLSearchParams({ page: '1.5' })]) await assert.rejects(warehouse.readWarehouseOverview(client, query), { status: 400 })
  for (const query of [new URLSearchParams({ type: 'DELETE_HISTORY' }), new URLSearchParams({ productId: 'invalid id' }), new URLSearchParams({ page: '0' }), new URLSearchParams({ page: 'NaN' })]) await assert.rejects(warehouse.readStockMovements(client, query), { status: 400 })
})

function warehouseSearchClient(products) {
  const matches = (product, where) => Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(condition => matches(product, condition))
    if (key === 'name' || key === 'code') {
      const literal = value.contains.replace(/\\([\\%_])/g, '$1')
      return typeof product[key] === 'string' && product[key].toLowerCase().includes(literal.toLowerCase())
    }
    return product[key] === value
  })
  return {
    product: {
      count: async ({ where }) => products.filter(product => matches(product, where)).length,
      findMany: async ({ where, skip, take }) => products.filter(product => matches(product, where)).slice(skip, skip + take),
      aggregate: async () => ({ _sum: { stock: 0 } }),
    },
    productVariant: {
      fields: { lowStockThreshold: 'threshold-field' }, count: async () => 0,
      aggregate: async () => ({ _sum: { stock: 0, damagedStock: 0 } }),
    },
    orderItem: { aggregate: async () => ({ _sum: { quantity: 0 } }), groupBy: async () => [] },
  }
}

test('Warehouse finds shoe models across English, Persian and Arabic query and stored digits', async () => {
  const products = ['622', '۶۲۲', '٦٢٢', '620'].map((model, index) => ({ id: String(index), name: `کتانی زنانه پانیک مدل سلین ${model}`, variants: [] }))
  const client = warehouseSearchClient(products)
  for (const q of ['622', '۶۲۲', '٦٢٢', '6۲٢', ' 622 ', 'سلین 622', 'سلین ۶۲۲', 'سلین ٦٢٢']) {
    const result = await warehouse.readWarehouseOverview(client, new URLSearchParams({ q }))
    assert.deepEqual(plain(result.products.map(product => product.id)), ['0', '1', '2'], q)
    assert.equal(result.pagination.total, 3, q)
  }
  assert.equal((await warehouse.readWarehouseOverview(client, new URLSearchParams({ q: 'سلین' }))).pagination.total, 4)
  assert.equal((await warehouse.readWarehouseOverview(client, new URLSearchParams({ q: '999' }))).pagination.total, 0)
})

test('Warehouse numeric search retains stock filters and database pagination', async () => {
  const products = Array.from({ length: 25 }, (_, index) => ({ id: String(index), name: `مدل ${index % 2 ? '۶۲۲' : '622'}`, inventoryConfigured: false, variants: [] }))
  products.push({ id: 'configured', name: 'مدل ۶۲۲', inventoryConfigured: true, variants: [] })
  const result = await warehouse.readWarehouseOverview(warehouseSearchClient(products), new URLSearchParams({ q: '622', filter: 'unconfigured', page: '2' }))
  assert.deepEqual(plain(result.products.map(product => product.id)), ['20', '21', '22', '23', '24'])
  assert.equal(result.pagination.total, 25)
  assert.equal(result.pagination.pages, 2)
})

test('Warehouse finds admin-defined codes with leading zeroes, letter case and equivalent digits', async () => {
  const client = warehouseSearchClient([
    { id: 'by-code', code: 'PN-00622', name: 'کفش پانیک', variants: [] },
    { id: 'other', code: 'PN-00620', name: 'کفش دیگر', variants: [] },
  ])
  for (const q of ['pn-00622', 'PN-۰۰۶۲۲', 'pn-٠٠٦٢٢', '00622']) {
    const result = await warehouse.readWarehouseOverview(client, new URLSearchParams({ q }))
    assert.deepEqual(plain(result.products.map(product => product.id)), ['by-code'])
  }
})

test('Warehouse treats LIKE pattern characters literally in every numeric search alternative', async () => {
  for (const character of ['%', '_', '\\']) {
    let where
    const client = warehouseSearchClient([])
    client.product.count = async args => { if (args.where.name || args.where.OR) where = args.where; return 0 }
    await warehouse.readWarehouseOverview(client, new URLSearchParams({ q: `${character}622` }))
    const predicates = where.OR ?? [where]
    for (const predicate of predicates) assert.equal((predicate.name ?? predicate.code).contains.startsWith(`\\${character}`), true)
  }
})

test('Conflicting reuse of an existing request key fails before a stock write', async () => {
  const movement = { id: 'old-movement', fingerprint: 'placeholder' }
  let inventoryRead = false
  const tx = {
    stockMovement: { findUnique: async () => movement },
    product: { updateMany: async () => { inventoryRead = true; throw new Error('A replay must not write stock') } },
  }
  // Fingerprint values are intentionally obtained through a first normal call in the DB suite;
  // this test checks conflicting reuse without hard-coding an internal hashing implementation.
  await assert.rejects(warehouse.applyStockOperation(tx, warehouse.parseStockOperation(valid), { id: 'admin', name: 'مدیر' }), { status: 409 })
  assert.equal(inventoryRead, false)
})

function route(file, session, prisma = {}, extra = {}) {
  return load(file, {
    '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma },
    '@/lib/request-origin': { isSameOriginRequest: () => true },
    '@/lib/warehouse': warehouse, ...extra,
  })
}
const request = (body = valid, method = 'POST') => new Request('http://localhost/api/admin/warehouse', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

// Every handler rejects guests and ordinary customer accounts before reading warehouse details.
for (const session of [null, { user: { id: 'customer', role: 'USER' } }]) {
  const label = session ? 'customer' : 'guest'
  test('Warehouse API blocks a ' + label + ' before any read or write', async () => {
    const prisma = new Proxy({}, { get() { throw new Error('Unauthorized warehouse request accessed the database') } })
    const endpoint = route('src/app/api/admin/inventory/route.ts', session, prisma)
    const readResponse = await endpoint.GET(new Request('http://localhost/api/admin/inventory'))
    assert.equal(readResponse.status, session ? 403 : 401)
    if (endpoint.POST) assert.equal((await endpoint.POST(request())).status, session ? 403 : 401)
    if (endpoint.PATCH) assert.equal((await endpoint.PATCH(request(valid, 'PATCH'))).status, session ? 403 : 401)
    const history = route('src/app/api/admin/inventory/movements/route.ts', session, prisma)
    assert.equal((await history.GET(new Request('http://localhost/api/admin/inventory/movements'))).status, session ? 403 : 401)
  })
}

test('Warehouse API rejects a foreign-origin stock mutation before accessing the database', async () => {
  const prisma = new Proxy({}, { get() { throw new Error('Cross-origin warehouse mutation accessed the database') } })
  const endpoint = route('src/app/api/admin/inventory/route.ts', { user: { id: 'admin', role: 'ADMIN', name: 'مدیر' } }, prisma, {
    '@/lib/request-origin': { isSameOriginRequest: () => false },
  })
  assert.equal((await endpoint.POST(request())).status, 403)
})

module.exports = { load, plain }
