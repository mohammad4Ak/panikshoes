// Real PostgreSQL regression; run only on the designated development DB.
// Every fixture, sequence and inventory change is in a disposable schema.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.hostname !== '192.168.1.104' || target.pathname !== '/shoes_shop' || (target.searchParams.get('schema') || 'public') !== 'public') {
  throw new Error('Bulk order integration requires the authorized local shoes_shop database')
}
const schema = 'test_bulk_orders_' + randomBytes(8).toString('hex')
assert.match(schema, /^test_bulk_orders_[a-f0-9]{16}$/)
const testUrl = new URL(target)
testUrl.searchParams.set('schema', schema)
const control = new PrismaClient({ datasourceUrl: target.toString() })
const db = new PrismaClient({ datasourceUrl: testUrl.toString() })
const root = path.resolve(__dirname, '..')
const actor = { id: 'bulk-admin', name: 'مدیر آزمایشی', role: 'ADMIN' }
const cache = new Map()

function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports
  const result = { exports: {} }
  cache.set(relative, result)
  const code = transformSync(readFileSync(path.join(root, relative), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  vm.runInNewContext(code, {
    module: result, URL, URLSearchParams, Request, Response, Headers, Date, Buffer, Error, console,
    process: { env: { AUTH_SECRET: 'isolated-bulk-integration-test-secret-12345678' } },
    require(name) {
      if (name === 'next/server') return { NextResponse: Response, connection: async () => {} }
      if (name === 'react') return { cache: fn => fn }
      if (name === '@/lib/prisma') return { prisma: db }
      if (name === '@/lib/auth') return { auth: async () => ({ user: actor }) }
      if (name === 'server-only') return {}
      if (name.startsWith('node:') || name === '@prisma/client') return require(name)
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      throw new Error('Unexpected dependency: ' + name)
    },
  }, { filename: relative })
  return result.exports
}

const inside = new Date('2026-10-10T11:00:00Z')
const orderId = i => `bulk-fixture-${String(i).padStart(2, '0')}`
async function createOrder(id, data = {}) {
  return db.order.create({ data: {
    id, userId: 'bulk-buyer', address: 'نشانی آزمایشی', phone: '09123456789', total: 1000,
    subtotal: 1000, status: 'PROCESSING', verified: true, paymentMethod: 'bank_transfer', paymentStatus: 'PAID', createdAt: inside,
    items: { create: { productId: 'bulk-shoe', variantId: 'bulk-variant', productName: 'کفش آزمایشی', size: 38, color: 'مشکی', price: 1000, quantity: 1 } },
    ...data,
  } })
}

async function main() {
  let created = false
  try {
    await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    created = true
    const migration = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: root, env: { ...process.env, DATABASE_URL: testUrl.toString() }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(migration.status, 0, 'Applying migrations to the isolated bulk test schema failed')
    assert.equal((await db.$queryRaw`SELECT current_schema() AS schema`)[0].schema, schema)
    await db.user.createMany({ data: [
      { ...actor, email: 'admin@bulk-test.invalid', password: '$disabled$fixture' },
      { id: 'bulk-buyer', name: 'مشتری آزمایشی', email: 'buyer@bulk-test.invalid', password: '$disabled$fixture' },
    ] })
    await db.category.create({ data: { id: 'bulk-category', name: 'آزمایش', slug: 'bulk-test' } })
    await db.product.create({ data: {
      id: 'bulk-shoe', code: 'BULK-TEST', name: 'کفش آزمایشی', slug: 'bulk-shoe', description: 'Fixture', price: 1000,
      categoryId: 'bulk-category', sizes: [38], colors: ['مشکی'], images: [], stock: 8, inventoryConfigured: true,
      variants: { create: { id: 'bulk-variant', size: 38, color: 'مشکی', stock: 8 } },
    } })
    for (let i = 0; i < 22; i++) await createOrder(orderId(i))
    await createOrder('bulk-fixture-before-day', { createdAt: new Date('2026-10-09T20:29:59Z') })
    await createOrder('bulk-fixture-after-day', { createdAt: new Date('2026-10-10T20:30:00Z') })
    await createOrder('bulk-fixture-already-shipped', { status: 'SHIPPED' })
    await createOrder('bulk-fixture-awaiting-payment', { status: 'PENDING', verified: false, paymentStatus: 'AWAITING_RECEIPT', paymentExpiresAt: new Date(Date.now() + 3600000) })

    const endpoint = load('src/app/api/admin/orders/bulk/route.ts')
    async function post(body) {
      const response = await endpoint.POST(new Request('http://localhost:3000/api/admin/orders/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify(body),
      }))
      return { status: response.status, body: await response.json() }
    }
    async function ok(body) {
      const response = await post(body)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      return response.body
    }
    const filters = 'q=bulk-fixture&range=custom&from=2026-10-10&to=2026-10-10'
    const preview = await ok({ action: 'preview', mode: 'filtered', filters, status: 'SHIPPED' })
    assert.equal(preview.rows.length, 24, 'Preview must cover all pages but exclude adjacent Tehran dates')
    assert.equal(preview.rows.filter(row => row.eligible).length, 22)
    assert.ok(preview.rows.some(row => row.id === orderId(0) && row.eligible))
    assert.equal(preview.rows.find(row => row.id === 'bulk-fixture-awaiting-payment').eligible, false)
    assert.equal(preview.rows.find(row => row.id === 'bulk-fixture-already-shipped').eligible, false)
    assert.equal(await db.invoice.count(), 0)
    assert.equal(await db.stockMovement.count(), 0)
    console.log('PASS filtered preview includes multiple pages, respects Tehran date boundaries, skips ineligible orders and has no side effects')

    await createOrder('bulk-fixture-added-after-preview')
    const outside = await post({ action: 'confirm', token: preview.token, ids: [orderId(0), 'bulk-fixture-added-after-preview'] })
    assert.ok(outside.status >= 400 && outside.status < 500)
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId(0) } })).status, 'PROCESSING')
    await db.order.update({ where: { id: orderId(1) }, data: { recipientName: 'گیرندهٔ اصلاح‌شده', updatedAt: new Date(Date.now() + 5000) } })
    const first = await ok({ action: 'confirm', token: preview.token, ids: [orderId(0), orderId(1)] })
    assert.deepEqual(Object.fromEntries(first.results.map(row => [row.id, row.outcome])), { [orderId(0)]: 'updated', [orderId(1)]: 'skipped' })
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId(1) } })).status, 'PROCESSING')
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: 'bulk-fixture-added-after-preview' } })).status, 'PROCESSING')
    assert.equal(await db.invoice.count({ where: { orderId: orderId(0) } }), 1)
    assert.equal(await db.stockMovement.count({ where: { orderId: orderId(0), type: 'SHIPMENT' } }), 1)
    assert.equal((await db.productVariant.findUniqueOrThrow({ where: { id: 'bulk-variant' } })).stock, 8)
    console.log('PASS preview freezes order IDs and versions; partial confirmation issues one invoice and shipment without reserving again')

    const pending = 'bulk-fixture-awaiting-payment'
    const cancel = await ok({ action: 'preview', mode: 'selected', ids: [pending, orderId(0)], status: 'CANCELLED' })
    assert.equal(cancel.rows.find(row => row.id === pending).eligible, true)
    assert.equal(cancel.rows.find(row => row.id === orderId(0)).eligible, false)
    const replies = await Promise.all([1, 2].map(() => ok({ action: 'confirm', token: cancel.token, ids: [pending] })))
    assert.deepEqual(replies.flatMap(result => result.results.map(row => row.outcome)).sort(), ['skipped', 'updated'])
    const cancelled = await db.order.findUniqueOrThrow({ where: { id: pending } })
    assert.equal(cancelled.status, 'CANCELLED')
    assert.equal(cancelled.paymentStatus, 'EXPIRED')
    assert.equal(await db.stockMovement.count({ where: { orderId: pending, type: 'RELEASE' } }), 1)
    assert.equal((await db.productVariant.findUniqueOrThrow({ where: { id: 'bulk-variant' } })).stock, 9)
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: 'bulk-shoe' } })).stock, 9)
    console.log('PASS concurrent bulk confirmations cancel once and release exactly one reserved pair')
  } finally {
    await db.$disconnect()
    try {
      if (created) {
        await control.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
        assert.equal((await control.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).length, 0)
        console.log('PASS isolated schema removed; store records were not changed')
      }
    } finally { await control.$disconnect() }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
