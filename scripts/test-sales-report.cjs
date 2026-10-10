const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Exercise the production report with isolated auth/database dependencies. No PostgreSQL connection is made.
function loadModule(relativePath, dependencies = {}, globals = {}) {
  const source = readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
  const context = {
    module: { exports: {} },
    Date, Intl, URL, URLSearchParams, Request, Response,
    console: { error: () => {} },
    ...globals,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  }
  vm.runInNewContext(code, context)
  return context.module.exports
}

const plain = (value) => JSON.parse(JSON.stringify(value))

function order(id, overrides = {}) {
  return {
    id, createdAt: new Date('2026-09-29T20:30:00.000Z'), verified: true,
    status: 'DELIVERED', total: 210000, shippingCost: 10000,
    shippingMethodName: 'پست پیشتاز', shippingMethodId: 'method-1',
    items: [{ productId: 'shoe-1', quantity: 2, price: 100000, product: { name: 'کفش کوهنوردی' } }],
    ...overrides,
  }
}

const reports = loadModule('src/lib/sales-report.ts')
const fixedNow = new Date('2026-09-30T10:00:00.000Z')
const query = (values = {}) => new URLSearchParams(values)
const customRange = (from, to = from) => reports.parseSalesRange(query({ range: 'custom', from, to }), fixedNow)

test('The rolling report includes today in Tehran and compares an equal, adjacent period', () => {
  for (const [preset, days, from, previousFrom, previousTo] of [
    ['7d', 7, '2026-09-24', '2026-09-17', '2026-09-23'],
    ['30d', 30, '2026-09-01', '2026-08-02', '2026-08-31'],
    ['90d', 90, '2026-07-03', '2026-04-04', '2026-07-02'],
  ]) {
    const range = reports.parseSalesRange(query({ range: preset }), fixedNow)
    assert.equal(range.from, from)
    assert.equal(range.to, '2026-09-30')
    assert.equal(range.days, days)
    assert.equal(range.previousFrom, previousFrom)
    assert.equal(range.previousTo, previousTo)
    assert.equal(range.previousEnd.getTime(), range.start.getTime())
    assert.equal(range.end.getTime() - range.start.getTime(), days * 86400000)
    assert.equal(range.previousEnd.getTime() - range.previousStart.getTime(), days * 86400000)
  }
})

test('The default range and the current Jalali month use the Tehran calendar', () => {
  assert.equal(reports.parseSalesRange(query(), fixedNow).preset, '30d')
  const month = reports.parseSalesRange(query({ range: 'month' }), fixedNow)
  assert.equal(month.from, '2026-09-23')
  assert.equal(month.to, '2026-09-30')
  assert.equal(month.days, 8)
  const nowruz = reports.parseSalesRange(query({ range: 'month' }), new Date('2024-03-20T10:00:00Z'))
  assert.equal(nowruz.from, '2024-03-20')
  assert.equal(nowruz.days, 1)
})

test('A UTC evening rolls into the next Tehran date regardless of the host timezone', () => {
  const range = reports.parseSalesRange(query({ range: '7d' }), new Date('2026-09-30T21:00:00Z'))
  assert.equal(range.to, '2026-10-01')
  assert.equal(range.from, '2026-09-25')
  assert.equal(range.end.toISOString(), '2026-10-01T20:30:00.000Z')
})

test('Inclusive custom dates become half-open Tehran instants, including leap day', () => {
  const single = customRange('2026-09-30')
  assert.equal(single.days, 1)
  assert.equal(single.start.toISOString(), '2026-09-29T20:30:00.000Z')
  assert.equal(single.end.toISOString(), '2026-09-30T20:30:00.000Z')
  assert.equal(single.previousFrom, '2026-09-29')
  assert.equal(single.previousTo, '2026-09-29')
  const leap = customRange('2024-02-28', '2024-03-01')
  assert.equal(leap.days, 3)
  assert.equal(leap.previousFrom, '2024-02-25')
  assert.equal(leap.previousTo, '2024-02-27')
  assert.equal(customRange('2024-01-01', '2024-12-31').days, 366)
})

