const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const context = {
    module: { exports: {} }, Request, Response, Uint8Array, Buffer,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code, context)
  return context.module.exports
}

const invoiceHelpers = () => load('src/lib/invoice.ts')
const invoice = { id: 42, issuedAt: '2026-10-01T12:30:00.000Z', snapshot: { schemaVersion: 1, total: 230000 } }
const privateCache = (response) => {
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
  assert.equal(response.headers.get('vary'), 'Cookie, Accept')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
}

function harness({ session = { user: { id: 'buyer', role: 'USER' } }, found = { status: 'PROCESSING', invoice }, renderError, dbError } = {}) {
  const queries = []
  const renders = []
  const binary = Uint8Array.from(Buffer.concat([Buffer.from('%PDF-1.3\ninvoice-binary\n'), Buffer.from([0, 127, 128, 255])]))
  const route = load('src/app/api/orders/[id]/invoice/route.ts', {
    'next/server': { NextResponse: Response },
    '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': { prisma: { order: { findFirst: async (query) => {
      queries.push(query)
      if (dbError) throw dbError
      // Simulate owner filtering against an order owned by buyer.
      return query.where.userId && query.where.userId !== 'buyer' ? null : found
    } } } },
    '@/lib/invoice': invoiceHelpers(),
    '@/lib/invoice-pdf': { renderInvoicePdf: async (data, status) => {
      renders.push({ data, status })
      if (renderError) throw renderError
      return binary
    } },
  })
  return { queries, renders, binary, get: (id = 'order-1', suffix = '', headers = {}) => route.GET(
    new Request(`http://localhost/api/orders/${id}/invoice${suffix}`, { headers }), { params: Promise.resolve({ id }) },
  ) }
}

test('Invoice download requires a live authenticated identity before any database read', async () => {
  for (const session of [null, {}, { user: {} }]) {
    const h = harness({ session })
    const response = await h.get()
    assert.equal(response.status, 401)
    privateCache(response)
    assert.equal(h.queries.length, 0)
    assert.equal(h.renders.length, 0)
  }
})

test('Foreign and missing orders both return 404 without exposing invoice metadata', async () => {
  for (const options of [{ session: { user: { id: 'stranger', role: 'USER' } } }, { found: null }]) {
    const h = harness(options)
    const response = await h.get()
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'سفارش یافت نشد' })
    privateCache(response)
    assert.equal(h.renders.length, 0)
  }
})

test('Owners receive a PDF attachment from the issued snapshot; URL flags cannot change it', async () => {
  const h = harness()
  const response = await h.get('order-1', '?verified=true&preview=success&total=1')
  assert.equal(response.status, 200)
  privateCache(response)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="katuni-INV-2026-000042.pdf"')
  assert.equal(response.headers.get('content-length'), String(h.binary.byteLength))
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(h.binary))
  assert.deepEqual(JSON.parse(JSON.stringify(h.queries[0].where)), { id: 'order-1', userId: 'buyer' })
  assert.strictEqual(h.renders[0].data.snapshot, invoice.snapshot)
  assert.equal(h.renders[0].status, 'PROCESSING')
})

test('Admins may retrieve a customer invoice; other roles remain restricted to ownership', async () => {
  const admin = harness({ session: { user: { id: 'admin', role: 'ADMIN' } } })
  assert.equal((await admin.get()).status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(admin.queries[0].where)), { id: 'order-1' })
  const stranger = harness({ session: { user: { id: 'stranger', role: 'admin' } } })
  assert.equal((await stranger.get()).status, 404)
})

test('Programmatic requests carry the identical PDF through JSON before the browser download', async () => {
  for (const role of ['USER', 'ADMIN']) {
    const h = harness({ session: { user: { id: role === 'ADMIN' ? 'admin' : 'buyer', role } } })
    const response = await h.get('order-1', '', { Accept: 'application/json' })
    assert.equal(response.status, 200)
    privateCache(response)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.headers.get('content-disposition'), null)
    const data = await response.json()
    assert.equal(typeof data.pdf, 'string')
    assert.deepEqual(Buffer.from(data.pdf, 'base64'), Buffer.from(h.binary))
  }
})

test('Navigation Accept lists keep the direct attachment download behavior', async () => {
  const response = await harness().get('order-1', '', { Accept: 'text/html,application/json,*/*;q=0.8' })
  assert.match(response.headers.get('content-disposition'), /^attachment;/)
})

test('Programmatic requests retain authentication, ownership and availability checks', async () => {
  for (const [options, status] of [
    [{ session: null }, 401],
    [{ session: { user: { id: 'stranger', role: 'USER' } } }, 404],
    [{ found: { status: 'PENDING', invoice: null } }, 409],
    [{ renderError: new Error('private document details') }, 500],
  ]) {
    const response = await harness(options).get('order-1', '', { Accept: 'application/json' })
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.headers.get('content-disposition'), null)
    privateCache(response)
  }
})

test('Unissued orders cannot create an invoice by downloading or pretending payment succeeded', async () => {
  const h = harness({ found: { status: 'PENDING', invoice: null } })
  const response = await h.get('order-1', '?verified=true&status=PROCESSING')
  assert.equal(response.status, 409)
  privateCache(response)
  assert.equal(h.renders.length, 0)
})

test('Cancelled and returned-to-pending orders retain the document with their current status', async () => {
  for (const status of ['CANCELLED', 'PENDING']) {
    const h = harness({ found: { status, invoice } })
    assert.equal((await h.get()).status, 200)
    assert.equal(h.renders[0].status, status)
    assert.strictEqual(h.renders[0].data.snapshot, invoice.snapshot)
  }
})

test('Failures return private generic errors instead of corrupted PDFs or private database details', async () => {
  for (const options of [{ dbError: new Error('secret database details') }, { renderError: new Error('private address') }]) {
    const h = harness(options)
    const response = await h.get()
    assert.equal(response.status, 500)
    privateCache(response)
    const text = await response.text()
    assert.ok(!text.includes('secret') && !text.includes('private address'))
    assert.match(response.headers.get('content-type'), /application\/json/)
  }
})

test('Oversized or empty identifiers are rejected without database or rendering work', async () => {
  for (const id of ['', 'x'.repeat(129)]) {
    const h = harness()
    assert.equal((await h.get(id)).status, 404)
    assert.equal(h.queries.length, 0)
    assert.equal(h.renders.length, 0)
  }
})
