const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const root = path.join(__dirname, '..')
const clone = value => structuredClone(value)
function load(file, dependencies = {}) {
  const result = { exports: {} }
  const code = transformSync(readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  vm.runInNewContext(code, { module: result, Date, Response, Request, URL, Uint8Array, require(name) {
    if (name === 'node:crypto') return require(name)
    assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name]
  } })
  return result.exports
}
const pricing = load('src/lib/pricing.ts'), coupons = load('src/lib/coupons.ts'), shipping = load('src/lib/shipping.ts')
const invoice = load('src/lib/invoice.ts'), contract = load('src/lib/payment-contract.ts'), origin = load('src/lib/request-origin.ts')
const key = '5f2727c3-580a-4d74-bb95-e0acbd6cb848'
const catalogue = [
  { id: 'p1', name: 'کتانی پانیک', price: 100_000, salePrice: 80_000, saleStartsAt: null, saleEndsAt: null, stock: 10, sizes: [38], colors: ['مشکی'], images: [] },
  { id: 'p2', name: 'لوفر پانیک', price: 50_000, stock: 10, sizes: [38], colors: ['مشکی'], images: [] },
]
const couponRow = extra => ({ id: 'coupon', code: 'PANIK10', name: 'پیشنهاد پانیک', type: 'PERCENT', value: 10, maxDiscount: null, minSubtotal: 0, maxUses: 20, perUserLimit: 1, startsAt: null, endsAt: null, isActive: true, usedCount: 0, version: 1, deletedAt: null, ...extra })
const item = (productId = 'p1', quantity = 1) => ({ productId, quantity, size: 38, color: 'مشکی' })
const body = extra => ({ items: [item()], address: 'نشانی خریدار', phone: '09123456789', shippingMethodId: 'post', paymentMethodId: 'bank_transfer', expectedSubtotal: 80_000, expectedShippingCost: 50_000, couponCode: 'PANIK10', expectedCouponDiscount: 8_000, ...extra })
const request = (payload, method = 'POST') => new Request('http://localhost/api/orders', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const context = id => ({ params: Promise.resolve({ id }) })

// All business functions and route handlers are real. Only the database transport is
// replaced with serial transactions and rollback; no local or deployed orders are touched.
function harness(options = {}) {
  let state = { products: clone(options.products || catalogue), coupon: couponRow(options.coupon), orders: [], redemptions: [], receipts: [], invoices: [] }
  let session = { user: { id: 'buyer', role: 'USER', name: 'خریدار' } }
  let queue = Promise.resolve()
  const events = []
  const method = { id: 'post', name: 'پست', isActive: true, baseCost: 50_000, additionalItemCost: 10_000, freeShippingThreshold: 200_000, ...options.shipping }
  function matches(record, where) {
    if (!record) return false
    return Object.entries(where || {}).every(([key, value]) => {
      if (key === 'AND') return value.every(condition => matches(record, condition))
      if (key === 'OR') return value.some(condition => matches(record, condition))
      if (key === 'invoice') return value.is === null && !record.invoice
      if (value instanceof Date) return record[key] instanceof Date && record[key].getTime() === value.getTime()
      if (value && typeof value === 'object') return Object.entries(value).every(([op, bound]) => {
        if (op === 'in') return bound.includes(record[key])
        if (record[key] == null) return false
        return op === 'lt' ? record[key] < bound : op === 'lte' ? record[key] <= bound : op === 'gt' ? record[key] > bound : op === 'gte' ? record[key] >= bound : false
      })
      return record[key] === value
    })
  }
  function change(record, data) {
    for (const [key, value] of Object.entries(data)) record[key] = value && typeof value === 'object' && !(value instanceof Date) && ('increment' in value || 'decrement' in value) ? record[key] + (value.increment || 0) - (value.decrement || 0) : clone(value)
  }
  function client(current) {
    function fullOrder(order) {
      if (!order) return null
      return { ...clone(order), user: { name: 'خریدار', email: 'buyer@example.test' },
        items: order.items.map(entry => ({ ...clone(entry), product: clone(current().products.find(product => product.id === entry.productId)) })),
        invoice: clone(current().invoices.find(entry => entry.orderId === order.id) || null),
        receipts: clone(current().receipts.filter(entry => entry.orderId === order.id)),
        _count: { receipts: current().receipts.filter(entry => entry.orderId === order.id).length },
      }
    }
    return {
      product: {
        findUnique: async ({ where }) => clone(current().products.find(product => product.id === where.id) || null),
        updateMany: async ({ where, data }) => { const product = current().products.find(product => matches(product, where)); if (!product) return { count: 0 }; change(product, data); events.push('stock-claim'); return { count: 1 } },
        update: async ({ where, data }) => { const product = current().products.find(product => product.id === where.id); assert.ok(product); change(product, data); events.push('stock-release'); return clone(product) },
      },
      shippingMethod: { findUnique: async () => clone(method) },
      paymentMethod: { findUnique: async () => ({ id: 'bank_transfer', isActive: true, cardNumber: '6037990000000006', cardholderName: 'فروشگاه', bankName: 'ملی' }) },
      order: {
        findFirst: async ({ where }) => fullOrder(current().orders.find(order => matches(order, where))),
        findUnique: async ({ where }) => fullOrder(current().orders.find(order => order.id === where.id)),
        findMany: async ({ where }) => current().orders.filter(order => matches(order, where)).map(fullOrder),
        create: async ({ data }) => {
          if (options.createError) throw new Error('Order persistence failed')
          if (data.checkoutKey && current().orders.some(order => order.checkoutKey === data.checkoutKey)) throw { code: 'P2002' }
          const order = { id: 'order-' + (current().orders.length + 1), status: 'PENDING', verified: false, createdAt: new Date(), updatedAt: new Date(), ...clone(data), items: data.items.create.map((entry, index) => ({ id: 'item-' + index, ...clone(entry) })) }
          current().orders.push(order); return fullOrder(order)
        },
        updateMany: async ({ where, data }) => { const found = current().orders.filter(order => matches(fullOrder(order), where)); found.forEach(order => change(order, data)); return { count: found.length } },
        delete: async ({ where }) => { current().orders = current().orders.filter(order => order.id !== where.id); current().redemptions = current().redemptions.filter(entry => entry.orderId !== where.id); return {} },
      },
      orderItem: { deleteMany: async () => ({ count: 1 }) },
      coupon: {
        findUnique: async ({ where }) => matches(current().coupon, where) ? clone(current().coupon) : null,
        updateMany: async ({ where, data }) => { if (!matches(current().coupon, where)) return { count: 0 }; change(current().coupon, data); events.push('coupon-claim'); return { count: 1 } },
      },
      couponRedemption: {
        count: async ({ where }) => current().redemptions.filter(entry => matches(entry, where)).length,
        findUnique: async ({ where }) => clone(current().redemptions.find(entry => matches(entry, where)) || null),
        create: async ({ data }) => {
          if (options.redemptionError) throw new Error('Coupon persistence failed')
          if (current().redemptions.some(entry => entry.orderId === data.orderId)) throw { code: 'P2002' }
          const created = { id: 'redemption-' + current().redemptions.length, ...clone(data), releasedAt: null, createdAt: new Date() }; current().redemptions.push(created); return clone(created)
        },
        updateMany: async ({ where, data }) => { const found = current().redemptions.filter(entry => matches(entry, where)); found.forEach(entry => change(entry, data)); return { count: found.length } },
      },
      paymentReceipt: { updateMany: async ({ where, data }) => { const found = current().receipts.filter(entry => matches(entry, where)); found.forEach(entry => change(entry, data)); return { count: found.length } } },
      invoice: { create: async ({ data }) => { const created = { id: current().invoices.length + 1, issuedAt: new Date(), ...clone(data) }; current().invoices.push(created); return clone(created) } },
    }
  }
  const prisma = new Proxy({}, { get(_, property) {
    if (property !== '$transaction') return client(() => state)[property]
    return async callback => {
      let unlock; const previous = queue; queue = new Promise(resolve => { unlock = resolve }); await previous
      const draft = clone(state)
      try { const result = await callback(client(() => draft)); state = draft; return result } finally { unlock() }
    }
  } })
  const payments = load('src/lib/payments.ts', { '@/lib/prisma': { prisma }, '@/lib/payment-contract': contract, '@/lib/request-origin': origin, '@/lib/coupons': coupons })
  const dependencies = { 'next/server': { NextResponse: Response }, '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma },
    '@/lib/shipping': shipping, '@/lib/pricing': pricing, '@/lib/coupons': coupons, '@/lib/payments': payments,
    '@/lib/payment-contract': contract, '@/lib/request-origin': origin, '@/lib/invoice': invoice,
    '@/lib/site-settings': { readSiteSettings: async () => ({ storeName: 'کفش پانیک' }) },
  }
  const orders = load('src/app/api/orders/route.ts', dependencies)
  const review = load('src/app/api/admin/payments/[id]/review/route.ts', dependencies)
  const status = load('src/app/api/orders/[id]/route.ts', dependencies)
  const asUser = (id, role = 'USER') => { session = { user: { id, role, name: id } } }
  return {
    state: () => clone(state), asUser, events,
    post: payload => orders.POST(request(payload)),
    cancel: (orderId, userId = 'buyer') => payments.cancelUnpaidOrder(orderId, userId),
    expire: date => payments.expireUnpaidOrders(date),
    updateProduct(id, changes) { Object.assign(state.products.find(product => product.id === id), changes) },
    updateCoupon(changes) { Object.assign(state.coupon, changes) },
    async lateReceipt(orderId) {
      await payments.expireUnpaidOrders(new Date(Date.now() + 700_000), orderId)
      Object.assign(state.orders.find(order => order.id === orderId), { paymentStatus: 'AWAITING_REVIEW' })
      state.receipts.push({ id: 'receipt', orderId, status: 'PENDING', isLate: true, createdAt: new Date() })
    },
    approve: orderId => { asUser('admin', 'ADMIN'); return review.POST(request({ receiptId: 'receipt', action: 'approve' }), context(orderId)) },
    delete: orderId => { asUser('admin', 'ADMIN'); return status.DELETE(new Request('http://localhost/api/orders', { method: 'DELETE' }), context(orderId)) },
    changeStatus: (orderId, value) => { asUser('admin', 'ADMIN'); return status.PATCH(request({ status: value }, 'PATCH'), context(orderId)) },
  }
}

test('Checkout freezes original/sale/coupon totals and applies free shipping to net goods', async () => {
  const h = harness()
  const response = await h.post(body({ items: [{ ...item('p1', 2), price: 1, originalPrice: 1 }, item('p2')], expectedSubtotal: 210_000, expectedCouponDiscount: 21_000, expectedShippingCost: 70_000, total: 1, productDiscount: 1, couponDiscount: 1 }))
  const order = await response.json(); assert.equal(response.status, 201)
  assert.equal(order.subtotal, 250_000); assert.equal(order.productDiscount, 40_000); assert.equal(order.couponDiscount, 21_000)
  assert.equal(order.shippingCost, 70_000); assert.equal(order.total, 259_000)
  assert.deepEqual(order.items.map(entry => [entry.originalPrice, entry.price, entry.couponDiscount]), [[100_000, 80_000, 16_000], [50_000, 50_000, 5_000]])
  assert.equal(h.state().coupon.usedCount, 1); assert.equal(h.state().redemptions.length, 1)
  const withoutCoupon = harness()
  assert.equal((await withoutCoupon.post(body({ items: [item('p1', 2), item('p2')], couponCode: null, expectedCouponDiscount: 0, expectedSubtotal: 210_000, expectedShippingCost: 0 }))).status, 201)
  assert.equal(withoutCoupon.state().orders[0].total, 210_000)
})
test('Sales are evaluated server-side and an expired sale requires price review before reservation', async () => {
  const h = harness(); h.updateProduct('p1', { saleEndsAt: new Date(Date.now() - 1000) })
  const response = await h.post(body()), error = await response.json()
  assert.equal(response.status, 409); assert.equal(error.code, 'ORDER_PRICES_CHANGED'); assert.equal(error.productPrices[0].price, 100_000)
  assert.equal(h.state().products[0].stock, 10); assert.equal(h.state().coupon.usedCount, 0); assert.equal(h.state().orders.length, 0)
})
test('Changed coupon amounts and shipping quotes never mutate stock or coupon capacity', async () => {
  for (const [extra, code] of [[{ expectedCouponDiscount: 7_999 }, 'COUPON_QUOTE_CHANGED'], [{ expectedShippingCost: 0 }, 'SHIPPING_QUOTE_CHANGED']]) {
    const h = harness(), response = await h.post(body(extra)); assert.equal(response.status, 409); assert.equal((await response.json()).code, code)
    assert.equal(h.state().products[0].stock, 10); assert.equal(h.state().coupon.usedCount, 0); assert.equal(h.state().orders.length, 0)
  }
})
test('Coupon codes normalize before fingerprinting; a lost-response retry cannot consume twice', async () => {
  const h = harness(), first = await h.post(body({ checkoutKey: key, couponCode: ' panik10 ' })), original = await first.json()
  assert.equal(first.status, 201)
  h.updateProduct('p1', { stock: 0, price: 200_000, salePrice: null }); h.updateCoupon({ isActive: false, version: 2 })
  const retry = await h.post(body({ checkoutKey: key, expectedSubtotal: 200_000, expectedCouponDiscount: 1 })), saved = await retry.json()
  assert.equal(retry.status, 200); assert.equal(saved.id, original.id); assert.equal(saved.total, original.total); assert.equal(saved.couponDiscount, original.couponDiscount)
  assert.equal(h.state().orders.length, 1); assert.equal(h.state().coupon.usedCount, 1); assert.equal(h.state().redemptions.length, 1)
  const changed = await h.post(body({ checkoutKey: key, couponCode: null, expectedCouponDiscount: 0 }))
  assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'CHECKOUT_KEY_REUSED')
})
test('Concurrent same-key submissions reserve exactly one order, coupon and product', async () => {
  const h = harness({ coupon: { maxUses: 1 } })
  const results = await Promise.all([h.post(body({ checkoutKey: key })), h.post(body({ checkoutKey: key }))])
  assert.deepEqual(results.map(response => response.status).sort(), [200, 201])
  const state = h.state(); assert.equal(state.orders.length, 1); assert.equal(state.products[0].stock, 9); assert.equal(state.coupon.usedCount, 1); assert.equal(state.redemptions.length, 1)
})
test('Concurrent buyers compete for final coupon capacity; loser retains all inventory and has no order', async () => {
  const h = harness({ coupon: { maxUses: 1 } })
  h.asUser('alice'); const first = h.post(body()); h.asUser('bob'); const second = h.post(body())
  const results = await Promise.all([first, second]); assert.deepEqual(results.map(response => response.status).sort(), [201, 409])
  const state = h.state(); assert.equal(state.orders.length, 1); assert.equal(state.products[0].stock, 9); assert.equal(state.coupon.usedCount, 1); assert.equal(state.redemptions.length, 1)
})
test('Same-user simultaneous orders cannot exceed the configured per-user limit', async () => {
  const h = harness()
  const results = await Promise.all([h.post(body()), h.post(body())]); assert.deepEqual(results.map(response => response.status).sort(), [201, 409])
  assert.equal(h.state().products[0].stock, 9); assert.equal(h.state().coupon.usedCount, 1); assert.equal(h.state().orders.length, 1)
})
test('Order or redemption persistence failure rolls back inventory, order and coupon together', async () => {
  for (const option of [{ createError: true }, { redemptionError: true }]) {
    const h = harness(option), response = await h.post(body()); assert.equal(response.status, 500)
    const state = h.state(); assert.equal(state.orders.length, 0); assert.equal(state.products[0].stock, 10); assert.equal(state.coupon.usedCount, 0); assert.equal(state.redemptions.length, 0)
  }
})
test('Customer cancellation releases the coupon once and allows a new discounted checkout', async () => {
  const h = harness({ coupon: { maxUses: 1 } }), order = await (await h.post(body())).json()
  await Promise.all([h.cancel(order.id), h.cancel(order.id)])
  assert.equal(h.state().coupon.usedCount, 0); assert.equal(h.state().products[0].stock, 10); assert.ok(h.state().redemptions[0].releasedAt)
  assert.equal((await h.post(body())).status, 201); assert.equal(h.state().coupon.usedCount, 1)
})
test('Expiry releases coupon and stock once; deleting an expired order does not release twice', async () => {
  const h = harness(), order = await (await h.post(body())).json()
  await Promise.all([h.expire(new Date(Date.now() + 700_000)), h.expire(new Date(Date.now() + 700_000))])
  assert.equal(h.state().coupon.usedCount, 0); assert.equal(h.state().products[0].stock, 10)
  assert.equal((await h.delete(order.id)).status, 200)
  assert.equal(h.state().coupon.usedCount, 0); assert.equal(h.state().products[0].stock, 10); assert.equal(h.state().redemptions.length, 0)
})
test('Deleting an active unpaid order releases its coupon before redemption cascade', async () => {
  const h = harness(), order = await (await h.post(body())).json()
  assert.equal((await h.delete(order.id)).status, 200)
  assert.equal(h.state().coupon.usedCount, 0); assert.equal(h.state().products[0].stock, 10); assert.equal(h.state().orders.length, 0); assert.equal(h.state().redemptions.length, 0)
})
test('Late payment approval reacquires coupon capacity, preserves original discount and issues one invoice', async () => {
  const h = harness(), order = await (await h.post(body())).json()
  await h.lateReceipt(order.id); h.updateCoupon({ value: 15, version: 2 })
  assert.equal((await h.approve(order.id)).status, 200); assert.equal((await h.approve(order.id)).status, 200)
  const state = h.state(); assert.equal(state.coupon.usedCount, 1); assert.equal(state.redemptions[0].releasedAt, null); assert.equal(state.products[0].stock, 9)
  assert.equal(state.orders[0].couponDiscount, 8_000); assert.equal(state.orders[0].total, 122_000); assert.equal(state.orders[0].verified, true); assert.equal(state.invoices.length, 1)
})
test('Late payment with exhausted coupon cannot change paid state, stock, invoice or receipt audit', async () => {
  const h = harness({ coupon: { maxUses: 1 } }), first = await (await h.post(body())).json()
  await h.lateReceipt(first.id); h.asUser('second-buyer'); assert.equal((await h.post(body())).status, 201)
  const before = h.state(), response = await h.approve(first.id); assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'COUPON_LIMIT_REACHED')
  const after = h.state(); assert.deepEqual(after.products, before.products); assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.receipts, before.receipts); assert.equal(after.invoices.length, 0); assert.equal(after.coupon.usedCount, 1)
})
test('A paid order cancellation retains its consumed coupon use and invoice history', async () => {
  const h = harness(), order = await (await h.post(body())).json()
  await h.lateReceipt(order.id); assert.equal((await h.approve(order.id)).status, 200)
  assert.equal((await h.changeStatus(order.id, 'CANCELLED')).status, 200)
  assert.equal(h.state().coupon.usedCount, 1); assert.equal(h.state().redemptions[0].releasedAt, null); assert.equal(h.state().invoices.length, 1)
})
