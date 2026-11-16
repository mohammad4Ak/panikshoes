// Local PostgreSQL regression. All fixtures live in one random schema; no
// public business rows are copied or written. Invoice IDs are explicit so a
// cloned serial default cannot advance a public sequence. Cleanup is exact.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.protocol !== 'postgresql:' || target.hostname !== '192.168.1.105' || target.pathname !== '/shoes_shop'
  || (target.searchParams.get('schema') || 'public') !== 'public') {
  throw new Error('Bulk print integration requires the designated local shoes_shop database')
}
const schema = 'test_order_print_' + randomBytes(8).toString('hex')
const identifier = value => { assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/); return '"' + value + '"' }
const checkScope = () => assert.match(schema, /^test_order_print_[a-f0-9]{16}$/)
checkScope()
const scope = identifier(schema)
const testUrl = new URL(target)
testUrl.searchParams.set('schema', schema)
testUrl.searchParams.set('connection_limit', '3')
testUrl.searchParams.set('connect_timeout', '10')
const controlUrl = new URL(target)
controlUrl.searchParams.set('connection_limit', '1')
controlUrl.searchParams.set('connect_timeout', '10')
const control = new PrismaClient({ datasourceUrl: controlUrl.toString() })
const db = new PrismaClient({ datasourceUrl: testUrl.toString() })
const tables = ['User', 'Category', 'Product', 'Order', 'OrderItem', 'Invoice', 'SiteSettings']
const actor = { id: 'print-admin', name: 'مدیر ایزوله', role: 'ADMIN' }
let session = { user: actor }, reads = 0, writes = 0, created = false
const cache = new Map()
const mutators = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'])
const guardedDb = new Proxy(db, { get(client, key) {
  if (key === '$executeRaw' || key === '$executeRawUnsafe') return () => { writes++; throw new Error('Printing attempted to execute a database mutation') }
  const delegate = client[key]
  if (typeof delegate === 'object' && delegate && typeof delegate.findMany === 'function') return new Proxy(delegate, { get(model, method) {
    const fn = model[method]
    if (typeof fn !== 'function') return fn
    return (...args) => {
      if (mutators.has(method)) { writes++; throw new Error('Printing attempted to mutate ' + String(key)) }
      reads++
      return Reflect.apply(fn, model, args)
    }
  } })
  if (typeof delegate === 'function') return delegate.bind(client)
  return delegate
} })

function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports
  const compiled = { exports: {} }
  cache.set(relative, compiled)
  const source = readFileSync(path.resolve(__dirname, '..', relative), 'utf8')
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
    module: compiled, URL, URLSearchParams, Date, Request, Response, Headers, Buffer, Error, Uint8Array, console,
    process: { env: { NODE_ENV: 'test' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: Response, connection: async () => {} }
      if (name === 'react') return { cache: fn => fn }
      if (name === 'server-only') return {}
      if (name === '@/lib/prisma') return { prisma: guardedDb }
      if (name === '@/lib/auth') return { auth: async () => session }
      if (name.startsWith('node:') || name === '@prisma/client') return require(name)
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      throw new Error('Unexpected test dependency ' + name)
    },
  }, { filename: relative })
  return compiled.exports
}

