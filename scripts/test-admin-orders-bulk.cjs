const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const inventory = require('./helpers/inventory-double.cjs')

// Run the real route, shared transition, filters, and token handling against
// transactional in-memory state. No connection or writes to the shop database.
const root = path.join(__dirname, '..')
const code = new Map()
function load(file, dependencies = {}, globals = {}) {
  if (!code.has(file)) code.set(file, transformSync(readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code)
  const testModule = { exports: {} }
  vm.runInNewContext(code.get(file), { module: testModule, Request, Response, URL, URLSearchParams, Intl, Date, Buffer, ...globals, require(name) {
    if (name === 'node:crypto') return require(name)
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return testModule.exports
}

const fixture = (id, extra = {}) => ({
  id, userId: 'buyer', status: 'PENDING', paymentMethod: null, paymentStatus: 'UNPAID', verified: false,
  createdAt: new Date('2026-11-06T12:00:00Z'), updatedAt: new Date('2026-11-06T12:00:00Z'),
  paymentExpiresAt: null, invoice: null, total: 200_000, shippingCost: 0,
  shippingMethodName: 'پست', recipientName: 'گیرنده', address: 'نشانی', phone: '09121111111',
  user: { name: 'خریدار', email: 'buyer@example.test' },
  items: [{ productId: 'shoe', productName: 'کفش', product: { name: 'کفش' }, price: 200_000, quantity: 1, size: 38, color: 'مشکی' }],
  ...extra,
})

function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every(part => matches(row, part))
    if (value instanceof Date) return row[key].getTime() === value.getTime()
    if (typeof value !== 'object' || value === null) return row[key] === value
    if (value.in) return value.in.includes(row[key])
    if (value.not) return row[key] !== value.not
    return (!value.gte || row[key] >= value.gte) && (!value.lt || row[key] < value.lt)
  })
}

function harness(orders = [fixture('one')], options = {}) {
  let state = { orders: structuredClone(orders), stock: options.stock ?? 10, movements: [], invoices: [] }
  let session = { user: { id: 'admin-one', name: 'مدیر', role: 'ADMIN' } }
  let now = Date.parse('2026-11-06T13:00:00Z')
  let transactions = 0
  const queries = []
  class TestDate extends Date { static now() { return now } }
  const db = {
    order: { findMany: async (query) => {
      queries.push(query)
      return state.orders.filter(row => matches(row, query.where))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(query.skip ?? 0, (query.skip ?? 0) + query.take)
        .map(row => Object.fromEntries(Object.keys(query.select).map(key => [key, row[key]])))
    } },
    $transaction: async callback => {
      transactions++
      const draft = structuredClone(state)
      const result = await callback({
        order: {
          findUnique: async ({ where }) => structuredClone(draft.orders.find(row => row.id === where.id) ?? null),
          updateMany: async ({ where, data }) => {
            const row = draft.orders.find(order => matches(order, where))
            if (!row || row.id === options.casLoss) return { count: 0 }
            Object.assign(row, data)
            return { count: 1 }
          },
        },
        product: {
          findUnique: async () => ({ stock: draft.stock }),
          update: async ({ data }) => { draft.stock += data.stock.increment },
          updateMany: async ({ data, where }) => {
            if (draft.stock < where.stock.gte) return { count: 0 }
            draft.stock -= data.stock.decrement
            return { count: 1 }
          },
        },
        invoice: { create: async ({ data }) => {
          if (data.orderId === options.invoiceFailure) throw new Error('Private database detail')
          const invoice = { id: draft.invoices.length + 1, ...data }
          draft.invoices.push(invoice)
          draft.orders.find(row => row.id === data.orderId).invoice = { id: invoice.id }
          return invoice
        } },
        stockMovement: { create: async ({ data }) => { draft.movements.push(data) } },
      })
      state = draft
      return result
    },
  }
  const deps = {
    'next/server': { NextResponse: Response },
    '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma: db },
    '@/lib/inventory': inventory,
    '@/lib/request-origin': load('src/lib/request-origin.ts'),
    '@/lib/invoice': load('src/lib/invoice.ts'),
    '@/lib/site-settings': { readSiteSettings: async () => ({ storeName: 'پانیک' }) },
    '@/lib/coupons': load('src/lib/coupons.ts'),
    '@/lib/payment-contract': load('src/lib/payment-contract.ts'),
    '@/lib/sales-report': load('src/lib/sales-report.ts'),
    '@/lib/api-input': load('src/lib/api-input.ts', { 'next/server': { NextResponse: Response } }),
    '@/lib/admin-order-bulk-contract': load('src/lib/admin-order-bulk-contract.ts'),
  }
  deps['@/lib/admin-orders'] = load('src/lib/admin-orders.ts', deps)
  deps['@/lib/order-status-transition'] = load('src/lib/order-status-transition.ts', deps)
  deps['@/lib/admin-order-bulk'] = load('src/lib/admin-order-bulk.ts', deps, { Date: TestDate, process: { env: { AUTH_SECRET: 'unit-test-signing-secret-not-used-in-production' } } })
  const route = load('src/app/api/admin/orders/bulk/route.ts', deps)
  const post = (body, headers = {}) => route.POST(new Request('http://localhost/api/admin/orders/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return { post, queries, state: () => state, transactions: () => transactions,
    actor(id, role = 'ADMIN') { session = id ? { user: { id, role } } : null },
    advance(ms) { now += ms },
    preview: (ids, status = 'PROCESSING') => post({ action: 'preview', mode: 'selected', ids, status }),
    confirm: (token, ids) => post({ action: 'confirm', token, ids }),
  }
}

test('Bulk order preview and confirmation require an administrator and same-origin request', async () => {
  const h = harness()
  for (const [user, role, status] of [[null, 'ADMIN', 401], ['buyer', 'USER', 403]]) {
    h.actor(user, role)
    assert.equal((await h.preview(['one'])).status, status)
    assert.equal((await h.confirm('token', ['one'])).status, status)
  }
  h.actor('admin-one')
  assert.equal((await h.post({ action: 'preview' }, { origin: 'https://elsewhere.test' })).status, 403)
  assert.equal(h.queries.length, 0)
  assert.equal(h.transactions(), 0)
})

test('Malformed, ambiguous, unbounded, and oversized previews never query or mutate orders', async () => {
  const h = harness()
  for (const body of ['{', { action: 'unknown' }, { action: 'preview', mode: 'selected', ids: ['one', 'one'], status: 'SHIPPED' },
    { action: 'preview', mode: 'selected', ids: ['one'], status: 'PAID' },
    { action: 'preview', mode: 'filtered', filters: 'q=%20&range=all', status: 'CANCELLED' },
    { action: 'preview', mode: 'filtered', filters: 'range=today&page=2', status: 'CANCELLED' },
    { action: 'preview', mode: 'filtered', filters: 'range=custom&from=2026-12-01&to=2026-11-01', status: 'CANCELLED' }]) {
    assert.equal((await h.post(body)).status, 400)
  }
  assert.equal((await h.post(' '.repeat(64 * 1024 + 1))).status, 413)
  assert.equal(h.queries.length, 0)
  assert.equal(h.transactions(), 0)
})

test('Selected preview preserves exact selection and excludes absent, already-target and unpaid orders', async () => {
  const h = harness([
    fixture('approved', { status: 'PROCESSING' }),
    fixture('unpaid', { paymentMethod: 'bank_transfer', paymentStatus: 'AWAITING_REVIEW' }),
    fixture('eligible'),
  ])
  const res = await h.preview(['unpaid', 'missing', 'approved', 'eligible'])
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store')
  const { rows, token } = await res.json()
  assert.deepEqual(rows.map(row => [row.id, row.status, row.eligible]), [
    ['unpaid', 'PENDING', false], ['missing', null, false], ['approved', 'PROCESSING', false], ['eligible', 'PENDING', true],
  ])
  assert.match(rows[0].reason, /تأیید کنید/)
  assert.doesNotMatch(JSON.stringify(rows), /09121111111|buyer@example/)
  assert.deepEqual(JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).orders.map(row => row.id), ['eligible'])
  assert.equal(h.transactions(), 0)
  assert.equal(h.state().invoices.length, 0)
})

test('Filtered preview uses the same Tehran calendar bounds across pages and freezes those rows', async () => {
  const h = harness([
    ...Array.from({ length: 25 }, (_, index) => fixture(`day-${index}`)),
    fixture('previous', { createdAt: new Date('2026-11-05T20:29:59.999Z') }),
    fixture('next', { createdAt: new Date('2026-11-06T20:30:00.000Z') }),
    fixture('different-status', { status: 'SHIPPED' }),
  ])
  const res = await h.post({ action: 'preview', mode: 'filtered', filters: 'range=custom&from=2026-11-06&to=2026-11-06&status=PENDING', status: 'PROCESSING' })
  assert.equal(res.status, 200)
  const preview = await res.json()
  assert.equal(preview.rows.length, 25)
  assert.ok(preview.rows.every(row => row.id.startsWith('day-') && row.eligible))
  assert.equal(h.queries[0].skip, undefined)
  assert.equal(h.queries[0].take, 101)
  const ids = preview.rows.map(row => row.id)
  h.state().orders.push(fixture('new-matching-row'))
  assert.equal((await h.confirm(preview.token, ids)).status, 400)
  assert.equal((await h.confirm(preview.token, [...ids.slice(0, 2), 'new-matching-row'])).status, 400)
  assert.equal(h.transactions(), 0)
  const batch = await (await h.confirm(preview.token, ids.slice(0, 20))).json()
  assert.deepEqual(batch.results.map(row => row.outcome), Array(20).fill('updated'))
  const rest = await (await h.confirm(preview.token, ids.slice(20))).json()
  assert.deepEqual(rest.results.map(row => row.outcome), Array(5).fill('updated'))
  assert.equal(h.state().orders.find(row => row.id === 'new-matching-row').status, 'PENDING')
  assert.equal(h.state().invoices.length, 25)
})

test('More than 100 matching orders require a narrower filter and do not silently truncate', async () => {
  const h = harness(Array.from({ length: 101 }, (_, index) => fixture(`row-${index}`)))
  const res = await h.post({ action: 'preview', mode: 'filtered', filters: 'status=PENDING', status: 'PROCESSING' })
  assert.equal(res.status, 422)
  assert.match((await res.json()).error, /محدودتر/)
  assert.equal(h.transactions(), 0)
})

test('Confirm rejects altered, expired and cross-account tokens, ineligible IDs and duplicate IDs before writing', async () => {
  const h = harness([fixture('one'), fixture('already', { status: 'PROCESSING' })])
  const { token } = await (await h.preview(['one', 'already'])).json()
  const altered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
  assert.equal((await h.confirm(altered, ['one'])).status, 400)
  assert.equal((await h.confirm(token, ['one', 'already'])).status, 400)
  assert.equal((await h.confirm(token, ['one', 'one'])).status, 400)
  h.actor('admin-two')
  assert.equal((await h.confirm(token, ['one'])).status, 409)
  h.actor('admin-one')
  h.advance(10 * 60 * 1000)
  assert.equal((await h.confirm(token, ['one'])).status, 409)
  assert.equal(h.transactions(), 0)
})

test('Invalid cancellation candidates are excluded, and repeated confirmation releases stock only once', async () => {
  const h = harness([
    fixture('cancel'), fixture('shipped', { status: 'SHIPPED' }), fixture('delivered', { status: 'DELIVERED' }),
    fixture('receipt', { paymentMethod: 'bank_transfer', paymentStatus: 'AWAITING_REVIEW' }),
    fixture('unpaid', { paymentMethod: 'bank_transfer', paymentStatus: 'AWAITING_RECEIPT', paymentExpiresAt: new Date('2026-11-06T14:00:00Z') }),
  ])
  const preview = await (await h.preview(['cancel', 'shipped', 'delivered', 'receipt', 'unpaid'], 'CANCELLED')).json()
  assert.deepEqual(preview.rows.map(row => row.eligible), [true, false, false, false, true])
  assert.equal(h.state().stock, 10)
  const result = await (await h.confirm(preview.token, ['cancel', 'unpaid'])).json()
  assert.deepEqual(result.results.map(row => row.outcome), ['updated', 'updated'])
  assert.equal(h.state().stock, 12)
  const unpaid = h.state().orders.find(row => row.id === 'unpaid')
  assert.equal(unpaid.paymentStatus, 'EXPIRED')
  assert.equal(unpaid.paymentExpiresAt, null)
  const replay = await (await h.confirm(preview.token, ['cancel', 'unpaid'])).json()
  assert.deepEqual(replay.results.map(row => row.outcome), ['skipped', 'skipped'])
  assert.equal(h.state().stock, 12)
})

test('Version changes, a lost claim, and invoice failures leave those rows unchanged while valid rows complete', async () => {
  const h = harness(['stale', 'race', 'failed', 'done'].map(id => fixture(id)), { casLoss: 'race', invoiceFailure: 'failed' })
  const ids = ['stale', 'race', 'failed', 'done']
  const preview = await (await h.preview(ids, 'SHIPPED')).json()
  h.state().orders[0].updatedAt = new Date(h.state().orders[0].updatedAt.getTime() + 1)
  const result = await (await h.confirm(preview.token, ids)).json()
  assert.deepEqual(result.results.map(row => row.outcome), ['skipped', 'skipped', 'error', 'updated'])
  assert.doesNotMatch(JSON.stringify(result), /Private database detail/)
  assert.deepEqual(h.state().orders.map(row => row.status), ['PENDING', 'PENDING', 'PENDING', 'SHIPPED'])
  assert.deepEqual(h.state().movements.map(row => [row.orderId, row.type, row.actorId]), [['done', 'SALE', 'admin-one'], ['done', 'SHIPMENT', 'admin-one']])
  assert.deepEqual(h.state().invoices.map(row => [row.orderId, row.snapshot.seller.name]), [['done', 'پانیک']])
})

test('A reopening with insufficient stock is skipped and does not leave a partial status or invoice', async () => {
  const h = harness([fixture('cancelled', { status: 'CANCELLED' })], { stock: 0 })
  const { token } = await (await h.preview(['cancelled'])).json()
  const result = await (await h.confirm(token, ['cancelled'])).json()
  assert.deepEqual(result.results.map(row => row.outcome), ['skipped'])
  assert.match(result.results[0].reason, /موجودی/)
  assert.equal(h.state().orders[0].status, 'CANCELLED')
  assert.equal(h.state().invoices.length, 0)
})
