const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const ExcelJS = require('exceljs')

function load(file, dependencies = {}) {
  const cache = new Map()
  function read(relative) {
    const absolute = path.resolve(__dirname, '..', relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const result = { exports: {} }
    vm.runInNewContext(transformSync(fs.readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022', supported: { 'dynamic-import': false } }).code, {
      module: result, Date, Error, URL, URLSearchParams, Response, Request, FormData, File, Buffer, console, Uint8Array,
      process: { env: { AUTH_SECRET: 'shipment-tests-independent-secret-123456789' } },
      require(name) {
        if (name in dependencies) return dependencies[name]
        if (name === 'next/server') return { NextResponse: Response }
        if (name.startsWith('node:') || name === 'exceljs' || name === '@prisma/client') return require(name)
        if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
        throw new Error('Unexpected dependency ' + name)
      },
    })
    cache.set(absolute, result.exports)
    return result.exports
  }
  return read(file)
}
const events = []
const deps = {
  '@/lib/inventory': { recordOrderInventoryEvent: async (_tx, items, type, context) => { events.push({ items, type, context }) }, InventoryError: class InventoryError extends Error {} },
  '@/lib/payments': { nextOrderVersion: previous => new Date(Math.max(Date.now(), previous.getTime() + 1)) },
}
const importer = load('src/lib/shipment-import.ts', deps)
const plain = value => JSON.parse(JSON.stringify(value))
const row = { rowNumber: 2, matchValue: '09123456789', trackingCode: '123456789012345678901234' }
function order(extra = {}) {
  return { id: 'order-abcdef123456', recipientName: 'گیرنده', phone: '09123456789', postalCode: '1234567890', status: 'SHIPPED', verified: true,
    trackingCode: null, trackingRecordedAt: null, updatedAt: new Date('2026-10-01'), createdAt: new Date('2026-09-01'), shippingMethodName: 'پست پیشتاز', total: 1000000,
    invoice: { id: 1 }, items: [{ productId: 'shoe', quantity: 1, size: 38, color: 'مشکی' }], user: { name: 'کاربر' }, ...extra }
}
function database(orders) {
  return { $queryRaw: async () => orders.map(item => ({ id: item.id })), order: {
    findMany: async () => orders,
    findUnique: async ({ where }) => { const item = orders.find(item => item.id === where.id); return item ? { ...item } : null },
    updateMany: async ({ where, data }) => {
      const current = orders.find(item => item.id === where.id)
      if (!current || current.status !== where.status || current.verified !== where.verified || current.trackingCode !== where.trackingCode || current.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 }
      Object.assign(current, data)
      return { count: 1 }
    },
  } }
}
async function preview(orders, rows = [row], markShipped = false, matchBy = 'phone') {
  return importer.previewShipmentImport(database(orders), { rows, markShipped, matchBy }, 'admin')
}

test('Shipment identifiers preserve long tracking strings and normalize Persian/Arabic digits', () => {
  assert.equal(importer.normalizeTrackingCode(' ۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶۷۸۹۰۱۲۳۴ '), row.trackingCode)
  assert.equal(importer.normalizeTrackingCode('ab-١٢٣٤٥٦'), 'AB123456')
  for (const value of [null, 123456789012345678, '', '=1+2', 'abc/def', '1'.repeat(41)]) assert.throws(() => importer.normalizeTrackingCode(value), { status: 400 })
})

test('Shipment phones accept country prefixes, national numeric cells and landlines', () => {
  for (const value of ['09123456789', '۹۱۲۳۴۵۶۷۸۹', '+98 912 345 6789', '00989123456789', '989123456789']) assert.equal(importer.normalizeShipmentPhone(value), '09123456789')
  assert.equal(importer.normalizeShipmentPhone('21-12345678'), '02112345678')
  assert.equal(importer.parseShipmentPreviewInput({ rows: [{ ...row, matchValue: '9123456789' }], matchBy: 'phone', markShipped: false }).rows[0].matchValue, '09123456789')
})

test('Malformed identifiers, invalid postal codes, duplicate row numbers and oversized batches are rejected', () => {
  for (const input of [{ rows: [], matchBy: 'phone', markShipped: false }, { rows: [row], matchBy: 'email', markShipped: false }, { rows: [row], matchBy: 'phone' }, { rows: [row, row], matchBy: 'phone', markShipped: false }, { rows: Array.from({ length: 1001 }, (_, index) => ({ ...row, rowNumber: index + 1 })), matchBy: 'phone', markShipped: false }]) assert.throws(() => importer.parseShipmentPreviewInput(input), { status: 400 })
  assert.match(importer.parseShipmentPreviewInput({ rows: [{ ...row, matchValue: '00000000000' }], matchBy: 'phone', markShipped: false }).rows[0].error, /تلفن/)
  assert.match(importer.parseShipmentPreviewInput({ rows: [{ ...row, matchValue: '0000000000' }], matchBy: 'postalCode', markShipped: false }).rows[0].error, /کدپستی/)
})

test('Exact duplicate lines skip later copies, while conflicting tracking assignments block both lines', () => {
  const duplicate = importer.parseShipmentPreviewInput({ rows: [row, { ...row, rowNumber: 3 }], matchBy: 'phone', markShipped: false })
  assert.equal(duplicate.rows[0].error, undefined); assert.match(duplicate.rows[1].error, /تکرار/)
  const conflict = importer.parseShipmentPreviewInput({ rows: [row, { ...row, rowNumber: 3, matchValue: '09121111111' }], matchBy: 'phone', markShipped: false })
  assert.ok(conflict.rows.every(item => item.error))
})

test('Excel cells reject rounded long numbers, formulas, dates and unsafe numeric values', () => {
  assert.deepEqual(plain(importer.shipmentCell(123456789012345)), { text: '123456789012345' })
  assert.deepEqual(plain(importer.shipmentCell(9123456789, '09123456789')), { text: '09123456789' })
  assert.equal(importer.shipmentCell('001234567890123456789012').text, '001234567890123456789012')
  for (const value of [1234567890123456, -1, 0.5, Infinity, { formula: '1+1', result: 2 }, new Date()]) assert.ok(importer.shipmentCell(value).error)
  assert.deepEqual(plain(importer.shipmentCell({ richText: [{ text: '۱۲۳' }, { text: '۴۵۶' }] })), { text: '۱۲۳۴۵۶' })
})

test('Actual xlsx workbook parses sheets and row coordinates without executing formulas', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('پست')
  sheet.addRow(['تلفن', 'کد رهگیری'])
  sheet.addRow(['09123456789', row.trackingCode])
  sheet.addRow([9123456789, { formula: '1+2', result: 3 }])
  const parsed = await importer.parseShipmentWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()))
  assert.equal(parsed[0].name, 'پست'); assert.equal(parsed[0].rows[1].rowNumber, 2)
  assert.equal(parsed[0].rows[1].cells[1].text, row.trackingCode)
  assert.ok(parsed[0].rows[2].cells[1].error)
})

