// Local-only regression: fixtures, tables, indexes and enum types stay in one
// random schema. Public tables are read only for structure; no business row is
// inserted, updated, deleted or copied. The exact schema is removed in finally.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.hostname !== '192.168.1.105' || target.pathname !== '/shoes_shop'
  || (target.searchParams.has('schema') && target.searchParams.get('schema') !== 'public')) {
  throw new Error('Warehouse-import integration requires the local development shoes_shop database and public source schema')
}
const schema = 'test_warehouse_import_' + randomBytes(8).toString('hex')
function identifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/)
  return '"' + value + '"'
}
function assertScope() { assert.match(schema, /^test_warehouse_import_[a-f0-9]{16}$/) }
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
const actor = { id: 'warehouse-import-admin', name: 'آزمایش ایزولهٔ ورود موجودی' }
const cache = new Map()
function load(relative) {
  if (cache.has(relative)) return cache.get(relative)
  const result = { exports: {} }
  cache.set(relative, result.exports)
  vm.runInNewContext(transformSync(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false },
  }).code, {
    module: result, Date, Error, Buffer, URL, URLSearchParams, Request, Response, FormData, File, Uint8Array, console,
    process: { env: { AUTH_SECRET: 'warehouse-import-isolated-test-secret-123456789' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: Response }
      if (name === '@/lib/prisma') return { prisma: isolated }
      if (name === '@/lib/auth') return { auth: async () => ({ user: { ...actor, role: 'ADMIN' } }) }
      if (name.startsWith('node:') || name === '@prisma/client' || name === 'exceljs') return require(name)
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      throw new Error('Unexpected dependency ' + name)
    },
  })
  cache.set(relative, result.exports)
  return result.exports
}
const importer = load('src/lib/warehouse-import.ts')
const inventory = load('src/lib/inventory.ts')
const warehouse = load('src/lib/warehouse.ts')
const transaction = callback => isolated.$transaction(callback, { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 })
const previewTransaction = callback => isolated.$transaction(callback, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 20000 })
let fixture = 0
async function product(extra = {}) {
  const id = 'import-product-' + (++fixture)
  return isolated.product.create({ data: {
    id, code: 'SKU-000' + fixture, name: 'کفش ایزوله ' + fixture, slug: id, description: 'فقط آزمایش ایزوله',
    price: 1000, images: [], sizes: [38, 39], colors: ['مشکی', 'کرم'], categoryId: 'isolated-unused-category',
    stock: 10, inventoryConfigured: true, inventoryVersion: 3,
    variants: { create: [
      { id: id + '-black', size: 38, color: 'مشکی', stock: 4, damagedStock: 2, lowStockThreshold: 0 },
      { id: id + '-cream', size: 39, color: 'کرم', stock: 6 },
      { id: id + '-retired', size: 40, color: 'سبز', stock: 5, damagedStock: 3, isActive: false },
    ] }, ...extra,
  } })
}
function row(current, quantity = '2', extra = {}) {
  return { rowNumber: 2, code: current.code, size: '38', color: 'مشکی', quantity, ...extra }
}
async function preview(rows, mode = 'RECEIPT') {
  return previewTransaction(tx => importer.previewWarehouseImport(tx, { mode, note: 'آزمایش ایزولهٔ ورود از اکسل', rows }, actor.id))
}
const claims = result => importer.verifyWarehouseImportPreview(result.token, actor.id)
const confirm = (result, productId) => transaction(tx => importer.confirmWarehouseImportProduct(tx, claims(result), productId, actor))
async function state(productId) {
  const current = await isolated.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: { orderBy: { id: 'asc' } } } })
  if (current.inventoryConfigured) assert.equal(current.stock, current.variants.filter(value => value.isActive).reduce((total, value) => total + value.stock, 0))
  return current
}
async function snapshot(productId) {
  return {
    product: await state(productId),
    movements: await isolated.stockMovement.findMany({ where: { productId }, orderBy: { id: 'asc' } }),
    orders: await isolated.order.findMany({ orderBy: { id: 'asc' }, include: { items: { orderBy: { id: 'asc' } } } }),
  }
}
const selected = (current, suffix = 'black') => current.variants.find(value => value.id === current.id + '-' + suffix)
async function rejectedUnchanged(result, productId, predicate = error => error.status === 409) {
  const before = await snapshot(productId)
  await assert.rejects(confirm(result, productId), predicate)
  assert.deepEqual(await snapshot(productId), before)
}

