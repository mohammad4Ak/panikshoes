const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const actor = { id: 'admin', name: 'مدیر قیمت' }
const admin = { user: { ...actor, role: 'ADMIN' } }
const now = Date.parse('2026-11-14T12:00:00.000Z')
const plain = value => JSON.parse(JSON.stringify(value))
const settings = extra => ({ operation: 'increase', unit: 'amount', value: 10, includeSalePrice: false, ...extra })
const product = extra => ({ id: 'shoe', code: '00622', name: 'کتانی', price: 100, salePrice: null, saleStartsAt: null, saleEndsAt: null, pricingVersion: 0, stock: 3, inventoryVersion: 4, viewCount: 5, ...extra })
const input = extra => ({ ids: ['shoe'], settings: settings(), reason: 'بازبینی قیمت پاییز', ...extra })
const request = (body, headers = {}) => new Request('http://localhost/api/admin/products/prices/preview', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
})

// Evaluate the actual signing, integer arithmetic, handlers and persistence code.
// All rows and signing credentials below are isolated test doubles.
function load(file = 'src/lib/product-price-bulk.ts', { prisma = {}, session = admin } = {}) {
  const cache = new Map()
  function read(relative) {
    const absolute = path.resolve(root, relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const result = { exports: {} }
    vm.runInNewContext(transformSync(readFileSync(absolute, 'utf8'), {
      loader: 'ts', format: 'cjs', target: 'es2022',
    }).code, {
      module: result, Buffer, Date, URL, Request, Response, BigInt,
      process: { env: { AUTH_SECRET: 'isolated-bulk-price-test-signing-secret' } },
      require(name) {
        if (name === 'node:crypto') return require(name)
        if (name === 'next/server') return { NextResponse: Response }
        if (name === '@/lib/auth') return { auth: async () => session }
        if (name === '@/lib/prisma') return { prisma }
        if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
        if (name.startsWith('./')) return read(path.relative(root, path.resolve(path.dirname(absolute), name + '.ts')))
        throw new Error('Unexpected dependency ' + name)
      },
    }, { filename: absolute })
    cache.set(absolute, result.exports)
    return result.exports
  }
  return read(file)
}

function database(products = [product()]) {
  let state = { products: structuredClone(products), audits: [], orders: [{ id: 'old', total: 100, price: 100 }], invoices: [{ total: 100 }] }
  let queue = Promise.resolve(), failAudit = false, beforeWrite = null
  const events = []
  function matches(row, where) {
    return Object.entries(where).every(([key, value]) => {
      if (value instanceof Date) return row[key] instanceof Date && row[key].getTime() === value.getTime()
      if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key])
      return row[key] === value
    })
  }
  function client(getState) {
    return {
      product: {
        findMany: async ({ where }) => structuredClone(getState().products.filter(row => matches(row, where))),
        findUnique: async ({ where }) => structuredClone(getState().products.find(row => matches(row, where)) ?? null),
        updateMany: async ({ where, data }) => {
          events.push(['cas', plain(where), plain(data)])
          if (beforeWrite) { const action = beforeWrite; beforeWrite = null; action(getState()) }
          const rows = getState().products.filter(row => matches(row, where))
          for (const row of rows) Object.assign(row, structuredClone(data), { pricingVersion: row.pricingVersion + data.pricingVersion.increment })
          return { count: rows.length }
        },
      },
      productPriceChange: {
        findUnique: async ({ where: { batchId_productId: where } }) => structuredClone(getState().audits.find(row => matches(row, where)) ?? null),
        create: async ({ data }) => {
          if (failAudit) throw new Error('Isolated ledger failure')
          if (getState().audits.some(row => row.batchId === data.batchId && row.productId === data.productId)) throw { code: 'P2002' }
          const row = { id: 'audit-' + getState().audits.length, createdAt: new Date(now), ...structuredClone(data) }
          getState().audits.push(row)
          return structuredClone(row)
        },
      },
    }
  }
  const db = { ...client(() => state), $transaction: async callback => {
    let unlock
    const previous = queue
    queue = new Promise(resolve => { unlock = resolve })
    await previous
    const draft = structuredClone(state)
    try { const result = await callback(client(() => draft)); state = draft; return result } finally { unlock() }
  } }
  return { db, events, state: () => structuredClone(state), mutate: action => action(state), failAudit: () => { failAudit = true }, beforeWrite: action => { beforeWrite = action } }
}