test('Historical Tehran daylight saving boundaries are honored rather than assuming a fixed offset', () => {
  const summer = customRange('2021-07-01')
  assert.equal(summer.start.toISOString(), '2021-06-30T19:30:00.000Z')
  assert.equal(summer.end.toISOString(), '2021-07-01T19:30:00.000Z')
  const shift = customRange('2021-03-22')
  assert.equal(shift.start.toISOString(), '2021-03-21T20:30:00.000Z')
  assert.equal(shift.end.toISOString(), '2021-03-22T19:30:00.000Z')
  assert.equal(shift.end.getTime() - shift.start.getTime(), 23 * 3600000)
})

test('Malformed dates, impossible leap dates, reversed dates and overlong ranges are rejected', () => {
  for (const values of [
    { range: 'week' }, { range: 'custom' },
    { range: 'custom', from: '2026-02-29', to: '2026-03-01' },
    { range: 'custom', from: '2026-02-30', to: '2026-03-01' },
    { range: 'custom', from: '2026-9-1', to: '2026-09-30' },
    { range: 'custom', from: '2026-09-30', to: '2026-09-29' },
    { range: 'custom', from: '2024-01-01', to: '2025-01-01' },
    { range: 'custom', from: 'not-a-date', to: '2026-09-30' },
  ]) assert.throws(() => reports.parseSalesRange(query(values), fixedNow), reports.SalesReportValidationError)
})

test('Payment classification treats paid cancellations separately and does not equate fulfillment with payment', () => {
  assert.equal(reports.classifyPayment(order('paid-pending', { status: 'PENDING' })), 'paid')
  assert.equal(reports.classifyPayment(order('unpaid-delivered', { status: 'DELIVERED', verified: false })), 'unpaid')
  assert.equal(reports.classifyPayment(order('paid-cancelled', { status: 'CANCELLED' })), 'paid_cancelled')
  assert.equal(reports.classifyPayment(order('unpaid-cancelled', { status: 'CANCELLED', verified: false })), 'unpaid_cancelled')
})

test('Ledger filters accept only explicit payment/status choices and bounded pagination', () => {
  assert.deepEqual(plain(reports.parseLedgerFilters(query())), { payment: 'all', status: 'all', page: 1, pageSize: 25 })
  for (const payment of ['all', 'paid', 'unpaid', 'paid_cancelled', 'unpaid_cancelled']) {
    assert.equal(reports.parseLedgerFilters(query({ payment })).payment, payment)
  }
  for (const status of ['all', 'PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
    assert.equal(reports.parseLedgerFilters(query({ status })).status, status)
  }
  for (const pageSize of ['25', '50', '100']) {
    assert.equal(reports.parseLedgerFilters(query({ page: '2', pageSize })).pageSize, Number(pageSize))
  }
  for (const values of [
    { payment: 'refunded' }, { status: 'PAID' }, { status: 'delivered' },
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'Infinity' },
    { pageSize: '0' }, { pageSize: '26' }, { pageSize: '1000' },
  ]) assert.throws(() => reports.parseLedgerFilters(query(values)), reports.SalesReportValidationError)
})

const accountingRange = customRange('2026-09-29', '2026-09-30')
const accountingOrders = [
  order('previous-paid', { createdAt: new Date('2026-09-26T20:30:00.000Z'), total: 110000,
    items: [{ productId: 'old-shoe', quantity: 1, price: 100000, product: { name: 'کفش قبلی' } }] }),
  order('previous-unpaid', { createdAt: new Date('2026-09-28T20:29:59.999Z'), verified: false, total: 990000 }),
  order('paid-start', { createdAt: new Date('2026-09-28T20:30:00.000Z') }),
  order('paid-processing', { createdAt: new Date('2026-09-29T10:00:00.000Z'), status: 'PROCESSING', total: 320000,
    shippingCost: 20000, shippingMethodName: 'تیپاکس',
    items: [
      { productId: 'shoe-1', quantity: 1, price: 100000, product: { name: 'کفش کوهنوردی' } },
      { productId: 'shoe-2', quantity: 2, price: 100000, product: { name: 'نیم‌بوت' } },
    ] }),
  order('paid-last', { createdAt: new Date('2026-09-30T20:29:59.999Z'), status: 'PENDING', total: 150000,
    shippingCost: 0, shippingMethodName: null,
    items: [{ productId: 'shoe-2', quantity: 1, price: 150000, product: { name: 'نیم‌بوت' } }] }),
  order('unpaid-delivered', { verified: false, total: 510000,
    items: [{ productId: 'unpaid-shoe', quantity: 5, price: 100000, product: { name: 'محصول تأییدنشده' } }] }),
  order('paid-cancelled', { status: 'CANCELLED', total: 760000,
    items: [{ productId: 'cancelled-shoe', quantity: 5, price: 150000, product: { name: 'محصول لغوشده' } }] }),
  order('unpaid-cancelled', { verified: false, status: 'CANCELLED', total: 99000, shippingCost: 0 }),
  order('outside-end', { createdAt: new Date('2026-09-30T20:30:00.000Z'), total: 5000000 }),
  order('outside-previous-start', { createdAt: new Date('2026-09-26T20:29:59.999Z'), total: 6000000 }),
]

