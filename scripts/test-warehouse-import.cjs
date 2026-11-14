const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const ExcelJS = require('exceljs')

function load(file, dependencies = {}, clock = Date) {
  const cache = new Map()
  function read(relative) {
    const absolute = path.resolve(__dirname, '..', relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const result = { exports: {} }
    vm.runInNewContext(transformSync(fs.readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false } }).code, {
      module: result, Date: clock, Error, URL, URLSearchParams, Response, Request, FormData, File, Buffer, console, Uint8Array,
      process: { env: { AUTH_SECRET: 'warehouse-import-unit-test-secret-12345' } },
      require(name) {
        if (name in dependencies) return dependencies[name]
        if (name === '@/lib/payments') return { nextOrderVersion: value => value }
        if (name === 'next/server') return { NextResponse: Response }
        if (name.startsWith('node:') || name === 'exceljs' || name === '@prisma/client') return require(name)
        if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
        if (name.startsWith('./')) return read(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), name + '.ts')))
        throw new Error('Unexpected dependency ' + name)
      },
    })
    cache.set(absolute, result.exports)
    return result.exports
  }
  return read(file)
}
const importer = load('src/lib/warehouse-import.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const actor = { id: 'admin', name: 'مدیر آزمایشی' }
const source = { rowNumber: 2, code: 'PN-۰۰۱۲۳', size: '۳۸', color: 'مشكي', quantity: '٢' }
const input = (rows = [source], mode = 'RECEIPT') => ({ rows, mode, note: 'ورود محمولهٔ آزمایشی' })
function fixture(extra = {}) {
  return { id: 'shoe', code: 'PN-00123', name: 'کفش', inventoryVersion: 4, inventoryConfigured: true, stock: 8, variants: [
    { id: 'black-38', productId: 'shoe', size: 38, color: 'مشکی', stock: 3, damagedStock: 2, isActive: true },
    { id: 'white-38', productId: 'shoe', size: 38, color: 'سفید', stock: 5, damagedStock: 1, isActive: true },
    { id: 'black-39', productId: 'shoe', size: 39, color: 'مشکی', stock: 6, damagedStock: 4, isActive: false },
  ], ...extra }
}
function database(products = [fixture()]) {
  const movements = [], reservations = [{ productId: 'shoe', size: 38, color: 'مشکی', _sum: { quantity: 7 } }]
  let writes = 0, locks = 0
  const db = {
    products, movements, reservations,
    get writes() { return writes }, get locks() { return locks },
    product: {
      findMany: async ({ where }) => products.filter(product => where.code.in.some(code => code.toUpperCase() === product.code.toUpperCase())),
      findUnique: async ({ where }) => products.find(product => product.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        writes++
        const product = products.find(product => product.id === where.id && product.inventoryVersion === where.inventoryVersion)
        if (!product) return { count: 0 }
        product.stock = data.stock; product.inventoryVersion += data.inventoryVersion.increment
        return { count: 1 }
      },
    },
    productVariant: {
      findMany: async ({ where, take }) => products.flatMap(product => product.variants).filter(variant => where.OR.some(pair => pair.productId === variant.productId && pair.size === variant.size)).slice(0, take),
      groupBy: async () => products.map(product => ({ productId: product.id, _sum: { stock: product.variants.filter(variant => variant.isActive).reduce((sum, variant) => sum + variant.stock, 0) } })),
      aggregate: async ({ where }) => ({ _sum: { stock: products.filter(product => product.id === where.productId).flatMap(product => product.variants).filter(variant => variant.isActive).reduce((sum, variant) => sum + variant.stock, 0) } }),
    },
    orderItem: { groupBy: async ({ where }) => {
      assert.deepEqual(plain(where.order.status.in), ['PENDING', 'PROCESSING'])
      return reservations
    } },
    stockMovement: {
      findMany: async ({ where }) => movements.filter(movement => where.requestKey.in.includes(movement.requestKey)),
      createMany: async ({ data }) => { writes++; movements.push(...plain(data)); return { count: data.length } },
    },
    $queryRaw: async (_strings, productId) => { locks++; return products.some(product => product.id === productId) ? [{ id: productId }] : [] },
    $executeRaw: async sql => {
      writes++
      const values = sql.values, productId = values.at(-1), product = products.find(product => product.id === productId)
      let count = 0
      for (let i = 0; i < values.length - 1; i += 3) {
        const variant = product.variants.find(variant => variant.id === values[i] && variant.stock === values[i + 1])
        if (variant) { variant.stock = values[i + 2]; count++ }
      }
      return count
    },
  }
  return db
}
const preview = (db = database(), rows = [source], mode = 'RECEIPT') => importer.previewWarehouseImport(db, input(rows, mode), actor.id)
const claims = result => importer.verifyWarehouseImportPreview(result.token, actor.id)

test('Localized code/size/quantity and normalized exact colors retain leading zeroes; preview never writes', async () => {
  const db = database(), result = await preview(db)
  assert.equal(db.writes, 0)
  assert.equal(db.locks, 0)
  assert.deepEqual(plain(result.summary), { total: 1, valid: 1, invalid: 0, products: 1 })
  assert.equal(result.rows[0].code, 'PN-00123')
  assert.equal(result.rows[0].size, 38)
  assert.equal(result.rows[0].stockBefore, 3)
  assert.equal(result.rows[0].stockAfter, 5)
  assert.equal(result.rows[0].reserved, 7)
  assert.equal(result.rows[0].damaged, 2)
  assert.equal(result.rows[0].isActive, true)
})

test('Count adjustment accepts zero available units and does not subtract reservations', async () => {
  const db = database(), result = await preview(db, [{ ...source, quantity: '۰' }], 'ADJUSTMENT')
  assert.equal(result.rows[0].stockAfter, 0)
  assert.equal(result.rows[0].reserved, 7)
  await importer.confirmWarehouseImportProduct(db, claims(result), 'shoe', actor)
  assert.equal(db.products[0].variants[0].stock, 0)
  assert.equal(db.products[0].stock, 5)
  assert.equal(db.reservations[0]._sum.quantity, 7)
  assert.equal(db.products[0].variants[0].damagedStock, 2)
})

test('All duplicate variant rows are invalid, including the first and a malformed-quantity occurrence', async () => {
  const result = await preview(database(), [source, { ...source, rowNumber: 7, color: 'مشکی', quantity: '-1' }])
  assert.equal(result.summary.valid, 0)
  assert.equal(result.products.length, 0)
  assert.equal(claims(result).rows.length, 0)
  for (const row of result.rows) assert.match(row.error, /تکرار/)
})

test('Ambiguous normalized colors, missing variants/products and unconfigured stock produce row errors', async () => {
  const product = fixture()
  product.variants.push({ ...product.variants[0], id: 'alias', color: 'مشكي', stock: 0 })
  assert.match((await preview(database([product]))).rows[0].error, /چند رنگ/)
  for (const row of [{ ...source, color: 'ناموجود' }, { ...source, size: '۹۹' }, { ...source, code: 'missing' }]) assert.ok((await preview(database(), [row])).rows[0].error)
  assert.match((await preview(database([fixture({ inventoryConfigured: false })]))).rows[0].error, /ابتدا/)
})

test('Inactive inventory is warning-only, remains inactive and cannot raise sellable parent stock', async () => {
  const db = database(), result = await preview(db, [{ ...source, size: '39' }])
  assert.equal(result.summary.valid, 1)
  assert.match(result.rows[0].warning, /غیرفعال/)
  await importer.confirmWarehouseImportProduct(db, claims(result), 'shoe', actor)
  assert.equal(db.products[0].stock, 8)
  assert.equal(db.products[0].variants[2].stock, 8)
  assert.equal(db.products[0].variants[2].isActive, false)
})

test('Input bounds reject malformed batches and preserve per-row numeric errors', async () => {
  for (const body of [{}, input([]), { ...input(), mode: 'DAMAGE' }, { ...input(), note: '' }, { ...input(), note: 'x'.repeat(501) }, { ...input(), extra: true }, input([source, source]), input([{ ...source, rowNumber: 1021 }]), input(Array.from({ length: 1001 }, (_, i) => ({ ...source, rowNumber: i + 1 })))]) assert.throws(() => importer.parseWarehouseImportPreviewInput(body), { status: 400 })
  for (const quantity of ['0', '-1', '1.5', '2e3', '2147483648', '۱٬۰۰۰', '', true, 2]) {
    const result = await preview(database(), [{ ...source, quantity }])
    assert.ok(result.rows[0].error, String(quantity))
    assert.equal(result.summary.valid, 0)
  }
  assert.ok((await preview(database(), [{ ...source, sourceError: 'فرمول مجاز نیست' }])).rows[0].error)
})

test('Group preflight rejects parent inconsistency, variant/product overflow and revision exhaustion', async () => {
  assert.match((await preview(database([fixture({ stock: 7 })]))).rows[0].error, /هماهنگ/)
  assert.ok((await preview(database([fixture({ inventoryVersion: 2147483647 })]))).rows[0].error)
  assert.ok((await preview(database(), [{ ...source, quantity: '2147483647' }])).rows[0].error)
  const product = fixture({ stock: 2147483647 })
  product.variants[1].stock = 2147483644
  assert.match((await preview(database([product]))).rows[0].error, /مجموع/)
})

test('Preview bounds the global candidate query rather than loading every product variant', async () => {
  const db = database()
  db.productVariant.findMany = async ({ take, where }) => {
    assert.equal(take, 5001)
    assert.deepEqual(plain(where), { OR: [{ productId: 'shoe', size: 38 }] })
    return Array.from({ length: 5001 }, () => fixture().variants[0])
  }
  await assert.rejects(preview(db), { status: 413 })
  assert.equal(db.writes, 0)
})

test('One product with several rows applies once atomically with a single revision and stable ledger retry', async () => {
  const db = database(), result = await preview(db, [source, { ...source, rowNumber: 3, color: 'سفید', quantity: '4' }])
  const signed = claims(result)
  const first = await importer.confirmWarehouseImportProduct(db, signed, 'shoe', actor)
  assert.deepEqual(plain(first.totals), { success: 2, replayed: 0, error: 0 })
  assert.equal(db.products[0].stock, 14)
  assert.equal(db.products[0].inventoryVersion, 5)
  assert.equal(db.movements.length, 2)
  assert.equal(db.movements[0].actorName, actor.name)
  const beforeRetry = plain({ products: db.products, movements: db.movements }), writes = db.writes
  db.products[0].inventoryVersion++ // unrelated later write must not obstruct replay
  const retry = await importer.confirmWarehouseImportProduct(db, signed, 'shoe', actor)
  assert.deepEqual(plain(retry.totals), { success: 0, replayed: 2, error: 0 })
  assert.equal(db.writes, writes)
  assert.deepEqual(plain(db.movements), beforeRetry.movements)
})

test('Stale inventory, changed variant and partial/conflicting ledger cannot apply a group', async () => {
  for (const alter of [db => db.products[0].inventoryVersion++, db => db.products[0].variants[0].damagedStock++]) {
    const db = database(), result = await preview(db)
    alter(db)
    await assert.rejects(importer.confirmWarehouseImportProduct(db, claims(result), 'shoe', actor), { code: 'PRODUCT_INVENTORY_CHANGED' })
    assert.equal(db.writes, 0)
  }
  const db = database(), result = await preview(db, [source, { ...source, rowNumber: 3, color: 'سفید' }]), signed = claims(result)
  db.movements.push({ requestKey: `bulk:admin:${signed.batchId}:2`, fingerprint: 'bad' })
  await assert.rejects(importer.confirmWarehouseImportProduct(db, signed, 'shoe', actor), { code: 'WAREHOUSE_IMPORT_PARTIAL' })
  assert.equal(db.writes, 0)
})

test('Signed values reject actor/token tampering, stale unsigned choices and excessive token size', async () => {
  const result = await preview(), signed = claims(result)
  assert.throws(() => importer.verifyWarehouseImportPreview(result.token, 'other'), { status: 400 })
  assert.throws(() => importer.verifyWarehouseImportPreview(result.token.slice(0, -2) + 'ab', actor.id), { status: 400 })
  assert.throws(() => importer.verifyWarehouseImportPreview('a'.repeat(900001), actor.id), { status: 400 })
  for (const value of [null, {}, '', 'missing-product']) assert.throws(() => importer.warehouseImportProduct(signed, value), { status: 400 })
  await assert.rejects(importer.confirmWarehouseImportProduct(database(), signed, 'shoe', { id: 'other' }), { status: 403 })
  const future = load('src/lib/warehouse-import.ts', {}, class extends Date { static now() { return Date.now() + 11 * 60000 } })
  assert.throws(() => future.verifyWarehouseImportPreview(result.token, actor.id), { status: 409 })
  assert.equal(future.verifyWarehouseImportPreview(result.token, actor.id, { allowExpired: true }).batchId, signed.batchId)
})

test('Expired pending groups deterministically reject, while complete committed groups replay after expiry', async () => {
  const db = database(), result = await preview(db), signed = claims(result)
  signed.expiresAt = Date.now() - 1
  await assert.rejects(importer.confirmWarehouseImportProduct(db, signed, 'shoe', actor), { status: 409 })
  assert.equal(db.writes, 0)
  signed.expiresAt = Date.now() + 60000
  await importer.confirmWarehouseImportProduct(db, signed, 'shoe', actor)
  signed.expiresAt = Date.now() - 1
  assert.equal((await importer.confirmWarehouseImportProduct(db, signed, 'shoe', actor)).totals.replayed, 1)
})

test('JSON reader enforces streamed limits without trusting content-length', async () => {
  await assert.rejects(importer.readWarehouseImportJson(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ data: 'x'.repeat(40) }) }), 20), { status: 413 })
  await assert.rejects(importer.readWarehouseImportJson(new Request('http://localhost', { method: 'POST', body: '[]' }), 20), { status: 400 })
  assert.deepEqual(plain(await importer.readWarehouseImportJson(new Request('http://localhost', { method: 'POST', body: '{"mode":"RECEIPT"}' }), 100)), { mode: 'RECEIPT' })
})