test('Workbook preflight rejects invalid archives and large merged/cell ranges before ExcelJS loads them', async () => {
  for (const buffer of [Buffer.alloc(0), Buffer.from('a'), Buffer.alloc(100), Buffer.alloc(4 * 1024 * 1024 + 1)]) assert.throws(() => importer.validateShipmentZip(buffer), { status: 400 })
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('large')
  sheet.getCell('CW1').value = 'outside 100 columns'
  await assert.rejects(importer.parseShipmentWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())), { status: 400 })
})

test('Chunked JSON requests are bounded before parsing and reject nonobject payloads', async () => {
  assert.equal((await importer.readShipmentJson(new Request('http://localhost', { method: 'POST', body: '{"rows":[]}' }), 100)).rows.length, 0)
  await assert.rejects(importer.readShipmentJson(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(200) }), 100), { status: 413 })
  for (const body of ['null', '[]', 'bad']) await assert.rejects(importer.readShipmentJson(new Request('http://localhost', { method: 'POST', body }), 100), { status: 400 })
})

test('Preview matches ORDER snapshot fields, exposes all ambiguous candidates and writes nothing', async () => {
  const a = order({ phone: '۰۹۱۲۳۴۵۶۷۸۹' }), b = order({ id: 'second-order-123456', phone: '+98 912 345 6789' })
  const result = await preview([a, b])
  assert.equal(result.rows[0].candidates.length, 2)
  assert.equal(a.trackingCode, null); assert.equal(b.trackingCode, null)
  assert.equal(importer.verifyShipmentPreview(result.token, 'admin').rows.length, 1)
})

