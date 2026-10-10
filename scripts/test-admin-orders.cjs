const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// All authorization, queries and aggregates run against an isolated in-memory
// database double; these checks never connect to or write the store database.
function load(relativePath, dependencies = {}, globals = {}) {
  const source = readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
  const context = {
    module: { exports: {} }, Date, Intl, URL, URLSearchParams, Request, Response,
    console: { error: () => {} }, ...globals,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
      return dependencies[name]
    },
  }
  vm.runInNewContext(code, context)
  return context.module.exports
}

const reports = load('src/lib/sales-report.ts')
const contract = load('src/lib/payment-contract.ts')
const helpers = load('src/lib/admin-orders.ts', {
  '@/lib/sales-report': reports, '@/lib/payment-contract': contract,
})
const fixedNow = new Date('2026-10-08T21:00:00.000Z') // October 9 in Tehran.
const query = (values = {}) => new URLSearchParams(values)
const parse = (values = {}, now = fixedNow) => helpers.parseAdminOrdersFilters(query(values), now)
const plain = (value) => JSON.parse(JSON.stringify(value))

function order(id, overrides = {}) {
  return {
    id, createdAt: new Date('2026-10-08T22:00:00.000Z'), status: 'PENDING', verified: false,
    total: 300000, shippingCost: 20000, shippingMethodName: 'پست پیشتاز',
    paymentStatus: 'AWAITING_RECEIPT', paymentMethod: 'bank_transfer',
    recipientName: 'گیرنده نمونه', address: 'نشانی نمونه', phone: '09121234567',
    user: { name: 'مشتری نمونه', email: 'shopper@example.test', password: 'do not expose' },
    items: [{ id: 'line-1', productId: 'shoe-1', productName: 'کفش قدیمی', quantity: 2,
      size: 38, color: 'کرم', price: 140000, product: { name: 'کفش جدید', internal: 'private' } }],
    invoice: null, _count: { receipts: 0 }, ...overrides,
  }
}

function matches(row, where = {}) {
  if (row === null || row === undefined) return false
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every((part) => matches(row, part))
    if (key === 'OR') return value.some((part) => matches(row, part))
    const actual = row[key]
    if (value === null || typeof value !== 'object' || value instanceof Date) return actual === value
    if ('some' in value) return actual.some((entry) => matches(entry, value.some))
    if ('contains' in value) {
      // Prisma contains is a PostgreSQL LIKE pattern. The production query
      // escapes wildcard characters; this double compares the resulting literal.
      const needle = value.contains.replace(/\\([\\%_])/g, '$1')
      return typeof actual === 'string' && (value.mode === 'insensitive'
        ? actual.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) : actual.includes(needle))
    }
    if ('gte' in value || 'lt' in value) {
      return (!value.gte || actual >= value.gte) && (!value.lt || actual < value.lt)
    }
    if ('not' in value) return actual !== value.not
    return matches(actual, value)
  })
}

function responseOrder(row, include) {
  assert.deepEqual(plain(include), plain(helpers.adminOrdersInclude))
  const { user, items, invoice, ...scalar } = row
  return {
    ...scalar, user: { name: user.name, email: user.email },
    items: items.map(({ product, ...item }) => ({ ...item, product: { name: product.name } })),
    invoice: invoice ? { id: invoice.id, issuedAt: invoice.issuedAt } : null,
  }
}

