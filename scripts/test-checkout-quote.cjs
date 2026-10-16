const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const code = transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const loaded = { exports: {} }
  vm.runInNewContext(code, { module: loaded, URL, Request, Response, Date, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return loaded.exports
}
const pricing = load('src/lib/pricing.ts')
const coupons = load('src/lib/coupons.ts')
const shipping = load('src/lib/shipping.ts')
const origin = load('src/lib/request-origin.ts')
const contract = load('src/lib/checkout-quote-contract.ts')
const product = { id: 'shoe', price: 100000, salePrice: 80000, saleStartsAt: null, saleEndsAt: null }
const carrier = { id: 'post', isActive: true, baseCost: 50000, additionalItemCost: 10000, freeShippingThreshold: 150000 }
const coupon = { id: 'coupon', code: 'PANIK10', name: 'پانیک', type: 'PERCENT', value: 10, maxDiscount: null,
  minSubtotal: 0, maxUses: 5, perUserLimit: 1, startsAt: null, endsAt: null, isActive: true, deletedAt: null, usedCount: 0, version: 1 }

function harness(options = {}) {
  let reads = 0, writes = 0
  const products = options.products ?? [product]
  const selectedCoupon = { ...coupon, ...options.coupon }
  const transaction = {
    product: { findMany: async ({ where }) => { reads++; return products.filter((p) => where.id.in.includes(p.id)) } },
    shippingMethod: { findUnique: async ({ where }) => { reads++; return where.id === carrier.id ? { ...carrier, ...options.carrier } : null } },
    coupon: { findUnique: async ({ where }) => { reads++; return where.code === selectedCoupon.code ? selectedCoupon : null }, updateMany: async () => { writes++; throw new Error('Quote must not reserve') } },
    couponRedemption: { count: async () => { reads++; return options.userUses ?? 0 }, create: async () => { writes++; throw new Error('Quote must not reserve') } },
  }
  let checkoutLookup
  const prisma = { $transaction: async (callback) => callback(transaction), order: { findFirst: async (query) => { checkoutLookup = query; return options.existingOrder ?? null } } }
  const route = load('src/app/api/checkout/quote/route.ts', {
    'next/server': { NextResponse: Response }, '@/lib/prisma': { prisma }, '@/lib/auth': { auth: async () => options.anonymous ? null : { user: { id: 'customer' } } },
    '@/lib/coupons': coupons, '@/lib/pricing': pricing, '@/lib/shipping': shipping, '@/lib/payments': { expireUnpaidOrders: async () => 0 }, '@/lib/request-origin': origin,
  })
  return { route, metrics: () => ({ reads, writes }), lookup: () => checkoutLookup }
}
const body = (extra = {}) => ({ items: [{ productId: 'shoe', quantity: 2 }], shippingMethodId: 'post', couponCode: 'PANIK10', ...extra })
const request = (value, extraHeaders = {}) => new Request('http://localhost/api/checkout/quote', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...extraHeaders }, body: JSON.stringify(value),
})

test('Checkout quote ignores forged client prices, applies direct sale then coupon, and uses net merchandise for free shipping', async () => {
  const h = harness()
  const response = await h.route.POST(request(body({ items: [{ productId: 'shoe', quantity: 2, price: 1 }], total: 1, couponDiscount: 999999 })))
  assert.equal(response.status, 200)
  const quote = await response.json()
  assert.equal(quote.grossSubtotal, 200000)
  assert.equal(quote.subtotal, 160000)
  assert.equal(quote.productDiscount, 40000)
  assert.equal(quote.couponDiscount, 16000)
  assert.equal(quote.shippingCost, 60000)
  assert.equal(quote.total, 204000)
  assert.equal(quote.couponCode, 'PANIK10')
  assert.deepEqual(quote.productPrices, [{ productId: 'shoe', price: 80000, originalPrice: 100000 }])
  assert.ok(contract.isCheckoutQuote(quote))
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(h.metrics().writes, 0)
})

test('Anonymous visitors can see current product and shipping totals but cannot apply a coupon', async () => {
  const h = harness({ anonymous: true })
  const quote = await h.route.POST(request(body({ couponCode: '' })))
  assert.equal(quote.status, 200)
  const data = await quote.json()
  assert.equal(data.couponDiscount, 0)
  assert.equal(data.shippingCost, 0)
  assert.equal(data.total, 160000)
  const denied = harness({ anonymous: true })
  assert.equal((await denied.route.POST(request(body()))).status, 401)
  assert.equal(denied.metrics().reads, 0)
})

