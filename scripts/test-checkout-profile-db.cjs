// Local opt-in integration test: all fixture rows live in a random isolated
// schema. Public customer, stock and payment rows are never modified.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomBytes, randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')
const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.hostname !== '192.168.1.104' || target.pathname !== '/shoes_shop') throw new Error('Checkout profile integration requires the authorized local shoes_shop database')
const schema = `panik_checkout_profile_test_${randomBytes(8).toString('hex')}`
if (!/^panik_checkout_profile_test_[a-f0-9]{16}$/.test(schema)) throw new Error('Unsafe isolated schema')
const control = new PrismaClient()
const testUrl = new URL(target)
testUrl.searchParams.set('schema', schema)
const db = new PrismaClient({ datasourceUrl: testUrl.toString() })
let created = false, precheckHook = null, paymentHook = null, expirationCalls = 0
const routeDb = new Proxy(db, { get(client, key) {
  if (key === 'product') return new Proxy(client.product, { get(delegate, method) {
    if (method === 'findUnique') return async args => { const value = await delegate.findUnique(args); if (precheckHook) await precheckHook(); return value }
    return typeof delegate[method] === 'function' ? delegate[method].bind(delegate) : delegate[method]
  } })
  if (key === '$transaction') return callback => client.$transaction(tx => callback(new Proxy(tx, { get(transaction, model) {
    if (model === 'paymentMethod') return new Proxy(transaction.paymentMethod, { get(delegate, method) {
      if (method === 'findUnique') return async args => { if (paymentHook) await paymentHook(); return delegate.findUnique(args) }
      return typeof delegate[method] === 'function' ? delegate[method].bind(delegate) : delegate[method]
    } })
    return typeof transaction[model] === 'function' ? transaction[model].bind(transaction) : transaction[model]
  } })), { maxWait: 5000, timeout: 15000 })
  return typeof client[key] === 'function' ? client[key].bind(client) : client[key]
} })
const cache = new Map()
function load(relative) {
  if (cache.has(relative)) return cache.get(relative)
  const testModule = { exports: {} }
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
    module: testModule, Response, Date, Buffer, require(name) {
      if (name === 'next/server') return { NextResponse: Response }
      if (name === '@/lib/prisma') return { prisma: routeDb }
      if (name === '@/lib/auth') return { auth: async () => ({ user: { id: 'buyer', name: 'خریدار آزمایشی', role: 'USER' } }) }
      if (name === '@/lib/request-origin') return { isSameOriginRequest: () => true }
      if (name === '@/lib/payments') return { expireUnpaidOrders: async () => { expirationCalls++; return 0 }, methodAvailability: () => ({ available: true }) }
      if (name.startsWith('@/lib/')) return load(`src/lib/${name.slice(6)}.ts`)
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), `${name}.ts`))
      if (name === 'node:crypto') return require(name)
      throw new Error(`Unexpected integration dependency ${name}`)
    },
  }, { filename: relative })
  cache.set(relative, testModule.exports)
  return testModule.exports
}
const { requireCheckoutProfile } = load('src/lib/checkout-profile.ts')
const { POST } = load('src/app/api/orders/route.ts')
const tx = callback => db.$transaction(callback, { maxWait: 5000, timeout: 15000 })
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Integration barrier timed out')), 5000) })]) }
  finally { clearTimeout(timer) }
}
const payload = extra => ({ checkoutKey: randomUUID(), recipientName: 'گیرنده', address: 'نشانی فقط در طرح آزمایشی', phone: '+98 9211112233', postalCode: '۹۸۷۶۵۴۳۲۱۰',
  items: [{ productId: 'shoe', size: 38, color: 'مشکی', quantity: 1 }], shippingMethodId: 'post', paymentMethodId: 'bank_transfer', expectedSubtotal: 100,
  expectedShippingCost: 0, couponCode: 'PANIK10', expectedCouponDiscount: 10, ...extra })