const accountingReport = () => reports.buildSalesReport(accountingOrders, accountingRange, { products: 40, users: 90 }, fixedNow)

test('Receipts include verified, noncancelled orders only; shipping collected is separate from merchandise', () => {
  const report = accountingReport()
  assert.equal(report.summary.orders, 6)
  assert.equal(report.summary.receipts, 680000)
  assert.equal(report.summary.merchandise, 650000)
  assert.equal(report.summary.shipping, 30000)
  assert.equal(report.summary.receipts, report.summary.merchandise + report.summary.shipping)
  assert.equal(report.summary.paidOrders, 3)
  assert.equal(report.summary.unitsSold, 6)
  assert.equal(report.summary.averageOrderValue, 226667)
  assert.deepEqual(plain(report.catalog), { products: 40, users: 90 })
})

test('Unpaid and cancelled balances reconcile all orders and paid cancellations are a distinct subset', () => {
  const report = accountingReport()
  const summary = report.summary
  assert.equal(summary.unpaidOrders, 1)
  assert.equal(summary.unpaidAmount, 510000)
  assert.equal(summary.cancelledOrders, 2)
  assert.equal(summary.cancelledAmount, 859000)
  assert.equal(summary.paidCancelledOrders, 1)
  assert.equal(summary.paidCancelledAmount, 760000)
  assert.equal(summary.receipts + summary.unpaidAmount + summary.cancelledAmount, 2049000)
  assert.equal(summary.paidOrders + summary.unpaidOrders + summary.cancelledOrders, summary.orders)
  assert.equal(report.paymentBreakdown.reduce((sum, row) => sum + row.count, 0), summary.orders)
  assert.equal(report.paymentBreakdown.reduce((sum, row) => sum + row.amount, 0), 2049000)
  assert.equal(report.statusBreakdown.reduce((sum, row) => sum + row.count, 0), summary.orders)
})

test('Previous-period financial comparisons use only that period and finite percentages', () => {
  const report = accountingReport()
  assert.equal(report.previous.orders, 2)
  assert.equal(report.previous.receipts, 110000)
  assert.equal(report.previous.merchandise, 100000)
  assert.equal(report.previous.unpaidAmount, 990000)
  assert.equal(report.changes.receipts, 518.18)
  assert.equal(report.changes.merchandise, 550)
  assert.equal(report.changes.paidOrders, 200)
  assert.deepEqual(plain(report.previousRange), { from: '2026-09-27', to: '2026-09-28' })
})

test('A zero previous-period baseline produces no growth percentage, not Infinity or misleading zero growth', () => {
  const report = reports.buildSalesReport([accountingOrders[2]], accountingRange, { products: 0, users: 0 }, fixedNow)
  for (const value of Object.values(report.changes)) assert.equal(value, null)
  const falling = reports.buildSalesReport([accountingOrders[0]], accountingRange, { products: 0, users: 0 }, fixedNow)
  assert.equal(falling.changes.receipts, -100)
  assert.equal(falling.changes.paidOrders, -100)
})

test('Top products sum quantities and historical line prices across paid orders only', () => {
  const top = accountingReport().topProducts
  assert.deepEqual(plain(top), [
    { productId: 'shoe-2', name: 'نیم‌بوت', sold: 3, merchandise: 350000 },
    { productId: 'shoe-1', name: 'کفش کوهنوردی', sold: 3, merchandise: 300000 },
  ])
  assert.equal(top.reduce((sum, row) => sum + row.sold, 0), 6)
  assert.equal(top.reduce((sum, row) => sum + row.merchandise, 0), 650000)
})