const core = load()

test('All arithmetic uses positive bounded integer toman and exact half-up rounding', () => {
  assert.equal(core.calculateProductPrice(101, settings({ unit: 'percent', value: 50 })), 152)
  assert.equal(core.calculateProductPrice(101, settings({ operation: 'decrease', unit: 'percent', value: 50 })), 51)
  assert.equal(core.calculateProductPrice(2_147_483_646, settings({ value: 1 })), 2_147_483_647)
  assert.equal(core.calculateProductPrice(2_147_483_647, settings({ operation: 'decrease', unit: 'percent', value: 99 })), 21_474_836)
  assert.equal(core.calculateProductPrice(1, settings({ unit: 'percent', value: 2_147_483_647 })), 21_474_837)
  for (const [price, change] of [[2_147_483_647, {}], [1, { operation: 'decrease', value: 1 }], [0, {}], [1.5, {}], [true, {}], [100, { value: 1.5 }], [100, { value: '10' }], [100, { value: 0 }], [100, { operation: 'decrease', unit: 'percent', value: 100 }]]) {
    assert.throws(() => core.calculateProductPrice(price, settings(change)))
  }
})

test('Preview preserves selected ordering and is read-only; missing rows and rounding no-ops explain exclusions', async () => {
  const memory = database([product(), product({ id: 'tiny', price: 1 })]), before = memory.state()
  const result = await core.previewProductPrices(memory.db, input({ ids: ['missing', 'tiny', 'shoe'], settings: settings({ operation: 'decrease', unit: 'percent', value: 1 }) }), actor, now)
  assert.deepEqual(plain(result.rows.map(row => [row.id, row.eligible])), [['missing', false], ['tiny', false], ['shoe', true]])
  assert.match(result.rows[1].reason, /گرد/)
  assert.equal(result.rows[2].after.price, 99)
  assert.equal(result.rows[2].before.pricingVersion, 0)
  assert.deepEqual(memory.state(), before)
  assert.equal(memory.events.length, 0)
})

test('Base-only is explicit; applying to existing sales preserves all active, scheduled and expired dates', async () => {
  for (const dates of [
    { saleStartsAt: null, saleEndsAt: null },
    { saleStartsAt: new Date(now - 1000), saleEndsAt: new Date(now + 1000) },
    { saleStartsAt: new Date(now + 1000), saleEndsAt: new Date(now + 2000) },
    { saleStartsAt: new Date(now - 2000), saleEndsAt: new Date(now - 1000) },
  ]) {
    const memory = database([product({ salePrice: 80, ...dates }), product({ id: 'no-sale' })])
    const preview = await core.previewProductPrices(memory.db, input({ ids: ['shoe', 'no-sale'], settings: settings({ includeSalePrice: true }) }), actor, now)
    assert.equal(preview.rows[0].after.price, 110)
    assert.equal(preview.rows[0].after.salePrice, 90)
    assert.equal(preview.rows[1].after.salePrice, null)
    assert.equal(preview.rows[0].after.saleStartsAt, dates.saleStartsAt?.toISOString() ?? null)
    assert.equal(preview.rows[0].after.saleEndsAt, dates.saleEndsAt?.toISOString() ?? null)
    const base = await core.previewProductPrices(memory.db, input(), actor, now)
    assert.equal(base.rows[0].after.salePrice, 80)
  }
})

test('Stored invalid sales cannot be silently repaired; sale equality, underflow and overflow block per product', async () => {
  for (const dates of [{}, { saleStartsAt: new Date(now + 1000) }, { saleEndsAt: new Date(now - 1000) }]) {
    const memory = database([product({ salePrice: 100, ...dates })])
    const preview = await core.previewProductPrices(memory.db, input(), actor, now)
    assert.equal(preview.token, null)
    assert.equal(preview.rows[0].eligible, false)
    assert.match(preview.rows[0].reason, /ذخیره/)
  }
  for (const [row, change] of [
    [product({ salePrice: 80 }), { operation: 'decrease', value: 20 }],
    [product({ price: 2, salePrice: 1 }), { operation: 'decrease', unit: 'percent', value: 50, includeSalePrice: true }],
    [product({ price: 5, salePrice: 2 }), { operation: 'decrease', value: 3, includeSalePrice: true }],
    [product({ price: 2_147_483_647 }), {}],
  ]) {
    const memory = database([row]), preview = await core.previewProductPrices(memory.db, input({ settings: settings(change) }), actor, now)
    assert.equal(preview.rows[0].eligible, false)
    assert.equal(memory.state().audits.length, 0)
  }
})