test('Only verified shipments qualify by default; processing requires explicit opt-in and an invoice', async () => {
  for (const extra of [{ verified: false }, { status: 'PENDING' }, { status: 'CANCELLED' }, { status: 'DELIVERED' }, { status: 'PROCESSING' }]) assert.ok((await preview([order(extra)])).rows[0].error)
  assert.equal((await preview([order({ status: 'PROCESSING' })], [row], true)).rows[0].candidates.length, 1)
  assert.ok((await preview([order({ status: 'PROCESSING', invoice: null })], [row], true)).rows[0].error)
})

test('Postal matching cannot use a current user postal code to fill a missing order snapshot', async () => {
  assert.equal((await preview([order()], [{ ...row, matchValue: '۱۲۳۴۵۶۷۸۹۰' }], false, 'postalCode')).rows[0].candidates.length, 1)
  assert.ok((await preview([order({ postalCode: null, user: { name: 'user', postalCode: '1234567890' } })], [{ ...row, matchValue: '1234567890' }], false, 'postalCode')).rows[0].error)
})

test('Optional order suffix narrows ambiguity and too-short suffixes are rejected', async () => {
  const result = await preview([order(), order({ id: 'second-order-654321' })], [{ ...row, orderReference: '#123456' }])
  assert.equal(result.rows[0].candidates.length, 1); assert.equal(result.rows[0].candidates[0].id, 'order-abcdef123456')
  assert.ok(importer.parseShipmentPreviewInput({ rows: [{ ...row, orderReference: '123' }], matchBy: 'phone', markShipped: false }).rows[0].error)
})

test('Preview signatures cannot be tampered with or used by another administrator', async () => {
  const result = await preview([order()])
  assert.throws(() => importer.verifyShipmentPreview(result.token, 'other-admin'), { status: 409 })
  const [payload, signature] = result.token.split('.')
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), markShipped: true })).toString('base64url')
  assert.throws(() => importer.verifyShipmentPreview(changed + '.' + signature, 'admin'), { status: 400 })
  for (const token of ['', 'invalid', result.token + '.extra']) assert.throws(() => importer.verifyShipmentPreview(token, 'admin'), { status: 400 })
  const originalNow = Date.now
  try { Date.now = () => originalNow() + 11 * 60 * 1000; assert.throws(() => importer.verifyShipmentPreview(result.token, 'admin'), { status: 409 }) }
  finally { Date.now = originalNow }
})

test('Large ambiguous previews fail with actionable guidance before producing an unconfirmable token', async () => {
  const orders = Array.from({ length: 20 }, (_, index) => order({ id: `order-ambiguous-${String(index).padStart(20, '0')}` }))
  const rows = Array.from({ length: 1000 }, (_, index) => ({ ...row, rowNumber: index + 1, trackingCode: String(1000000 + index) }))
  await assert.rejects(preview(orders, rows), error => error.status === 413 && /بخش‌های کوچک‌تر/.test(error.message) && /شمارهٔ سفارش/.test(error.message))
})