function harness({ session = { user: { id: 'admin-1', role: 'ADMIN' } }, rows = [], failAt, onExpire } = {}) {
  const calls = []
  const failure = () => { throw new Error('private PostgreSQL password or address') }
  const prisma = {
    order: {
      count: async ({ where }) => {
        calls.push({ operation: 'count', where })
        if (failAt === 'database') failure()
        return rows.filter((row) => matches(row, where)).length
      },
      aggregate: async (args) => {
        calls.push({ operation: 'aggregate', ...args })
        const selected = rows.filter((row) => matches(row, args.where))
        return { _count: { _all: selected.length }, _sum: { total: selected.length ? selected.reduce((sum, row) => sum + row.total, 0) : null } }
      },
      findMany: async (args) => {
        calls.push({ operation: 'findMany', ...args })
        assert.ok(args.take <= 50)
        const selected = rows.filter((row) => matches(row, args.where)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        return selected.slice(args.skip, args.skip + args.take).map((row) => responseOrder(row, args.include))
      },
    },
    $transaction: async (callback, options) => {
      calls.push({ operation: 'transaction', options })
      return callback(prisma)
    },
  }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])) }
    static now() { return fixedNow.getTime() }
  }
  const route = load('src/app/api/admin/orders/route.ts', {
    'next/server': { NextResponse: Response }, '@/lib/prisma': { prisma },
    '@/lib/auth': { auth: async () => { calls.push({ operation: 'auth' }); if (failAt === 'auth') failure(); return session } },
    '@/lib/payments': { expireUnpaidOrders: async (now) => {
      calls.push({ operation: 'expire', now })
      if (failAt === 'expiry') failure()
      if (onExpire) onExpire(rows)
      return 0
    } },
    '@/lib/admin-orders': helpers, '@/lib/sales-report': reports,
  }, { Date: ClockDate })
  return {
    calls,
    get: async (values = {}) => route.GET(new Request('http://localhost/api/admin/orders?' + query(values))),
    getRaw: async (params) => route.GET(new Request('http://localhost/api/admin/orders?' + params)),
  }
}

const ids = (rows, values) => rows.filter((row) => matches(row, helpers.adminOrdersWhere(parse(values)))).map((row) => row.id)

const dashboardRows = [
  order('today-unpaid'),
  order('today-paid', { verified: true, paymentStatus: 'PAID', status: 'PROCESSING', total: 510000 }),
  order('today-paid-cancelled', { verified: true, paymentStatus: 'PAID', status: 'CANCELLED', total: 900000 }),
  order('today-unverified-shipped', { verified: false, status: 'SHIPPED', total: 700000 }),
  order('old-review', { createdAt: new Date('2026-10-01T10:00:00Z'), paymentStatus: 'AWAITING_REVIEW' }),
  order('old-late-review', { createdAt: new Date('2026-10-01T10:00:00Z'), paymentStatus: 'AWAITING_REVIEW', status: 'CANCELLED' }),
  order('old-ready', { createdAt: new Date('2026-10-01T10:00:00Z'), paymentStatus: 'PAID', verified: true, status: 'PROCESSING' }),
  order('old-unpaid-processing', { createdAt: new Date('2026-10-01T10:00:00Z'), status: 'PROCESSING' }),
  order('already-reviewed', { createdAt: new Date('2026-10-01T10:00:00Z'), paymentStatus: 'AWAITING_REVIEW', verified: true, status: 'DELIVERED' }),
]

test('Default admin filters preserve all orders, with bounded pagination and no date predicate', () => {
  assert.deepEqual(plain(parse()), { q: '', status: 'all', payment: 'all', range: 'all', from: null, to: null, start: null, end: null, page: 1, pageSize: 20 })
  assert.deepEqual(plain(helpers.adminOrdersWhere(parse())), {})
  assert.equal(parse({ q: '  کفش  ', page: '1000000', pageSize: '50' }).q, 'کفش')
})

test('All supported status/payment choices are accepted; unexpected values and oversized pages are rejected', () => {
  for (const status of ['all', 'active', 'PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']) assert.equal(parse({ status }).status, status)
  for (const payment of ['all', 'paid', 'unpaid', 'AWAITING_REVIEW', 'AWAITING_RECEIPT', 'REJECTED', 'EXPIRED']) assert.equal(parse({ payment }).payment, payment)
  for (const values of [
    { status: 'toString' }, { status: 'PAID' }, { payment: 'PAID' }, { range: 'month' },
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'Infinity' }, { page: '1000001' },
    { page: '9007199254740999' }, { pageSize: '100' }, { pageSize: '0' }, { pageSize: '20.0' },
  ]) assert.throws(() => parse(values), helpers.AdminOrdersValidationError)
})

test('Duplicate known filters are rejected rather than accepting only their first value', () => {
  for (const key of ['q', 'status', 'payment', 'range', 'from', 'to', 'page', 'pageSize']) {
    assert.throws(() => helpers.parseAdminOrdersFilters(new URLSearchParams(key + '=1&' + key + '=2')), helpers.AdminOrdersValidationError)
  }
})

test('Search is trimmed, never silently truncated, and rejects control characters before any query', () => {
  assert.equal(parse({ q: 'x'.repeat(120) }).q.length, 120)
  for (const q of ['x'.repeat(121), ' '.repeat(121), 'name\nother', 'x\u0000y', '\u007f']) {
    assert.throws(() => parse({ q }), helpers.AdminOrdersValidationError)
  }
})

