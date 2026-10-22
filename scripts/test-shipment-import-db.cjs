// Local-only shipment regression. All tables/fixtures live in an isolated random
// schema. Never write, copy or clear public business records.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')
const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.hostname !== '192.168.1.104' || target.pathname !== '/shoes_shop' || (target.searchParams.has('schema') && target.searchParams.get('schema') !== 'public')) throw new Error('Shipment integration requires the local development shoes_shop database and public source schema')
const schema = 'test_shipments_' + randomBytes(8).toString('hex')
assert.match(schema, /^test_shipments_[a-f0-9]{16}$/)
const scope = '"' + schema + '"'
const isolatedUrl = new URL(target)
isolatedUrl.searchParams.set('schema', schema); isolatedUrl.searchParams.set('connection_limit', '4')
const source = new PrismaClient({ datasources: { db: { url: target.toString() } } })
const isolated = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } })
let created = false
const cache = new Map()
function load(relative) {
  if (cache.has(relative)) return cache.get(relative)
  const result = { exports: {} }; cache.set(relative, result.exports)
  vm.runInNewContext(transformSync(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false } }).code, {
    module: result, Date, Error, Buffer, URL, URLSearchParams, Request, Response, process: { env: { AUTH_SECRET: 'isolated-shipment-tests-secret-123456789' } }, console,
    require(name) {
      if (name === 'next/server') return { NextResponse: Response }
      if (name === '@/lib/prisma') return { prisma: isolated }
      if (name === '@/lib/auth') return { auth: async () => ({ user: { id: actor.id, name: actor.name, role: 'ADMIN' } }) }
      if (name.startsWith('node:') || name === '@prisma/client' || name === 'exceljs') return require(name)
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      throw new Error('Unexpected dependency ' + name)
    },
  })
  cache.set(relative, result.exports)
  return result.exports
}
const shipment = load('src/lib/shipment-import.ts')
const transaction = callback => isolated.$transaction(callback, { maxWait: 10000, timeout: 20000 })
const actor = { id: 'shipment-admin', name: 'آزمایش ایزوله' }
const identifiers = { phone: '09123456789', postalCode: '1234567890' }
const row = { rowNumber: 2, matchValue: identifiers.phone, trackingCode: '001234567890123456789012' }
async function preview(rows = [row], markShipped = false, matchBy = 'phone') {
  return transaction(tx => shipment.previewShipmentImport(tx, { rows, markShipped, matchBy }, actor.id))
}
async function order(id, extra = {}) {
  await isolated.order.create({ data: { id, userId: actor.id, address: 'نشانی آزمایش', phone: identifiers.phone, postalCode: identifiers.postalCode, total: 1000, verified: true, status: 'SHIPPED',
    items: { create: { id: id + '-item', productId: 'shoe', variantId: 'variant', productName: 'کفش آزمایش', quantity: 1, size: 38, color: 'مشکی', price: 1000 } }, ...extra } })
}
async function main() {
  try {
    await source.$executeRawUnsafe('CREATE SCHEMA ' + scope); created = true
    for (const table of ['User', 'Order', 'OrderItem', 'Invoice', 'Product', 'ProductVariant', 'StockMovement']) await source.$executeRawUnsafe('CREATE TABLE ' + scope + '."' + table + '" (LIKE "public"."' + table + '" INCLUDING ALL)')
    const enums = await source.$queryRaw`SELECT t.typname AS name, e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`
    for (const name of ['Role', 'OrderStatus', 'PaymentStatus', 'ShoeType', 'StockMovementType']) {
      const labels = enums.filter(value => value.name === name).map(value => "'" + value.label.replace(/'/g, "''") + "'")
      assert.ok(labels.length)
      await source.$executeRawUnsafe('CREATE TYPE ' + scope + '."' + name + '" AS ENUM (' + labels.join(',') + ')')
    }
    const enumColumns = await source.$queryRaw`SELECT table_name, column_name, udt_name, column_default FROM information_schema.columns WHERE table_schema = ${schema} AND udt_name IN ('Role', 'OrderStatus', 'PaymentStatus', 'ShoeType', 'StockMovementType')`
    for (const column of enumColumns) {
      for (const value of [column.table_name, column.column_name, column.udt_name]) assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/)
      const table = scope + '."' + column.table_name + '"', name = '"' + column.column_name + '"', type = scope + '."' + column.udt_name + '"'
      await source.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + ' DROP DEFAULT')
      await source.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + ' TYPE ' + type + ' USING ' + name + '::text::' + type)
      if (column.column_default) {
        const label = /^'([^']+)'::/.exec(column.column_default)?.[1]
        assert.ok(label && enums.some(value => value.name === column.udt_name && value.label === label))
        await source.$executeRawUnsafe('ALTER TABLE ' + table + ' ALTER COLUMN ' + name + " SET DEFAULT '" + label.replace(/'/g, "''") + "'::" + type)
      }
    }
    await isolated.user.create({ data: { id: actor.id, name: actor.name, email: 'shipment-tests@isolated.invalid', password: '$disabled$fixture', role: 'ADMIN' } })
    await isolated.product.create({ data: { id: 'shoe', code: 'ISOLATED-SHIPMENT', name: 'کفش آزمایش', slug: 'isolated-shipment-shoe', description: 'موقت', price: 1000, images: [], sizes: [38], colors: ['مشکی'], categoryId: 'isolated-unused-category', stock: 7, inventoryConfigured: true } })
    await isolated.productVariant.create({ data: { id: 'variant', productId: 'shoe', size: 38, color: 'مشکی', stock: 7 } })
    await order('shipment-order-one', { phone: '+98 912 345 6789' })
    const first = await preview()
    assert.equal(first.rows[0].candidates.length, 1)
    let claims = shipment.verifyShipmentPreview(first.token, actor.id)
    await transaction(tx => shipment.confirmShipmentRow(tx, claims, { rowNumber: 2, orderId: 'shipment-order-one', overwrite: false }, actor))
    assert.equal((await isolated.order.findUniqueOrThrow({ where: { id: 'shipment-order-one' } })).trackingCode, row.trackingCode)
    assert.equal(await isolated.stockMovement.count(), 0)
    console.log('PASS real normalized SQL matches +98 order snapshots and records long zero-prefixed tracking without another stock movement')

    await order('shipment-order-two', { phone: '۰۹۱۲۳۴۵۶۷۸۹', postalCode: '۱۲۳۴۵۶۷۸۹۰', status: 'PROCESSING' })
    // Explicit IDs prevent LIKE-cloned defaults from advancing public sequences.
    await isolated.invoice.create({ data: { id: 1, orderId: 'shipment-order-two', snapshot: {} } })
    const ambiguous = await preview([row], true)
    assert.equal(ambiguous.rows[0].candidates.length, 2)
    const second = await preview([{ ...row, orderReference: 'shipment-order-two' }], true)
    assert.equal(second.rows[0].candidates.length, 1)
    claims = shipment.verifyShipmentPreview(second.token, actor.id)
    const choice = { rowNumber: 2, orderId: 'shipment-order-two', overwrite: false }
    const concurrent = await Promise.allSettled([1, 2].map(() => transaction(tx => shipment.confirmShipmentRow(tx, claims, choice, actor))))
    assert.ok(concurrent.some(result => result.status === 'fulfilled'))
    assert.equal(await isolated.stockMovement.count({ where: { type: 'SHIPMENT', orderId: choice.orderId } }), 1)
    assert.equal((await isolated.product.findUniqueOrThrow({ where: { id: 'shoe' } })).stock, 7)
    assert.equal((await isolated.productVariant.findUniqueOrThrow({ where: { id: 'variant' } })).stock, 7)
    assert.equal((await transaction(tx => shipment.confirmShipmentRow(tx, claims, choice, actor))).status, 'unchanged')
    console.log('PASS true concurrent processing confirmations emit exactly one SHIPMENT ledger event and keep available stock unchanged')

    const postal = await preview([{ ...row, matchValue: identifiers.postalCode, trackingCode: '123456000000000000000000', orderReference: 'shipment-order-two' }], false, 'postalCode')
    assert.equal(postal.rows[0].candidates.length, 1)
    claims = shipment.verifyShipmentPreview(postal.token, actor.id)
    await assert.rejects(transaction(tx => shipment.confirmShipmentRow(tx, claims, { ...choice, overwrite: false }, actor)), { status: 409 })
    await transaction(tx => shipment.confirmShipmentRow(tx, claims, { ...choice, overwrite: true }, actor))
    assert.equal(await isolated.stockMovement.count({ where: { type: 'SHIPMENT', orderId: choice.orderId } }), 1)
    console.log('PASS Persian postal snapshot matching and explicit correction preserve shipment history without duplicate events')

    const stale = await preview([{ ...row, trackingCode: '987654000000000000000000', orderReference: 'shipment-order-two' }])
    claims = shipment.verifyShipmentPreview(stale.token, actor.id)
    await isolated.order.update({ where: { id: choice.orderId }, data: { status: 'DELIVERED' } })
    await assert.rejects(transaction(tx => shipment.confirmShipmentRow(tx, claims, { ...choice, overwrite: true }, actor)), { status: 409 })
    console.log('PASS a stale tracking import cannot modify an order that has been delivered since preview')

    await order('shipment-order-three')
    const batch = await preview([
      { ...row, rowNumber: 2, orderReference: 'shipment-order-one', trackingCode: '111122223333444455556666' },
      { ...row, rowNumber: 3, orderReference: 'shipment-order-three', trackingCode: '222233334444555566667777' },
    ])
    await isolated.order.update({ where: { id: 'shipment-order-one' }, data: { status: 'DELIVERED' } })
    const endpoint = load('src/app/api/admin/shipments/confirm/route.ts')
    const response = await endpoint.POST(new Request('http://localhost:3000/api/admin/shipments/confirm', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: batch.token, choices: [{ rowNumber: 2, orderId: 'shipment-order-one', overwrite: true }, { rowNumber: 3, orderId: 'shipment-order-three', overwrite: false }] }) }))
    assert.equal(response.status, 200)
    const results = (await response.json()).results
    assert.equal(results[0].status, 'error'); assert.equal(results[1].status, 'saved')
    assert.equal((await isolated.order.findUniqueOrThrow({ where: { id: 'shipment-order-three' } })).trackingCode, '222233334444555566667777')
    console.log('PASS real confirmation endpoint reports a stale row while independently saving another valid row')
  } finally {
    await isolated.$disconnect()
    if (created) {
      assert.match(schema, /^test_shipments_[a-f0-9]{16}$/)
      await source.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
      assert.equal((await source.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).length, 0)
      console.log('PASS isolated schema removed; public business data untouched')
    }
  }
}
main().catch(error => { console.error(error.name, error.code || '', error.message); process.exitCode = 1 }).finally(() => source.$disconnect())