const request = body => new Request('http://localhost/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body) })
async function counts() {
  const [product, variant, orderCount, movementCount, coupon, uses] = await Promise.all([
    db.product.findUniqueOrThrow({ where: { id: 'shoe' } }), db.productVariant.findUniqueOrThrow({ where: { id: 'variant' } }),
    db.order.count(), db.stockMovement.count(), db.coupon.findUniqueOrThrow({ where: { id: 'coupon' } }), db.couponRedemption.count(),
  ])
  return { stock: product.stock, version: product.inventoryVersion, variantStock: variant.stock, orderCount, movementCount, couponCount: coupon.usedCount, uses }
}

async function main() {
  try {
    await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    created = true
    // Deploy the real migrations into the isolated schema, including its own
    // enum types, defaults and constraints. Do not point this at public.
    const migration = spawnSync(process.execPath, [path.join(__dirname, '../node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: testUrl.toString() }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(migration.status, 0, 'Isolated checkout test migration failed')
    const [location] = await db.$queryRaw`SELECT current_schema() AS schema`
    assert.equal(location.schema, schema, 'Unqualified account-lock SQL must resolve only inside the test schema')
    await db.user.create({ data: { id: 'buyer', email: 'buyer@checkout-test.invalid', name: 'آزمایش داخلی', password: '$disabled$fixture', phone: '09123456789', postalCode: '1234567890' } })
    await db.category.create({ data: { id: 'category', name: 'آزمایش', slug: 'fixture' } })
    await db.product.create({ data: { id: 'shoe', code: 'TEST-SHOE', name: 'آزمایش', slug: 'fixture-shoe', description: 'Fixture only', price: 100, categoryId: 'category', sizes: [38], colors: ['مشکی'], images: [], stock: 5, inventoryConfigured: true,
      variants: { create: { id: 'variant', size: 38, color: 'مشکی', stock: 5 } } } })
    await db.shippingMethod.create({ data: { id: 'post', name: 'پست آزمایشی', isActive: true } })
    await db.paymentMethod.upsert({ where: { id: 'bank_transfer' }, create: { id: 'bank_transfer', name: 'پرداخت آزمایشی', isActive: true, cardNumber: 'fixture-not-a-real-card', cardholderName: 'فقط آزمایش' }, update: { isActive: true, cardNumber: 'fixture-not-a-real-card', cardholderName: 'فقط آزمایش' } })
    await db.coupon.create({ data: { id: 'coupon', code: 'PANIK10', name: 'آزمایش', type: 'PERCENT', value: 10, perUserLimit: 10, maxUses: 10, minSubtotal: 0 } })

    const locked = deferred(), release = deferred()
    const purchaseRead = tx(async transaction => { await requireCheckoutProfile(transaction, 'buyer'); locked.resolve(); await release.promise })
    await bounded(locked.promise)
    let blockFinished = false
    const block = db.user.update({ where: { id: 'buyer' }, data: { isActive: false } }).then(value => { blockFinished = true; return value })
    try { await pause(120); assert.equal(blockFinished, false, 'Support blocking must wait for a checkout-held shared lock') }
    finally { release.resolve() }
    await bounded(Promise.all([purchaseRead, block]))
    await assert.rejects(tx(transaction => requireCheckoutProfile(transaction, 'buyer')), error => error.code === 'ACCOUNT_INACTIVE')
    console.log('PASS real shared checkout lock serializes account blocking; later purchases see ACCOUNT_INACTIVE')

    await db.user.update({ where: { id: 'buyer' }, data: { isActive: true } })
    const edited = deferred(), commitEdit = deferred()
    const supportEdit = tx(async transaction => { await transaction.user.update({ where: { id: 'buyer' }, data: { postalCode: null } }); edited.resolve(); await commitEdit.promise })
    await bounded(edited.promise)
    let guardFinished = false
    const guard = tx(transaction => requireCheckoutProfile(transaction, 'buyer')).then(() => ({ code: 'unexpected-success' }), error => error).then(result => { guardFinished = true; return result })
    try { await pause(120); assert.equal(guardFinished, false, 'FOR SHARE must wait for a concurrent account edit') }
    finally { commitEdit.resolve() }
    await bounded(supportEdit)
    assert.equal((await bounded(guard)).code, 'PROFILE_INCOMPLETE')
    console.log('PASS checkout waits for an account edit and validates its committed postal code')

    const before = await counts(), expirations = expirationCalls
    const denied = await POST(request(payload()))
    assert.equal(denied.status, 409)
    assert.equal((await denied.json()).code, 'PROFILE_INCOMPLETE')
    assert.deepEqual(await counts(), before)
    assert.equal(expirationCalls, expirations)
    console.log('PASS actual order route rejects incomplete profile before expiry, stock, coupon and order mutations')

    await db.user.update({ where: { id: 'buyer' }, data: { postalCode: '1234567890' } })
    const body = payload(), createdOrder = await POST(request(body))
    assert.equal(createdOrder.status, 201)
    const order = await createdOrder.json()
    assert.equal(order.phone, '09211112233')
    assert.equal(order.postalCode, '9876543210')
    assert.deepEqual(await counts(), { stock: 4, version: 1, variantStock: 4, orderCount: 1, movementCount: 1, couponCount: 1, uses: 1 })
    await db.user.update({ where: { id: 'buyer' }, data: { phone: null, postalCode: null } })
    const replay = await POST(request(body))
    assert.equal(replay.status, 200)
    assert.equal((await replay.json()).id, order.id)
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).postalCode, '9876543210')
    assert.deepEqual(await counts(), { stock: 4, version: 1, variantStock: 4, orderCount: 1, movementCount: 1, couponCount: 1, uses: 1 })
    console.log('PASS canonical shipment snapshots survive account edits; lost-response replay never reserves stock or coupons twice')

    await db.user.update({ where: { id: 'buyer' }, data: { phone: '09123456789', postalCode: '1234567890' } })
    precheckHook = async () => { await db.user.update({ where: { id: 'buyer' }, data: { isActive: false } }); precheckHook = null }
    const beforeRace = await counts(), rejectedRace = await POST(request(payload()))
    assert.equal(rejectedRace.status, 403)
    assert.equal((await rejectedRace.json()).code, 'ACCOUNT_INACTIVE')
    assert.deepEqual(await counts(), beforeRace)
    console.log('PASS a block committed between checkout preflight and transaction is rechecked before reservation')

    await db.user.update({ where: { id: 'buyer' }, data: { isActive: true } })
    const inside = deferred(), proceed = deferred()
    paymentHook = async () => { inside.resolve(); await proceed.promise }
    const purchase = POST(request(payload()))
    await bounded(inside.promise)
    let supportFinished = false
    const blocking = db.user.update({ where: { id: 'buyer' }, data: { isActive: false } }).then(value => { supportFinished = true; return value })
    try { await pause(120); assert.equal(supportFinished, false, 'Actual checkout must retain its account lock until commit') }
    finally { proceed.resolve() }
    const [purchaseResponse] = await bounded(Promise.all([purchase, blocking]))
    paymentHook = null
    assert.equal(purchaseResponse.status, 201)
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: 'buyer' } })).isActive, false)
    assert.deepEqual(await counts(), { stock: 3, version: 2, variantStock: 3, orderCount: 2, movementCount: 2, couponCount: 2, uses: 2 })
    assert.equal((await POST(request(payload()))).status, 403)
    console.log('PASS actual purchase commits before a waiting support block; subsequent purchases are rejected')
  } finally {
    await db.$disconnect()
    if (created) {
      await control.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
      const remaining = await control.$queryRaw`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${schema}`
      assert.equal(remaining.length, 0)
      console.log('PASS isolated checkout-profile schema removed; public business rows untouched')
    }
    await control.$disconnect()
  }
}
main().catch(error => { console.error(error.name, error.code || '', error.message); process.exitCode = 1 })
