const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const root = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))

function load(file, dependencies = {}) {
  const result = { exports: {} }
  const code = transformSync(readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  vm.runInNewContext(code, { module: result, Date, Response, Request, URL, BigInt, require(name) { assert.ok(name in dependencies, name); return dependencies[name] } })
  return result.exports
}
const pricing = load('src/lib/pricing.ts')
const core = load('src/lib/coupons.ts')
const origin = load('src/lib/request-origin.ts')
const now = new Date('2026-10-15T12:00:00.000Z')
const earlier = new Date(now.getTime() - 1000)
const later = new Date(now.getTime() + 1000)
const input = extra => ({ code: 'panik10', name: 'پیشنهاد پاییز', type: 'PERCENT', value: 10, maxDiscount: null, minSubtotal: 0, maxUses: 10, perUserLimit: 1, startsAt: null, endsAt: null, isActive: true, ...extra })
const row = extra => ({ ...input(), code: 'PANIK10', id: 'coupon-1', usedCount: 0, version: 1, deletedAt: null, createdAt: now, updatedAt: now, ...extra })

test('Product pricing uses integer toman and does not mutate the original base price', () => {
  const product = { price: 1_900_000, salePrice: 1_710_000 }
  assert.deepEqual(plain(pricing.productPricing(product, now)), { originalPrice: 1_900_000, effectivePrice: 1_710_000, discountAmount: 190_000, discountPercent: 10, isDiscounted: true })
  assert.equal(product.price, 1_900_000)
  assert.equal(pricing.productPricing({ price: 100 }, now).effectivePrice, 100)
})
test('Sales start inclusively, end exclusively and support serialized server dates', () => {
  for (const start of [now, now.toISOString()]) assert.equal(pricing.productPricing({ price: 100, salePrice: 90, saleStartsAt: start, saleEndsAt: later }, now).isDiscounted, true)
  assert.equal(pricing.productPricing({ price: 100, salePrice: 90, saleStartsAt: later }, now).isDiscounted, false)
  assert.equal(pricing.productPricing({ price: 100, salePrice: 90, saleEndsAt: now }, now).isDiscounted, false)
  assert.equal(pricing.productPricing({ price: 100, salePrice: 90, saleStartsAt: earlier, saleEndsAt: later }, now).isDiscounted, true)
})
for (const extra of [{ salePrice: 0 }, { salePrice: -1 }, { salePrice: 100 }, { salePrice: 101 }, { salePrice: 10.5 }, { salePrice: '90' }, { salePrice: 90, saleStartsAt: 'garbage' }, { salePrice: 90, saleStartsAt: later, saleEndsAt: earlier }]) {
  test('Invalid or inactive sales do not change customer price: ' + JSON.stringify(extra), () => {
    assert.equal(pricing.productPricing({ price: 100, ...extra }, now).effectivePrice, 100)
  })
}
test('Largest-remainder allocation is deterministic, exact and bounded per line', () => {
  assert.deepEqual(plain(pricing.allocateDiscount([100, 100, 100], 2)), [1, 1, 0])
  assert.deepEqual(plain(pricing.allocateDiscount([0, 10, 20], 10)), [0, 3, 7])
  assert.deepEqual(plain(pricing.allocateDiscount([], 0)), [])
  assert.deepEqual(plain(pricing.allocateDiscount([20, 30], 50)), [20, 30])
  const huge = pricing.allocateDiscount([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 1], Number.MAX_SAFE_INTEGER)
  assert.equal(huge.reduce((sum, value) => sum + value, 0), Number.MAX_SAFE_INTEGER)
  for (let amount = 0; amount <= 200; amount++) {
    const allocated = pricing.allocateDiscount([17, 79, 104], amount)
    assert.equal(allocated.reduce((sum, value) => sum + value, 0), amount)
    assert.ok(allocated.every((value, index) => Number.isInteger(value) && value >= 0 && value <= [17, 79, 104][index]))
  }
})
for (const [lines, amount] of [[[1], 2], [[-1], 0], [[1.5], 0], [[1], -1], [[1], 0.5], [[], 1]]) test('Invalid discount allocation is rejected: ' + JSON.stringify([lines, amount]), () => assert.throws(() => pricing.allocateDiscount(lines, amount)))

test('Coupon input normalizes codes and preserves explicitly configured zero minimum', () => {
  const parsed = core.parseCouponInput(input({ code: ' panik-10 ', startsAt: now.toISOString(), endsAt: later.toISOString() }))
  assert.equal(parsed.code, 'PANIK-10'); assert.equal(parsed.minSubtotal, 0)
  assert.equal(parsed.startsAt.getTime(), now.getTime())
  for (const absent of [undefined, null, '', '  ']) assert.equal(core.normalizeCouponCode(absent), null)
})
for (const extra of [{ code: 'fa' }, { code: 'تخفیف' }, { code: 'ß12' }, { code: 'FOO BAR' }, { type: 'FREE' }, { value: 0 }, { value: 100 }, { value: 1.5 }, { value: '10' }, { minSubtotal: -1 }, { maxDiscount: 0 }, { maxUses: 0 }, { perUserLimit: 0 }, { isActive: 'yes' }, { startsAt: '2026-10-15' }, { startsAt: '2026-02-30T12:00:00Z' }, { startsAt: later.toISOString(), endsAt: now.toISOString() }, { name: '' }, { name: 'x'.repeat(121) }, { name: 'abc\u0000' }]) test('Invalid coupon configuration is rejected: ' + JSON.stringify(extra).slice(0, 90), () => assert.throws(() => core.parseCouponInput(input(extra))))
test('Fixed coupons require a minimum above the discount and cannot have percentage caps', () => {
  assert.equal(core.parseCouponInput(input({ type: 'FIXED', value: 50_000, minSubtotal: 50_001 })).value, 50_000)
  for (const minimum of [0, 49_999, 50_000]) assert.throws(() => core.parseCouponInput(input({ type: 'FIXED', value: 50_000, minSubtotal: minimum })))
  assert.throws(() => core.parseCouponInput(input({ type: 'FIXED', value: 1, minSubtotal: 2, maxDiscount: 2 })))
})

function harness(coupon = row(), redemptions = []) {
  let state = { coupons: coupon ? [structuredClone(coupon)] : [], redemptions: structuredClone(redemptions) }
  const events = []
  let queue = Promise.resolve()
  function matches(record, where) {
    if (!where) return true
    return Object.entries(where).every(([key, value]) => {
      if (key === 'AND') return value.every(condition => matches(record, condition))
      if (key === 'OR') return value.some(condition => matches(record, condition))
      if (value instanceof Date) return record[key] instanceof Date && record[key].getTime() === value.getTime()
      if (value && typeof value === 'object') return Object.entries(value).every(([op, bound]) => op === 'lt' ? record[key] < bound : op === 'lte' ? record[key] <= bound : op === 'gte' ? record[key] >= bound : op === 'gt' ? record[key] > bound : false)
      return record[key] === value
    })
  }
  function change(record, data) {
    for (const [key, value] of Object.entries(data)) record[key] = value && typeof value === 'object' && !(value instanceof Date) && ('increment' in value || 'decrement' in value) ? record[key] + (value.increment || 0) - (value.decrement || 0) : structuredClone(value)
  }
  function client(current) {
    return {
      coupon: {
        findUnique: async ({ where }) => { const found = current().coupons.find(item => matches(item, where)); return found ? structuredClone(found) : null },
        findMany: async ({ where }) => structuredClone(current().coupons.filter(item => matches(item, where))),
        create: async ({ data }) => {
          if (current().coupons.some(item => item.code === data.code)) throw { code: 'P2002' }
          const created = row({ ...structuredClone(data), id: 'created-' + current().coupons.length }); current().coupons.push(created); return structuredClone(created)
        },
        updateMany: async ({ where, data }) => { events.push(['coupon-update', plain(where), plain(data)]); const found = current().coupons.filter(item => matches(item, where)); found.forEach(item => change(item, data)); return { count: found.length } },
      },
      couponRedemption: {
        count: async ({ where }) => { events.push(['user-count']); return current().redemptions.filter(item => matches(item, where)).length },
        findUnique: async ({ where }) => { const found = current().redemptions.find(item => matches(item, where)); return found ? structuredClone(found) : null },
        create: async ({ data }) => {
          if (current().redemptions.some(item => item.orderId === data.orderId)) throw { code: 'P2002' }
          const created = { id: 'redemption-' + current().redemptions.length, releasedAt: null, createdAt: now, ...structuredClone(data) }; current().redemptions.push(created); return structuredClone(created)
        },
        updateMany: async ({ where, data }) => { const found = current().redemptions.filter(item => matches(item, where)); found.forEach(item => change(item, data)); return { count: found.length } },
      },
    }
  }
  const db = { ...client(() => state), $transaction: async callback => {
    let unlock; const previous = queue; queue = new Promise(resolve => { unlock = resolve }); await previous
    const draft = structuredClone(state)
    try { const result = await callback(client(() => draft)); state = draft; return result } finally { unlock() }
  } }
  return { db, state: () => structuredClone(state), events, quote: (subtotal = 100_000, user = 'user-1') => core.quoteCoupon(db, 'PANIK10', user, subtotal, now) }
}

test('Quote supports no code, capped percentages and fixed amounts; never mutates reservations', async () => {
  const h = harness(row({ value: 25, maxDiscount: 20_000 }))
  assert.deepEqual(plain(await core.quoteCoupon(h.db, null, 'user-1', 100_000, now)), { couponId: null, code: null, discount: 0 })
  assert.equal((await h.quote()).discount, 20_000); assert.equal(h.state().coupons[0].usedCount, 0)
  const fixed = harness(row({ type: 'FIXED', value: 10_000, minSubtotal: 20_000 }))
  assert.equal((await fixed.quote()).discount, 10_000)
})
for (const extra of [null, { isActive: false }, { deletedAt: now }, { startsAt: later }, { endsAt: now }, { maxUses: 1, usedCount: 1 }, { minSubtotal: 100_001 }]) test('Unavailable coupon quotes are rejected without a claim: ' + JSON.stringify(extra), async () => {
  const h = harness(extra === null ? null : row(extra)); await assert.rejects(() => h.quote()); assert.equal(h.events.filter(event => event[0] === 'coupon-update').length, 0)
})
test('Quote enforces user limit and rejects sub-toman or free-order discounts', async () => {
  const h = harness(row(), [{ id: 'existing', couponId: 'coupon-1', userId: 'user-1', orderId: 'order-0', releasedAt: null }])
  await assert.rejects(() => h.quote(), error => error.code === 'COUPON_USER_LIMIT_REACHED')
  await assert.rejects(() => harness(row({ value: 1 })).quote(1))
  await assert.rejects(() => harness(row({ type: 'FIXED', value: 100, minSubtotal: 0 })).quote(100))
})
test('Two concurrent checkouts cannot overspend the final global coupon use', async () => {
  const h = harness(row({ maxUses: 1 }))
  const quotes = await Promise.all([h.quote(100_000, 'alice'), h.quote(100_000, 'bob')])
  const results = await Promise.allSettled(quotes.map((quote, index) => h.db.$transaction(tx => core.reserveCoupon(tx, quote, index ? 'bob' : 'alice', 'order-' + index, now))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(h.state().coupons[0].usedCount, 1); assert.equal(h.state().redemptions.length, 1)
})
test('Same-user checkouts serialize on the coupon row; rejected second transaction rolls back its claim', async () => {
  const h = harness(row({ maxUses: 10, perUserLimit: 1 })); const quote = await h.quote()
  const results = await Promise.allSettled(['order-1', 'order-2'].map(order => h.db.$transaction(tx => core.reserveCoupon(tx, quote, 'user-1', order, now))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(h.state().coupons[0].usedCount, 1); assert.equal(h.state().redemptions.length, 1)
  const events = h.events.map(event => event[0]); const firstClaim = events.indexOf('coupon-update'); assert.equal(events[firstClaim + 1], 'user-count')
})
test('A stale quote cannot reserve changed admin conditions', async () => {
  const h = harness(); const quote = await h.quote(); quote.version = 0
  await assert.rejects(() => h.db.$transaction(tx => core.reserveCoupon(tx, quote, 'user-1', 'order-1', now)), error => error.code === 'COUPON_CHANGED')
  assert.equal(h.state().coupons[0].usedCount, 0)
})
test('Cancellation/expiry releases exactly once and restores global and per-user availability', async () => {
  const h = harness(row({ maxUses: 1 })); const quote = await h.quote()
  await h.db.$transaction(tx => core.reserveCoupon(tx, quote, 'user-1', 'order-1', now))
  await Promise.all([1, 2].map(() => h.db.$transaction(tx => core.releaseCouponReservation(tx, 'order-1', later))))
  assert.equal(h.state().coupons[0].usedCount, 0); assert.ok(h.state().redemptions[0].releasedAt)
  assert.equal((await h.quote()).discount, 10_000)
})
test('Late approval reacquires one use; repeated approval remains idempotent', async () => {
  const h = harness(); const quote = await h.quote()
  await h.db.$transaction(tx => core.reserveCoupon(tx, quote, 'user-1', 'order-1', now))
  await h.db.$transaction(tx => core.releaseCouponReservation(tx, 'order-1', later))
  await h.db.$transaction(tx => core.reacquireCouponReservation(tx, 'order-1', 'user-1', now))
  await h.db.$transaction(tx => core.reacquireCouponReservation(tx, 'order-1', 'user-1', now))
  assert.equal(h.state().coupons[0].usedCount, 1); assert.equal(h.state().redemptions[0].releasedAt, null)
})
test('Late approval cannot reclaim exhausted or archived coupon capacity', async () => {
  for (const extra of [{ maxUses: 1, usedCount: 1 }, { deletedAt: now }, { endsAt: now }]) {
    const h = harness(row(extra), [{ id: 'released', couponId: 'coupon-1', userId: 'user-1', orderId: 'order-1', releasedAt: earlier }])
    await assert.rejects(() => h.db.$transaction(tx => core.reacquireCouponReservation(tx, 'order-1', 'user-1', now)))
    assert.ok(h.state().redemptions[0].releasedAt)
  }
})

const admin = { user: { id: 'admin', role: 'ADMIN' } }
const ctx = { params: Promise.resolve({ id: 'coupon-1' }) }
const request = (body, headers = {}) => new Request('http://localhost/api/admin/coupons', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
function routes(h, session = admin) {
  const dependencies = { 'next/server': { NextResponse: Response }, '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma: h.db }, '@/lib/coupons': core, '@/lib/request-origin': origin }
  return { list: load('src/app/api/admin/coupons/route.ts', dependencies), detail: load('src/app/api/admin/coupons/[id]/route.ts', dependencies) }
}
for (const session of [null, {}, { user: { role: 'ADMIN' } }, { user: { id: 'user-1', role: 'USER' } }]) test('Coupon admin endpoints require an identified administrator: ' + JSON.stringify(session), async () => {
  const h = harness(), api = routes(h, session), expected = session?.user?.id ? 403 : 401
  assert.equal((await api.list.GET()).status, expected); assert.equal((await api.list.POST(request(input()))).status, expected)
  assert.equal((await api.detail.PUT(request(input({ expectedVersion: 1 })), ctx)).status, expected)
  assert.equal((await api.detail.DELETE(request({ expectedVersion: 1 }), ctx)).status, expected)
})
test('Admin list is uncached and excludes archived codes', async () => {
  const h = harness(row({ deletedAt: now })), response = await routes(h).list.GET()
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), [])
})
test('Admin creates normalized code and rejects duplicate or malformed bodies', async () => {
  const h = harness(null), api = routes(h)
  const created = await api.list.POST(request(input())); assert.equal(created.status, 201); assert.equal((await created.json()).code, 'PANIK10')
  assert.equal((await api.list.POST(request(input()))).status, 409)
  assert.equal((await api.list.POST(new Request('http://localhost/api', { method: 'POST', body: '{' }))).status, 400)
})
test('Admin writes reject cross-site origins before any mutation', async () => {
  const h = harness(), api = routes(h), foreign = { Origin: 'https://evil.example' }
  assert.equal((await api.list.POST(request(input(), foreign))).status, 403)
  assert.equal((await api.detail.PUT(request(input({ expectedVersion: 1 }), foreign), ctx)).status, 403)
  assert.equal((await api.detail.DELETE(request({ expectedVersion: 1 }, foreign), ctx)).status, 403)
  assert.equal(h.events.length, 0)
})
test('Admin update uses revision locking and never rewrites reserved usage count', async () => {
  const h = harness(row({ usedCount: 2 })), api = routes(h)
  const response = await api.detail.PUT(request(input({ expectedVersion: 1, value: 20, usedCount: 0 })), ctx)
  assert.equal(response.status, 200); assert.equal(h.state().coupons[0].value, 20); assert.equal(h.state().coupons[0].version, 2); assert.equal(h.state().coupons[0].usedCount, 2)
  assert.equal((await api.detail.PUT(request(input({ expectedVersion: 1, value: 30 })), ctx)).status, 409)
  assert.equal(h.state().coupons[0].value, 20)
  assert.equal((await api.detail.PUT(request(input({ expectedVersion: 2, maxUses: 1 })), ctx)).status, 400)
})
test('Admin deletion soft-archives without deleting historical orders or redemptions', async () => {
  const h = harness(row({ usedCount: 1 }), [{ id: 'historical', couponId: 'coupon-1', userId: 'user-1', orderId: 'order-1', releasedAt: null }]), api = routes(h)
  assert.equal((await api.detail.DELETE(request({ expectedVersion: 1 }), ctx)).status, 200)
  const state = h.state(); assert.equal(state.coupons.length, 1); assert.equal(state.coupons[0].isActive, false); assert.ok(state.coupons[0].deletedAt); assert.equal(state.redemptions.length, 1); assert.equal(state.coupons[0].usedCount, 1)
  assert.equal((await api.detail.DELETE(request({ expectedVersion: 2 }), ctx)).status, 404)
})
test('Admin refuses missing version and absent coupon edits', async () => {
  const h = harness(null), api = routes(h)
  assert.equal((await api.detail.PUT(request(input()), ctx)).status, 400)
  assert.equal((await api.detail.PUT(request(input({ expectedVersion: 1 })), ctx)).status, 404)
  assert.equal((await api.detail.DELETE(request({ expectedVersion: 1 }), ctx)).status, 404)
})