test('XLSX parser retains coordinates, numeric provenance, text zeros and cell errors without executing formulas', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('انبار')
  sheet.addRow(['کد محصول', 'سایز', 'رنگ', 'تعداد'])
  sheet.getRow(4).values = ['PN-00123', 38, 'مشکی', 2]
  sheet.getRow(6).values = [123, 39, 'مشکی', { formula: '1+1', result: 2 }]
  sheet.getRow(7).values = ['00123', 38, 'مشکی', 1234567890123456]
  const parsed = await importer.parseWarehouseImportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()))
  assert.deepEqual(plain(parsed[0].rows.map(row => row.rowNumber)), [1, 4, 6, 7])
  assert.equal(parsed[0].rows[1].cells[0].text, 'PN-00123')
  assert.equal(parsed[0].rows[1].cells[1].numeric, true)
  assert.equal(parsed[0].rows[2].cells[0].numeric, true)
  assert.match(parsed[0].rows[2].cells[3].error, /فرمول/)
  assert.equal(parsed[0].rows[3].cells[0].text, '00123')
  assert.ok(parsed[0].rows[3].cells[3].error)
  await assert.rejects(importer.parseWarehouseImportWorkbook(Buffer.from('not an xlsx')), { status: 400 })
})

test('Compact ZIPs whose worksheet JSON would exceed the host response budget reject before response', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('large')
  for (let row = 0; row < 500; row++) sheet.addRow(Array.from({ length: 24 }, () => 'x'.repeat(250)))
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  assert.ok(buffer.length < 4 * 1024 * 1024)
  await assert.rejects(importer.parseWarehouseImportWorkbook(buffer), { status: 413 })
})