test('Daily trend respects exact Tehran boundaries and excludes unpaid and cancelled orders', () => {
  const trend = accountingReport().trend
  assert.equal(trend.length, 2)
  assert.deepEqual(plain(trend.map(({ label, ...row }) => row)), [
    { date: '2026-09-29', receipts: 530000, merchandise: 500000, shipping: 30000, paidOrders: 2 },
    { date: '2026-09-30', receipts: 150000, merchandise: 150000, shipping: 0, paidOrders: 1 },
  ])
  assert.equal(trend.reduce((sum, row) => sum + row.receipts, 0), accountingReport().summary.receipts)
})

test('Long-range trend groups by Jalali months and moves a midnight order across the correct month boundary', () => {
  const range = customRange('2026-06-01', '2026-09-30')
  const rows = [
    order('shahrivar-end', { createdAt: new Date('2026-09-22T20:29:59.999Z'), total: 210000 }),
    order('mehr-start', { createdAt: new Date('2026-09-22T20:30:00.000Z'), total: 320000, shippingCost: 20000 }),
  ]
  const report = reports.buildSalesReport(rows, range, { products: 0, users: 0 }, fixedNow)
  assert.equal(report.range.interval, 'month')
  assert.deepEqual(plain(report.trend.map((entry) => entry.date)), ['1405-03', '1405-04', '1405-05', '1405-06', '1405-07'])
  assert.equal(report.trend.find((entry) => entry.date === '1405-06').receipts, 210000)
  assert.equal(report.trend.find((entry) => entry.date === '1405-07').receipts, 320000)
  assert.match(report.trend.find((entry) => entry.date === '1405-06').label, /شهریور/)
  assert.match(report.trend.find((entry) => entry.date === '1405-07').label, /مهر/)
  assert.equal(report.trend.reduce((sum, entry) => sum + entry.receipts, 0), report.summary.receipts)
})

test('Shipping breakdown uses immutable order method names, including a fallback for historical orders', () => {
  const shipping = accountingReport().shippingBreakdown
  assert.equal(shipping.length, 3)
  assert.deepEqual(plain(shipping.find((row) => row.name === 'پست پیشتاز')), {
    name: 'پست پیشتاز', paidOrders: 1, shipping: 10000, receipts: 210000,
  })
  assert.deepEqual(plain(shipping.find((row) => row.name === 'تیپاکس')), {
    name: 'تیپاکس', paidOrders: 1, shipping: 20000, receipts: 320000,
  })
  assert.deepEqual(plain(shipping.find((row) => !['پست پیشتاز', 'تیپاکس'].includes(row.name))), {
    name: 'روش ارسال ثبت نشده', paidOrders: 1, shipping: 0, receipts: 150000,
  })
  assert.equal(shipping.reduce((sum, row) => sum + row.shipping, 0), 30000)
})

test('An empty report has explicit zero balances and zero-filled days without invalid average values', () => {
  const report = reports.buildSalesReport([], accountingRange, { products: 0, users: 0 }, fixedNow)
  for (const value of Object.values(report.summary)) assert.equal(value, 0)
  assert.equal(report.topProducts.length, 0)
  assert.equal(report.shippingBreakdown.length, 0)
  assert.equal(report.trend.length, 2)
  assert.ok(report.trend.every((row) => row.receipts === 0 && row.paidOrders === 0))
  assert.equal(report.generatedAt, fixedNow.toISOString())
})

test('Report notes explicitly distinguish registration time, unknown refunds, and receipts from profit', () => {
  const notes = accountingReport().notes.join(' ')
  assert.match(notes, /تاریخ ثبت سفارش/)
  assert.match(notes, /زمان واقعی دریافت وجه ثبت نشده/)
  assert.match(notes, /استرداد وجه/)
  assert.match(notes, /بهای خرید کالا/)
  assert.match(notes, /سود/)
})

