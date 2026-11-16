// Local-only integration regression. Every fixture, cloned table/index/check and
// enum lives in one random schema. Public data is never copied or changed.
// The exact schema is removed in finally, including after a failed assertion.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.protocol !== 'postgresql:' || target.hostname !== '192.168.1.105' || target.pathname !== '/shoes_shop'
  || (target.searchParams.has('schema') && target.searchParams.get('schema') !== 'public')) {
  throw new Error('Bulk-price integration requires the local development shoes_shop database and public source schema')
}
const schema = 'test_product_price_bulk_' + randomBytes(8).toString('hex')
function identifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/)
  return '"' + value + '"'
}
function assertScope() { assert.match(schema, /^test_product_price_bulk_[a-f0-9]{16}$/) }
assertScope()
const scope = identifier(schema)
const isolatedUrl = new URL(target)
isolatedUrl.searchParams.set('schema', schema)
isolatedUrl.searchParams.set('connection_limit', '4')
isolatedUrl.searchParams.set('connect_timeout', '10')
const sourceUrl = new URL(target)
sourceUrl.searchParams.set('schema', 'public')
sourceUrl.searchParams.set('connection_limit', '1')
sourceUrl.searchParams.set('connect_timeout', '10')
const source = new PrismaClient({ datasources: { db: { url: sourceUrl.toString() } } })
const isolated = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } })
let created = false
const actor = { id: 'bulk-price-isolated-admin', name: 'آزمایش ایزولهٔ قیمت گروهی' }
const cache = new Map()
function load(relative) {
  if (cache.has(relative)) return cache.get(relative)
  const result = { exports: {} }
  cache.set(relative, result.exports)
  vm.runInNewContext(transformSync(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false },
  }).code, {
    module: result, Date, Error, Buffer, URL, URLSearchParams, Request, Response, FormData, File, Uint8Array, console,
    process: { env: { AUTH_SECRET: 'bulk-price-isolated-test-secret-123456789' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: Response }
      if (name === '@/lib/prisma') return { prisma: isolated }
      if (name === '@/lib/auth') return { auth: async () => ({ user: { ...actor, role: 'ADMIN' } }) }
      // Pricing quotes are real DB reads; housekeeping is outside this test.
      if (relative === 'src/app/api/checkout/quote/route.ts' && name === '@/lib/payments') return { expireUnpaidOrders: async () => 0 }
      if (name.startsWith('node:') || name === '@prisma/client') return require(name)
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      throw new Error('Unexpected dependency ' + name)
    },
  })
  cache.set(relative, result.exports)
  return result.exports
}
const bulk = load('src/lib/product-price-bulk.ts')
const inventory = load('src/lib/inventory.ts')
const warehouse = load('src/lib/warehouse.ts')
const invoice = load('src/lib/invoice.ts')
const orderTotals = load('src/lib/order-totals.ts')
const transaction = callback => isolated.$transaction(callback, { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 })
const settings = { operation: 'increase', unit: 'amount', value: 100, includeSalePrice: false }
const reason = 'اصلاح قیمت فقط در طرح آزمایشی ایزوله'
let fixture = 0
async function product(extra = {}) {
  const id = 'bulk-price-product-' + (++fixture)
  return isolated.product.create({ data: {
    id, code: 'ISOLATED-PRICE-' + fixture, name: 'کفش ایزوله ' + fixture, slug: id, description: 'فقط آزمایش ایزوله',
    price: 1000, images: [], sizes: [38], colors: ['مشکی'], categoryId: 'bulk-price-category',
    stock: 10, inventoryConfigured: true, inventoryVersion: 3, pricingVersion: 0,
    variants: { create: { id: id + '-black', size: 38, color: 'مشکی', stock: 10, damagedStock: 2 } },
    ...extra,
  } })
}
const preview = (products, changes = {}, now) => bulk.previewProductPrices(isolated, {
  ids: products.map(value => typeof value === 'string' ? value : value.id), settings: { ...settings, ...changes }, reason,
}, actor, now)
const confirm = (result, productId, db = isolated, now) => bulk.confirmProductPrice(db, { token: result.token, productId }, actor, now)
const current = id => isolated.product.findUniqueOrThrow({ where: { id }, include: { variants: { orderBy: { id: 'asc' } } } })
const audits = productId => isolated.productPriceChange.findMany({ where: productId ? { productId } : {}, orderBy: { id: 'asc' } })
const history = () => isolated.order.findMany({ orderBy: { id: 'asc' }, include: { items: { orderBy: { id: 'asc' } }, invoice: true } })
async function snapshot(id) {
  return { product: await current(id), audits: await audits(id), history: await history(),
    movements: await isolated.stockMovement.findMany({ orderBy: { id: 'asc' } }) }
}
function priceSnapshot(value) {
  return { price: value.price, salePrice: value.salePrice ?? null, saleStartsAt: value.saleStartsAt?.toISOString() ?? null,
    saleEndsAt: value.saleEndsAt?.toISOString() ?? null, pricingVersion: value.pricingVersion }
}
const request = body => new Request('http://localhost:3000/api/products/test', {
  method: 'PUT', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
async function individual(id, body, status = 200) {
  const response = await load('src/app/api/products/[id]/route.ts').PUT(request(body), { params: Promise.resolve({ id }) })
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}
async function quote(id) {
  const response = await load('src/app/api/checkout/quote/route.ts').POST(new Request('http://localhost:3000/api/checkout/quote', {
    method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: id, size: 38, color: 'مشکی', quantity: 2 }], shippingMethodId: 'bulk-price-shipping' }),
  }))
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}

