// Local-only PostgreSQL integration checks. Every exact randomized fixture is removed in finally.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.hostname !== '192.168.1.104' || target.pathname !== '/shoes_shop') {
  throw new Error('Warehouse integration checks require the local development shoes_shop database')
}
const cache = new Map()
function load(relative) {
  if (cache.has(relative)) return cache.get(relative)
  const result = { exports: {} }
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code, {
    module: result, Date, URL, URLSearchParams, Buffer, console,
    require(name) {
      if (name === 'next/server') return { NextResponse: Response }
      if (name.startsWith('node:')) return require(name)
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      throw new Error('Unexpected dependency ' + name)
    },
  })
  cache.set(relative, result.exports)
  return result.exports
}

const warehouse = load('src/lib/warehouse.ts')
const inventory = load('src/lib/inventory.ts')
const prisma = new PrismaClient()
const prefix = 'TEST_WAREHOUSE_' + randomBytes(6).toString('hex')
const categoryId = prefix + '_CATEGORY', userId = prefix + '_USER'
const productIds = [prefix + '_SHOE', prefix + '_OVERFLOW', prefix + '_LEGACY']
const orderIds = [prefix + '_DELIVERED', prefix + '_SHIPPED', prefix + '_PENDING', prefix + '_RETIRED', prefix + '_LEGACY_LINES']
const actor = { id: userId, name: 'آزمایش انبارداری' }
const dimensions = { sizes: [38, 39], colors: ['مشکی', 'کرم'] }
const rows = [
  { size: 38, color: 'مشکی', stock: 4 }, { size: 38, color: 'کرم', stock: 8 },
  { size: 39, color: 'مشکی', stock: 0 }, { size: 39, color: 'کرم', stock: 2 },
]
const transaction = callback => prisma.$transaction(callback, { isolationLevel: 'ReadCommitted', maxWait: 10000, timeout: 20000 })
let operationNumber = 0
const requestKey = () => prefix + '_REQUEST_' + (++operationNumber)
const storedKey = input => 'manual:' + actor.id + ':' + input.requestKey

async function state(id = productIds[0]) {
  const product = await prisma.product.findUniqueOrThrow({ where: { id }, include: { variants: { orderBy: { id: 'asc' } } } })
  if (product.inventoryConfigured) assert.equal(product.stock, product.variants.filter(row => row.isActive).reduce((sum, row) => sum + row.stock, 0), 'Parent stock must equal the sum of active available inventory')
  return product
}
const chosen = product => product.variants.find(row => row.size === 38 && row.color === 'مشکی')
async function body(type, quantity, extra = {}) {
  const product = await state(extra.productId || productIds[0])
  return {
    productId: product.id, variantId: chosen(product).id, type, quantity,
    inventoryVersion: product.inventoryVersion, note: 'آزمایش کنترل گردش موجودی', requestKey: requestKey(), ...extra,
  }
}
const submit = input => transaction(client => warehouse.applyStockOperation(client, warehouse.parseStockOperation(input), actor))
async function unchangedAfterRejected(input, predicate = error => error.status >= 400 && error.status < 500) {
  const before = await state(input.productId)
  const beforeCount = await prisma.stockMovement.count({ where: { productId: input.productId } })
  await assert.rejects(submit(input), predicate)
  assert.deepEqual(await state(input.productId), before)
  assert.equal(await prisma.stockMovement.count({ where: { productId: input.productId } }), beforeCount)
}