test('Ledger rows use quantities and order snapshots and omit payment credentials and contact details', () => {
  const row = reports.buildSalesLedgerRow(order('ledger-1', {
    user: { name: 'مشتری نمونه', email: 'secret@example.test', password: 'secret', phone: '09120000000' },
    address: 'private address', phone: '09120000000', authority: 'gateway-secret',
  }))
  assert.equal(row.customerName, 'مشتری نمونه')
  assert.equal(row.units, 2)
  assert.equal(row.merchandise + row.shipping, row.total)
  const serialized = JSON.stringify(row)
  for (const value of ['secret@example.test', 'private address', '09120000000', 'gateway-secret']) assert.ok(!serialized.includes(value))
})

test('Timezone-sensitive report results are identical under UTC, Los Angeles and Tehran hosts', () => {
  const helperPath = path.join(__dirname, '../src/lib/sales-report.ts')
  const script = `
    const { readFileSync } = require('node:fs');
    const { transformSync } = require('esbuild');
    const vm = require('node:vm');
    const context = { module: { exports: {} }, Date, Intl, URLSearchParams };
    vm.runInNewContext(transformSync(readFileSync(${JSON.stringify(helperPath)}, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, context);
    const reports = context.module.exports;
    const result = [
      ['range=30d', '2026-09-30T21:00:00Z'],
      ['range=month', '2026-09-30T10:00:00Z'],
      ['range=custom&from=2021-03-22&to=2021-03-22', '2026-09-30T10:00:00Z'],
    ].map(([query, now]) => reports.parseSalesRange(new URLSearchParams(query), new Date(now)));
    process.stdout.write(JSON.stringify(result));
  `
  const snapshots = ['UTC', 'America/Los_Angeles', 'Asia/Tehran'].map((TZ) => {
    const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  })
  assert.deepEqual(snapshots[0], snapshots[1])
  assert.deepEqual(snapshots[0], snapshots[2])
})

function parseCsv(csv) {
  const rows = []
  let row = [], cell = '', quoted = false
  const text = csv.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++ }
      else quoted = !quoted
    } else if (!quoted && char === ',') {
      row.push(cell); cell = ''
    } else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += char
  }
  assert.equal(quoted, false, 'CSV ended inside an unterminated quoted cell')
  if (row.length || cell) { row.push(cell); rows.push(row) }
  return rows
}

test('Excel CSV has a UTF-8 BOM, Persian headers, Tehran dates and undecorated numeric amounts', () => {
  const row = reports.buildSalesLedgerRow(order('csv-1', { user: { name: 'مشتری' } }))
  const csv = reports.salesLedgerCsv([row])
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  assert.match(csv, /\r\n$/)
  const cells = parseCsv(csv)
  assert.equal(cells.length, 2)
  assert.ok(cells[0].every((header) => /[\u0600-\u06FF]/.test(header)))
  assert.equal(cells[1][0], 'csv-1')
  assert.equal(cells[1][1], '2026-09-30 00:00')
  assert.equal(cells[1][2], 'مشتری')
  assert.deepEqual(cells[1].slice(5, 9), ['2', '200000', '10000', '210000'])
})

test('CSV quotes and round-trips Persian, commas, quotes and multiline customer or shipping names', () => {
  const row = reports.buildSalesLedgerRow(order('csv-special', {
    user: { name: 'نام, "نمونه"\nخط دوم' }, shippingMethodName: 'پست, "ویژه"',
  }))
  const cells = parseCsv(reports.salesLedgerCsv([row]))
  assert.equal(cells.length, 2)
  assert.equal(cells[1][2], 'نام, "نمونه"\nخط دوم')
  assert.equal(cells[1][9], 'پست, "ویژه"')
  assert.equal(cells[1].length, cells[0].length)
})

test('CSV text fields neutralize formulas after whitespace/control characters without altering amounts', () => {
  for (const attack of ['=SUM(1,2)', '+1+2', '-1+2', '@SUM(A1)', '  =HYPERLINK("https://example.test")', '\t+1', '\r@SUM(A1)', '\u0000=1']) {
    const row = reports.buildSalesLedgerRow(order(attack, { user: { name: attack }, shippingMethodName: attack }))
    const cells = parseCsv(reports.salesLedgerCsv([row]))[1]
    for (const index of [0, 2, 9]) assert.ok(!/^[\s\u0000-\u001f]*[=+\-@]/.test(cells[index]), `${JSON.stringify(attack)} remained an executable formula`)
    assert.deepEqual(cells.slice(5, 9), ['2', '200000', '10000', '210000'])
  }
})

