const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function cron(secret) {
  let sweeps = 0
  const dependencies = {
    'node:crypto': require('node:crypto'), 'next/server': { NextResponse: Response },
    '@/lib/payments': { expireUnpaidOrders: async () => { sweeps++; return 2 } },
  }
  const source = readFileSync(path.join(__dirname, '../src/app/api/cron/payments/expire/route.ts'), 'utf8')
  const context = { module: { exports: {} }, Buffer, process: { env: { CRON_SECRET: secret } },
    require(name) { assert.ok(name in dependencies); return dependencies[name] } }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, context)
  return { route: context.module.exports, sweeps: () => sweeps }
}

test('Expiry cron never mutates inventory without a configured strong bearer secret', async () => {
  const secret = 'a'.repeat(40)
  for (const [configured, authorization] of [
    [undefined, 'Bearer undefined'], ['short', 'Bearer short'], [secret, ''],
    [secret, `Bearer ${'b'.repeat(40)}`], [secret, `Bearer ${secret}extra`],
  ]) {
    const app = cron(configured)
    const response = await app.route.GET(new Request('http://localhost/api/cron/payments/expire', { headers: { authorization } }))
    assert.equal(response.status, 401)
    assert.equal(app.sweeps(), 0)
  }
})

test('Authenticated expiry cron supports scheduler GET and POST and returns no private order data', async () => {
  const secret = 'a'.repeat(40)
  const app = cron(secret)
  for (const method of ['GET', 'POST']) {
    const response = await app.route[method](new Request('http://localhost/api/cron/payments/expire', { method, headers: { authorization: `Bearer ${secret}` } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { expired: 2 })
    assert.match(response.headers.get('cache-control'), /private.*no-store/)
  }
  assert.equal(app.sweeps(), 2)
})

function reservationSweep(rows, raceId) {
  const orders = structuredClone(rows), released = [], batches = [], stock = new Map()
  function matches(order, where) {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return value.some(filter => matches(order, filter))
      if (key === 'items') return order.items.some(item => value.some.productId.in.includes(item.productId))
      if (key === 'coupon') return order.couponCode === value.is.code
      if (value instanceof Date) return order[key]?.getTime() === value.getTime()
      if (value && typeof value === 'object') {
        if ('in' in value) return value.in.includes(order[key])
        if ('lte' in value) return order[key] !== null && order[key] <= value.lte
        if ('gt' in value) return order[key] > value.gt
      }
      return order[key] === value
    })
  }
  const tx = { order: {
    findMany: async ({ where, orderBy, take }) => {
      const key = Object.keys(orderBy)[0]
      const candidates = orders.filter(row => matches(row, where)).sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0).slice(0, take)
      batches.push(candidates.length)
      return candidates.map(row => ({ id: row.id }))
    },
    findUnique: async ({ where }) => structuredClone(orders.find(row => row.id === where.id)),
    updateMany: async ({ where, data }) => {
      const row = orders.find(row => matches(row, where))
      if (!row) return { count: 0 }
      if (row.id === raceId) { row.paymentStatus = 'AWAITING_REVIEW'; return { count: 0 } }
      Object.assign(row, data); return { count: 1 }
    },
  }, product: { update: async ({ where, data }) => { stock.set(where.id, (stock.get(where.id) ?? 0) + data.stock.increment) } } }
  const prisma = { ...tx, $transaction: callback => callback(tx) }
  const deps = {
    '@/lib/prisma': { prisma }, '@/lib/payment-contract': { PAYMENT_WINDOW_MS: 600000 }, '@/lib/request-origin': {},
    '@/lib/coupons': { releaseCouponReservation: async (_tx, id) => { released.push(id) } },
  }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/payments.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: compiled, Date, require: name => { assert.ok(name in deps); return deps[name] } })
  return { expire: compiled.exports.expireUnpaidOrders, orders, released, stock, batches }
}
const expiredReservation = (id, productId = 'unrelated', couponCode = null) => ({ id, paymentMethod: 'bank_transfer', status: 'PENDING', verified: false,
  paymentStatus: 'AWAITING_RECEIPT', paymentExpiresAt: new Date(0), updatedAt: new Date(0), couponId: couponCode ? 'coupon' : null, couponCode,
  items: [{ productId, quantity: 1 }],
})

test('Checkout releases relevant stock and coupon reservations beyond 100 unrelated expired orders', async () => {
  const unrelated = Array.from({ length: 101 }, (_, i) => expiredReservation(`a-${String(i).padStart(3, '0')}`))
  const h = reservationSweep([...unrelated, expiredReservation('z-stock', 'shoe'), expiredReservation('z-coupon', 'other', 'PANIK10')])
  assert.equal(await h.expire(new Date(), undefined, { productIds: ['shoe'], couponCode: 'PANIK10' }), 2)
  assert.equal(h.stock.get('shoe'), 1)
  assert.deepEqual(h.released, ['z-coupon'])
  assert.equal(h.orders.filter(row => row.status === 'PENDING').length, 101, 'An unrelated backlog cannot block this checkout')
})

test('Targeted checkout cleanup drains every page and progresses past raced candidates', async () => {
  const h = reservationSweep(Array.from({ length: 137 }, (_, i) => expiredReservation(`r-${String(i).padStart(3, '0')}`, 'shoe', 'PANIK10')), 'r-000')
  assert.equal(await h.expire(new Date(), undefined, { productIds: ['shoe'], couponCode: 'PANIK10' }), 136)
  assert.deepEqual(h.batches, [100, 37])
  assert.equal(h.stock.get('shoe'), 136)
  assert.equal(h.released.length, 136)
  assert.equal(await h.expire(new Date(), undefined, { productIds: ['shoe'], couponCode: 'PANIK10' }), 0)
})

test('Background reservation cleanup retains its 100-order batch bound', async () => {
  const h = reservationSweep(Array.from({ length: 137 }, (_, i) => expiredReservation(`r-${String(i).padStart(3, '0')}`)))
  assert.equal(await h.expire(new Date()), 100)
  assert.deepEqual(h.batches, [100])
  assert.equal(h.orders.filter(row => row.status === 'PENDING').length, 37)
})
