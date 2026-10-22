// Exercise the real profile guard and checkout transaction, never the legacy
// checkout-profile double used by the shipping/inventory-only test suites.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')
const { createHash, randomUUID } = require('node:crypto')
const { memoryInventory } = require('./helpers/inventory-memory.cjs')
const root = path.join(__dirname, '..')
const clone = value => structuredClone(value)
const defaults = () => ({
  checkoutKey: randomUUID(), recipientName: 'گیرنده', address: 'نشانی ارسال', phone: '09123456789', postalCode: '1234567890',
  items: [{ productId: 'shoe', quantity: 1, size: 38, color: 'مشکی' }],
  shippingMethodId: 'post', paymentMethodId: 'bank_transfer', expectedSubtotal: 100, expectedShippingCost: 0,
})
const request = body => new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body) })

function harness(options = {}) {
  const users = [
    { id: 'buyer', name: 'خریدار', phone: '09123456789', postalCode: '1234567890', isActive: true, ...options.user },
    { id: 'other', name: 'دیگری', phone: '09121111111', postalCode: '9876543210', isActive: true },
  ]
  const memory = memoryInventory({
    users,
    products: [{ id: 'shoe', name: 'پانیک', price: 100, stock: 5, sizes: [38], colors: ['مشکی'], inventoryConfigured: true, inventoryVersion: 0 }],
    variants: [{ id: 'variant', productId: 'shoe', size: 38, color: 'مشکی', stock: 5, damagedStock: 0, isActive: true }],
  })
  let orders = [], redemptions = [], coupon = { id: 'discount', code: 'PANIK10', name: 'تخفیف', type: 'PERCENT', value: 10, maxDiscount: null, minSubtotal: 0, maxUses: 10, perUserLimit: 1, startsAt: null, endsAt: null, deletedAt: null, isActive: true, usedCount: 0, version: 1 }
  const metrics = { expiration: 0, paymentReads: 0, couponReads: 0, couponWrites: 0, orderWrites: 0, rawQueries: [], profileQueries: [], transactions: 0 }
  let session = { user: { id: options.userId ?? 'buyer', name: 'خریدار', role: 'USER' } }
  const prisma = {
    user: { findUnique: async query => {
      metrics.profileQueries.push(clone(query))
      return memory.prisma.user.findUnique(query)
    } },
    product: { findUnique: async query => {
      const product = await memory.prisma.product.findUnique(query)
      if (options.afterPrecheck) await options.afterPrecheck(memory.prisma)
      return product
    } },
    order: { findFirst: async ({ where }) => clone(orders.find(order => order.checkoutKey === where.checkoutKey && order.userId === where.userId) ?? null) },
    $transaction: async callback => {
      metrics.transactions++
      return memory.prisma.$transaction(async inventoryTx => {
        const orderDraft = clone(orders), redemptionDraft = clone(redemptions), couponDraft = clone(coupon)
        const tx = {
          ...inventoryTx,
          $queryRaw: async (strings, ...values) => {
            metrics.rawQueries.push({ text: strings.join('?'), values })
            const user = await inventoryTx.user.findUnique({ where: { id: values[0] } })
            return user ? [user] : []
          },
          paymentMethod: { findUnique: async () => { metrics.paymentReads++; return { id: 'bank_transfer', isActive: true, cardNumber: 'saved-card', cardholderName: 'فروشگاه' } } },
          shippingMethod: { findUnique: async () => ({ id: 'post', name: 'پست', isActive: true, baseCost: 0, additionalItemCost: 0, freeShippingThreshold: null }) },
          coupon: {
            findUnique: async ({ where }) => { metrics.couponReads++; return where.id === couponDraft.id || where.code === couponDraft.code ? couponDraft : null },
            updateMany: async () => { metrics.couponWrites++; couponDraft.usedCount++; return { count: 1 } },
          },
          couponRedemption: {
            count: async ({ where }) => redemptionDraft.filter(row => row.couponId === where.couponId && row.userId === where.userId).length,
            create: async ({ data }) => { metrics.couponWrites++; redemptionDraft.push(clone(data)); return data },
          },
          order: { create: async ({ data }) => {
            metrics.orderWrites++
            const row = { ...clone(data), createdAt: new Date(), items: clone(data.items.create) }
            orderDraft.push(row)
            return clone(row)
          } },
        }
        const result = await callback(tx)
        orders = orderDraft; redemptions = redemptionDraft; coupon = couponDraft
        return result
      })
    },
  }
  const cache = new Map()
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative)
    const testModule = { exports: {} }
    vm.runInNewContext(transformSync(readFileSync(path.join(root, relative), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
      module: testModule, Response, Date, Buffer, require(name) {
        if (name === 'node:crypto') return require(name)
        if (name === 'next/server') return { NextResponse: Response }
        if (name === '@/lib/prisma') return { prisma }
        if (name === '@/lib/auth') return { auth: async () => session }
        if (name === '@/lib/payments') return { expireUnpaidOrders: async () => { metrics.expiration++; return 0 }, methodAvailability: () => ({ available: true }) }
        if (name === '@/lib/request-origin') return { isSameOriginRequest: () => true }
        if (name.startsWith('@/lib/')) return load(`src/lib/${name.slice(6)}.ts`)
        if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), `${name}.ts`))
        throw new Error(`Unexpected dependency ${name}`)
      },
    }, { filename: relative })
    cache.set(relative, testModule.exports)
    return testModule.exports
  }
  return {
    route: load('src/app/api/orders/route.ts'), guard: load('src/lib/checkout-profile.ts'), metrics,
    state: () => ({ ...memory.state(), orders: clone(orders), redemptions: clone(redemptions), coupon: clone(coupon) }),
    updateUser: data => memory.prisma.user.update({ where: { id: 'buyer' }, data }),
    setSession: value => { session = value }, seedOrder: order => { orders.push(clone(order)) },
  }
}