test('An empty CSV still has a valid BOM and its complete column header', () => {
  const csv = reports.salesLedgerCsv([])
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  assert.equal(parseCsv(csv).length, 1)
  assert.equal(parseCsv(csv)[0].length, 10)
})

function matches(row, where = {}) {
  if (where.AND && !where.AND.every((condition) => matches(row, condition))) return false
  if (where.OR && !where.OR.some((condition) => matches(row, condition))) return false
  if (where.verified !== undefined && row.verified !== where.verified) return false
  if (typeof where.status === 'string' && row.status !== where.status) return false
  if (where.status && typeof where.status === 'object' && row.status === where.status.not) return false
  if (where.createdAt) {
    if (where.createdAt.gte && row.createdAt < where.createdAt.gte) return false
    if (where.createdAt.lt && row.createdAt >= where.createdAt.lt) return false
  }
  return true
}

function project(row, select) {
  if (row === null || row === undefined) return row
  return Object.fromEntries(Object.entries(select).map(([key, config]) => {
    if (config === true) return [key, row[key]]
    const value = row[key]
    return [key, Array.isArray(value) ? value.map((entry) => project(entry, config.select)) : project(value, config.select)]
  }))
}

function routeHarness({
  session = { user: { id: 'admin-1', role: 'ADMIN' } }, rows = accountingOrders,
  countOverride, findOverride, fail = false,
} = {}) {
  const calls = []
  const prisma = {
    order: {
      count: async (args) => {
        calls.push({ model: 'order', operation: 'count', args })
        if (fail) throw new Error('private database connection/password')
        return countOverride ?? rows.filter((row) => matches(row, args.where)).length
      },
      findMany: async (args) => {
        calls.push({ model: 'order', operation: 'findMany', args })
        if (fail) throw new Error('private database connection/password')
        if (findOverride) return findOverride(args)
        let selected = rows.filter((row) => matches(row, args.where))
        if (args.orderBy) selected = selected.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        if (args.skip) selected = selected.slice(args.skip)
        if (args.take) selected = selected.slice(0, args.take)
        return selected.map((row) => project(row, args.select))
      },
    },
    product: { count: async () => { calls.push({ model: 'product', operation: 'count' }); return 40 } },
    user: { count: async () => { calls.push({ model: 'user', operation: 'count' }); return 90 } },
    $transaction: async (callback, options) => {
      calls.push({ model: 'prisma', operation: 'transaction', args: options })
      return callback(prisma)
    },
  }
  const dependencies = {
    'next/server': { NextResponse: Response },
    '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': { prisma },
    '@/lib/sales-report': reports,
  }
  const stats = loadModule('src/app/api/admin/stats/route.ts', dependencies)
  const ledger = loadModule('src/app/api/admin/reports/orders/route.ts', dependencies)
  const request = (endpoint, values = {}) => new Request(`http://localhost/api/admin/${endpoint}?${query({ range: 'custom', from: '2026-09-29', to: '2026-09-30', ...values })}`)
  return {
    calls, request,
    stats: (values) => stats.GET(request('stats', values)),
    ledger: (values) => ledger.GET(request('reports/orders', values)),
    rawStats: stats.GET,
    rawLedger: ledger.GET,
  }
}

test('Both financial routes reject anonymous/incomplete identities and customers before querying any data', async () => {
  for (const [session, status] of [
    [null, 401], [{}, 401], [{ user: {} }, 401], [{ user: { role: 'ADMIN' } }, 401],
    [{ user: { id: '', role: 'ADMIN' } }, 401], [{ user: { id: 'customer-1', role: 'USER' } }, 403],
  ]) {
    const h = routeHarness({ session })
    for (const response of [await h.stats(), await h.ledger(), await h.ledger({ format: 'csv' })]) {
      assert.equal(response.status, status)
      assert.match(response.headers.get('cache-control'), /private.*no-store/)
    }
    assert.equal(h.calls.length, 0)
  }
})