test('Preview response limits count Persian UTF-8 metadata independently of token size', async () => {
  const name = 'پ'.repeat(Math.ceil(importer.MAX_SHIPMENT_PREVIEW_RESPONSE_BYTES / 2))
  assert.ok(name.length < importer.MAX_SHIPMENT_PREVIEW_RESPONSE_BYTES)
  await assert.rejects(preview([order({ recipientName: name })]), error => error.status === 413 && /حجم پیش‌نمایش/.test(error.message))
})

test('Preview accounts for confirmation choices even when legacy order identifiers are unusually long', async () => {
  const identifier = 'order-' + 'a'.repeat(27000)
  const orders = [order({ id: identifier })]
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...row, rowNumber: index + 1, trackingCode: String(1000000 + index) }))
  // The token alone fits 1.5MB; repeating long IDs in up to 25 confirmation
  // choices would exceed 1.6MB, so this preview must not be advertised as usable.
  await assert.rejects(preview(orders, rows), error => error.status === 413 && /حجم پیش‌نمایش/.test(error.message))
})

test('Successful multirow previews stay inside response and 25-row confirmation body budgets', async () => {
  const orders = [order(), order({ id: 'other-order-654321' })]
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...row, rowNumber: index + 1, trackingCode: String(1000000 + index) }))
  const result = await preview(orders, rows)
  assert.ok(result.token.length <= importer.MAX_SHIPMENT_PREVIEW_TOKEN_CHARS)
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= importer.MAX_SHIPMENT_PREVIEW_RESPONSE_BYTES)
  const choices = rows.slice(0, 25).map(source => ({ rowNumber: source.rowNumber, orderId: orders[0].id, overwrite: false }))
  assert.ok(Buffer.byteLength(JSON.stringify({ token: result.token, choices }), 'utf8') <= 1_600_000)
  assert.equal(importer.verifyShipmentPreview(result.token, 'admin').rows.length, 100)
})

test('Confirmation only accepts explicit candidate choices and forbids duplicate orders in a batch', async () => {
  const result = await preview([order()], [row, { ...row, rowNumber: 3, trackingCode: '654321098765432109876543' }])
  const claims = importer.verifyShipmentPreview(result.token, 'admin')
  assert.throws(() => importer.shipmentChoices({ choices: [{ rowNumber: 2, orderId: 'arbitrary-order', overwrite: false }] }, claims), { status: 400 })
  assert.throws(() => importer.shipmentChoices({ choices: claims.rows.map(source => ({ rowNumber: source.rowNumber, orderId: order().id, overwrite: false })) }, claims), { status: 400 })
  assert.equal(importer.shipmentChoices({ choices: [{ rowNumber: 2, orderId: order().id, overwrite: false }] }, claims).length, 1)
})

test('Adding tracking to a shipped order updates metadata without creating another inventory movement', async () => {
  events.length = 0
  const current = order(), result = await preview([current]), claims = importer.verifyShipmentPreview(result.token, 'admin')
  const saved = await importer.confirmShipmentRow(database([current]), claims, { rowNumber: 2, orderId: current.id, overwrite: false }, { id: 'admin' })
  assert.equal(saved.status, 'saved'); assert.equal(current.trackingCode, row.trackingCode)
  assert.ok(current.trackingRecordedAt instanceof Date); assert.equal(events.length, 0)
})

test('Confirming a processing order records exactly one shipment and retry is a no-op', async () => {
  events.length = 0
  const current = order({ status: 'PROCESSING' }), result = await preview([current], [row], true), claims = importer.verifyShipmentPreview(result.token, 'admin'), tx = database([current])
  const choice = { rowNumber: 2, orderId: current.id, overwrite: false }
  assert.equal((await importer.confirmShipmentRow(tx, claims, choice, { id: 'admin', name: 'مدیر' })).status, 'saved')
  const stamp = current.trackingRecordedAt
  assert.equal(current.status, 'SHIPPED'); assert.equal(events.length, 1); assert.equal(events[0].type, 'SHIPMENT')
  assert.equal((await importer.confirmShipmentRow(tx, claims, choice, { id: 'admin' })).status, 'unchanged')
  assert.equal(events.length, 1); assert.equal(current.trackingRecordedAt, stamp)
})