test('Preview rejects invalid, duplicate, oversized, empty and malformed selection/settings/reasons before reads', async () => {
  let reads = 0
  const db = { product: { findMany: async () => { reads++; return [] } } }
  for (const change of [
    { ids: [] }, { ids: ['shoe', 'shoe'] }, { ids: [1] }, { ids: ['bad id'] }, { ids: Array.from({ length: 201 }, (_, index) => 'id-' + index) },
    { settings: null }, { settings: settings({ operation: 'set' }) }, { settings: settings({ unit: 'rial' }) },
    { settings: settings({ includeSalePrice: 'false' }) }, { settings: settings({ value: Infinity }) },
    { settings: settings({ operation: 'decrease', unit: 'percent', value: 100 }) },
    { reason: '' }, { reason: 'x'.repeat(501) }, { reason: 'invalid\u0000' },
  ]) await assert.rejects(() => core.previewProductPrices(db, input(change), actor, now))
  assert.equal(reads, 0)
})

test('Confirmation atomically writes price, independent version and detached immutable audit snapshots only', async () => {
  const memory = database([product({ salePrice: 80, saleStartsAt: new Date(now - 1000) })])
  const previous = memory.state(), preview = await core.previewProductPrices(memory.db, input(), actor, now)
  const { result } = await core.confirmProductPrice(memory.db, { token: preview.token, productId: 'shoe' }, actor, now)
  assert.equal(result.outcome, 'updated')
  assert.equal(result.after.price, 110)
  const state = memory.state(), row = state.products[0], audit = state.audits[0]
  assert.equal(row.pricingVersion, 1)
  assert.equal(row.stock, 3); assert.equal(row.inventoryVersion, 4); assert.equal(row.viewCount, 5)
  assert.equal(row.salePrice, 80); assert.deepEqual(row.saleStartsAt, previous.products[0].saleStartsAt)
  assert.equal(audit.batchId, preview.batchId); assert.equal(audit.actorId, actor.id); assert.equal(audit.actorName, actor.name)
  assert.equal(audit.productCode, '00622'); assert.equal(audit.productName, 'کتانی'); assert.equal(audit.reason, input().reason)
  assert.equal(audit.beforePrice, 100); assert.equal(audit.afterPrice, 110); assert.equal(audit.beforePricingVersion, 0); assert.equal(audit.afterPricingVersion, 1)
  assert.equal(audit.fingerprint.length, 64)
  assert.deepEqual(state.orders, previous.orders); assert.deepEqual(state.invoices, previous.invoices)
})

test('Same-token concurrency, lost response, expiry, subsequent price changes and deletion recover one durable result', async () => {
  const memory = database(), preview = await core.previewProductPrices(memory.db, input(), actor, now)
  const body = { token: preview.token, productId: 'shoe' }
  const results = await Promise.all([core.confirmProductPrice(memory.db, body, actor, now), core.confirmProductPrice(memory.db, body, actor, now)])
  assert.deepEqual(results.map(value => value.result.outcome).sort(), ['already_applied', 'updated'])
  memory.mutate(state => { state.products[0].price = 999; state.products[0].pricingVersion = 10 })
  const afterEdit = await core.confirmProductPrice(memory.db, body, actor, now + 86400000)
  assert.equal(afterEdit.result.outcome, 'already_applied'); assert.equal(afterEdit.result.after.price, 110)
  memory.mutate(state => { state.products = [] })
  const deleted = await core.confirmProductPrice(memory.db, body, actor, now + 86400000)
  assert.equal(deleted.result.outcome, 'already_applied')
  assert.equal(memory.state().audits.length, 1)
})

