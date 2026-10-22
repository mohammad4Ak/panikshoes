const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { memoryInventory } = require('./helpers/inventory-memory.cjs')

const root = path.resolve(__dirname, '..')
const admin = { user: { id: 'admin', name: 'مدیر', role: 'ADMIN' } }
const context = (id = 'shoe') => ({ params: Promise.resolve({ id }) })
const request = body => new Request('http://localhost/api/products', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

// Run the real validation, handlers and inventory writes with a rollback-capable
// database double. No product, account, upload or database is changed by this file.
function load(file, { session = admin, prisma = {} } = {}) {
  const cache = new Map()
  const dependencies = {
    'next/server': { NextResponse: Response },
    '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': { prisma },
    '@/lib/payments': { expireUnpaidOrders: async () => 0 },
    '@/lib/product-reviews': { withProductRatings: async products => products },
  }
  function read(relative) {
    const absolute = path.resolve(root, relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const testModule = { exports: {} }
    vm.runInNewContext(transformSync(fs.readFileSync(absolute, 'utf8'), {
      loader: 'ts', format: 'cjs', target: 'es2022',
    }).code, {
      module: testModule, Response, Request, URL, Date, Buffer,
      require(name) {
        if (name in dependencies) return dependencies[name]
        if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
        if (name.startsWith('./')) return read(path.relative(root, path.resolve(path.dirname(absolute), name + '.ts')))
        throw new Error('Unexpected dependency ' + name)
      },
    })
    cache.set(absolute, testModule.exports)
    return testModule.exports
  }
  return read(file)
}

const codes = load('src/lib/product-code.ts')
const catalog = load('src/lib/catalog-input.ts')
const input = extra => ({ code: 'NEW-00622', name: 'پانیک', price: 100, categoryId: 'cat', sizes: [38], colors: ['مشکی'], variants: [{ size: 38, color: 'مشکی', stock: 2 }], ...extra })
const baseProduct = {
  id: 'shoe', code: '00622', name: 'کتانی زنانه پانیک مدل سلین ۶۲۲', slug: 'panik-622',
  price: 100, description: 'قبلی', images: ['/shoe.png'], categoryId: 'cat', sizes: [38], colors: ['مشکی'],
  stock: 3, inventoryConfigured: true, inventoryVersion: 4,
}

function database({ conflictTarget = ['code'] } = {}) {
  const memory = memoryInventory({
    products: [baseProduct, { ...baseProduct, id: 'other', code: 'MODEL-620', slug: 'panik-620', stock: 0 }],
    variants: [{ id: 'v1', productId: 'shoe', size: 38, color: 'مشکی', stock: 3, damagedStock: 0, lowStockThreshold: 2, isActive: true }],
  })
  function wrap(client) {
    async function assertUnique(code, excludingId) {
      if (code === undefined) return
      const products = await client.product.findMany()
      if (products.some(product => product.id !== excludingId && product.code.toUpperCase() === code.toUpperCase())) {
        throw { code: 'P2002', meta: { modelName: 'Product', target: conflictTarget } }
      }
    }
    return {
      product: {
        ...client.product,
        create: async query => { await assertUnique(query.data.code); return client.product.create(query) },
        update: async query => { await assertUnique(query.data.code, query.where.id); return client.product.update(query) },
      },
      productVariant: client.productVariant, orderItem: client.orderItem, stockMovement: client.stockMovement,
      category: { findUnique: async ({ where }) => where.id === 'cat' ? { id: 'cat', name: 'کتانی' } : null },
    }
  }
  return {
    state: memory.state,
    prisma: { ...wrap(memory.prisma), $transaction: callback => memory.prisma.$transaction(client => callback(wrap(client))) },
  }
}

for (const [value, expected] of [
  ['00622', '00622'], ['  panik-۰۰۶۲۲  ', 'PANIK-00622'], ['panik-٠٠٦٢٢', 'PANIK-00622'],
  ['aB_۰۱.٢-3', 'AB_01.2-3'], ['0', '0'], ['A'.repeat(64), 'A'.repeat(64)],
]) test('Product codes canonicalize digits/case without losing zeroes: ' + JSON.stringify(value), () => {
  assert.equal(codes.productCodeField(value), expected)
})

for (const value of [undefined, null, 622, false, [], {}, '', '  ', 'A B', 'A/B', 'الف۶۲۲', 'A'.repeat(65), '\u0000', 'ß', 'ＳＫＵ', '6\u200c22', '6\n22']) {
  test('Invalid product code is rejected: ' + JSON.stringify(value), () => assert.throws(() => codes.productCodeField(value)))
}

test('New products require a code; metadata-only updates omit it and an explicit blank cannot clear it', () => {
  const missing = input(); delete missing.code
  assert.throws(() => catalog.productInput(missing, true), /کد محصول/)
  assert.equal(catalog.productInput(input({ code: ' ۰۰۶۲۲ ' }), true).code, '00622')
  assert.equal(Object.hasOwn(catalog.productInput({ name: 'نام جدید' }), 'code'), false)
  for (const code of ['', ' ', null, 622]) assert.throws(() => catalog.productInput({ code }), /کد محصول/)
})

test('Only Product code constraints get the specific collision response', () => {
  for (const target of [['code'], ['upper(code)'], 'Product_code_key', 'Product_code_upper_key', ['Product_code_upper_key']]) {
    assert.equal(codes.isProductCodeConflict({ code: 'P2002', meta: { modelName: 'Product', target } }), true)
    assert.equal(codes.isProductCodeConflict({ code: 'P2002', meta: { target } }), true)
  }
  for (const error of [null, {}, { code: 'P2025' }, { code: 'P2002' },
    { code: 'P2002', meta: { modelName: 'Coupon', target: ['code'] } },
    { code: 'P2002', meta: { modelName: 'Product', target: ['slug'] } },
  ]) assert.equal(codes.isProductCodeConflict(error), false)
})

for (const session of [null, { user: { id: 'customer', role: 'USER' } }]) {
  test('Only an admin can create or change codes: ' + JSON.stringify(session), async () => {
    const db = database(), before = db.state()
    const options = { prisma: db.prisma, session }
    assert.equal((await load('src/app/api/products/route.ts', options).POST(request(input()))).status, 401)
    assert.equal((await load('src/app/api/products/[id]/route.ts', options).PUT(request({ code: 'CHANGED' }), context())).status, 401)
    assert.deepEqual(db.state(), before)
  })
}

test('Create saves the canonical code with initial inventory and ledger atomically', async () => {
  const db = database(), api = load('src/app/api/products/route.ts', { prisma: db.prisma })
  const response = await api.POST(request(input({ code: ' panik-۰۰۶۲۲ ' })))
  assert.equal(response.status, 201)
  const product = await response.json()
  assert.equal(product.code, 'PANIK-00622')
  const state = db.state(), created = state.products.find(row => row.id === product.id)
  assert.equal(created.code, 'PANIK-00622'); assert.equal(created.stock, 2)
  assert.equal(state.variants.filter(row => row.productId === product.id).length, 1)
  const opening = state.stockMovements.find(row => row.productId === product.id)
  assert.equal(opening.type, 'OPENING'); assert.equal(opening.stockAfter, 2); assert.equal(opening.actorId, 'admin')
})

for (const code of [undefined, '', null, 622, 'A B']) test('Create rejects invalid code before any inventory/product write: ' + JSON.stringify(code), async () => {
  const db = database(), before = db.state()
  const response = await load('src/app/api/products/route.ts', { prisma: db.prisma }).POST(request(input({ code })))
  assert.equal(response.status, 400); assert.match((await response.json()).error, /کد محصول/)
  assert.deepEqual(db.state(), before)
})

for (const code of ['00622', '۰۰۶۲۲', '٠٠٦٢٢', 'model-620']) test('Create rejects a canonical duplicate without adding a product or opening balance: ' + code, async () => {
  const db = database(), before = db.state()
  const response = await load('src/app/api/products/route.ts', { prisma: db.prisma }).POST(request(input({ code })))
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PRODUCT_CODE_EXISTS')
  assert.deepEqual(db.state(), before)
})

test('Renaming a code keeps product ID, slug and stock; unchanged/omitted codes remain valid', async () => {
  const db = database(), api = load('src/app/api/products/[id]/route.ts', { prisma: db.prisma })
  assert.equal((await api.PUT(request({ code: '۰۰۶۲۲' }), context())).status, 200)
  assert.equal((await api.PUT(request({ name: 'تغییر نام' }), context())).status, 200)
  assert.equal(db.state().products[0].code, '00622')
  assert.equal((await api.PUT(request({ code: ' panik_۰۰۶۲۲.a ' }), context())).status, 200)
  const state = db.state(), product = state.products[0]
  assert.equal(product.code, 'PANIK_00622.A'); assert.equal(product.id, baseProduct.id); assert.equal(product.slug, baseProduct.slug)
  assert.equal(product.stock, 3); assert.equal(product.inventoryVersion, 4); assert.equal(state.stockMovements.length, 0)
})

for (const conflictTarget of [['code'], ['upper(code)'], 'Product_code_key', 'Product_code_upper_key']) test('Conflicting code edit rolls back inventory, dimensions and ledger: ' + conflictTarget, async () => {
  const db = database({ conflictTarget }), before = db.state()
  const response = await load('src/app/api/products/[id]/route.ts', { prisma: db.prisma }).PUT(request({
    code: 'model-۶۲۰', name: 'نباید ذخیره شود', expectedInventoryVersion: 4,
    variants: [{ size: 38, color: 'مشکی', stock: 9 }],
  }), context())
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'PRODUCT_CODE_EXISTS')
  assert.deepEqual(db.state(), before)
})

test('Two requests for the same canonical code cannot both create a product', async () => {
  const db = database(), api = load('src/app/api/products/route.ts', { prisma: db.prisma })
  const responses = await Promise.all(['new-۰۰۶۲۲', 'NEW-00622'].map(code => api.POST(request(input({ code })))))
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409])
  const products = db.state().products.filter(row => row.code === 'NEW-00622')
  assert.equal(products.length, 1)
  assert.equal(db.state().stockMovements.filter(row => row.productId === products[0].id).length, 1)
})

test('A slug collision is not mislabeled as a product-code collision', async () => {
  const db = database()
  const prisma = { ...db.prisma, $transaction: async () => { throw { code: 'P2002', meta: { modelName: 'Product', target: ['slug'] } } } }
  const response = await load('src/app/api/products/route.ts', { prisma }).POST(request(input()))
  assert.equal(response.status, 409); assert.equal((await response.json()).code, undefined)
})

test('Catalog code search normalizes digits/case and treats identifier underscores literally', async () => {
  let query
  const prisma = { product: { findMany: async value => { query = value; return [] } } }
  const response = await load('src/app/api/products/route.ts', { prisma }).GET(new Request('http://localhost/api/products?q=sku_۰۰۶۲۲&categoryId=cat'))
  assert.equal(response.status, 200)
  const code = query.where.OR.find(condition => condition.code).code
  assert.equal(code.contains, 'SKU\\_00622'); assert.equal(code.mode, 'insensitive')
  assert.equal(query.where.categoryId, 'cat')
  assert.equal(query.where.OR.find(condition => condition.name).name.contains, 'sku_۰۰۶۲۲')
})