async function setup() {
  assertScope()
  const auditForeignKeys = await source.$queryRaw`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND t.relname = 'ProductPriceChange' AND c.contype = 'f'`
  assert.deepEqual(auditForeignKeys, [], 'Durable audit snapshots must survive deleting products and actors')
  await source.$executeRawUnsafe('CREATE SCHEMA ' + scope)
  created = true
  for (const table of ['User', 'Category', 'Product', 'ProductVariant', 'StockMovement', 'Order', 'OrderItem', 'Invoice', 'ShippingMethod', 'ProductPriceChange']) {
    await source.$executeRawUnsafe('CREATE TABLE ' + scope + '.' + identifier(table) + ' (LIKE "public".' + identifier(table) + ' INCLUDING ALL)')
  }
  // LIKE preserves real checks/indexes, but initially references public enums.
  // Clone every enum used by a fixture table, including new audit enums.
  const columns = await source.$queryRaw`SELECT c.table_name, c.column_name, c.udt_name, c.column_default FROM information_schema.columns c JOIN pg_type t ON t.typname = c.udt_name JOIN pg_namespace n ON n.oid = t.typnamespace WHERE c.table_schema = ${schema} AND n.nspname = 'public' AND t.typtype = 'e'`
  const enums = await source.$queryRaw`SELECT t.typname AS name, e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`
  for (const name of new Set(columns.map(value => value.udt_name))) {
    const labels = enums.filter(value => value.name === name).map(value => "'" + value.label.replace(/'/g, "''") + "'")
    assert.ok(labels.length)
    await source.$executeRawUnsafe('CREATE TYPE ' + scope + '.' + identifier(name) + ' AS ENUM (' + labels.join(',') + ')')
  }
  for (const column of columns) {
    const table = scope + '.' + identifier(column.table_name), name = identifier(column.column_name), type = scope + '.' + identifier(column.udt_name)
    await source.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + ' DROP DEFAULT')
    await source.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + ' TYPE ' + type + ' USING ' + name + '::text::' + type)
    if (column.column_default) {
      const label = /^'([^']+)'::/.exec(column.column_default)?.[1]
      assert.ok(label && enums.some(value => value.name === column.udt_name && value.label === label))
      await source.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + " SET DEFAULT '" + label.replace(/'/g, "''") + "'::" + type)
    }
  }
  assert.deepEqual(await isolated.$queryRaw`SELECT current_schema() AS name`, [{ name: schema }])
  // All serial IDs below are explicit: cloned defaults cannot advance a public sequence.
  await isolated.user.create({ data: { ...actor, email: 'bulk-price@isolated.invalid', password: '$disabled$fixture', role: 'ADMIN' } })
  await isolated.category.create({ data: { id: 'bulk-price-category', name: 'دستهٔ ایزوله', slug: 'bulk-price-category' } })
  await isolated.shippingMethod.create({ data: { id: 'bulk-price-shipping', name: 'ارسال ایزوله', baseCost: 100, isActive: true } })
}