test('Routes enforce authenticated admin, same origin and exact signed-only confirmation inputs', async () => {
  for (const route of ['workbook', 'preview', 'confirm']) {
    const file = `src/app/api/admin/inventory/import/${route}/route.ts`
    for (const [session, origin, status] of [[null, true, 401], [{ user: { id: 'u', role: 'CUSTOMER' } }, true, 403], [{ user: { id: 'a', role: 'ADMIN' } }, false, 403]]) {
      const api = load(file, { '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma: {} }, '@/lib/request-origin': { isSameOriginRequest: () => origin } })
      assert.equal((await api.POST(new Request('http://localhost', { method: 'POST', body: '{}' }))).status, status)
    }
  }
  const api = load('src/app/api/admin/inventory/import/confirm/route.ts', {
    '@/lib/auth': { auth: async () => ({ user: { id: actor.id, role: 'ADMIN' } }) },
    '@/lib/prisma': { prisma: { $transaction: () => { throw new Error('Unsigned input reached DB') } } }, '@/lib/request-origin': { isSameOriginRequest: () => true },
  })
  assert.equal((await api.POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ token: (await preview()).token, productId: 'shoe', quantity: 999 }) }))).status, 400)
})

test('Confirm returns complete known rollback results but keeps unknown commit failures distinguishable', async () => {
  class KnownRejection extends Error { status = 409 }
  const failure = { productId: 'shoe', results: [{ rowNumber: 2, productId: 'shoe', variantId: 'black-38', status: 'error', error: 'stale' }], totals: { success: 0, replayed: 0, error: 1 } }
  for (const [error, expected] of [[new KnownRejection('stale'), 200], [new Error('connection lost while committing'), 500]]) {
    const api = load('src/app/api/admin/inventory/import/confirm/route.ts', {
      '@/lib/auth': { auth: async () => ({ user: { id: actor.id, role: 'ADMIN' } }) },
      '@/lib/prisma': { prisma: { $transaction: work => work({}) } }, '@/lib/request-origin': { isSameOriginRequest: () => true },
      '@/lib/inventory': { InventoryError: KnownRejection },
      '@/lib/warehouse-import': { MAX_WAREHOUSE_IMPORT_CONFIRM_BYTES: 950000, readWarehouseImportJson: request => request.json(), verifyWarehouseImportPreview: () => ({}), warehouseImportProduct: () => [{}], confirmWarehouseImportProduct: async () => { throw error }, warehouseImportFailure: () => failure },
    })
    const response = await api.POST(new Request('http://localhost', { method: 'POST', body: '{"token":"signed","productId":"shoe"}' }))
    assert.equal(response.status, expected)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    if (expected === 200) assert.deepEqual(await response.json(), failure)
  }
})