test('The stats endpoint queries current and previous periods with only the required financial fields', async () => {
  const h = routeHarness()
  const response = await h.stats()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /private.*no-store/)
  const report = await response.json()
  assert.equal(report.summary.receipts, 680000)
  assert.equal(report.previous.receipts, 110000)
  const read = h.calls.find((call) => call.model === 'order' && call.operation === 'findMany').args
  assert.equal(read.where.createdAt.gte.toISOString(), '2026-09-26T20:30:00.000Z')
  assert.equal(read.where.createdAt.lt.toISOString(), '2026-09-30T20:30:00.000Z')
  assert.equal(read.select.shippingCost, true)
  assert.equal(read.select.items.select.price, true)
  for (const field of ['email', 'phone', 'address', 'authority', 'password']) assert.ok(!JSON.stringify(read.select).includes(`"${field}"`))
})

test('Malformed report/filter/format queries return 400 before reads or exports', async () => {
  const h = routeHarness()
  for (const values of [
    { range: 'anything' }, { from: '2026-02-29' }, { to: '2026-09-28' },
    { from: '2024-01-01', to: '2025-01-01' },
  ]) assert.equal((await h.stats(values)).status, 400)
  for (const values of [
    { from: '2026-02-29' }, { payment: 'refunded' }, { status: 'UNKNOWN' },
    { page: '0' }, { pageSize: '500' }, { format: 'xlsx' },
  ]) assert.equal((await h.ledger(values)).status, 400)
  assert.equal(h.calls.length, 0)
})

test('Duplicate scope parameters are rejected instead of letting chart, ledger and export disagree', async () => {
  const h = routeHarness()
  const scope = 'range=custom&from=2026-09-29&to=2026-09-30'
  for (const suffix of ['&range=7d', '&from=2026-09-30', '&to=2026-10-01']) {
    assert.equal((await h.rawStats(new Request(`http://localhost/api/admin/stats?${scope}${suffix}`))).status, 400)
  }
  for (const suffix of ['&payment=paid&payment=unpaid', '&status=SHIPPED&status=DELIVERED', '&page=1&page=2', '&format=json&format=csv']) {
    assert.equal((await h.rawLedger(new Request(`http://localhost/api/admin/reports/orders?${scope}${suffix}`))).status, 400)
  }
  assert.equal(h.calls.length, 0)
})

test('Ledger payment filters are exclusive and intersect fulfillment status and current dates', async () => {
  const expected = {
    all: ['paid-start', 'paid-processing', 'paid-last', 'unpaid-delivered', 'paid-cancelled', 'unpaid-cancelled'],
    paid: ['paid-start', 'paid-processing', 'paid-last'],
    unpaid: ['unpaid-delivered'], paid_cancelled: ['paid-cancelled'], unpaid_cancelled: ['unpaid-cancelled'],
  }
  for (const [payment, ids] of Object.entries(expected)) {
    const response = await routeHarness().ledger({ payment })
    assert.equal(response.status, 200)
    const ledger = await response.json()
    assert.deepEqual(ledger.orders.map((row) => row.id).sort(), ids.sort())
    assert.equal(ledger.pagination.total, ids.length)
  }
  assert.equal((await (await routeHarness().ledger({ payment: 'paid', status: 'CANCELLED' })).json()).pagination.total, 0)
  const delivered = await (await routeHarness().ledger({ payment: 'paid', status: 'DELIVERED' })).json()
  assert.deepEqual(delivered.orders.map((row) => row.id), ['paid-start'])
})

test('Ledger pagination uses date/id ordering for ties and never leaks earlier or later days', async () => {
  const rows = Array.from({ length: 31 }, (_, index) => order(`order-${String(index).padStart(3, '0')}`))
  rows.push(accountingOrders[0], accountingOrders[8])
  const h = routeHarness({ rows })
  const first = await (await h.ledger({ page: '1' })).json()
  const second = await (await h.ledger({ page: '2' })).json()
  assert.deepEqual(first.pagination, { page: 1, pageSize: 25, total: 31, pages: 2 })
  assert.equal(first.orders.length, 25)
  assert.equal(second.orders.length, 6)
  assert.equal(first.orders[0].id, 'order-030')
  assert.equal(first.orders.at(-1).id, 'order-006')
  assert.equal(second.orders[0].id, 'order-005')
  assert.equal(second.orders.at(-1).id, 'order-000')
  assert.equal(new Set([...first.orders, ...second.orders].map((row) => row.id)).size, 31)
  const reads = h.calls.filter((call) => call.operation === 'findMany')
  for (const { args } of reads) assert.deepEqual(plain(args.orderBy), [{ createdAt: 'desc' }, { id: 'desc' }])
  assert.equal(reads[1].args.skip, 25)
  const transactions = h.calls.filter((call) => call.operation === 'transaction')
  assert.equal(transactions.length, 2)
  assert.ok(transactions.every(({ args }) => args.isolationLevel === 'RepeatableRead'))
})