async function main() {
  try {
    await setup()
    const first = await product({ salePrice: 800, pricingVersion: 3 })
    const purchase = await isolated.order.create({ data: {
      id: 'bulk-price-historical-order', userId: actor.id, status: 'PROCESSING', paymentStatus: 'PAID', verified: true,
      total: 1500, subtotal: 2000, productDiscount: 400, couponDiscount: 200, shippingCost: 100,
      address: 'آزمایش بدون ارسال', phone: '00000000000', recipientName: actor.name,
      items: { create: { id: 'bulk-price-historical-item', productId: first.id, productName: first.name, variantId: first.id + '-black',
        price: 800, originalPrice: 1000, quantity: 2, couponDiscount: 200, size: 38, color: 'مشکی' } },
    }, include: { user: true, items: { include: { product: true } } } })
    await isolated.invoice.create({ data: { id: -710000001, orderId: purchase.id, snapshot: invoice.buildInvoiceSnapshot(purchase) } })
    const oldHistory = await history(), oldTotals = orderTotals.getOrderTotals(oldHistory[0])
    const before = await snapshot(first.id)
    const oldQuote = await quote(first.id)
    assert.deepEqual(oldQuote.productPrices, [{ productId: first.id, price: 800, originalPrice: 1000 }])
    const receipt = await preview([first], { unit: 'percent', value: 10, includeSalePrice: true })
    assert.equal(receipt.rows[0].eligible, true)
    assert.equal(receipt.rows[0].after.price, 1100)
    assert.equal(receipt.rows[0].after.salePrice, 880)
    assert.deepEqual(await snapshot(first.id), before)
    console.log('PASS preview and checkout quote are read-only and freeze exact base/sale prices and pricing revision')

    // Open both PostgreSQL transactions before either confirms; prove that a
    // simultaneous retry is recovered rather than performing a second update.
    let arrived = 0, release
    const ready = new Promise(resolve => { release = resolve })
    const synchronized = new Proxy(isolated, { get(client, key) {
      if (key === '$transaction') return (callback, options) => client.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1`
        if (++arrived === 2) release()
        await ready
        return callback(tx)
      }, options)
      return client[key]
    } })
    const concurrent = await Promise.allSettled([1, 2].map(() => confirm(receipt, first.id, synchronized)))
    assert.ok(concurrent.every(value => value.status === 'fulfilled'), concurrent.map(value => value.reason?.message).join('; '))
    assert.deepEqual(concurrent.map(value => value.value.result.outcome).sort(), ['already_applied', 'updated'])
    const saved = await current(first.id), ledger = await audits(first.id)
    assert.equal(saved.price, 1100); assert.equal(saved.salePrice, 880); assert.equal(saved.pricingVersion, 4)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].actorId, actor.id); assert.equal(ledger[0].actorName, actor.name)
    assert.equal(ledger[0].reason, reason); assert.equal(ledger[0].beforePrice, 1000); assert.equal(ledger[0].afterPrice, 1100)
    assert.equal(ledger[0].beforeSalePrice, 800); assert.equal(ledger[0].afterSalePrice, 880)
    assert.equal(ledger[0].operation, 'increase'); assert.equal(ledger[0].unit, 'percent')
    assert.equal(ledger[0].value, 10); assert.equal(ledger[0].includeSalePrice, true)
    assert.equal(ledger[0].productCode, first.code); assert.equal(ledger[0].productName, first.name)
    assert.equal(ledger[0].beforePricingVersion, 3); assert.equal(ledger[0].afterPricingVersion, 4)
    assert.equal(saved.inventoryVersion, before.product.inventoryVersion)
    assert.deepEqual(saved.variants, before.product.variants)
    assert.equal(saved.stock, before.product.stock)
    assert.deepEqual(await history(), oldHistory)
    assert.deepEqual(orderTotals.getOrderTotals((await history())[0]), oldTotals)
    assert.deepEqual(await isolated.stockMovement.findMany(), before.movements)
    const newQuote = await quote(first.id)
    assert.deepEqual(newQuote.productPrices, [{ productId: first.id, price: 880, originalPrice: 1100 }])
    assert.equal(newQuote.grossSubtotal, 2200); assert.equal(newQuote.subtotal, 1760); assert.equal(newQuote.total, 1860)
    console.log('PASS concurrent confirmation writes once and current checkout prices change while stock, prior order amounts and invoice snapshots remain immutable')

    await individual(first.id, { price: 2000, salePrice: 1600, expectedPricing: priceSnapshot(saved) })
    const afterLaterEdit = await snapshot(first.id)
    const replayed = await confirm(receipt, first.id)
    assert.equal(replayed.result.outcome, 'already_applied')
    assert.equal(replayed.result.auditId, ledger[0].id)
    assert.equal(replayed.result.after.price, 1100); assert.equal(replayed.result.after.salePrice, 880)
    assert.equal((await confirm(receipt, first.id, isolated, Date.parse(receipt.expiresAt) + 1)).result.outcome, 'already_applied')
    assert.deepEqual(await snapshot(first.id), afterLaterEdit)
    console.log('PASS retry returns durable original prices after later edits and preview expiry without touching history')

    const aba = await product()
    const stale = await preview([aba])
    await individual(aba.id, { price: 1200, expectedPricing: priceSnapshot(aba) })
    const middle = await current(aba.id)
    assert.equal(middle.pricingVersion, 1)
    await individual(aba.id, { price: 1000, expectedPricing: priceSnapshot(middle) })
    const restored = await snapshot(aba.id)
    assert.equal(restored.product.pricingVersion, 2)
    assert.equal((await confirm(stale, aba.id)).result.outcome, 'skipped')
    assert.deepEqual(await snapshot(aba.id), restored)
    await individual(aba.id, { price: 1300, expectedPricing: priceSnapshot(aba) }, 409)
    const legacy = priceSnapshot(restored.product); delete legacy.pricingVersion
    await individual(aba.id, { price: 1300, expectedPricing: legacy }, 409)
    await individual(aba.id, { name: aba.name + ' ویرایش' })
    assert.equal((await current(aba.id)).pricingVersion, 2)
    console.log('PASS individual price edits invalidate stale ABA previews and old versionless pricing forms while ordinary product edits keep the pricing revision')

    const independent = await product()
    const independentPreview = await preview([independent])
    await isolated.product.update({ where: { id: independent.id }, data: { viewCount: { increment: 1 } } })
    const item = { productId: independent.id, variantId: independent.id + '-black', size: 38, color: 'مشکی', quantity: 1 }
    await transaction(tx => inventory.reserveInventory(tx, [item]))
    await transaction(tx => inventory.releaseInventory(tx, [item]))
    let stockState = await current(independent.id)
    await transaction(tx => warehouse.updateLowStockThreshold(tx, { productId: independent.id, variantId: item.variantId,
      inventoryVersion: stockState.inventoryVersion, lowStockThreshold: 7 }))
    stockState = await current(independent.id)
    await transaction(tx => warehouse.applyStockOperation(tx, warehouse.parseStockOperation({ productId: independent.id,
      variantId: item.variantId, inventoryVersion: stockState.inventoryVersion, type: 'RECEIPT', quantity: 1,
      note: 'ثبت دستی ایزوله', requestKey: 'bulk-price-isolated-stock-operation' }), actor))
    const independentBefore = await snapshot(independent.id)
    assert.equal(independentBefore.product.pricingVersion, 0)
    assert.equal((await confirm(independentPreview, independent.id)).result.outcome, 'updated')
    const independentAfter = await snapshot(independent.id)
    assert.equal(independentAfter.product.inventoryVersion, independentBefore.product.inventoryVersion)
    assert.equal(independentAfter.product.stock, independentBefore.product.stock)
    assert.equal(independentAfter.product.viewCount, independentBefore.product.viewCount)
    assert.deepEqual(independentAfter.product.variants, independentBefore.product.variants)
    assert.deepEqual(independentAfter.movements, independentBefore.movements)
    console.log('PASS views, reservations, releases, thresholds and manual stock changes do not invalidate price previews; bulk pricing preserves their balances')

    const rollbackProduct = await product()
    const rollback = await preview([rollbackProduct])
    const rollbackBefore = await snapshot(rollbackProduct.id)
    const forced = new Error('forced isolated bulk-price ledger failure')
    const broken = new Proxy(isolated, { get(client, key) {
      if (key === '$transaction') return (callback, options) => client.$transaction(tx => callback(new Proxy(tx, { get(inner, model) {
        if (model === 'productPriceChange') return new Proxy(inner.productPriceChange, { get(delegate, action) {
          return action === 'create' ? async () => { throw forced } : delegate[action]
        } })
        return inner[model]
      } })), options)
      return client[key]
    } })
    await assert.rejects(confirm(rollback, rollbackProduct.id, broken), error => error === forced)
    assert.deepEqual(await snapshot(rollbackProduct.id), rollbackBefore)
    assert.equal((await confirm(rollback, rollbackProduct.id)).result.outcome, 'updated')
    console.log('PASS ledger failure rolls back price and revision atomically; a clean retry writes one audit record')

    const checkoutRace = await product()
    // Checkout read this price revision before the administrator committed.
    const expectedPricingVersions = new Map([[checkoutRace.id, checkoutRace.pricingVersion]])
    const changedDuringCheckout = await preview([checkoutRace])
    const confirmedResponse = await load('src/app/api/admin/products/prices/confirm/route.ts').POST(new Request('http://localhost:3000/api/admin/products/prices/confirm', {
      method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: changedDuringCheckout.token, productId: checkoutRace.id }),
    }))
    assert.equal(confirmedResponse.status, 200)
    assert.equal((await confirmedResponse.json()).result.outcome, 'updated')
    const checkoutBefore = await snapshot(checkoutRace.id)
    const checkoutItem = { productId: checkoutRace.id, variantId: checkoutRace.id + '-black', size: 38, color: 'مشکی', quantity: 1 }
    await assert.rejects(transaction(tx => inventory.reserveInventory(tx, [checkoutItem], { expectedPricingVersions })),
      error => error instanceof inventory.InventoryError && error.status === 409 && error.code === 'ORDER_PRICES_CHANGED')
    assert.deepEqual(await snapshot(checkoutRace.id), checkoutBefore)
    await transaction(tx => inventory.reserveInventory(tx, [checkoutItem], {
      expectedPricingVersions: new Map([[checkoutRace.id, checkoutBefore.product.pricingVersion]]),
    }))
    assert.equal((await current(checkoutRace.id)).stock, checkoutBefore.product.stock - 1)
    await transaction(tx => inventory.releaseInventory(tx, [checkoutItem]))
    console.log('PASS real confirmation endpoint and checkout price-revision claim reject a price changed after checkout read, without reserving stock or creating history')

    const expires = await product()
    const expiredPreview = await preview([expires])
    const expiryBefore = await snapshot(expires.id)
    const expired = await confirm(expiredPreview, expires.id, isolated, Date.parse(expiredPreview.expiresAt))
    assert.equal(expired.result.outcome, 'skipped'); assert.equal(expired.result.code, 'PREVIEW_EXPIRED')
    assert.deepEqual(await snapshot(expires.id), expiryBefore)
    console.log('PASS an uncommitted preview expires without changing any prices, audit, stock or historical orders')

    const maximum = await product({ price: 2147483646 })
    const ceiling = await preview([maximum], { value: 1 })
    assert.equal(ceiling.rows[0].eligible, true)
    assert.equal((await confirm(ceiling, maximum.id)).result.outcome, 'updated')
    assert.equal((await current(maximum.id)).price, 2147483647)
    const maximumBefore = await snapshot(maximum.id)
    assert.equal((await preview([maximum], { value: 1 })).rows[0].eligible, false)
    assert.deepEqual(await snapshot(maximum.id), maximumBefore)
    const rounded = await product({ price: 101 })
    const rounding = await preview([rounded], { unit: 'percent', value: 50 })
    assert.equal(rounding.rows[0].after.price, 152)
    assert.equal((await confirm(rounding, rounded.id)).result.outcome, 'updated')
    assert.equal((await current(rounded.id)).price, 152)
    const zero = await product({ price: 1 })
    assert.equal((await preview([zero], { operation: 'decrease', value: 1 })).rows[0].eligible, false)
    assert.equal((await preview([zero], { operation: 'decrease', unit: 'percent', value: 1 })).rows[0].eligible, false)
    const versionCeiling = await product({ pricingVersion: 2147483647 })
    const versionCeilingBefore = await snapshot(versionCeiling.id)
    assert.equal((await preview([versionCeiling])).rows[0].eligible, false)
    await individual(versionCeiling.id, { price: 1100, expectedPricing: priceSnapshot(versionCeiling) }, 409)
    assert.deepEqual(await snapshot(versionCeiling.id), versionCeilingBefore)
    console.log('PASS exact PostgreSQL integer ceiling, overflow rejection, positive-price minimum and half-toman rounding are preserved in real writes')

    const unsafeAfter = await product({ salePrice: 980 })
    assert.equal((await preview([unsafeAfter], { operation: 'decrease', value: 30 })).rows[0].eligible, false)
    const pairedSale = await preview([unsafeAfter], { operation: 'decrease', value: 30, includeSalePrice: true })
    assert.equal(pairedSale.rows[0].eligible, true)
    assert.equal(pairedSale.rows[0].after.price, 970); assert.equal(pairedSale.rows[0].after.salePrice, 950)
    assert.equal((await confirm(pairedSale, unsafeAfter.id)).result.outcome, 'updated')
    const collapsedSale = await product({ price: 2, salePrice: 1 })
    assert.equal((await preview([collapsedSale], { operation: 'decrease', unit: 'percent', value: 50, includeSalePrice: true })).rows[0].eligible, false)
    for (const schedule of [
      { saleStartsAt: new Date(Date.now() + 86400000), saleEndsAt: new Date(Date.now() + 172800000) },
      { saleStartsAt: new Date(Date.now() - 172800000), saleEndsAt: new Date(Date.now() - 86400000) },
    ]) {
      // Existing database checks prevent even expired/future invalid sales from
      // being stored. Exercise those real checks rather than weakening fixtures.
      await assert.rejects(product({ salePrice: 1000, ...schedule }), error => /Product_sale_valid/.test(error.message))
      const scheduled = await product({ salePrice: 800, ...schedule })
      const scheduledPreview = await preview([scheduled], { value: 100, includeSalePrice: true })
      assert.equal(scheduledPreview.rows[0].eligible, true)
      assert.equal((await confirm(scheduledPreview, scheduled.id)).result.outcome, 'updated')
      const scheduledAfter = await current(scheduled.id)
      assert.equal(scheduledAfter.price, 1100); assert.equal(scheduledAfter.salePrice, 900)
      assert.equal(scheduledAfter.saleStartsAt.getTime(), schedule.saleStartsAt.getTime())
      assert.equal(scheduledAfter.saleEndsAt.getTime(), schedule.saleEndsAt.getTime())
    }
    console.log('PASS PostgreSQL rejects invalid expired/scheduled sales; bulk preserves valid sale schedules and rejects invalid resulting discounts after rounding')

    const deleted = await product()
    const deletionPreview = await preview([deleted])
    const deletedCommit = await confirm(deletionPreview, deleted.id)
    assert.equal(deletedCommit.result.outcome, 'updated')
    await isolated.productVariant.deleteMany({ where: { productId: deleted.id } })
    await isolated.product.delete({ where: { id: deleted.id } })
    const deletedReplay = await confirm(deletionPreview, deleted.id, isolated, Date.parse(deletionPreview.expiresAt) + 1)
    assert.equal(deletedReplay.result.outcome, 'already_applied')
    assert.equal(deletedReplay.result.auditId, deletedCommit.result.auditId)
    assert.deepEqual(deletedReplay.result.before, deletedCommit.result.before)
    assert.deepEqual(deletedReplay.result.after, deletedCommit.result.after)
    assert.equal((await audits(deleted.id)).length, 1)
    assert.equal(await isolated.product.count({ where: { id: deleted.id } }), 0)
    assert.deepEqual(await history(), oldHistory)
    console.log('PASS committed retry survives product deletion and expiry, retaining the original audit snapshots')
  } finally {
    await isolated.$disconnect()
    if (created) {
      assertScope()
      await source.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
      assert.equal((await source.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).length, 0)
      console.log('PASS exact isolated schema removed; public catalog, stock, orders, invoices and audit history untouched')
    }
  }
}
main().catch(error => { console.error(error.name, error.code || '', error.message); process.exitCode = 1 }).finally(() => source.$disconnect())