test('Today follows Tehran across the UTC evening and uses inclusive dates with an exclusive end', () => {
  const range = parse({ range: 'today' })
  assert.equal(helpers.adminOrdersToday(fixedNow), '2026-10-09')
  assert.equal(range.from, '2026-10-09')
  assert.equal(range.to, '2026-10-09')
  assert.equal(range.start.toISOString(), '2026-10-08T20:30:00.000Z')
  assert.equal(range.end.toISOString(), '2026-10-09T20:30:00.000Z')
  assert.equal(parse({ range: '7d' }).from, '2026-10-03')
  assert.equal(parse({ range: '30d' }).from, '2026-09-10')
})

test('Custom range honors historical daylight saving and accepts a 366-day leap year', () => {
  const custom = parse({ range: 'custom', from: '2021-03-22', to: '2021-03-22' })
  assert.equal(custom.start.toISOString(), '2021-03-21T20:30:00.000Z')
  assert.equal(custom.end.toISOString(), '2021-03-22T19:30:00.000Z')
  assert.equal(custom.end - custom.start, 23 * 3600000)
  assert.equal(parse({ range: 'custom', from: '2024-01-01', to: '2024-12-31' }).to, '2024-12-31')
})

test('Invalid dates, missing or reversed dates, custom dates on presets and overlong ranges are rejected', () => {
  for (const values of [
    { range: 'custom' }, { range: 'custom', from: '2026-10-09' },
    { range: 'custom', from: '2026-02-29', to: '2026-03-01' },
    { range: 'custom', from: '2026-10-10', to: '2026-10-09' },
    { range: 'custom', from: '2026-1-1', to: '2026-10-09' },
    { range: 'custom', from: '2024-01-01', to: '2025-01-01' },
    { range: 'today', from: '2026-10-09', to: '2026-10-09' },
    { range: 'all', from: '' }, { range: '7d', to: '2026-10-09' },
  ]) assert.throws(() => parse(values), helpers.AdminOrdersValidationError)
})

test('Date filtering includes unpaid orders exactly at start and excludes orders exactly at the next day', () => {
  const rows = [
    order('before', { createdAt: new Date('2026-10-08T20:29:59.999Z') }),
    order('start', { createdAt: new Date('2026-10-08T20:30:00.000Z') }),
    order('last', { createdAt: new Date('2026-10-09T20:29:59.999Z') }),
    order('after', { createdAt: new Date('2026-10-09T20:30:00.000Z') }),
  ]
  assert.deepEqual(ids(rows, { range: 'today', payment: 'unpaid' }), ['start', 'last'])
})

test('Search finds full IDs, visible short IDs with #, customer name/email, recipient and phone', () => {
  const row = order('cmorder-ab1234')
  for (const q of ['cmorder-ab1234', 'AB1234', '#ab1234', 'مشتری نمونه', 'SHOPPER@EXAMPLE', 'گیرنده نمونه', '09121234567']) {
    assert.deepEqual(ids([row], { q }), [row.id], q)
  }
  assert.deepEqual(ids([row], { q: '#' }), [])
})

test('Search covers immutable item product-name snapshots as well as current product names', () => {
  const rows = [order('snapshot')]
  assert.deepEqual(ids(rows, { q: 'قدیمی' }), ['snapshot'])
  assert.deepEqual(ids(rows, { q: 'جدید' }), ['snapshot'])
  assert.deepEqual(ids(rows, { q: 'ناموجود' }), [])
})

test('Persian and Arabic numeric searches find ASCII phone numbers and common digit scripts stored in orders', () => {
  const rows = [order('ascii'), order('persian', { phone: '۰۹۱۲۱۲۳۴۵۶۷' }), order('arabic', { phone: '٠٩١٢١٢٣٤٥٦٧' })]
  for (const q of ['۰۹۱۲۱۲۳۴۵۶۷', '٠٩١٢١٢٣٤٥٦٧', '۰٩۱٢۱۲۳۴٥۶۷', '0912-123 4567']) {
    assert.deepEqual(ids(rows, { q }), ['ascii', 'persian', 'arabic'])
  }
})

