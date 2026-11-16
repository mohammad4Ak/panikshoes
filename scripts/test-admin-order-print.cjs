const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const cache = new Map()
function load(file, dependencies = {}, globals = {}) {
  if (!cache.has(file)) cache.set(file, transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code)
  const compiled = { exports: {} }
  vm.runInNewContext(cache.get(file), { module: compiled, Request, Response, URL, URLSearchParams, Intl, Date, Buffer, ...globals, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`)
    return dependencies[name]
  } })
  return compiled.exports
}
const frozenNow = Date.parse('2026-11-14T13:00:00Z')
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [frozenNow])) } static now() { return frozenNow } }
const deps = {
  'next/server': { NextResponse: Response },
  '@/lib/payment-contract': load('src/lib/payment-contract.ts'),
  '@/lib/sales-report': load('src/lib/sales-report.ts'),
  '@/lib/customer-contact': load('src/lib/customer-contact.ts'),
  '@/lib/invoice': load('src/lib/invoice.ts'),
  '@/lib/admin-order-print-contract': load('src/lib/admin-order-print-contract.ts'),
  '@/lib/request-origin': load('src/lib/request-origin.ts'),
}
deps['@/lib/api-input'] = load('src/lib/api-input.ts', deps)
deps['@/lib/admin-orders'] = load('src/lib/admin-orders.ts', deps)
deps['@/lib/admin-order-print'] = load('src/lib/admin-order-print.ts', deps, { Date: TestDate })

const plain = value => JSON.parse(JSON.stringify(value))
function snapshot(id = 'one', overrides = {}) {
  return {
    schemaVersion: 1, seller: { name: 'فروشنده هنگام صدور' }, buyer: { name: 'خریدار سابق', email: 'old@example.test' },
    recipient: { name: 'گیرنده هنگام صدور', address: 'نشانی هنگام صدور', phone: '09121111111' },
    orderId: id, orderCreatedAt: '2026-11-14T08:00:00.000Z', currency: 'تومان',
    items: [{ productId: 'shoe', productName: 'کفش هنگام خرید', quantity: 2, size: 38, color: 'مشکی', unitPrice: 100000, lineTotal: 200000 }],
    subtotal: 200000, shippingMethodName: 'پست قدیم', shippingCost: 50000, total: 250000, ...overrides,
  }
}
function order(id = 'one', overrides = {}) {
  return {
    id, status: 'PROCESSING', verified: true, createdAt: new Date('2026-11-14T08:00:00Z'),
    recipientName: 'گیرنده ذخیره‌شده', address: 'نشانی ثبت سفارش', phone: '09123456789', postalCode: '0123456789',
    shippingMethodName: 'پست', trackingCode: null,
    items: [{ id: 'item', productId: 'shoe', productName: 'کفش هنگام خرید', quantity: 2, size: 38, color: 'مشکی' }],
    invoice: { id: 123, issuedAt: new Date('2026-11-14T09:00:00Z'), snapshot: snapshot(id) },
    // These fields must never be selected or used by the print implementation.
    user: { name: 'نام جدید حساب', phone: '09999999999', postalCode: '9999999999', address: 'نشانی جدید حساب' },
    currentProduct: { name: 'نام جدید ویترین', price: 999999999 }, ...overrides,
  }
}
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every(part => matches(row, part))
    if (key === 'OR') return value.some(part => matches(row, part))
    if (value === null || typeof value !== 'object') return row[key] === value
    if (value.in) return value.in.includes(row[key])
    if (value.not) return row[key] !== value.not
    if (value.contains !== undefined) return String(row[key] ?? '').toLowerCase().includes(value.contains.replace(/\\([\\%_])/g, '$1').toLowerCase())
    return (!value.gte || row[key] >= value.gte) && (!value.lt || row[key] < value.lt)
  })
}
function harness(orders = [order()], settings = { storeName: 'پانیک', phone: '04112345678', address: 'نشانی فعلی فرستنده' }) {
  const original = plain(orders)
  let session = { user: { id: 'admin', role: 'ADMIN' } }
  const queries = [], settingQueries = []
  const db = {
    order: { findMany: async query => {
      queries.push(query)
      return structuredClone(orders.filter(row => matches(row, query.where)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, query.take))
    } },
    siteSettings: { findUnique: async query => { settingQueries.push(query); return settings } },
  }
  const route = load('src/app/api/admin/orders/documents/route.ts', { ...deps, '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma: db } }, { Date: TestDate })
  const post = (body = { kind: 'invoice', mode: 'selected', ids: ['one'] }, options = {}) => route.POST(new Request('http://localhost:3000/api/admin/orders/documents', {
    method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', ...options.headers }, body: options.raw ?? JSON.stringify(body),
  }))
  return { post, db, queries, settingQueries, setSession(value) { session = value }, unchanged() { assert.deepEqual(plain(orders), original) } }
}

test('Only admins from the same origin can access documents; denial precedes reads', async () => {
  for (const [session, status] of [[null, 401], [{ user: { id: 'buyer', role: 'USER' } }, 403]]) {
    const app = harness(); app.setSession(session)
    const response = await app.post()
    assert.equal(response.status, status); assert.equal(app.queries.length, 0); assert.equal(app.settingQueries.length, 0)
    assert.match(response.headers.get('cache-control'), /private.*no-store/)
  }
  const app = harness()
  const response = await app.post(undefined, { headers: { origin: 'https://foreign.example' } })
  assert.equal(response.status, 403); assert.equal(app.queries.length, 0); assert.equal(app.settingQueries.length, 0)
})

test('Selected documents retain the exact requested order and report missing orders explicitly', async () => {
  const app = harness([order('one'), order('two')])
  const response = await app.post({ kind: 'invoice', mode: 'selected', ids: ['two', 'missing', 'one'] })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload.rows.map(row => row.id), ['two', 'missing', 'one'])
  assert.equal(payload.rows[1].eligible, false); assert.equal(payload.rows[1].document, null)
  assert.match(payload.rows[1].reason, /یافت نشد/); assert.equal(payload.limit, 100)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('vary'), 'Cookie')
  app.unchanged()
})

test('Invoices use only the immutable issued snapshot and retain old branding and zero current profile/catalog values', async () => {
  const saved = snapshot()
  const app = harness([order()])
  const response = await app.post()
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(payload.rows[0].document.invoice.snapshot, saved)
  assert.equal(payload.rows[0].document.invoice.number, 'INV-2026-000123')
  assert.equal(app.settingQueries.length, 0, 'Invoice branding is frozen, so current settings are not read')
  assert.equal(Object.hasOwn(app.queries[0].select, 'user'), false)
  assert.equal(Object.hasOwn(app.queries[0].select.items.select, 'product'), false)
  assert.equal(JSON.stringify(payload).includes('999999999'), false)
  app.unchanged()
})

test('Printing never issues an absent invoice or changes order/payment/stock state', async () => {
  const app = harness([order('one', { invoice: null, status: 'PENDING', verified: false })])
  const response = await app.post()
  assert.equal(response.status, 200)
  const row = (await response.json()).rows[0]
  assert.equal(row.eligible, false); assert.match(row.reason, /صادر نشده/)
  app.unchanged()
})

test('Previously issued cancelled and pending invoices remain printable with clear status warnings', async () => {
  for (const status of ['CANCELLED', 'PENDING']) {
    const app = harness([order('one', { status, verified: false })])
    const row = (await (await app.post()).json()).rows[0]
    assert.equal(row.eligible, true); assert.equal(row.document.status, status); assert.ok(row.warnings.length)
    app.unchanged()
  }
})

test('Invalid invoice structures, identity, dates, arithmetic and totals are skipped rather than regenerated', async () => {
  const cases = [
    null, {}, snapshot('another'), snapshot('one', { schemaVersion: 2 }), snapshot('one', { currency: 'ریال' }),
    snapshot('one', { orderCreatedAt: 'invalid' }), snapshot('one', { orderCreatedAt: '2026-02-31T08:00:00.000Z' }),
    snapshot('one', { orderCreatedAt: '1' }), snapshot('one', { total: 1 }), snapshot('one', { subtotal: 1 }),
    snapshot('one', { shippingCost: -1 }), snapshot('one', { items: [] }),
    snapshot('one', { items: [{ ...snapshot().items[0], quantity: 1.5 }] }),
    snapshot('one', { items: [{ ...snapshot().items[0], lineTotal: 199999 }] }),
    snapshot('one', { items: [{ ...snapshot().items[0], couponDiscount: -1 }] }),
    snapshot('one', { items: [{ ...snapshot().items[0], quantity: Number.MAX_SAFE_INTEGER }] }),
  ]
  for (const value of cases) {
    const app = harness([order('one', { invoice: { id: 123, issuedAt: new Date('2026-11-14'), snapshot: value } })])
    const row = (await (await app.post()).json()).rows[0]
    assert.equal(row.eligible, false, JSON.stringify(value)); assert.equal(row.document, null); assert.match(row.reason, /نامعتبر/)
  }
})

test('Discounted snapshots accept exact coupon allocation including a zero-valued line and reject inconsistent discounts', async () => {
  const saved = snapshot('one', {
    items: [
      { productId: 'shoe', productName: 'اول', size: 38, color: 'مشکی', quantity: 1, originalUnitPrice: 200000, unitPrice: 150000, productDiscount: 50000, couponDiscount: 150000, lineTotal: 0 },
      { productId: 'other', productName: 'دوم', size: 39, color: 'سفید', quantity: 1, originalUnitPrice: 100000, unitPrice: 100000, productDiscount: 0, couponDiscount: 0, lineTotal: 100000 },
    ], subtotal: 300000, productDiscount: 50000, couponDiscount: 150000, couponCode: 'TEST', merchandiseTotal: 100000, shippingCost: 0, total: 100000,
  })
  const parse = deps['@/lib/admin-order-print'].storedInvoiceSnapshot
  assert.deepEqual(plain(parse(saved, 'one')), saved)
  for (const patch of [{ couponDiscount: 149999 }, { productDiscount: 0 }, { merchandiseTotal: 1 }]) assert.equal(parse({ ...saved, ...patch }, 'one'), null)
})

test('Malformed invoice metadata does not crash or create a printable invoice', async () => {
  for (const invoice of [{ id: 0, issuedAt: new Date(), snapshot: snapshot() }, { id: 1, issuedAt: new Date('invalid'), snapshot: snapshot() }]) {
    const app = harness([order('one', { invoice })])
    const row = (await (await app.post()).json()).rows[0]
    assert.equal(row.eligible, false)
  }
})

test('Packing and shipping labels reject unpaid, pending and cancelled orders', async () => {
  for (const kind of ['packing', 'shipping-label']) {
    for (const patch of [{ verified: false }, { status: 'PENDING' }, { status: 'CANCELLED' }]) {
      const app = harness([order('one', patch)])
      const row = (await (await app.post({ kind, mode: 'selected', ids: ['one'] })).json()).rows[0]
      assert.equal(row.eligible, false); assert.equal(row.document, null)
      app.unchanged()
    }
  }
})

test('Packing uses order variant snapshots, recipient data and only configured sender contacts without money', async () => {
  const app = harness([order()])
  const response = await app.post({ kind: 'packing', mode: 'selected', ids: ['one'] })
  const row = (await response.json()).rows[0]
  assert.equal(row.eligible, true)
  assert.deepEqual(row.document.recipient, { name: 'گیرنده ذخیره‌شده', address: 'نشانی ثبت سفارش', phone: '09123456789', postalCode: '0123456789' })
  assert.deepEqual(row.document.seller, { name: 'پانیک', phone: '04112345678', address: 'نشانی فعلی فرستنده' })
  assert.deepEqual(row.document.items, [{ productName: 'کفش هنگام خرید', quantity: 2, size: 38, color: 'مشکی' }])
  for (const value of ['price', 'total', 'email', 'snapshot', 'unitPrice']) assert.equal(JSON.stringify(row.document).includes(`"${value}"`), false, value)
  app.unchanged()
})

test('A missing legacy name uses the matching issued invoice instead of current profile/catalog data', async () => {
  const original = order('one', { recipientName: null, items: [{ ...order().items[0], productName: null }] })
  const app = harness([original])
  const row = (await (await app.post({ kind: 'packing', mode: 'selected', ids: ['one'] })).json()).rows[0]
  assert.equal(row.document.recipient.name, 'گیرنده هنگام صدور')
  assert.equal(row.document.items[0].productName, 'کفش هنگام خرید')
  assert.equal(row.warnings.length, 0)
  const missing = harness([{ ...original, invoice: null }])
  const unknown = (await (await missing.post({ kind: 'packing', mode: 'selected', ids: ['one'] })).json()).rows[0]
  assert.equal(unknown.document.recipient.name, 'گیرنده ثبت نشده'); assert.equal(unknown.document.items[0].productName, 'کالای ثبت‌شده'); assert.equal(unknown.warnings.length, 2)
  const label = (await (await missing.post({ kind: 'shipping-label', mode: 'selected', ids: ['one'] })).json()).rows[0]
  assert.equal(label.eligible, false); assert.match(label.reason, /نام گیرنده/)
})

test('Labels normalize Persian phone/postal digits and preserve leading zero; legacy missing postcode is explicit', async () => {
  const app = harness([order('one', { phone: '+۹۸۹۱۲۳۴۵۶۷۸۹', postalCode: '۰۱۲۳۴-۵۶۷۸۹' })])
  const label = (await (await app.post({ kind: 'shipping-label', mode: 'selected', ids: ['one'] })).json()).rows[0]
  assert.equal(label.eligible, true); assert.equal(label.document.recipient.phone, '09123456789'); assert.equal(label.document.recipient.postalCode, '0123456789'); assert.deepEqual(label.document.items, [])
  for (const postalCode of [null, '', '1111111111', '1234']) {
    const legacy = harness([order('one', { postalCode })])
    const skipped = (await (await legacy.post({ kind: 'shipping-label', mode: 'selected', ids: ['one'] })).json()).rows[0]
    assert.equal(skipped.eligible, false); assert.match(skipped.reason, /کدپستی/)
    const packing = (await (await legacy.post({ kind: 'packing', mode: 'selected', ids: ['one'] })).json()).rows[0]
    assert.equal(packing.eligible, true); assert.equal(packing.document.recipient.postalCode, null); assert.ok(packing.warnings.some(warning => warning.includes('کدپستی')))
  }
})

test('Incomplete order addresses and shipping phone cannot silently fall back to current user details', async () => {
  for (const patch of [{ address: '' }, { phone: '' }, { phone: '123' }]) {
    const app = harness([order('one', patch)])
    const label = (await (await app.post({ kind: 'shipping-label', mode: 'selected', ids: ['one'] })).json()).rows[0]
    assert.equal(label.eligible, false); assert.equal(label.document, null)
  }
})

test('Absent sender settings stay blank with warnings instead of printing sample addresses or phones', async () => {
  const app = harness([order()], null)
  const label = (await (await app.post({ kind: 'shipping-label', mode: 'selected', ids: ['one'] })).json()).rows[0]
  assert.equal(label.eligible, true)
  assert.deepEqual(label.document.seller, { name: 'فروشگاه', phone: '', address: '' })
  assert.equal(label.warnings.length, 3)
  assert.deepEqual(plain(app.settingQueries[0]), { where: { id: 1 }, select: { storeName: true, phone: true, address: true } })
})

test('Filtered preparation reuses date/status/payment filters without pagination and includes every matching page', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => order(`order-${index}`))
  rows.push(order('old', { createdAt: new Date('2026-11-13T19:59:00Z') }), order('unpaid', { verified: false }))
  const app = harness(rows)
  const response = await app.post({ kind: 'invoice', mode: 'filtered', filters: 'range=today&status=PROCESSING&payment=paid' })
  const payload = await response.json()
  assert.equal(response.status, 200); assert.equal(payload.rows.length, 25)
  const query = app.queries[0]
  assert.equal(query.skip, undefined); assert.equal(query.take, 101)
  assert.equal(query.where.AND[0].createdAt.gte.toISOString(), '2026-11-13T20:30:00.000Z')
  assert.equal(query.where.AND[0].createdAt.lt.toISOString(), '2026-11-14T20:30:00.000Z')
  assert.deepEqual(plain(query.where.AND.slice(1)), [{ status: 'PROCESSING' }, { verified: true }])
})

test('Limits reject all 101 filtered matches instead of silently printing the first 100', async () => {
  const app = harness(Array.from({ length: 101 }, (_, index) => order(`order-${index}`)))
  const response = await app.post({ kind: 'invoice', mode: 'filtered', filters: 'range=today' })
  assert.equal(response.status, 422); assert.match((await response.json()).error, /بیش از ۱۰۰/)
  app.unchanged()
})

test('Invalid selections and filters are rejected before querying orders', async () => {
  const cases = [
    { kind: 'unknown', mode: 'selected', ids: ['one'] }, { kind: 'invoice', mode: 'all' },
    { kind: 'invoice', mode: 'selected', ids: [] }, { kind: 'invoice', mode: 'selected', ids: ['one', 'one'] },
    { kind: 'invoice', mode: 'selected', ids: ['bad id'] }, { kind: 'invoice', mode: 'selected', ids: Array.from({ length: 101 }, (_, index) => String(index)) },
    { kind: 'invoice', mode: 'selected', ids: ['one'], filters: 'range=today' },
    { kind: 'invoice', mode: 'filtered', filters: '' }, { kind: 'invoice', mode: 'filtered', filters: 'range=all&status=all&payment=all' },
    { kind: 'invoice', mode: 'filtered', filters: 'range=today&page=2' }, { kind: 'invoice', mode: 'filtered', filters: 'range=today&range=7d' },
    { kind: 'invoice', mode: 'filtered', filters: 'range=custom&from=bad&to=bad' }, { kind: 'invoice', mode: 'filtered', filters: 'status=invalid' },
    { kind: 'invoice', mode: 'filtered', filters: 'range=today', ids: ['one'] },
    { kind: 'packing', mode: 'selected', ids: [] }, { kind: 'shipping-label', mode: 'filtered', filters: 'range=today&page=2' },
    { kind: 'packing', mode: 'selected', ids: ['one'], unexpected: 'value' },
  ]
  for (const body of cases) {
    const app = harness()
    const response = await app.post(body)
    assert.equal(response.status, 400, JSON.stringify(body)); assert.equal(app.queries.length, 0); assert.equal(app.settingQueries.length, 0)
  }
})

test('Invalid fulfillment requests remain 400 without touching an unavailable sender-settings database', async () => {
  const app = harness()
  let settingsReads = 0
  app.db.siteSettings.findUnique = async () => { settingsReads++; throw new Error('Sender database unavailable') }
  for (const body of [{ kind: 'packing', mode: 'selected', ids: [] }, { kind: 'shipping-label', mode: 'filtered', filters: 'range=custom&from=bad&to=bad' }, { kind: 'bad', mode: 'selected', ids: ['one'] }]) {
    const response = await app.post(body)
    assert.equal(response.status, 400)
  }
  assert.equal(settingsReads, 0); assert.equal(app.queries.length, 0)
})

test('Malformed JSON and oversized bodies are rejected without order or sender reads', async () => {
  for (const [raw, headers, status] of [['[]', {}, 400], ['{', {}, 400], ['x'.repeat(65537), {}, 413], ['{}', { 'content-length': '65537' }, 413]]) {
    const app = harness()
    const response = await app.post(undefined, { raw, headers })
    assert.equal(response.status, status); assert.equal(app.queries.length, 0); assert.equal(app.settingQueries.length, 0)
  }
})

test('More than 500 packing lines skip the complete order, and 3MiB response cap never truncates documents', async () => {
  const app = harness([order('one', { items: Array.from({ length: 501 }, (_, index) => ({ ...order().items[0], id: String(index) })) })])
  const row = (await (await app.post({ kind: 'packing', mode: 'selected', ids: ['one'] })).json()).rows[0]
  assert.equal(row.eligible, false); assert.match(row.reason, /بیش از حد بزرگ/)
  const names = 'ف'.repeat(1000)
  const oversized = harness(Array.from({ length: 4 }, (_, orderIndex) => order(`order-${orderIndex}`, { items: Array.from({ length: 500 }, (_, index) => ({ ...order().items[0], id: String(index), productName: names })) })))
  const response = await oversized.post({ kind: 'packing', mode: 'filtered', filters: 'range=today' })
  assert.equal(response.status, 413); assert.match((await response.json()).error, /حجم مدارک/)
})

test('An empty filtered result is a complete empty preparation rather than an error or fabricated document', async () => {
  const app = harness([])
  const response = await app.post({ kind: 'invoice', mode: 'filtered', filters: 'range=today' })
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).rows, [])
})