test('CSV exports every matching row beyond the current page and shares exact filters with the ledger', async () => {
  const rows = Array.from({ length: 31 }, (_, index) => order(`paid-${String(index).padStart(3, '0')}`, { user: { name: 'مشتری' } }))
  rows.push(order('unpaid-excluded', { verified: false }), order('cancelled-excluded', { status: 'CANCELLED' }), accountingOrders[0], accountingOrders[8])
  const h = routeHarness({ rows })
  const ledger = await (await h.ledger({ payment: 'paid', status: 'DELIVERED', page: '2' })).json()
  assert.equal(ledger.orders.length, 6)
  const exported = await h.ledger({ payment: 'paid', status: 'DELIVERED', page: '2', format: 'csv' })
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-type'), /text\/csv.*charset=utf-8/i)
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="sales-orders-2026-09-29-2026-09-30\.csv"/)
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff')
  assert.match(exported.headers.get('cache-control'), /private.*no-store/)
  const bytes = Buffer.from(await exported.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF])
  const cells = parseCsv(bytes.toString('utf8'))
  assert.equal(cells.length, 32)
  assert.equal(cells[1][0], 'paid-030')
  assert.equal(cells.at(-1)[0], 'paid-000')
  const reads = h.calls.filter((call) => call.operation === 'findMany')
  assert.deepEqual(plain(reads[0].args.where), plain(reads[1].args.where))
  assert.equal(reads[1].args.skip, undefined)
})

test('CSV refuses oversized reports explicitly instead of silently truncating data', async () => {
  const h = routeHarness({ countOverride: 10001 })
  const response = await h.ledger({ format: 'csv' })
  assert.equal(response.status, 422)
  assert.equal(h.calls.filter((call) => call.operation === 'findMany').length, 0)
  assert.ok((await response.json()).error)
})

test('CSV detects a count/fetch race that crosses the export limit', async () => {
  const rows = Array.from({ length: 10001 }, (_, index) => order(`race-${index}`))
  const h = routeHarness({ countOverride: 9999, findOverride: () => rows })
  assert.equal((await h.ledger({ format: 'csv' })).status, 422)
})

test('Exactly ten thousand matching CSV rows remain complete and exportable', async () => {
  const rows = Array.from({ length: 10000 }, (_, index) => order(`limit-${String(index).padStart(5, '0')}`))
  const response = await routeHarness({ rows }).ledger({ format: 'csv' })
  assert.equal(response.status, 200)
  const cells = parseCsv(await response.text())
  assert.equal(cells.length, 10001)
})

test('Ledger query and serialized JSON expose customer names but no contact or payment secrets', async () => {
  const h = routeHarness({ rows: [order('private-1', {
    user: { name: 'مشتری', email: 'secret@example.test', password: 'private-password', phone: '09120000000' },
    address: 'private-address', phone: '09120000000', authority: 'private-authority',
  })] })
  const response = await h.ledger()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.orders[0].customerName, 'مشتری')
  const read = h.calls.find((call) => call.operation === 'findMany').args
  assert.deepEqual(plain(read.select.user), { select: { name: true } })
  for (const field of ['email', 'phone', 'address', 'password', 'authority']) assert.ok(!JSON.stringify(read.select).includes(`"${field}"`))
  for (const value of ['secret@example.test', '09120000000', 'private-password', 'private-address', 'private-authority']) assert.ok(!JSON.stringify(body).includes(value))
})

test('Database failures return visible noncached errors instead of empty success or private diagnostics', async () => {
  const h = routeHarness({ fail: true })
  for (const response of [await h.stats(), await h.ledger(), await h.ledger({ format: 'csv' })]) {
    assert.equal(response.status, 500)
    assert.match(response.headers.get('cache-control'), /private.*no-store/)
    const body = await response.json()
    assert.ok(body.error)
    assert.ok(!JSON.stringify(body).includes('password'))
  }
})