test('Common Persian/Arabic kaf and yeh variants are searched without changing stored data', () => {
  const rows = [order('persian', { recipientName: 'کیانا' }), order('arabic', { recipientName: 'كيانا' }), order('alternate', { recipientName: 'كىانا' })]
  for (const q of ['کیانا', 'كيانا', 'كىانا']) assert.deepEqual(ids(rows, { q }), ['persian', 'arabic', 'alternate'])
})

test('LIKE wildcard characters in names/email are escaped and remain literal search text', () => {
  for (const special of ['%', '_', '\\']) {
    const where = helpers.adminOrdersWhere(parse({ q: special }))
    const predicate = where.AND[0].OR.find((part) => part.phone).phone
    assert.equal(predicate.contains, '\\' + special)
    assert.deepEqual(ids([order('normal'), order('literal', { recipientName: 'a' + special + 'b' })], { q: special }), ['literal'])
  }
})

test('Combined status/payment/date/search predicates all apply and review includes cancelled late receipts', () => {
  assert.deepEqual(ids(dashboardRows, { payment: 'AWAITING_REVIEW' }), ['old-review', 'old-late-review'])
  assert.deepEqual(ids(dashboardRows, { payment: 'paid', status: 'CANCELLED' }), ['today-paid-cancelled'])
  assert.deepEqual(ids(dashboardRows, { payment: 'paid', status: 'active', range: 'today' }), ['today-paid'])
  assert.deepEqual(ids(dashboardRows, { payment: 'unpaid', status: 'SHIPPED', range: 'today', q: 'گیرنده' }), ['today-unverified-shipped'])
  assert.deepEqual(ids(dashboardRows, { payment: 'paid', status: 'SHIPPED', range: 'today' }), [])
})

test('Dashboard aggregates use confirmed payment and global operational queues, including late receipts', () => {
  const where = helpers.adminOrdersDashboardWhere(fixedNow)
  assert.equal(where.date, '2026-10-09')
  assert.equal(dashboardRows.filter((row) => matches(row, where.todayOrders)).length, 4)
  assert.equal(dashboardRows.filter((row) => matches(row, where.todayPaidOrders)).length, 1)
  assert.equal(dashboardRows.filter((row) => matches(row, where.awaitingReview)).length, 2)
  assert.equal(dashboardRows.filter((row) => matches(row, where.readyToShip)).length, 2)
})

test('Anonymous, incomplete-session and non-admin callers never read or expire order data', async () => {
  for (const [session, status] of [[null, 401], [{ user: { role: 'ADMIN' } }, 401], [{ user: { id: 'customer-1', role: 'USER' } }, 403]]) {
    const h = harness({ session })
    const response = await h.get()
    assert.equal(response.status, status)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(h.calls.map((call) => call.operation), ['auth'])
  }
})

test('Invalid filters return private 400 before expiry or database work, with no stack/details', async () => {
  const h = harness()
  const response = await h.getRaw('q=x&q=y')
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(typeof (await response.json()).error, 'string')
  assert.deepEqual(h.calls.map((call) => call.operation), ['auth'])
})

test('API dashboard remains independent of a table filter that matches nothing', async () => {
  const h = harness({ rows: dashboardRows })
  const response = await h.get({ q: 'no such order', range: 'today', status: 'DELIVERED' })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.deepEqual(data.orders, [])
  assert.deepEqual(data.pagination, { page: 1, pageSize: 20, total: 0, pages: 1 })
  assert.deepEqual(data.dashboard, { date: '2026-10-09', timeZone: 'Asia/Tehran', todayOrders: 4, todayPaidOrders: 1, todayPaidTotal: 510000, awaitingReview: 2, readyToShip: 2 })
  assert.equal(data.generatedAt, fixedNow.toISOString())
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  const snapshot = h.calls.find((call) => call.operation === 'transaction')
  assert.deepEqual(plain(snapshot.options), { isolationLevel: 'RepeatableRead' })
})

