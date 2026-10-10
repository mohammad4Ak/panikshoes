const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function cron(secret) {
  let sweeps = 0
  const dependencies = {
    'node:crypto': require('node:crypto'), 'next/server': { NextResponse: Response },
    '@/lib/payments': { expireUnpaidOrders: async () => { sweeps++; return 2 } },
  }
  const source = readFileSync(path.join(__dirname, '../src/app/api/cron/payments/expire/route.ts'), 'utf8')
  const context = { module: { exports: {} }, Buffer, process: { env: { CRON_SECRET: secret } },
    require(name) { assert.ok(name in dependencies); return dependencies[name] } }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, context)
  return { route: context.module.exports, sweeps: () => sweeps }
}

test('Expiry cron never mutates inventory without a configured strong bearer secret', async () => {
  const secret = 'a'.repeat(40)
  for (const [configured, authorization] of [
    [undefined, 'Bearer undefined'], ['short', 'Bearer short'], [secret, ''],
    [secret, `Bearer ${'b'.repeat(40)}`], [secret, `Bearer ${secret}extra`],
  ]) {
    const app = cron(configured)
    const response = await app.route.GET(new Request('http://localhost/api/cron/payments/expire', { headers: { authorization } }))
    assert.equal(response.status, 401)
    assert.equal(app.sweeps(), 0)
  }
})

test('Authenticated expiry cron supports scheduler GET and POST and returns no private order data', async () => {
  const secret = 'a'.repeat(40)
  const app = cron(secret)
  for (const method of ['GET', 'POST']) {
    const response = await app.route[method](new Request('http://localhost/api/cron/payments/expire', { method, headers: { authorization: `Bearer ${secret}` } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { expired: 2 })
    assert.match(response.headers.get('cache-control'), /private.*no-store/)
  }
  assert.equal(app.sweeps(), 2)
})