for (const user of [
  { phone: null }, { phone: '' }, { phone: '123' }, { postalCode: null }, { postalCode: '' }, { postalCode: '1111111111' }, { phone: null, postalCode: null },
]) {
  test(`Account completion is required even when the shipping payload is valid: ${JSON.stringify(user)}`, async () => {
    const h = harness({ user })
    const before = h.state()
    const response = await h.route.POST(request({ ...defaults(), couponCode: 'PANIK10', expectedCouponDiscount: 10, userId: 'other' }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'PROFILE_INCOMPLETE')
    assert.equal(h.metrics.profileQueries[0].where.id, 'buyer', 'Caller-supplied userId cannot borrow another completed profile')
    assert.equal(h.metrics.expiration, 0, 'Invalid accounts must not trigger old-order expiration writes')
    assert.equal(h.metrics.transactions, 0)
    assert.equal(h.metrics.orderWrites + h.metrics.couponWrites + h.metrics.paymentReads, 0)
    assert.deepEqual(h.state(), before)
  })
}

for (const userId of ['buyer', 'missing']) {
  test(`Inactive or deleted accounts are rejected before checkout writes: ${userId}`, async () => {
    const h = harness({ userId, user: { isActive: false } })
    const response = await h.route.POST(request(defaults()))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'ACCOUNT_INACTIVE')
    assert.equal(h.metrics.expiration + h.metrics.orderWrites + h.metrics.couponWrites, 0)
  })
}

test('The real transaction guard binds only the authenticated ID and requests a PostgreSQL shared row lock', async () => {
  const h = harness()
  const id = "buyer' OR true --"
  let capture
  await assert.rejects(h.guard.requireCheckoutProfile({ $queryRaw: async (strings, ...values) => { capture = { text: strings.join('?'), values }; return [] } }, id), error => error.code === 'ACCOUNT_INACTIVE')
  assert.match(capture.text, /FROM "User" WHERE "id" = \? FOR SHARE/)
  assert.equal(capture.values[0], id)
  assert.ok(!capture.text.includes(id))
})

for (const change of [{ phone: null }, { postalCode: null }, { isActive: false }]) {
  test(`Checkout rechecks account changes between preflight and its stock transaction: ${JSON.stringify(change)}`, async () => {
    const h = harness({ afterPrecheck: db => db.user.update({ where: { id: 'buyer' }, data: change }) })
    const response = await h.route.POST(request({ ...defaults(), couponCode: 'PANIK10', expectedCouponDiscount: 10 }))
    assert.equal(response.status, change.isActive === false ? 403 : 409)
    assert.equal((await response.json()).code, change.isActive === false ? 'ACCOUNT_INACTIVE' : 'PROFILE_INCOMPLETE')
    assert.equal(h.metrics.transactions, 1)
    assert.match(h.metrics.rawQueries[0].text, /FOR SHARE/)
    assert.equal(h.metrics.paymentReads + h.metrics.orderWrites + h.metrics.couponWrites, 0)
    const state = h.state()
    assert.equal(state.products[0].stock, 5)
    assert.equal(state.variants[0].stock, 5)
    assert.equal(state.stockMovements.length + state.redemptions.length + state.orders.length, 0)
  })
}

