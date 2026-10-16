const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const inventory = require('./helpers/inventory-double.cjs')

// Run the real handler with isolated auth/database dependencies; no live orders are touched.
const source = readFileSync(path.join(__dirname, '../src/app/api/orders/route.ts'), 'utf8')
const { code } = transformSync(source, {
  loader: 'ts', format: 'cjs', target: 'es2022',
})
const shippingSource = readFileSync(path.join(__dirname, '../src/lib/shipping.ts'), 'utf8')
const shippingContext = { module: { exports: {} } }
vm.runInNewContext(transformSync(shippingSource, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, shippingContext)
const pricingContext = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/pricing.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, pricingContext)
const couponsContext = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/coupons.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, couponsContext)

function loadHandler(session, prismaOverrides = {}) {
  const queries = []
  const rows = [{ id: 'order-1' }]
  const dependencies = {
    'node:crypto': require('node:crypto'),
    'next/server': { NextResponse: Response }, '@/lib/request-origin': { isSameOriginRequest: () => true },
    '@/lib/shipping': shippingContext.module.exports,
    '@/lib/pricing': pricingContext.module.exports, '@/lib/coupons': couponsContext.module.exports,
    '@/lib/inventory': inventory,
    '@/lib/payments': { expireUnpaidOrders: async () => 0, methodAvailability: (method) => ({ available: Boolean(method.cardNumber && method.cardholderName) }) }, '@/lib/payment-contract': { PAYMENT_WINDOW_MS: 600000 },
    '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': {
      prisma: { order: { findMany: async (query) => { queries.push(query); return rows } }, ...prismaOverrides },
    },
  }
  const context = { module: { exports: {} }, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } }
  vm.runInNewContext(code, context)
  return { GET: context.module.exports.GET, POST: context.module.exports.POST, queries, rows }
}

for (const session of [null, {}, { user: {} }, { user: { role: 'ADMIN' } }, { user: { id: '' } }]) {
  test(`Reject missing identity: ${JSON.stringify(session)}`, async () => {
    const { GET, queries } = loadHandler(session)
    const response = await GET()
    assert.equal(response.status, 401)
    assert.equal(queries.length, 0)
  })
}

test('Customers only query their own orders', async () => {
  const { GET, queries, rows } = loadHandler({ user: { id: 'customer-1', role: 'USER' } })
  const response = await GET()
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(queries[0].where)), { userId: 'customer-1' })
  assert.deepEqual(await response.json(), rows)
})

test('Authenticated admins can query all orders', async () => {
  const { GET, queries } = loadHandler({ user: { id: 'admin-1', role: 'ADMIN' } })
  assert.equal((await GET()).status, 200)
  assert.deepEqual(Object.keys(queries[0].where), [])
})

test('Checkout accepts every catalog-valid color length through 100 characters', async () => {
  for (const length of [81, 100, 101]) {
    const color = 'م'.repeat(length)
    const product = { id: 'shoe', name: 'پانیک', price: 100, stock: 2, sizes: [38], colors: [color] }
    let reservations = 0
    const tx = {
      product: {
        findUnique: async () => product,
        updateMany: async () => { reservations++; return { count: 1 } },
      },
      paymentMethod: { findUnique: async () => ({ id: 'bank_transfer', isActive: true, cardNumber: 'saved-card', cardholderName: 'فروشگاه' }) },
      shippingMethod: { findUnique: async () => ({ id: 'post', name: 'پست', isActive: true, baseCost: 0, additionalItemCost: 0, freeShippingThreshold: null }) },
      order: { create: async ({ data }) => ({ id: 'order', ...data, items: data.items.create }) },
    }
    const { POST } = loadHandler({ user: { id: 'buyer', role: 'USER', name: 'خریدار' } }, {
      product: tx.product, $transaction: callback => callback(tx),
    })
    const response = await POST(new Request('http://localhost/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        items: [{ productId: 'shoe', size: 38, color, quantity: 1 }], address: 'نشانی خریدار', phone: '09123456789',
        paymentMethodId: 'bank_transfer', shippingMethodId: 'post', expectedSubtotal: 100, expectedShippingCost: 0,
      }),
    }))
    assert.equal(response.status, length <= 100 ? 201 : 400, `Color length ${length}`)
    assert.equal(reservations, length <= 100 ? 1 : 0)
    if (length <= 100) assert.equal((await response.json()).items[0].color, color)
  }
})