async function main() {
  try {
    await prisma.category.create({ data: { id: categoryId, name: prefix, slug: prefix.toLowerCase() } })
    await prisma.user.create({ data: { id: userId, email: prefix.toLowerCase() + '@warehouse-test.invalid', name: actor.name, role: 'ADMIN', password: '$disabled$temporary-test-account' } })
    await prisma.product.createMany({ data: productIds.map((id, index) => ({ id, name: 'آزمایش داخلی انبارداری ' + prefix, slug: id.toLowerCase(), description: 'موقت و بدون امکان خرید عمومی', price: 100, categoryId, stock: index === 2 ? 7 : 0, ...dimensions })) })
    await transaction(client => inventory.configureInventory(client, productIds[0], rows, 0, dimensions, { actorId: actor.id, actorName: actor.name }))
    await transaction(client => inventory.configureInventory(client, productIds[1], rows.map((row, index) => ({ ...row, stock: index === 0 ? 2147483646 : 0 })), 0, dimensions, { actorId: actor.id, actorName: actor.name }))
    const variant = chosen(await state())
    for (let index = 0; index < orderIds.length; index++) {
      await prisma.order.create({ data: {
        id: orderIds[index], userId, total: 600, address: 'آزمایش داخلی — بدون ارسال', phone: '00000000000',
        status: ['DELIVERED', 'SHIPPED', 'PENDING', 'DELIVERED', 'DELIVERED'][index], paymentStatus: 'PAID',
        items: { create: index === 4 ? [2, 3].map(quantity => ({ productId: productIds[0], variantId: null, productName: 'قدیمی', size: 38, color: 'مشکی', price: 100, quantity })) : [{ productId: productIds[0], variantId: variant.id, productName: 'آزمایش', size: 38, color: 'مشکی', price: 100, quantity: index === 0 ? 3 : 2 }] },
      } })
    }

    const overviewBefore = await transaction(client => warehouse.readWarehouseOverview(client, new URLSearchParams({ q: prefix })))
    assert.equal(overviewBefore.pagination.total, 3)
    assert.equal(overviewBefore.products.length, 3)
    const warehouseProduct = overviewBefore.products.find(product => product.id === productIds[0])
    assert.equal(chosen(warehouseProduct).reserved, 2)
    assert.equal(warehouseProduct.variants.find(row => row.size === 38 && row.color === 'کرم').reserved, 0)
    assert.ok(overviewBefore.summary.unallocated >= 7)
    const unconfigured = await transaction(client => warehouse.readWarehouseOverview(client, new URLSearchParams({ q: prefix, filter: 'unconfigured' })))
    assert.deepEqual(unconfigured.products.map(product => product.id), [productIds[2]])
    console.log('PASS warehouse reports live pending reservations per exact combination and keeps legacy totals unallocated')

    const receipt = await body('RECEIPT', 5)
    await submit(receipt)
    let current = await state()
    assert.equal(chosen(current).stock, 9)
    assert.equal(chosen(current).damagedStock, 0)
    assert.equal(current.stock, 19)
    const originalReceipt = await prisma.stockMovement.findUniqueOrThrow({ where: { requestKey: storedKey(receipt) } })
    assert.equal(originalReceipt.actorName, actor.name)
    assert.equal(originalReceipt.quantity, 5)
    assert.equal(originalReceipt.stockBefore, 4)
    assert.equal(originalReceipt.stockAfter, 9)
    const overviewAfterReceipt = await transaction(client => warehouse.readWarehouseOverview(client, new URLSearchParams({ q: prefix })))
    assert.equal(overviewAfterReceipt.summary.available, overviewBefore.summary.available + 5)
    console.log('PASS incoming units enter exactly the selected color/size and preserve an actor snapshot')

    await submit(await body('DAMAGE', 3))
    current = await state(); assert.equal(chosen(current).stock, 6); assert.equal(chosen(current).damagedStock, 3)
    await submit(await body('REPAIR', 1))
    current = await state(); assert.equal(chosen(current).stock, 7); assert.equal(chosen(current).damagedStock, 2)
    await submit(await body('DISPOSAL', 1))
    current = await state(); assert.equal(chosen(current).stock, 7); assert.equal(chosen(current).damagedStock, 1)
    await submit(await body('ADJUSTMENT', 2))
    current = await state(); assert.equal(chosen(current).stock, 2); assert.equal(chosen(current).damagedStock, 1)
    const damagedOverview = await transaction(client => warehouse.readWarehouseOverview(client, new URLSearchParams({ q: prefix, filter: 'damaged' })))
    assert.deepEqual(damagedOverview.products.map(product => product.id), [productIds[0]])
    assert.equal(damagedOverview.summary.damaged, overviewBefore.summary.damaged + 1)
    const lowOverview = await transaction(client => warehouse.readWarehouseOverview(client, new URLSearchParams({ q: prefix, filter: 'low' })))
    assert.ok(lowOverview.products.some(product => product.id === productIds[0]))
    console.log('PASS damage, repair, disposal and counted available-stock adjustments reconcile distinct buckets')

    for (const [type, quantity] of [['DAMAGE', 3], ['REPAIR', 2], ['DISPOSAL', 2]]) await unchangedAfterRejected(await body(type, quantity))
    console.log('PASS insufficient available or damaged quantities cannot create stock or a ledger entry')

    const beforeRetry = await state()
    assert.equal((await submit(receipt)).replayed, true)
    assert.deepEqual(await state(), beforeRetry)
    assert.equal(await prisma.stockMovement.count({ where: { requestKey: storedKey(receipt) } }), 1)
    await unchangedAfterRejected({ ...receipt, quantity: 6 }, error => error.status === 409)
    console.log('PASS retried identical requests return the original result despite stale versions; altered reuse is rejected')

    const concurrentReceipt = await body('RECEIPT', 2)
    const duplicates = await Promise.allSettled([submit(concurrentReceipt), submit(concurrentReceipt)])
    assert.ok(duplicates.every(result => result.status === 'fulfilled'))
    assert.equal(chosen(await state()).stock, 4)
    assert.equal(await prisma.stockMovement.count({ where: { requestKey: storedKey(concurrentReceipt) } }), 1)
    console.log('PASS concurrent duplicate submissions enter inventory and ledger only once')

    const rollbackInput = await body('RECEIPT', 2), beforeRollback = await state()
    const forced = new Error('forced warehouse transaction rollback')
    await assert.rejects(transaction(async client => { await warehouse.applyStockOperation(client, warehouse.parseStockOperation(rollbackInput), actor); throw forced }), error => error === forced)
    assert.deepEqual(await state(), beforeRollback)
    assert.equal(await prisma.stockMovement.count({ where: { requestKey: storedKey(rollbackInput) } }), 0)
    console.log('PASS inventory, parent aggregate, version and ledger all roll back as one transaction')

    const rejectedLedgerInput = await body('RECEIPT', 1), beforeLedgerFailure = await state()
    await assert.rejects(transaction(client => warehouse.applyStockOperation(new Proxy(client, { get(target, key) {
      if (key === 'stockMovement') return new Proxy(target.stockMovement, { get(model, action) { return action === 'create' ? async () => { throw forced } : model[action] } })
      return target[key]
    } }), warehouse.parseStockOperation(rejectedLedgerInput), actor)), error => error === forced)
    assert.deepEqual(await state(), beforeLedgerFailure)
    assert.equal(await prisma.stockMovement.count({ where: { requestKey: storedKey(rejectedLedgerInput) } }), 0)
    console.log('PASS failure to append an audit record rolls back the inventory write itself')

    const staleAdjustment = await body('ADJUSTMENT', 100)
    await transaction(client => inventory.reserveInventory(client, [{ productId: productIds[0], size: 38, color: 'مشکی', quantity: 1, variantId: variant.id }]))
    await unchangedAfterRejected(staleAdjustment, error => error.status === 409)
    assert.equal(chosen(await state()).stock, 3)
    await transaction(client => inventory.releaseInventory(client, [{ productId: productIds[0], size: 38, color: 'مشکی', quantity: 1, variantId: variant.id }]))
    console.log('PASS checkout reservations invalidate stale warehouse edits and cancellation restores the exact variant')

    const conflictingVersion = (await state()).inventoryVersion
    const distinctAttempts = await Promise.allSettled([
      submit(await body('RECEIPT', 1, { inventoryVersion: conflictingVersion })),
      submit(await body('ADJUSTMENT', 8, { inventoryVersion: conflictingVersion })),
    ])
    assert.equal(distinctAttempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(distinctAttempts.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1)
    console.log('PASS concurrent distinct warehouse edits cannot silently overwrite each other')

    const thresholdProduct = await state(), thresholdCount = await prisma.stockMovement.count({ where: { productId: productIds[0] } })
    await transaction(client => warehouse.updateLowStockThreshold(client, { productId: productIds[0], variantId: variant.id, inventoryVersion: thresholdProduct.inventoryVersion, lowStockThreshold: 0 }))
    const thresholdChanged = await state()
    assert.equal(chosen(thresholdChanged).lowStockThreshold, 0)
    assert.equal(chosen(thresholdChanged).stock, chosen(thresholdProduct).stock)
    assert.equal(thresholdChanged.inventoryVersion, thresholdProduct.inventoryVersion + 1)
    assert.equal(await prisma.stockMovement.count({ where: { productId: productIds[0] } }), thresholdCount)
    await assert.rejects(transaction(client => warehouse.updateLowStockThreshold(client, { productId: productIds[0], variantId: variant.id, inventoryVersion: thresholdProduct.inventoryVersion, lowStockThreshold: 5 })), error => error.status === 409)
    assert.deepEqual(await state(), thresholdChanged)
    console.log('PASS low-stock thresholds accept zero, preserve quantities and reject concurrent stale settings')

    for (const badOrder of [orderIds[2], prefix + '_MISSING_ORDER']) await unchangedAfterRejected(await body('RETURN_SELLABLE', 1, { orderId: badOrder }))
    const otherVariant = (await state()).variants.find(row => row.size === 39 && row.color === 'کرم')
    await unchangedAfterRejected(await body('RETURN_DAMAGED', 1, { variantId: otherVariant.id, orderId: orderIds[0] }))
    console.log('PASS unshipped, nonexistent or mismatched order lines cannot be returned')

    const beforeReturn = await state()
    await submit(await body('RETURN_SELLABLE', 1, { orderId: orderIds[0] }))
    await submit(await body('RETURN_DAMAGED', 2, { orderId: orderIds[0] }))
    current = await state()
    assert.equal(chosen(current).stock, chosen(beforeReturn).stock + 1)
    assert.equal(chosen(current).damagedStock, chosen(beforeReturn).damagedStock + 2)
    await unchangedAfterRejected(await body('RETURN_SELLABLE', 1, { orderId: orderIds[0] }))
    await unchangedAfterRejected(await body('RETURN_DAMAGED', 1, { orderId: orderIds[0] }))
    console.log('PASS sellable and damaged returns share one cumulative cap equal to the actual shipped quantity')

    await submit(await body('RETURN_SELLABLE', 5, { orderId: orderIds[4] }))
    await unchangedAfterRejected(await body('RETURN_DAMAGED', 1, { orderId: orderIds[4] }))
    console.log('PASS matching legacy order lines without variant IDs share the same exact-combination return cap')

    const returnVersion = (await state()).inventoryVersion
    const parallelReturns = await Promise.allSettled([
      submit(await body('RETURN_SELLABLE', 2, { orderId: orderIds[1], inventoryVersion: returnVersion })),
      submit(await body('RETURN_DAMAGED', 2, { orderId: orderIds[1], inventoryVersion: returnVersion })),
    ])
    assert.equal(parallelReturns.filter(result => result.status === 'fulfilled').length, 1)
    await unchangedAfterRejected(await body('RETURN_SELLABLE', 1, { orderId: orderIds[1] }))
    console.log('PASS simultaneous alternative return classifications cannot exceed the shipped quantity')

    const beforeRetirement = await state()
    await transaction(client => inventory.configureInventory(client, productIds[0], beforeRetirement.variants.filter(row => row.color === 'کرم').map(row => ({ size: row.size, color: row.color, stock: row.stock })), beforeRetirement.inventoryVersion, { sizes: dimensions.sizes, colors: ['کرم'] }, { actorId: actor.id, actorName: actor.name }))
    const retired = await state(), retiredRow = chosen(retired)
    assert.equal(retiredRow.id, variant.id)
    assert.equal(retiredRow.isActive, false)
    await submit(await body('RETURN_SELLABLE', 1, { orderId: orderIds[3] }))
    current = await state()
    assert.equal(chosen(current).stock, retiredRow.stock + 1)
    assert.equal(chosen(current).isActive, false)
    assert.equal(current.stock, retired.stock)
    const retiredMovement = await prisma.stockMovement.findFirstOrThrow({ where: { productId: productIds[0], orderId: orderIds[3], type: 'RETURN_SELLABLE' } })
    assert.equal(retiredMovement.activeBefore, false)
    assert.equal(retiredMovement.activeAfter, false)
    await assert.rejects(transaction(client => inventory.reserveInventory(client, [{ productId: productIds[0], size: 38, color: 'مشکی', quantity: 1, variantId: variant.id }])), error => error.status === 409)
    console.log('PASS retired variants keep exact identity and returned units without reactivation or inflating sellable totals')

    await unchangedAfterRejected(await body('RECEIPT', 2, { productId: productIds[1] }))
    await submit(await body('RECEIPT', 1, { productId: productIds[1] }))
    assert.equal((await state(productIds[1])).stock, 2147483647)
    await unchangedAfterRejected(await body('RECEIPT', 1, { productId: productIds[1] }))
    console.log('PASS integer ceilings reject available-stock overflow without partial ledger writes')

    const history = await transaction(client => warehouse.readStockMovements(client, new URLSearchParams({ productId: productIds[0], type: 'RETURN_DAMAGED' })))
    assert.ok(history.movements.length > 0)
    assert.ok(history.movements.every(movement => movement.productId === productIds[0] && movement.type === 'RETURN_DAMAGED'))
    assert.ok(history.movements.every(movement => !('fingerprint' in movement) && !('requestKey' in movement)))
    assert.equal(history.pagination.total, await prisma.stockMovement.count({ where: { productId: productIds[0], type: 'RETURN_DAMAGED' } }))
    console.log('PASS filtered movement history reports exact totals and omits private retry fingerprints')

    await assert.rejects(prisma.productVariant.update({ where: { id: variant.id }, data: { damagedStock: -1 } }))
    await assert.rejects(prisma.productVariant.update({ where: { id: variant.id }, data: { lowStockThreshold: -1 } }))
    await assert.rejects(prisma.productVariant.delete({ where: { id: variant.id } }))
    await assert.rejects(prisma.product.delete({ where: { id: productIds[1] } }))
    console.log('PASS PostgreSQL rejects negative damaged/threshold values and preserves referenced warehouse history')
  } finally {
    await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } })
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } })
    await prisma.product.deleteMany({ where: { id: { in: productIds } } })
    await prisma.category.deleteMany({ where: { id: categoryId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    assert.equal(await prisma.product.count({ where: { id: { in: productIds } } }), 0)
    assert.equal(await prisma.stockMovement.count({ where: { productId: { in: productIds } } }), 0)
    console.log('PASS exact temporary fixtures removed; existing catalog, orders and stock history untouched')
  }
}
main().catch(error => { console.error(error.name, error.code || '', error.message); process.exitCode = 1 }).finally(() => prisma.$disconnect())