test('Checkout stores canonical recipient identifiers and reserves stock/coupon exactly once', async () => {
  const h = harness({ user: { phone: '+98 9123456789', postalCode: '۱۲۳۴۵۶۷۸۹۰' } })
  const body = { ...defaults(), phone: '+98 921-111-2233', postalCode: '۹۸۷۶۵-۴۳۲۱۰', couponCode: 'PANIK10', expectedCouponDiscount: 10 }
  const response = await h.route.POST(request(body))
  assert.equal(response.status, 201)
  const order = await response.json()
  assert.equal(order.phone, '09211112233')
  assert.equal(order.postalCode, '9876543210')
  assert.equal(order.userId, 'buyer')
  assert.equal(order.total, 90)
  const state = h.state()
  assert.equal(state.products[0].stock, 4)
  assert.equal(state.variants[0].stock, 4)
  assert.equal(state.stockMovements.length, 1)
  assert.equal(state.stockMovements[0].type, 'RESERVE')
  assert.equal(state.stockMovements[0].actorId, 'buyer')
  assert.equal(state.coupon.usedCount, 1)
  assert.equal(state.redemptions.length, 1)
  assert.equal(h.metrics.rawQueries[0].values[0], 'buyer')
  assert.match(h.metrics.rawQueries[0].text, /FOR SHARE/)
})

for (const invalid of [{ phone: '123' }, { postalCode: undefined }, { postalCode: 1234567890 }, { postalCode: '1111111111' }]) {
  test(`Shipping contact validation cannot be bypassed by a completed account: ${JSON.stringify(invalid)}`, async () => {
    const h = harness()
    const response = await h.route.POST(request({ ...defaults(), ...invalid }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'RECIPIENT_CONTACT_INVALID')
    assert.equal(h.metrics.profileQueries.length + h.metrics.expiration + h.metrics.orderWrites, 0)
  })
}

test('Account edits cannot change an existing order snapshot and exact lost-response replay bypasses current profile/stock/coupon checks', async () => {
  const h = harness()
  const body = { ...defaults(), couponCode: 'PANIK10', expectedCouponDiscount: 10 }
  const created = await h.route.POST(request(body))
  assert.equal(created.status, 201)
  const first = await created.json(), snapshot = h.state()
  const metrics = clone(h.metrics)
  await h.updateUser({ phone: null, postalCode: null })
  const replay = await h.route.POST(request(body))
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).id, first.id)
  assert.deepEqual(h.state().orders, snapshot.orders)
  assert.equal(h.state().products[0].stock, snapshot.products[0].stock)
  assert.equal(h.state().coupon.usedCount, 1)
  assert.equal(h.metrics.profileQueries.length, metrics.profileQueries.length)
  assert.equal(h.metrics.expiration, metrics.expiration)
  assert.equal(h.metrics.rawQueries.length, metrics.rawQueries.length)
})

test('A reused checkout key with a different postal code is rejected without changing the existing shipment or stock', async () => {
  const h = harness()
  const body = defaults()
  assert.equal((await h.route.POST(request(body))).status, 201)
  const before = h.state()
  const response = await h.route.POST(request({ ...body, postalCode: '9876543210' }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'CHECKOUT_KEY_REUSED')
  assert.deepEqual(h.state(), before)
})

test('A checkout belonging to another user is not returned when their key is supplied', async () => {
  const h = harness()
  const body = defaults()
  assert.equal((await h.route.POST(request(body))).status, 201)
  h.setSession({ user: { id: 'other', name: 'دیگری', role: 'USER' } })
  const response = await h.route.POST(request(body))
  assert.equal(response.status, 201)
  const own = await response.json()
  assert.equal(own.userId, 'other')
  assert.equal(h.state().orders.length, 2)
  assert.equal(h.state().products[0].stock, 3)
})

for (const phone of ['09123456789', '۰۹۱۲۳۴۵۶۷۸۹', '+98 9123456789']) {
  test(`Historical no-postal checkout can replay its original raw phone safely: ${phone}`, async () => {
    const h = harness({ user: { phone: null, postalCode: null } })
    const body = { ...defaults(), phone, postalCode: undefined }
    const intent = { recipientName: body.recipientName, address: body.address, phone: phone.trim(), shippingMethodId: body.shippingMethodId, paymentMethodId: body.paymentMethodId, items: body.items }
    h.seedOrder({ id: 'legacy', userId: 'buyer', checkoutKey: `buyer:${body.checkoutKey}`, checkoutFingerprint: createHash('sha256').update(JSON.stringify(intent)).digest('hex'), postalCode: null, phone, items: body.items })
    const response = await h.route.POST(request(body))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).id, 'legacy')
    assert.equal(h.metrics.profileQueries.length + h.metrics.expiration + h.metrics.orderWrites, 0)
    assert.equal(h.state().products[0].stock, 5)
  })
}