async function setup() {
  assertScope()
  await source.$executeRawUnsafe('CREATE SCHEMA ' + scope)
  created = true
  for (const table of ['User', 'Order', 'OrderItem', 'Product', 'ProductVariant', 'StockMovement']) {
    await source.$executeRawUnsafe('CREATE TABLE ' + scope + '.' + identifier(table) + ' (LIKE "public".' + identifier(table) + ' INCLUDING ALL)')
  }
  // LIKE preserves real checks/indexes, but initially references public enums.
  // Clone and retype those columns so raw SQL and Prisma both use this schema.
  const enums = await source.$queryRaw`SELECT t.typname AS name, e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' ORDER BY t.typname, e.enumsortorder`
  const names = ['Role', 'OrderStatus', 'PaymentStatus', 'ShoeType', 'StockMovementType']
  for (const name of names) {
    const labels = enums.filter(value => value.name === name).map(value => "'" + value.label.replace(/'/g, "''") + "'")
    assert.ok(labels.length)
    await source.$executeRawUnsafe('CREATE TYPE ' + scope + '.' + identifier(name) + ' AS ENUM (' + labels.join(',') + ')')
  }
  const columns = await source.$queryRaw`SELECT table_name, column_name, udt_name, column_default FROM information_schema.columns WHERE table_schema = ${schema} AND udt_name IN ('Role', 'OrderStatus', 'PaymentStatus', 'ShoeType', 'StockMovementType')`
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
  await isolated.user.create({ data: { id: actor.id, email: 'warehouse-import@isolated.invalid', name: actor.name, password: '$disabled$fixture', role: 'ADMIN' } })
}

async function main() {
  try {
    await setup()
    const first = await product()
    // Explicit IDs prevent a LIKE-cloned serial default from advancing any
    // public sequence. Reservations are already excluded from available stock.
    await isolated.order.create({ data: {
      id: 'isolated-reserved-order', userId: actor.id, total: 2000, address: 'آزمایش بدون ارسال', phone: '00000000000', status: 'PENDING',
      items: { create: { id: 'isolated-reserved-item', productId: first.id, variantId: first.id + '-black', productName: first.name, size: 38, color: 'مشکی', price: 1000, quantity: 2 } },
    } })
    const before = await snapshot(first.id)
    const receipt = await preview([
      row(first, '۲', { code: first.code.toLowerCase() }),
      row(first, '3', { rowNumber: 3, size: '۳۹', color: 'كرم' }),
      row(first, '4', { rowNumber: 4, size: '40', color: 'سبز' }),
    ])
    assert.equal(receipt.summary.valid, 3)
    assert.equal(receipt.rows[0].reserved, 2)
    assert.equal(receipt.rows[2].isActive, false)
    assert.deepEqual(await snapshot(first.id), before)
    console.log('PASS real preview resolves normalized codes/colors and reservations without changing any inventory or order')

    // Both PostgreSQL transactions are open before either calls confirm.
    let arrived = 0, release
    const ready = new Promise(resolve => { release = resolve })
    const concurrent = await Promise.allSettled([1, 2].map(() => transaction(async tx => {
      await tx.$queryRaw`SELECT 1`
      if (++arrived === 2) release()
      await ready
      return importer.confirmWarehouseImportProduct(tx, claims(receipt), first.id, actor)
    })))
    assert.ok(concurrent.every(value => value.status === 'fulfilled'))
    assert.deepEqual(concurrent.map(value => value.value.totals.success).sort(), [0, 3])
    assert.deepEqual(concurrent.map(value => value.value.totals.replayed).sort(), [0, 3])
    const received = await state(first.id)
    assert.equal(received.stock, 15)
    assert.equal(received.inventoryVersion, before.product.inventoryVersion + 1)
    assert.equal(selected(received).stock, 6)
    assert.equal(selected(received).damagedStock, 2)
    assert.equal(selected(received, 'cream').stock, 9)
    assert.equal(selected(received, 'retired').stock, 9)
    assert.equal(selected(received, 'retired').isActive, false)
    assert.equal(selected(received, 'retired').damagedStock, 3)
    assert.deepEqual((await snapshot(first.id)).orders, before.orders)
    const movements = await isolated.stockMovement.findMany({ where: { productId: first.id } })
    assert.equal(movements.length, 3)
    assert.ok(movements.every(value => value.actorId === actor.id && value.actorName === actor.name && value.type === 'RECEIPT'))
    assert.deepEqual(movements.map(value => [value.variantId, value.stockBefore, value.stockAfter]).sort(), [
      [first.id + '-black', 4, 6], [first.id + '-cream', 6, 9], [first.id + '-retired', 5, 9],
    ].sort())
    console.log('PASS true concurrent same-product confirmations write each source row once, increment one revision and preserve inactive/damaged/reserved buckets')

    const manual = warehouse.parseStockOperation({ productId: first.id, variantId: first.id + '-black', inventoryVersion: received.inventoryVersion, type: 'RECEIPT', quantity: 1, note: 'ثبت دستی پس از ورود', requestKey: 'isolated-manual-receipt' })
    await transaction(tx => warehouse.applyStockOperation(tx, manual, actor))
    const afterManual = await snapshot(first.id)
    const replayed = await confirm(receipt, first.id)
    assert.equal(replayed.totals.replayed, 3)
    assert.equal(replayed.results[0].stockAfter, 6)
    assert.deepEqual(await snapshot(first.id), afterManual)
    const expiredClaims = { ...claims(receipt), expiresAt: Date.now() - 1 }
    assert.equal((await transaction(tx => importer.confirmWarehouseImportProduct(tx, expiredClaims, first.id, actor))).totals.replayed, 3)
    assert.deepEqual(await snapshot(first.id), afterManual)
    console.log('PASS lost-response retries return original ledger balances after later manual writes and after preview expiry')

    const staleManual = await preview([row(first)])
    const manualState = await state(first.id)
    await transaction(tx => warehouse.applyStockOperation(tx, warehouse.parseStockOperation({ ...manual, inventoryVersion: manualState.inventoryVersion, requestKey: 'isolated-manual-second' }), actor))
    await rejectedUnchanged(staleManual, first.id, error => error.code === 'PRODUCT_INVENTORY_CHANGED')
    const staleCheckout = await preview([row(first), row(first, '3', { rowNumber: 3, size: '39', color: 'کرم' })])
    const reservedItem = { productId: first.id, variantId: first.id + '-black', size: 38, color: 'مشکی', quantity: 1 }
    await transaction(tx => inventory.reserveInventory(tx, [reservedItem]))
    await rejectedUnchanged(staleCheckout, first.id, error => error.code === 'PRODUCT_INVENTORY_CHANGED')
    await transaction(tx => inventory.releaseInventory(tx, [reservedItem]))
    await rejectedUnchanged(staleCheckout, first.id, error => error.code === 'PRODUCT_INVENTORY_CHANGED')
    console.log('PASS manual writes and checkout reservation/release revisions reject every row of an old product preview, even after balances are restored')

    const adjustment = await preview([row(first, '0'), row(first, '2', { rowNumber: 3, size: '39', color: 'کرم' })], 'ADJUSTMENT')
    const beforeAdjustment = await snapshot(first.id)
    const adjusted = await confirm(adjustment, first.id)
    assert.equal(adjusted.totals.success, 2)
    const afterAdjustment = await state(first.id)
    assert.equal(selected(afterAdjustment).stock, 0)
    assert.equal(selected(afterAdjustment, 'cream').stock, 2)
    assert.equal(afterAdjustment.stock, 2)
    assert.equal(selected(afterAdjustment).damagedStock, 2)
    assert.equal(selected(afterAdjustment, 'retired').stock, 9)
    assert.deepEqual((await snapshot(first.id)).orders, beforeAdjustment.orders)
    console.log('PASS counted available-stock adjustment accepts zero without consuming reservations or changing damaged/retired stock')

    const rollbackProduct = await product()
    const rollback = await preview([row(rollbackProduct), row(rollbackProduct, '3', { rowNumber: 3, size: '39', color: 'کرم' })])
    const rollbackBefore = await snapshot(rollbackProduct.id)
    const forced = new Error('forced isolated import ledger failure')
    await assert.rejects(transaction(tx => importer.confirmWarehouseImportProduct(new Proxy(tx, { get(client, key) {
      if (key === 'stockMovement') return new Proxy(client.stockMovement, { get(model, action) { return action === 'createMany' ? async () => { throw forced } : model[action] } })
      return client[key]
    } }), claims(rollback), rollbackProduct.id, actor)), error => error === forced)
    assert.deepEqual(await snapshot(rollbackProduct.id), rollbackBefore)
    assert.equal((await confirm(rollback, rollbackProduct.id)).totals.success, 2)
    console.log('PASS bulk ledger failure rolls back every variant, parent aggregate and revision, allowing a clean retry')

    // Configuring up to 500 active combinations never deletes historical rows;
    // the lifetime total can legitimately exceed the per-import group limit.
    const historical = await product()
    await isolated.productVariant.createMany({ data: Array.from({ length: 500 }, (_, index) => ({
      id: historical.id + '-history-' + index, productId: historical.id, size: 1000 + index,
      color: 'بازنشسته ' + index, stock: 1, damagedStock: 2, isActive: false,
    })) })
    assert.equal(await isolated.productVariant.count({ where: { productId: historical.id } }), 503)
    const historicalImport = await preview([
      row(historical), row(historical, '3', { rowNumber: 3, size: '1000', color: 'بازنشسته ۰' }),
    ])
    assert.equal(historicalImport.summary.valid, 2)
    assert.equal((await confirm(historicalImport, historical.id)).totals.success, 2)
    const historicalAfter = await state(historical.id)
    assert.equal(historicalAfter.stock, 12)
    const old = historicalAfter.variants.find(value => value.id === historical.id + '-history-0')
    assert.equal(old.stock, 4)
    assert.equal(old.damagedStock, 2)
    assert.equal(old.isActive, false)
    console.log('PASS a product with more than 500 historical variants imports requested active and retired rows while preserving aggregate availability')

    const overflowProduct = await product({ stock: 2147483646, variants: { create: [
      { id: 'overflow-black', size: 38, color: 'مشکی', stock: 2147483645 },
      { id: 'overflow-cream', size: 39, color: 'کرم', stock: 1 },
    ] } })
    const overflowBefore = await snapshot(overflowProduct.id)
    const overflow = await preview([row(overflowProduct, '1'), row(overflowProduct, '1', { rowNumber: 3, size: '39', color: 'کرم' })])
    assert.equal(overflow.summary.valid, 0)
    assert.ok(overflow.rows.every(value => value.error))
    assert.deepEqual(await snapshot(overflowProduct.id), overflowBefore)
    const ceiling = await preview([row(overflowProduct, '1')])
    assert.equal((await confirm(ceiling, overflowProduct.id)).totals.success, 1)
    assert.equal((await state(overflowProduct.id)).stock, 2147483647)
    const beyond = await preview([row(overflowProduct, '1')])
    assert.equal(beyond.summary.valid, 0)
    console.log('PASS aggregate and variant integer ceilings reject unsafe groups before writes and accept the exact maximum')

    const independent = await product()
    const combined = await preview([row(rollbackProduct), row(independent, '2', { rowNumber: 3 })])
    const staleVersion = await state(rollbackProduct.id)
    await transaction(tx => warehouse.updateLowStockThreshold(tx, { productId: rollbackProduct.id, variantId: rollbackProduct.id + '-black', inventoryVersion: staleVersion.inventoryVersion, lowStockThreshold: 5 }))
    const endpoint = load('src/app/api/admin/inventory/import/confirm/route.ts')
    const send = productId => endpoint.POST(new Request('http://localhost:3000/api/admin/inventory/import/confirm', {
      method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: combined.token, productId }),
    }))
    const staleBefore = await snapshot(rollbackProduct.id)
    const rejected = await send(rollbackProduct.id)
    assert.equal(rejected.status, 200)
    assert.equal((await rejected.json()).totals.error, 1)
    assert.deepEqual(await snapshot(rollbackProduct.id), staleBefore)
    const saved = await send(independent.id)
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).totals.success, 1)
    assert.equal(selected(await state(independent.id)).stock, 6)
    console.log('PASS real confirmation endpoint reports an entire stale product as failed while another product from the same preview saves independently')

    // Exercise an actual installed check in the cloned schema, then ensure the
    // rejected SQL leaves the fixture intact. No public foreign keys are copied.
    await assert.rejects(isolated.productVariant.update({ where: { id: first.id + '-black' }, data: { stock: -1 } }))
    await assert.rejects(isolated.productVariant.update({ where: { id: first.id + '-black' }, data: { damagedStock: -1 } }))
    await state(first.id)
    console.log('PASS cloned PostgreSQL checks reject negative available and damaged quantities')
  } finally {
    await isolated.$disconnect()
    if (created) {
      assertScope()
      await source.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
      assert.equal((await source.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).length, 0)
      console.log('PASS exact isolated schema removed; public catalog, orders, inventory and history untouched')
    }
  }
}
main().catch(error => { console.error(error.name, error.code || '', error.message); process.exitCode = 1 }).finally(() => source.$disconnect())