const inside = new Date('2026-10-10T11:00:00Z')
let invoiceId = 5000000
async function order(id, extra = {}, itemExtra = {}) {
  return db.order.create({ data: {
    id, userId: 'print-buyer', recipientName: 'گیرنده هنگام سفارش', address: 'نشانی هنگام سفارش', phone: '09123456789', postalCode: '0123456789',
    status: 'PROCESSING', verified: true, paymentStatus: 'PAID', paymentMethod: 'bank_transfer', createdAt: inside,
    shippingMethodName: 'پست ثبت‌شده', shippingCost: 50, subtotal: 2000, productDiscount: 400, couponDiscount: 200, couponCode: 'PAST200', total: 1450,
    trackingCode: '000000001234567890123456',
    items: { create: { id: id + '-item', productId: 'print-product', productName: 'نام محصول هنگام خرید', price: 800, originalPrice: 1000,
      couponDiscount: 200, quantity: 2, size: 38, color: 'مشکی', ...itemExtra } },
    ...extra,
  }, include: { user: true, items: { include: { product: true } } } })
}
async function issued(purchase, transform = value => value) {
  const snapshot = transform(load('src/lib/invoice.ts').buildInvoiceSnapshot(purchase, 'پانیک هنگام صدور'))
  return db.invoice.create({ data: { id: ++invoiceId, orderId: purchase.id, issuedAt: new Date('2026-10-11T09:00:00Z'), snapshot } })
}
const plain = value => JSON.parse(JSON.stringify(value))
async function businessState() {
  const result = {}
  for (const name of ['user', 'category', 'product', 'order', 'orderItem', 'invoice', 'siteSettings']) {
    result[name] = await db[name].findMany({ orderBy: { id: 'asc' } })
  }
  return plain(result)
}
async function post(body, origin = 'http://localhost:3000') {
  const result = await load('src/app/api/admin/orders/documents/route.ts').POST(new Request('http://localhost:3000/api/admin/orders/documents', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: result.status, headers: result.headers, body: await result.json() }
}
async function ok(body) {
  const result = await post(body)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.match(result.headers.get('cache-control'), /private.*no-store/)
  assert.match(result.headers.get('vary'), /Cookie/i)
  assert.equal(result.body.kind, body.kind)
  assert.equal(result.body.limit, 100)
  return result.body
}
const request = (kind, ids) => ({ mode: 'selected', kind, ids })
const eligible = result => result.rows.filter(row => row.eligible)

async function setup() {
  checkScope()
  await control.$executeRawUnsafe('CREATE SCHEMA ' + scope)
  created = true
  for (const table of tables) await control.$executeRawUnsafe('CREATE TABLE ' + scope + '.' + identifier(table) + ' (LIKE "public".' + identifier(table) + ' INCLUDING ALL)')
  const columns = await control.$queryRaw`SELECT c.table_name, c.column_name, c.udt_name, c.column_default FROM information_schema.columns c JOIN pg_type t ON t.typname = c.udt_name JOIN pg_namespace n ON n.oid = t.typnamespace WHERE c.table_schema = ${schema} AND n.nspname = 'public' AND t.typtype = 'e'`
  const enums = await control.$queryRaw`SELECT t.typname AS name, e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`
  for (const name of new Set(columns.map(value => value.udt_name))) {
    const labels = enums.filter(value => value.name === name).map(value => "'" + value.label.replace(/'/g, "''") + "'")
    assert.ok(labels.length)
    await control.$executeRawUnsafe('CREATE TYPE ' + scope + '.' + identifier(name) + ' AS ENUM (' + labels.join(',') + ')')
  }
  for (const column of columns) {
    const table = scope + '.' + identifier(column.table_name), name = identifier(column.column_name), type = scope + '.' + identifier(column.udt_name)
    await control.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + ' DROP DEFAULT')
    await control.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + ' TYPE ' + type + ' USING ' + name + '::text::' + type)
    if (column.column_default) {
      const label = /^'([^']+)'::/.exec(column.column_default)?.[1]
      assert.ok(label && enums.some(value => value.name === column.udt_name && value.label === label))
      await control.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + " SET DEFAULT '" + label.replace(/'/g, "''") + "'::" + type)
    }
  }
  assert.deepEqual(await db.$queryRaw`SELECT current_schema() AS name`, [{ name: schema }])
  await db.user.createMany({ data: [
    { ...actor, email: 'print-admin@isolated.invalid', password: '$disabled$fixture' },
    { id: 'print-buyer', name: 'خریدار هنگام صدور', email: 'buyer-old@isolated.invalid', phone: '09111111111', postalCode: '1234567890', password: '$disabled$fixture' },
  ] })
  await db.category.create({ data: { id: 'print-category', name: 'آزمایش چاپ', slug: 'print-category' } })
  await db.product.create({ data: { id: 'print-product', code: 'PRINT-TEST', slug: 'print-product', name: 'نام ویترین اولیه', description: 'ایزوله', price: 1000,
    images: [], categoryId: 'print-category', sizes: [38], colors: ['مشکی'], stock: 10 } })
  await db.siteSettings.create({ data: { ...load('src/lib/site-settings-contract.ts').defaultSiteSettings, id: 1, storeName: 'پانیک فعلی', phone: '04123456789', address: 'نشانی فرستنده تنظیم‌شده', email: 'store@isolated.invalid' } })
}