test('API expires reservations before the coherent dashboard and order snapshot', async () => {
  const rows = [order('expired', { status: 'PROCESSING', verified: true, paymentStatus: 'AWAITING_RECEIPT' })]
  const h = harness({ rows, onExpire: (data) => { data[0].verified = false; data[0].status = 'CANCELLED'; data[0].paymentStatus = 'EXPIRED' } })
  const response = await h.get({ payment: 'EXPIRED' })
  const data = await response.json()
  assert.equal(data.orders[0].status, 'CANCELLED')
  assert.equal(data.dashboard.readyToShip, 0)
  assert.equal(data.dashboard.todayPaidOrders, 0)
  assert.ok(h.calls.findIndex((call) => call.operation === 'expire') < h.calls.findIndex((call) => call.operation === 'transaction'))
  assert.equal(h.calls.find((call) => call.operation === 'expire').now.toISOString(), fixedNow.toISOString())
})

test('Pagination is database bounded, stable for tied timestamps, and totals/metrics cover all pages', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => order('order-' + String(index).padStart(3, '0'), { verified: true, paymentStatus: 'PAID', total: 1000 }))
  const h = harness({ rows })
  const data = await (await h.get({ page: '2' })).json()
  assert.deepEqual(data.pagination, { page: 2, pageSize: 20, total: 45, pages: 3 })
  assert.equal(data.orders.length, 20)
  assert.equal(data.orders[0].id, 'order-024')
  assert.equal(data.orders.at(-1).id, 'order-005')
  assert.equal(data.dashboard.todayOrders, 45)
  assert.equal(data.dashboard.todayPaidOrders, 45)
  assert.equal(data.dashboard.todayPaidTotal, 45000)
  const read = h.calls.find((call) => call.operation === 'findMany')
  assert.deepEqual(plain(read.orderBy), [{ createdAt: 'desc' }, { id: 'desc' }])
  assert.equal(read.take, 20)
  assert.equal(read.skip, 20)
})

test('A stale page after deletion clamps to the last available page and empty lists clamp to page one', async () => {
  for (const [count, page, length] of [[21, 2, 1], [20, 1, 20], [0, 1, 0]]) {
    const h = harness({ rows: Array.from({ length: count }, (_, index) => order('order-' + index)) })
    const data = await (await h.get({ page: '9999' })).json()
    assert.equal(data.pagination.page, page)
    assert.equal(data.orders.length, length)
    assert.equal(data.pagination.total, count)
    assert.equal(data.pagination.pages, Math.max(1, Math.ceil(count / 20)))
  }
})

test('Fifty-row pages work without allowing unrestricted reads', async () => {
  const h = harness({ rows: Array.from({ length: 51 }, (_, index) => order('order-' + index)) })
  const data = await (await h.get({ pageSize: '50' })).json()
  assert.equal(data.orders.length, 50)
  assert.equal(data.pagination.pages, 2)
  assert.equal(h.calls.find((call) => call.operation === 'findMany').take, 50)
})

test('An empty aggregate returns zero money and payment counts rather than null', async () => {
  const data = await (await harness().get()).json()
  assert.equal(data.dashboard.todayPaidOrders, 0)
  assert.equal(data.dashboard.todayPaidTotal, 0)
  assert.equal(data.dashboard.awaitingReview, 0)
  assert.equal(data.dashboard.readyToShip, 0)
})

test('Order response preserves invoice/payment history and snapshot data while selecting safe related fields', async () => {
  const h = harness({ rows: [order('with-invoice', { invoice: { id: 8, issuedAt: new Date('2026-10-09T10:00:00Z'), snapshot: { private: 'do not expose' } }, _count: { receipts: 2 } })] })
  const data = await (await h.get()).json()
  assert.deepEqual(data.orders[0].invoice, { id: 8, issuedAt: '2026-10-09T10:00:00.000Z' })
  assert.equal(data.orders[0]._count.receipts, 2)
  assert.equal(data.orders[0].items[0].productName, 'کفش قدیمی')
  assert.equal(data.orders[0].items[0].product.name, 'کفش جدید')
  assert.equal(data.orders[0].recipientName, 'گیرنده نمونه')
  assert.ok(!JSON.stringify(data).includes('do not expose'))
  assert.ok(!JSON.stringify(data).includes('password'))
  assert.ok(!JSON.stringify(data).includes('internal'))
})

test('Auth, expiration and database failures return private generic errors without leaking internals', async () => {
  for (const failAt of ['auth', 'expiry', 'database']) {
    const h = harness({ failAt })
    const response = await h.get()
    assert.equal(response.status, 500)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ['error'])
    assert.ok(!JSON.stringify(body).includes('PostgreSQL'))
    assert.ok(!JSON.stringify(body).includes('password'))
  }
})