test('Expired unapplied operations are definitive skips, while tampering, actor changes and out-of-preview products fail closed', async () => {
  const memory = database(), preview = await core.previewProductPrices(memory.db, input(), actor, now)
  const body = { token: preview.token, productId: 'shoe' }
  const expired = await core.confirmProductPrice(memory.db, body, actor, Date.parse(preview.expiresAt))
  assert.equal(expired.result.outcome, 'skipped'); assert.equal(expired.result.code, 'PREVIEW_EXPIRED')
  await assert.rejects(() => core.confirmProductPrice(memory.db, body, { id: 'other-admin' }, now), /حساب دیگری/)
  await assert.rejects(() => core.confirmProductPrice(memory.db, { ...body, token: 'x' + preview.token.slice(1) }, actor, now))
  await assert.rejects(() => core.confirmProductPrice(memory.db, { ...body, productId: 'another-shoe' }, actor, now))
  await assert.rejects(() => core.confirmProductPrice(memory.db, { ...body, token: 'x'.repeat(300000) }, actor, now))
  assert.equal(memory.state().audits.length, 0); assert.equal(memory.state().products[0].price, 100)
})

test('CAS catches after-preview edits and ABA, but unrelated stock/view activity does not stale a preview', async () => {
  for (const change of [row => { row.price = 101 }, row => { row.salePrice = 80 }, row => { row.saleStartsAt = new Date(now) }, row => { row.code = 'NEW' }, row => { row.name = 'نام جدید' }, row => { row.pricingVersion += 2 }]) {
    const memory = database(), preview = await core.previewProductPrices(memory.db, input(), actor, now)
    memory.beforeWrite(state => change(state.products[0]))
    const { result } = await core.confirmProductPrice(memory.db, { token: preview.token, productId: 'shoe' }, actor, now)
    assert.equal(result.outcome, 'skipped'); assert.equal(result.code, 'PRODUCT_PRICE_CHANGED')
    assert.equal(memory.state().audits.length, 0)
  }
  const memory = database(), preview = await core.previewProductPrices(memory.db, input(), actor, now)
  memory.mutate(state => Object.assign(state.products[0], { stock: 0, inventoryVersion: 100, viewCount: 1000, updatedAt: new Date() }))
  assert.equal((await core.confirmProductPrice(memory.db, { token: preview.token, productId: 'shoe' }, actor, now)).result.outcome, 'updated')
})

test('An audit insertion failure rolls back its product update, while independent product results remain committed', async () => {
  const memory = database([product(), product({ id: 'shoe2' })]), preview = await core.previewProductPrices(memory.db, input({ ids: ['shoe', 'shoe2'] }), actor, now)
  assert.equal((await core.confirmProductPrice(memory.db, { token: preview.token, productId: 'shoe' }, actor, now)).result.outcome, 'updated')
  memory.failAudit()
  await assert.rejects(() => core.confirmProductPrice(memory.db, { token: preview.token, productId: 'shoe2' }, actor, now), /ledger/)
  const state = memory.state()
  assert.equal(state.products[0].price, 110); assert.equal(state.products[1].price, 100)
  assert.equal(state.products[1].pricingVersion, 0); assert.equal(state.audits.length, 1)
})

test('Preview and confirm routes require an identified admin, same origin and private uncached responses', async () => {
  for (const endpoint of ['preview', 'confirm']) {
    const file = `src/app/api/admin/products/prices/${endpoint}/route.ts`
    for (const [session, status] of [[null, 401], [{ user: { role: 'ADMIN' } }, 401], [{ user: { id: 'customer', role: 'USER' } }, 403]]) {
      const response = await load(file, { session }).POST(request(input()))
      assert.equal(response.status, status)
      assert.match(response.headers.get('Cache-Control'), /private, no-store/)
    }
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await load(file).POST(request(input(), headers))).status, 403)
    }
  }
  const memory = database(), api = load('src/app/api/admin/products/prices/preview/route.ts', { prisma: memory.db })
  const response = await api.POST(request(input()))
  assert.equal(response.status, 200); assert.equal(response.headers.get('Vary'), 'Cookie')
  assert.equal((await response.json()).rows[0].eligible, true)
})

test('Bounded JSON reader checks actual bytes as well as declared length and rejects malformed JSON', async () => {
  for (const body of ['{bad', '[]', 'null']) {
    await assert.rejects(() => core.readProductPriceBulkJson(new Request('http://localhost', { method: 'POST', body })))
  }
  await assert.rejects(() => core.readProductPriceBulkJson(request({}, { 'Content-Length': '999999' })))
  await assert.rejects(() => core.readProductPriceBulkJson(request({ reason: 'x'.repeat(400000) })))
})
