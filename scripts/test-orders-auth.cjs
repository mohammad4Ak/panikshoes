const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Run the real handler with isolated auth/database dependencies; no live orders are touched.
const source = readFileSync(path.join(__dirname, '../src/app/api/orders/route.ts'), 'utf8')
const { code } = transformSync(source, {
  loader: 'ts', format: 'cjs', target: 'es2022',
})
const shippingSource = readFileSync(path.join(__dirname, '../src/lib/shipping.ts'), 'utf8')
const shippingContext = { module: { exports: {} } }
vm.runInNewContext(transformSync(shippingSource, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, shippingContext)

function loadHandler(session) {
  const queries = []
  const rows = [{ id: 'order-1' }]
  const dependencies = {
    'node:crypto': require('node:crypto'),
    'next/server': { NextResponse: Response }, '@/lib/request-origin': { isSameOriginRequest: () => true },
    '@/lib/shipping': shippingContext.module.exports,
    '@/lib/payments': { expireUnpaidOrders: async () => 0, methodAvailability: (method) => ({ available: Boolean(method.cardNumber && method.cardholderName) }) }, '@/lib/payment-contract': { PAYMENT_WINDOW_MS: 600000 },
    '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': {
      prisma: { order: { findMany: async (query) => { queries.push(query); return rows } } },
    },
  }
  const context = { module: { exports: {} }, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } }
  vm.runInNewContext(code, context)
  return { GET: context.module.exports.GET, queries, rows }
}

for (const session of [null, {}, { user: {} }, { user: { role: 'ADMIN' } }, { user: { id: '' } }]) {
  test(`Reject missing identity: ${JSON.stringify(session)}`, async () => {
    const { GET, queries } = loadHandler(session)
    const response = await GET()
    assert.equal(response.status, 401)
    assert.equal(queries.length, 0)
  })
}

test('Customers only query their own orders', async () => {
  const { GET, queries, rows } = loadHandler({ user: { id: 'customer-1', role: 'USER' } })
  const response = await GET()
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(queries[0].where)), { userId: 'customer-1' })
  assert.deepEqual(await response.json(), rows)
})

test('Authenticated admins can query all orders', async () => {
  const { GET, queries } = loadHandler({ user: { id: 'admin-1', role: 'ADMIN' } })
  assert.equal((await GET()).status, 200)
  assert.deepEqual(Object.keys(queries[0].where), [])
})
