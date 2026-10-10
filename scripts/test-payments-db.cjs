// Opt-in PostgreSQL integration check. Only an isolated, explicitly named test
// schema is accepted; application rows and real bank settings are never used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { AsyncLocalStorage } = require('node:async_hooks')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const root = path.resolve(__dirname, '..')
const testUrl = process.env.PAYMENT_TEST_DATABASE_URL
if (!testUrl) throw new Error('Set PAYMENT_TEST_DATABASE_URL with a dedicated katuni_payment_test_<id> schema.')
const parsed = new URL(testUrl)
const schema = parsed.searchParams.get('schema')
if (!/^katuni_payment_test_[a-z0-9]{8,32}$/.test(schema || '')) throw new Error('Refusing a non-test database schema.')
const db = new PrismaClient({ datasourceUrl: testUrl })
let stockReadBarrier = null
let orderReadBarrier = null
const routeProducts = new Proxy(db.product, {
  get(target, key) {
    if (key === 'findUnique') return async (args) => {
      const product = await target.findUnique(args)
      const barrier = stockReadBarrier
      if (barrier && args.where.id === barrier.productId) await barrier.arrive(product)
      return product
    }
    const value = target[key]
    return typeof value === 'function' ? value.bind(target) : value
  },
})
const routeDb = new Proxy(db, {
  get(target, key) {
    if (key === 'product') return routeProducts
    if (key === '$transaction') return (action, ...options) => {
      if (typeof action !== 'function' || !orderReadBarrier) return target.$transaction(action, ...options)
      return target.$transaction(async (tx) => action(new Proxy(tx, {
        get(transaction, delegate) {
          if (delegate !== 'order') return transaction[delegate]
          return new Proxy(transaction.order, {
            get(orders, method) {
              if (method === 'findUnique') return async (args) => {
                const order = await orders.findUnique(args)
                const barrier = orderReadBarrier
                if (barrier && args.where.id === barrier.orderId) await barrier.arrive(order)
                return order
              }
              const value = orders[method]
              return typeof value === 'function' ? value.bind(orders) : value
            },
          })
        },
      })), ...options)
    }
    const value = target[key]
    return typeof value === 'function' ? value.bind(target) : value
  },
})
let session = null
const requestSession = new AsyncLocalStorage()
let created = false
const cache = new Map()
const settingsInvalidations = []
function load(relative) {
  const file = path.resolve(root, relative)
  if (cache.has(file)) return cache.get(file)
  const testModule = { exports: {} }
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const deps = (name) => {
    if (name === '@/lib/prisma' || name === './prisma') return { prisma: routeDb }
    if (name === '@/lib/auth') return { auth: async () => requestSession.getStore() ?? session }
    if (name === 'next/cache') return { revalidatePath: (...args) => settingsInvalidations.push(args) }
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`)
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(file), `${name}.ts`)))
    return require(name)
  }
  vm.runInNewContext(code, { module: testModule, require: deps, Request, Response, File, FormData, URL, Uint8Array, Buffer, Date, process, console })
  cache.set(file, testModule.exports)
  return testModule.exports
}
const params = (id, receiptId) => ({ params: Promise.resolve({ id, ...(receiptId ? { receiptId } : {}) }) })
const json = (data, method = 'POST') => new Request('http://localhost/api/test', {
  method, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(data),
})
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')
function uploadRequest({ key = randomUUID(), late = false } = {}) {
  const form = new FormData()
  form.set('file', new File([png], 'test.png', { type: 'image/png' }))
  form.set('submissionKey', key)
  form.set('payerCardLast4', '۱۲۳۴')
  if (late) form.set('latePayment', 'true')
  return new Request('http://localhost/api/test', { method: 'POST', headers: { Origin: 'http://localhost' }, body: form })
}

async function racePendingOrder(orderId, actions) {
  const versions = []
  let releaseReads
  let failReads
  const bothReads = new Promise((resolve, reject) => { releaseReads = resolve; failReads = reject })
  const timeout = setTimeout(() => failReads(new Error('Concurrent payment actors did not both read the pending order')), 3000)
  orderReadBarrier = { orderId, async arrive(order) {
    versions.push(`${order.status}:${order.paymentStatus}:${order.updatedAt.toISOString()}`)
    if (versions.length === 2) {
      orderReadBarrier = null
      clearTimeout(timeout)
      releaseReads()
    }
    await bothReads
  } }
  let results
  try { results = await Promise.all(actions.map((action) => action())) }
  finally { clearTimeout(timeout); orderReadBarrier = null }
  assert.equal(versions.length, 2)
  assert.equal(versions[0], versions[1], 'Payment actors must compete for the same pending order version')
  return results
}

async function main() {
  const existing = await db.$queryRawUnsafe('SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1', schema)
  assert.equal(existing.length, 0, 'Refusing to reuse an existing schema')
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  created = true
  const migration = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: root, env: { ...process.env, DATABASE_URL: testUrl }, encoding: 'utf8', timeout: 60000,
  })
  assert.equal(migration.status, 0, 'Test schema migration failed')
  const buyer = await db.user.create({ data: { email: 'buyer@example.test', name: 'Test buyer', password: 'not-a-login' } })
  const other = await db.user.create({ data: { email: 'other@example.test', name: 'Other buyer', password: 'not-a-login' } })
  const admin = await db.user.create({ data: { email: 'admin@example.test', name: 'Test admin', role: 'ADMIN', password: 'not-a-login' } })
  const category = await db.category.create({ data: { name: 'Test', slug: 'test' } })
  const product = await db.product.create({ data: { name: 'Test shoe', slug: 'test-shoe', description: 'Test only', categoryId: category.id,
    price: 100000, sizes: [42], colors: ['green'], images: [], stock: 20 } })
  const shipping = await db.shippingMethod.create({ data: { name: 'Test delivery', isActive: true, baseCost: 0 } })
  await db.paymentMethod.update({ where: { id: 'bank_transfer' }, data: { isActive: true, cardNumber: '6037990000000006', cardholderName: 'TEST ONLY' } })
  const orders = load('src/app/api/orders/route.ts')
  const upload = load('src/app/api/orders/[id]/receipts/route.ts')
  const receipt = load('src/app/api/orders/[id]/receipts/[receiptId]/route.ts')
  const review = load('src/app/api/admin/payments/[id]/review/route.ts')
  const payment = load('src/app/api/orders/[id]/payment/route.ts')
  const cancel = load('src/app/api/orders/[id]/cancel/route.ts')
  const publicSettings = load('src/app/api/site-settings/route.ts')
  const adminSettings = load('src/app/api/admin/site-settings/route.ts')
  const settingsContract = load('src/lib/site-settings-contract.ts')
  const { expireUnpaidOrders } = load('src/lib/payments.ts')
  const login = (user) => { session = { user: { id: user.id, name: user.name, email: user.email, role: user.role } } }
  const asUser = (user, action) => requestSession.run({ user: { id: user.id, name: user.name, email: user.email, role: user.role } }, action)
  const stock = async () => (await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock
  async function saveSettings(changes) {
    const current = await asUser(admin, async () => {
      const response = await adminSettings.GET()
      assert.equal(response.status, 200)
      return response.json()
    })
    const response = await asUser(admin, () => adminSettings.PATCH(json({ ...current, ...changes }, 'PATCH')))
    const body = await response.json()
    assert.equal(response.status, 200, body.error)
    return body
  }

  const seeded = await db.siteSettings.findUniqueOrThrow({ where: { id: 1 } })
  assert.equal(seeded.version, 1)
  assert.equal(seeded.storeName, settingsContract.defaultSiteSettings.storeName)
  const seededPublicResponse = await publicSettings.GET()
  assert.equal(seededPublicResponse.status, 200)
  const seededPublic = await seededPublicResponse.json()
  assert.deepEqual(Object.keys(seededPublic).sort(), [...Object.keys(settingsContract.defaultSiteSettings), 'version'].sort())
  assert.equal(seededPublic.version, 1)
  assert.equal('id' in seededPublic, false)
  assert.equal('updatedAt' in seededPublic, false)
  assert.equal('createdAt' in seededPublic, false)

  // Both admins submit the same version. PostgreSQL must recheck the CAS
  // predicate after acquiring the row lock, rather than overwrite the winner.
  const draft = { announcementEnabled: false, announcementText: 'Not yet published', announcementLink: '/products',
    announcementLinkLabel: 'Draft promotion', logoUrl: '/uploads/test-logo.png', logoLightUrl: '/uploads/test-logo-light.webp' }
  const settingsRace = await Promise.all([
    asUser(admin, () => adminSettings.PATCH(json({ ...seededPublic, ...draft, storeName: 'First settings editor' }, 'PATCH'))),
    asUser(admin, () => adminSettings.PATCH(json({ ...seededPublic, ...draft, storeName: 'Second settings editor' }, 'PATCH'))),
  ])
  assert.deepEqual(settingsRace.map((response) => response.status).sort(), [200, 409])
  assert.deepEqual(settingsInvalidations, [['/', 'layout']])
  const raceWinner = await db.siteSettings.findUniqueOrThrow({ where: { id: 1 } })
  assert.equal(raceWinner.version, 2)
  assert.ok(['First settings editor', 'Second settings editor'].includes(raceWinner.storeName))
  const afterRacePublic = await (await publicSettings.GET()).json()
  assert.equal(afterRacePublic.storeName, raceWinner.storeName)
  assert.equal(afterRacePublic.announcementText, '')
  assert.equal(afterRacePublic.announcementLink, null)
  assert.equal(afterRacePublic.announcementLinkLabel, '')
  const afterRaceAdmin = await asUser(admin, async () => (await adminSettings.GET()).json())
  assert.equal(afterRaceAdmin.announcementText, draft.announcementText)
  assert.equal(afterRaceAdmin.announcementLink, draft.announcementLink)

  // Optional contact information can be removed. Null logos restore the
  // built-in artwork and must persist as null rather than a literal URL.
  const cleared = await saveSettings({ phone: '', email: '', address: '', supportHours: '', instagramUrl: null,
    telegramUrl: null, logoUrl: null, logoLightUrl: null })
  assert.equal(cleared.version, 3)
  const clearedRow = await db.siteSettings.findUniqueOrThrow({ where: { id: 1 } })
  for (const key of ['phone', 'email', 'address', 'supportHours']) assert.equal(clearedRow[key], '')
  for (const key of ['instagramUrl', 'telegramUrl', 'logoUrl', 'logoLightUrl']) assert.equal(clearedRow[key], null)
  assert.equal((await saveSettings({ storeName: 'Test seller brand' })).version, 4)
  async function checkoutResponse(user = buyer, overrides = {}) {
    const response = await asUser(user, () => orders.POST(json({ items: [{ productId: product.id, size: 42, color: 'green', quantity: 1 }],
      address: 'Test address', phone: '09120000000', recipientName: 'Test', shippingMethodId: shipping.id,
      paymentMethodId: 'bank_transfer', expectedShippingCost: 0, expectedSubtotal: 100000, checkoutKey: randomUUID(), ...overrides })))
    const body = await response.json()
    return { response, body }
  }
  async function checkout(user = buyer, overrides = {}) {
    login(user)
    const { response, body } = await checkoutResponse(user, overrides)
    assert.equal(response.status, 201, body.error)
    return body
  }
  const first = await checkout()
  assert.equal(await stock(), 19)
  const key = randomUUID()
  const uploads = await Promise.all([upload.POST(uploadRequest({ key }), params(first.id)), upload.POST(uploadRequest({ key }), params(first.id))])
  assert.ok(uploads.some((response) => response.status === 201))
  assert.ok(uploads.every((response) => [201, 409].includes(response.status)))
  const retry = await upload.POST(uploadRequest({ key }), params(first.id))
  assert.equal(retry.status, 201)
  const proof = (await retry.json()).receipt
  assert.equal(proof.payerCardLast4, '1234')
  assert.equal(await db.paymentReceipt.count({ where: { orderId: first.id } }), 1)
  assert.equal(await expireUnpaidOrders(new Date(Date.now() + 3600000)), 0, 'A receipt must preserve the stock reservation')
  login(other)
  assert.equal((await payment.GET(new Request('http://localhost'), params(first.id))).status, 404)
  assert.equal((await receipt.GET(new Request('http://localhost'), params(first.id, proof.id))).status, 404)
  assert.equal((await review.POST(json({ receiptId: proof.id, action: 'approve' }), params(first.id))).status, 403)
  login(admin)
  const image = await receipt.GET(new Request('http://localhost'), params(first.id, proof.id))
  assert.equal(image.status, 200)
  assert.match(image.headers.get('cache-control'), /private.*no-store/)
  const reviews = await Promise.all([review.POST(json({ receiptId: proof.id, action: 'approve' }), params(first.id)), review.POST(json({ receiptId: proof.id, action: 'approve' }), params(first.id))])
  assert.ok(reviews.some((response) => response.status === 200))
  assert.ok(reviews.every((response) => [200, 409].includes(response.status)))
  assert.equal((await review.POST(json({ receiptId: proof.id, action: 'approve' }), params(first.id))).status, 200)
  assert.equal(await db.invoice.count({ where: { orderId: first.id } }), 1)
  assert.equal(await stock(), 19)
  const paid = await db.order.findUniqueOrThrow({ where: { id: first.id } })
  assert.equal(paid.verified, true)
  assert.equal(paid.status, 'PROCESSING')
  assert.equal(paid.paymentStatus, 'PAID')
  const originalInvoice = await db.invoice.findUniqueOrThrow({ where: { orderId: first.id } })
  assert.equal(originalInvoice.snapshot.seller.name, 'Test seller brand')
  const originalSnapshot = JSON.stringify(originalInvoice.snapshot)
  await saveSettings({ storeName: 'Later seller brand' })
  assert.equal((await db.siteSettings.findUniqueOrThrow({ where: { id: 1 } })).storeName, 'Later seller brand')
  assert.equal(JSON.stringify((await db.invoice.findUniqueOrThrow({ where: { orderId: first.id } })).snapshot), originalSnapshot,
    'Changing the store brand must not rewrite an already issued invoice')
  assert.equal((await review.POST(json({ receiptId: proof.id, action: 'approve' }), params(first.id))).status, 200)
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { orderId: first.id } })).snapshot.seller.name, 'Test seller brand',
    'Approval retries must retain the original invoice seller snapshot')

  const expired = await checkout()
  await db.order.update({ where: { id: expired.id }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } })
  const expirations = await Promise.all([expireUnpaidOrders(), expireUnpaidOrders()])
  assert.equal(expirations.reduce((a, b) => a + b, 0), 1)
  assert.equal(await stock(), 19)
  assert.equal((await upload.POST(uploadRequest(), params(expired.id))).status, 409)
  const lateResponse = await upload.POST(uploadRequest({ late: true }), params(expired.id))
  assert.equal(lateResponse.status, 201)
  const lateProof = (await lateResponse.json()).receipt
  assert.equal(lateProof.isLate, true)
  assert.equal(await stock(), 19)
  await db.product.update({ where: { id: product.id }, data: { stock: 0 } })
  login(admin)
  assert.equal((await review.POST(json({ receiptId: lateProof.id, action: 'approve' }), params(expired.id))).status, 409)
  assert.equal(await db.invoice.count({ where: { orderId: expired.id } }), 0)
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: expired.id } })).verified, false)
  await db.product.update({ where: { id: product.id }, data: { stock: 19 } })
  assert.equal((await review.POST(json({ receiptId: lateProof.id, action: 'approve' }), params(expired.id))).status, 200)
  assert.equal(await stock(), 18)

  const rejected = await checkout()
  const submitted = await upload.POST(uploadRequest(), params(rejected.id))
  const rejectedProof = (await submitted.json()).receipt
  login(admin)
  assert.equal((await review.POST(json({ receiptId: rejectedProof.id, action: 'reject', note: 'Unreadable receipt' }), params(rejected.id))).status, 200)
  const rejection = await db.order.findUniqueOrThrow({ where: { id: rejected.id } })
  assert.equal(rejection.paymentStatus, 'REJECTED')
  assert.ok(rejection.paymentExpiresAt.getTime() > Date.now() + 590000)
  assert.equal((await review.POST(json({ receiptId: rejectedProof.id, action: 'reject', note: 'Retry' }), params(rejected.id))).status, 200)
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: rejected.id } })).paymentExpiresAt.getTime(), rejection.paymentExpiresAt.getTime())
  login(buyer)
  assert.equal((await upload.POST(uploadRequest(), params(rejected.id))).status, 201)
  assert.equal(await db.paymentReceipt.count({ where: { orderId: rejected.id } }), 2)
  assert.equal(await stock(), 17)

  // A customer can relinquish an unpaid reservation, but cannot cancel another
  // customer's purchase or release a payment already awaiting staff review.
  const abandoned = await checkout(buyer, { items: [
    { productId: product.id, size: 42, color: 'green', quantity: 2 },
    { productId: product.id, size: 42, color: 'green', quantity: 1 },
  ], expectedSubtotal: 300000 })
  assert.equal(await stock(), 14)
  session = null
  assert.equal((await cancel.POST(json({}), params(abandoned.id))).status, 401)
  assert.equal((await asUser(other, () => cancel.POST(json({}), params(abandoned.id)))).status, 404)
  assert.equal(await stock(), 14)
  const cancelled = await Promise.all([
    asUser(buyer, () => cancel.POST(json({}), params(abandoned.id))),
    asUser(buyer, () => cancel.POST(json({}), params(abandoned.id))),
  ])
  assert.ok(cancelled.every((response) => response.status === 200), 'Cancellation retries must be idempotent')
  const abandonedOrder = await db.order.findUniqueOrThrow({ where: { id: abandoned.id } })
  assert.equal(abandonedOrder.status, 'CANCELLED')
  assert.equal(abandonedOrder.paymentStatus, 'UNPAID')
  assert.equal(abandonedOrder.paymentExpiresAt, null)
  assert.equal(await stock(), 17, 'Grouped stock must be released exactly once')
  assert.equal((await asUser(buyer, () => cancel.POST(json({}), params(abandoned.id)))).status, 200)
  assert.equal((await asUser(buyer, () => upload.POST(uploadRequest(), params(abandoned.id)))).status, 409)
  assert.equal(await stock(), 17)
  assert.equal((await asUser(buyer, () => cancel.POST(json({}), params(first.id)))).status, 409, 'A paid order cannot be abandoned')
  assert.equal((await asUser(buyer, () => cancel.POST(json({}), params(rejected.id)))).status, 409, 'Submitted receipts retain their reservation')
  assert.equal(await stock(), 17)

  // A rejected proof has not established payment; it is safe to release its
  // held stock while retaining the audit record of the rejected upload.
  const retryAbandoned = await checkout()
  const retryProofResponse = await asUser(buyer, () => upload.POST(uploadRequest(), params(retryAbandoned.id)))
  assert.equal(retryProofResponse.status, 201)
  const retryProof = (await retryProofResponse.json()).receipt
  assert.equal((await asUser(admin, () => review.POST(json({ receiptId: retryProof.id, action: 'reject', note: 'Test unreadable proof' }), params(retryAbandoned.id)))).status, 200)
  assert.equal((await asUser(buyer, () => cancel.POST(json({}), params(retryAbandoned.id)))).status, 200)
  assert.equal(await stock(), 17)
  assert.equal(await db.paymentReceipt.count({ where: { orderId: retryAbandoned.id } }), 1)

  // Both actors may read the pending reservation, but only one may claim its
  // version and release it. The losing cancellation is still safe to retry.
  const expiryRace = await checkout()
  await db.order.update({ where: { id: expiryRace.id }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } })
  const expiryResults = await racePendingOrder(expiryRace.id, [
    () => asUser(buyer, () => cancel.POST(json({}), params(expiryRace.id))),
    () => expireUnpaidOrders(new Date(), expiryRace.id),
  ])
  assert.equal(expiryResults[0].status, 200)
  const afterExpiryRace = await db.order.findUniqueOrThrow({ where: { id: expiryRace.id } })
  assert.equal(afterExpiryRace.status, 'CANCELLED')
  assert.ok(['UNPAID', 'EXPIRED'].includes(afterExpiryRace.paymentStatus))
  assert.equal(afterExpiryRace.paymentExpiresAt, null)
  assert.equal(await stock(), 17)
  assert.equal((await asUser(buyer, () => cancel.POST(json({}), params(expiryRace.id)))).status, 200)
  assert.equal(await expireUnpaidOrders(new Date(Date.now() + 3600000), expiryRace.id), 0)
  assert.equal(await stock(), 17)

  const receiptRace = await checkout()
  const receiptResults = await racePendingOrder(receiptRace.id, [
    () => asUser(buyer, () => cancel.POST(json({}), params(receiptRace.id))),
    () => asUser(buyer, () => upload.POST(uploadRequest(), params(receiptRace.id))),
  ])
  const afterReceiptRace = await db.order.findUniqueOrThrow({ where: { id: receiptRace.id } })
  if (afterReceiptRace.paymentStatus === 'AWAITING_REVIEW') {
    assert.equal(receiptResults[0].status, 409)
    assert.equal(receiptResults[1].status, 201)
    assert.equal(afterReceiptRace.status, 'PENDING')
    assert.equal(await stock(), 16, 'A submitted proof must keep its stock reservation')
    assert.equal(await db.paymentReceipt.count({ where: { orderId: receiptRace.id } }), 1)
  } else {
    assert.equal(afterReceiptRace.paymentStatus, 'UNPAID')
    assert.equal(afterReceiptRace.status, 'CANCELLED')
    assert.equal(receiptResults[0].status, 200)
    assert.equal(receiptResults[1].status, 409)
    assert.equal(await stock(), 17, 'Cancellation winning the race must release the reservation')
    assert.equal(await db.paymentReceipt.count({ where: { orderId: receiptRace.id } }), 0)
  }

  // Distinct authentication contexts compete for the final pair. A losing
  // request cannot create an order, reserve negative stock or deduct twice.
  await db.product.update({ where: { id: product.id }, data: { stock: 1 } })
  const orderCountBefore = await db.order.count()
  const stockReads = []
  let releaseStockReads
  let failStockReads
  const bothStockReads = new Promise((resolve, reject) => { releaseStockReads = resolve; failStockReads = reject })
  const stockReadTimeout = setTimeout(() => failStockReads(new Error('Concurrent buyers did not both reach stock preflight')), 5000)
  stockReadBarrier = { productId: product.id, async arrive(stored) {
    stockReads.push(stored.stock)
    if (stockReads.length === 2) {
      stockReadBarrier = null
      clearTimeout(stockReadTimeout)
      releaseStockReads()
    }
    await bothStockReads
  } }
  let finalPair
  try { finalPair = await Promise.all([checkoutResponse(buyer), checkoutResponse(other)]) }
  finally { clearTimeout(stockReadTimeout); stockReadBarrier = null }
  assert.deepEqual(stockReads, [1, 1], 'Both users must pass the same stock preflight before competing atomically')
  const successful = finalPair.filter(({ response }) => response.status === 201)
  const unsuccessful = finalPair.filter(({ response }) => response.status === 409)
  assert.equal(successful.length, 1)
  assert.equal(unsuccessful.length, 1)
  assert.equal(unsuccessful[0].body.code, 'STOCK_UNAVAILABLE')
  assert.deepEqual(unsuccessful[0].body.outOfStock, [product.id])
  assert.equal(await stock(), 0)
  assert.equal(await db.order.count(), orderCountBefore + 1)
  const winner = await db.order.findUniqueOrThrow({ where: { id: successful[0].body.id } })
  assert.ok([buyer.id, other.id].includes(winner.userId))
  const winningUser = winner.userId === buyer.id ? buyer : other
  assert.equal((await asUser(winningUser, () => cancel.POST(json({}), params(winner.id)))).status, 200)
  assert.equal(await stock(), 1, 'The final pair must become available immediately after abandonment')
  const followingPurchase = await checkout(winner.userId === buyer.id ? other : buyer)
  assert.equal(await stock(), 0)
  assert.notEqual(followingPurchase.id, winner.id)
  console.log('PASS: PostgreSQL settings seed/projection, concurrent settings CAS, empty contact/logo persistence, immutable invoice brand snapshot, checkout, receipt/review/expiry, private access, late payment, rejection/resubmission, cancellation and stock races.')
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 }).finally(async () => {
  if (created) {
    // schema passed a strict allowlist and did not exist before this test.
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
    const remaining = await db.$queryRawUnsafe('SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1', schema)
    assert.equal(remaining.length, 0, 'Isolated payment test schema must be removed')
    console.log('Removed isolated payment test schema; cleanup verified.')
  }
  await db.$disconnect()
})