test('Tracking conflicts require explicit overwrite confirmation', async () => {
  const current = order({ trackingCode: '654321098765432109876543' }), result = await preview([current]), claims = importer.verifyShipmentPreview(result.token, 'admin'), tx = database([current])
  await assert.rejects(importer.confirmShipmentRow(tx, claims, { rowNumber: 2, orderId: current.id, overwrite: false }, { id: 'admin' }), { status: 409 })
  assert.equal((await importer.confirmShipmentRow(tx, claims, { rowNumber: 2, orderId: current.id, overwrite: true }, { id: 'admin' })).status, 'saved')
})

test('Order revisions, payment changes and recipient changes invalidate old previews', async () => {
  for (const change of [{ updatedAt: new Date('2026-10-02') }, { trackingCode: '654321000000000000000000' }, { status: 'DELIVERED' }, { verified: false }, { phone: '09121111111' }]) {
    const current = order(), result = await preview([current]), claims = importer.verifyShipmentPreview(result.token, 'admin')
    Object.assign(current, change)
    await assert.rejects(importer.confirmShipmentRow(database([current]), claims, { rowNumber: 2, orderId: current.id, overwrite: true }, { id: 'admin' }), { status: 409 })
  }
})

test('A lost compare-and-swap never records a shipment inventory event', async () => {
  events.length = 0
  const current = order({ status: 'PROCESSING' }), result = await preview([current], [row], true), claims = importer.verifyShipmentPreview(result.token, 'admin'), tx = database([current])
  tx.order.updateMany = async () => ({ count: 0 })
  await assert.rejects(importer.confirmShipmentRow(tx, claims, { rowNumber: 2, orderId: current.id, overwrite: false }, { id: 'admin' }), { status: 409 })
  assert.equal(events.length, 0); assert.equal(current.trackingCode, null)
})

test('All shipment endpoints reject ordinary users before parsing or reading orders', async () => {
  for (const file of ['workbook', 'preview', 'confirm', 'order']) {
    const route = load(`src/app/api/admin/shipments/${file}/route.ts`, { ...deps, '@/lib/auth': { auth: async () => ({ user: { id: 'customer', role: 'USER' } }) }, '@/lib/prisma': new Proxy({}, { get() { throw new Error('Unauthorized database read') } }) })
    const handler = route.POST || route.GET
    const response = await handler(new Request('http://localhost/api/admin/shipments/' + file, { method: route.POST ? 'POST' : 'GET', ...(route.POST ? { body: 'invalid data' } : {}) }))
    assert.equal(response.status, 403)
  }
})

test('Authenticated workbook upload and downloadable template preserve text formatting and enforce same origin', async () => {
  const route = load('src/app/api/admin/shipments/workbook/route.ts', { ...deps, '@/lib/auth': { auth: async () => ({ user: { id: 'admin', role: 'ADMIN' } }) } })
  const template = await route.GET()
  assert.equal(template.status, 200)
  assert.match(template.headers.get('Content-Disposition'), /shipment-template\.xlsx/)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await template.arrayBuffer()))
  assert.equal(workbook.worksheets[0].getColumn(3).numFmt, '@')
  workbook.worksheets[0].addRow(['09123456789', '1234567890', row.trackingCode])
  const form = new FormData()
  form.set('file', new File([await workbook.xlsx.writeBuffer()], 'tracking.xlsx'))
  const uploaded = await route.POST(new Request('http://localhost/api/admin/shipments/workbook', { method: 'POST', body: form, headers: { Origin: 'http://localhost' } }))
  assert.equal(uploaded.status, 200)
  assert.equal((await uploaded.json()).sheets[0].rows[1].cells[2].text, row.trackingCode)
  const denied = await route.POST(new Request('http://localhost/api/admin/shipments/workbook', { method: 'POST', body: form, headers: { Origin: 'https://evil.invalid' } }))
  assert.equal(denied.status, 403)
})