async function main() {
  try {
    await setup()
    const history = await order('print-historical')
    const invoice = await issued(history)
    await db.user.update({ where: { id: 'print-buyer' }, data: { name: 'نام فعلی کاربر نباید چاپ شود', email: 'current-private@isolated.invalid', phone: '09999999999', postalCode: '9876543210' } })
    await db.product.update({ where: { id: 'print-product' }, data: { name: 'نام فعلی ویترین نباید چاپ شود', price: 999999 } })
    const before = await businessState()
    const invoiced = await ok(request('invoice', [history.id]))
    assert.equal(eligible(invoiced).length, 1)
    assert.deepEqual(invoiced.rows[0].document.invoice.snapshot, plain(invoice.snapshot))
    assert.equal(invoiced.rows[0].document.invoice.snapshot.buyer.name, 'خریدار هنگام صدور')
    assert.equal(invoiced.rows[0].document.invoice.snapshot.items[0].lineTotal, 1400)
    assert.equal(invoiced.rows[0].document.invoice.snapshot.total, 1450)
    assert.equal(JSON.stringify(invoiced).includes('current-private@isolated.invalid'), false)
    assert.deepEqual(await businessState(), before)
    console.log('PASS issued invoices retain exact historical names, prices, discounts and recipients without writes or current profile/catalog leakage')

    const packed = await ok(request('packing', [history.id]))
    const label = await ok(request('shipping-label', [history.id]))
    for (const result of [packed, label]) {
      assert.equal(eligible(result).length, 1)
      const document = result.rows[0].document
      assert.equal(document.recipient.name, 'گیرنده هنگام سفارش')
      assert.equal(document.recipient.phone, '09123456789')
      assert.equal(document.recipient.postalCode, '0123456789')
      assert.equal(document.recipient.address, 'نشانی هنگام سفارش')
      if (document.kind === 'packing') assert.equal(document.items[0].productName, 'نام محصول هنگام خرید')
      else assert.equal(document.items.length, 0, 'Shipping labels must not disclose contents')
      assert.equal(document.trackingCode, '000000001234567890123456')
      assert.equal(document.seller.address, 'نشانی فرستنده تنظیم‌شده')
      for (const field of ['price', 'total', 'subtotal', 'couponDiscount', 'email', 'unitPrice']) assert.equal(JSON.stringify(document).includes('"' + field + '":'), false, field)
    }
    assert.deepEqual(await businessState(), before)
    console.log('PASS packing slips and labels preserve zero-prefixed order contacts/tracking, omit financial fields, use configured sender and do not change order status')

    const legacy = await order('print-legacy')
    const legacyInvoice = await issued(legacy)
    await db.order.update({ where: { id: legacy.id }, data: { recipientName: null } })
    await db.orderItem.update({ where: { id: legacy.id + '-item' }, data: { productName: null } })
    const legacyPrint = await ok(request('packing', [legacy.id]))
    assert.equal(eligible(legacyPrint).length, 1)
    assert.equal(legacyPrint.rows[0].document.recipient.name, legacyInvoice.snapshot.recipient.name)
    assert.equal(legacyPrint.rows[0].document.items[0].productName, legacyInvoice.snapshot.items[0].productName)
    const noSnapshots = await order('print-no-name', { recipientName: null }, { productName: null })
    const unnamed = await ok(request('packing', [noSnapshots.id]))
    assert.equal(eligible(unnamed).length, 1)
    assert.ok(unnamed.rows[0].warnings.length >= 2)
    assert.equal(JSON.stringify(unnamed).includes('نام فعلی'), false)
    const unnamedLabel = await ok(request('shipping-label', [noSnapshots.id]))
    assert.equal(unnamedLabel.rows[0].eligible, false)
    assert.equal(unnamedLabel.rows[0].document, null)
    assert.ok(unnamedLabel.rows[0].reason)
    console.log('PASS legacy missing names use immutable invoice fallbacks or explicit generic warnings, never live user/product names')

    const missingPostal = await order('print-missing-postal', { postalCode: null })
    const noPostalLabel = await ok(request('shipping-label', [missingPostal.id]))
    assert.equal(noPostalLabel.rows[0].eligible, false)
    assert.equal(noPostalLabel.rows[0].document, null)
    assert.ok(noPostalLabel.rows[0].reason)
    const noPostalPacking = await ok(request('packing', [missingPostal.id]))
    assert.equal(noPostalPacking.rows[0].eligible, true)
    assert.ok(noPostalPacking.rows[0].warnings.length)
    const cancelled = await order('print-cancelled', { status: 'CANCELLED' })
    await issued(cancelled)
    const unpaid = await order('print-unpaid', { verified: false, paymentStatus: 'AWAITING_RECEIPT', status: 'PENDING' })
    for (const kind of ['packing', 'shipping-label']) {
      const result = await ok(request(kind, [cancelled.id, unpaid.id]))
      assert.ok(result.rows.every(row => !row.eligible && row.document === null && row.reason))
    }
    const historicalCancelled = await ok(request('invoice', [cancelled.id]))
    assert.equal(historicalCancelled.rows[0].eligible, true)
    assert.equal(historicalCancelled.rows[0].document.status, 'CANCELLED')
    console.log('PASS fulfillment rejects missing postal labels, cancelled/unpaid orders; packing warns for legacy postal gaps and existing cancelled invoices retain cancellation status')

    const bad = await order('print-bad-invoice')
    await issued(bad, snapshot => ({ ...snapshot, orderId: 'unrelated-order' }))
    const brokenTotal = await order('print-bad-total')
    await issued(brokenTotal, snapshot => ({ ...snapshot, total: snapshot.total + 1 }))
    const missing = await order('print-no-invoice')
    const invalid = await ok(request('invoice', [bad.id, brokenTotal.id, missing.id, 'print-nonexistent']))
    assert.equal(invalid.rows.length, 4)
    assert.ok(invalid.rows.every(row => !row.eligible && row.document === null && row.reason))
    assert.equal(await db.invoice.count({ where: { orderId: missing.id } }), 0)
    console.log('PASS malformed, wrong-order, inconsistent and absent invoice snapshots are explicitly skipped without auto-issuing documents')

    await db.siteSettings.delete({ where: { id: 1 } })
    const noSettings = await ok(request('shipping-label', [history.id]))
    assert.equal(noSettings.rows[0].document.seller.phone, '')
    assert.equal(noSettings.rows[0].document.seller.address, '')
    assert.ok(noSettings.rows[0].warnings.length)
    assert.equal(JSON.stringify(noSettings).includes('ولیعصر'), false)
    assert.equal(JSON.stringify(noSettings).includes('02112345678'), false)
    console.log('PASS absent sender settings produce omissions and warnings rather than fabricated default contact details')

    for (let i = 0; i < 22; i++) await order('print-range-' + String(i).padStart(2, '0'))
    await order('print-range-before', { createdAt: new Date('2026-10-09T20:29:59Z') })
    await order('print-range-after', { createdAt: new Date('2026-10-10T20:30:00Z') })
    const allPages = await ok({ mode: 'filtered', kind: 'packing', filters: 'q=print-range&range=custom&from=2026-10-10&to=2026-10-10' })
    assert.equal(allPages.rows.length, 22)
    assert.equal(eligible(allPages).length, 22)
    assert.equal(allPages.rows.some(row => row.id.endsWith('-before') || row.id.endsWith('-after')), false)
    const selected = await ok(request('packing', ['print-range-21', 'print-range-00', 'print-nonexistent']))
    assert.deepEqual(selected.rows.map(row => row.id), ['print-range-21', 'print-range-00', 'print-nonexistent'])
    assert.equal(selected.rows[2].document, null)
    console.log('PASS filtered printing spans all list pages with exact Tehran date boundaries, while selected order order and missing rows stay explicit')

    await db.order.createMany({ data: Array.from({ length: 101 }, (_, index) => ({ id: 'print-limit-' + index, userId: 'print-buyer', address: 'ایزوله', phone: '09123456789', total: 1000 })) })
    for (const body of [request('invoice', Array.from({ length: 101 }, (_, index) => 'print-limit-' + index)), { mode: 'filtered', kind: 'packing', filters: 'q=print-limit' }]) {
      const result = await post(body)
      assert.ok(result.status >= 400 && result.status < 500)
      assert.ok(result.body.error)
      assert.equal(Object.hasOwn(result.body, 'rows'), false)
    }
    console.log('PASS oversized selected and filtered scopes are refused, never silently truncated')

    const long = await order('print-long', { subtotal: 1000000, productDiscount: 200000, couponDiscount: 100000, total: 700050 })
    await db.orderItem.createMany({ data: Array.from({ length: 499 }, (_, index) => ({
      id: 'print-long-extra-' + String(index).padStart(3, '0'), orderId: long.id, productId: 'print-product',
      productName: 'شرح بلند کالای هنگام خرید '.repeat(10), price: 800, originalPrice: 1000, couponDiscount: 200, quantity: 2, size: 38, color: 'مشکی',
    })) })
    const fullLong = await db.order.findUniqueOrThrow({ where: { id: long.id }, include: { user: true, items: { include: { product: true }, orderBy: { id: 'asc' } } } })
    await issued(fullLong)
    const longPacking = await ok(request('packing', [long.id]))
    const longInvoice = await ok(request('invoice', [long.id]))
    assert.equal(longPacking.rows[0].document.items.length, 500)
    assert.equal(longInvoice.rows[0].document.invoice.snapshot.items.length, 500)
    await db.orderItem.create({ data: { id: 'print-long-overflow', orderId: long.id, productId: 'print-product', productName: 'ردیف افزودهٔ ایزوله', price: 100, quantity: 1, size: 38, color: 'مشکی' } })
    const tooLong = await ok(request('packing', [long.id]))
    assert.equal(tooLong.rows[0].eligible, false)
    assert.equal(tooLong.rows[0].document, null)
    assert.ok(tooLong.rows[0].reason)
    console.log('PASS full 500-item invoice and packing documents retain every row; a 501-item packing order is explicitly skipped instead of truncated')

    const privateBefore = await businessState()
    for (const [identity, origin, expected] of [[null, 'http://localhost:3000', 401], [{ user: { ...actor, role: 'USER' } }, 'http://localhost:3000', 403], [{ user: actor }, 'https://foreign.invalid', 403]]) {
      session = identity
      const readsBefore = reads
      const result = await post(request('invoice', [history.id]), origin)
      assert.equal(result.status, expected)
      assert.equal(reads, readsBefore, 'Authentication/origin must reject before private database reads')
      const serialized = JSON.stringify(result.body)
      for (const secret of ['09123456789', '0123456789', 'نشانی هنگام سفارش', 'buyer-old@isolated.invalid']) assert.equal(serialized.includes(secret), false)
      assert.match(result.headers.get('cache-control'), /no-store/)
    }
    session = { user: actor }
    assert.equal(writes, 0)
    assert.deepEqual(await businessState(), privateBefore)
    console.log('PASS anonymous/customer/foreign-origin requests leak no recipient data and perform no database reads; all print endpoints remain mutation-free')
  } finally {
    await db.$disconnect()
    try {
      if (created) {
        checkScope()
        await control.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
        assert.equal((await control.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).length, 0)
        console.log('PASS exact isolated schema removed; public business records and sequences were untouched')
      }
    } finally { await control.$disconnect() }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