test('Expired scheduled product discounts restore the original price and coupons are calculated from that current value', async () => {
  const h = harness({ products: [{ ...product, saleEndsAt: new Date('2000-01-01T00:00:00Z') }] })
  const data = await (await h.route.POST(request(body()))).json()
  assert.equal(data.productDiscount, 0)
  assert.equal(data.subtotal, 200000)
  assert.equal(data.couponDiscount, 20000)
  assert.equal(data.total, 180000)
})

test('A quote enforces active period, minimum basket and user/global limits without consuming a use', async () => {
  for (const options of [{ coupon: { isActive: false } }, { coupon: { endsAt: new Date('2000-01-01T00:00:00Z') } },
    { coupon: { minSubtotal: 200000 } }, { coupon: { usedCount: 5 } }, { userUses: 1 }]) {
    const h = harness(options)
    const response = await h.route.POST(request(body()))
    assert.ok([400, 409].includes(response.status))
    assert.match((await response.json()).code, /^COUPON_/)
    assert.equal(h.metrics().writes, 0)
  }
})

test('Quote rejects unsafe origins and malformed basket inputs before reading stored data', async () => {
  const foreign = harness()
  assert.equal((await foreign.route.POST(request(body(), { Origin: 'https://evil.test' }))).status, 403)
  assert.equal(foreign.metrics().reads, 0)
  for (const input of [null, [], body({ items: [] }), body({ items: [{ productId: 'shoe', quantity: -1 }] }),
    body({ items: [{ productId: 'shoe', quantity: 1.5 }] }), body({ couponCode: {} }), body({ shippingMethodId: '' })]) {
    const h = harness()
    assert.equal((await h.route.POST(request(input))).status, 400)
    assert.equal(h.metrics().reads, 0)
  }
})

test('Missing products, inactive carriers and monetary overflow do not produce an actionable quote', async () => {
  for (const options of [{ products: [] }, { carrier: { isActive: false } }, { products: [{ ...product, price: 2147483647, salePrice: null }] }]) {
    const h = harness(options)
    const response = await h.route.POST(request(body({ couponCode: null })))
    assert.ok([400, 409].includes(response.status))
  }
})

test('Client quote guard rejects inconsistent totals and malformed price updates', () => {
  const valid = { grossSubtotal: 200000, subtotal: 160000, productDiscount: 40000, couponDiscount: 16000, shippingCost: 60000, total: 204000, couponCode: 'PANIK10', productPrices: [{ productId: 'shoe', price: 80000, originalPrice: 100000 }] }
  assert.ok(contract.isCheckoutQuote(valid))
  for (const invalid of [null, { ...valid, total: 1 }, { ...valid, couponDiscount: 160001 }, { ...valid, shippingCost: -1 }, { ...valid, productPrices: [{ productId: 'shoe', price: 80000, originalPrice: 1 }] }]) assert.equal(contract.isCheckoutQuote(invalid), false)
})

test('An owned committed checkout remains recoverable before rechecking its now-exhausted coupon', async () => {
  const key = '5f2727c3-580a-4d74-bb95-e0acbd6cb848'
  const h = harness({ coupon: { usedCount: 5 }, userUses: 1, existingOrder: { id: 'owned-order' } })
  const response = await h.route.POST(request(body({ checkoutKey: key })))
  assert.equal(response.status, 409)
  const data = await response.json()
  assert.equal(data.code, 'CHECKOUT_ALREADY_CREATED')
  assert.equal(data.existingOrderId, 'owned-order')
  assert.equal(h.lookup().where.userId, 'customer')
  assert.equal(h.lookup().where.checkoutKey, `customer:${key}`)
  assert.equal(h.metrics().reads, 0)
  const anonymous = harness({ anonymous: true, existingOrder: { id: 'another-order' } })
  assert.equal((await anonymous.route.POST(request(body({ checkoutKey: key })))).status, 401)
  assert.equal(anonymous.lookup(), undefined)
  const invalid = harness()
  assert.equal((await invalid.route.POST(request(body({ checkoutKey: 'bad-key' })))).status, 400)
  assert.equal(invalid.lookup(), undefined)
})
