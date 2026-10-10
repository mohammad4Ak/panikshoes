// Opt-in real PostgreSQL check. All writes are rolled back; no storefront settings persist.
// Run: node --env-file=.env scripts/test-home-hero-settings-db.cjs
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')
const root = path.join(__dirname, '..')
const prisma = new PrismaClient()

function loadRoute(database) {
  const cache = new Map()
  function load(file) {
    const filename = path.resolve(root, file)
    if (cache.has(filename)) return cache.get(filename)
    const testModule = { exports: {} }
    const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
    vm.runInNewContext(code, { module: testModule, Response, Request, Headers, URL, Date,
      require(name) {
        if (name === 'react') return { cache: fn => fn }
        if (name === 'next/server') return { NextResponse: Response, connection: async () => {} }
        if (name === 'next/cache') return { revalidatePath: () => {} }
        if (name === '@/lib/prisma') return { prisma: database }
        if (name === '@/lib/auth') return { auth: async () => ({ user: { id: 'integration-admin', role: 'ADMIN' } }) }
        if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
        throw new Error('Unexpected dependency ' + name)
      },
    }, { filename })
    cache.set(filename, testModule.exports)
    return testModule.exports
  }
  return load('src/app/api/admin/site-settings/route.ts')
}
const request = body => new Request('http://localhost/api/admin/site-settings', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body),
})
;(async () => {
  const rollback = new Error('ROLLBACK_EXPECTED')
  try {
    await prisma.$transaction(async tx => {
      const before = await tx.siteSettings.findUnique({ where: { id: 1 } })
      assert.ok(before, 'Existing store settings required')
      const route = loadRoute({ ...tx, product: tx.product, siteSettings: tx.siteSettings, $transaction: fn => fn(tx) })
      const original = await (await route.GET()).json()
      const products = (await tx.product.findMany({ select: { id: true, images: true }, take: 100 })).filter(p => p.images[0]?.trim())
      assert.ok(products.length >= 2, 'Two real photo products required')
      const ids = [products[1].id, products[0].id]
      const input = { ...original, homeHeroProductIds: ids, homeHeroIntervalSeconds: 10 }
      const saved = await route.PATCH(request(input)); assert.equal(saved.status, 200)
      const result = await saved.json()
      assert.deepEqual(result.homeHeroProductIds, ids)
      assert.equal(result.homeHeroIntervalSeconds, 10)
      assert.equal(result.version, original.version + 1)
      for (const key of Object.keys(original).filter(k => !['version', 'homeHeroProductIds', 'homeHeroIntervalSeconds'].includes(k))) assert.deepEqual(result[key], original[key], key + ' changed')
      assert.equal((await route.PATCH(request(input))).status, 409)
      const current = await tx.siteSettings.findUnique({ where: { id: 1 } })
      assert.equal((await route.PATCH(request({ ...result, homeHeroProductIds: ['missing-' + randomUUID()] }))).status, 400)
      assert.equal((await route.PATCH(request({ ...result, homeHeroIntervalSeconds: 4 }))).status, 400)
      assert.deepEqual(await tx.siteSettings.findUnique({ where: { id: 1 } }), current)
      const cleared = await route.PATCH(request({ ...result, homeHeroProductIds: [], homeHeroIntervalSeconds: 120 }))
      assert.equal(cleared.status, 200)
      assert.deepEqual((await cleared.json()).homeHeroProductIds, [])
      throw rollback
    }, { timeout: 20000 })
    throw new Error('Test transaction unexpectedly committed')
  } catch (error) { if (error !== rollback) throw error }
  console.log('Real PostgreSQL hero ordering, interval, version conflict, validation and fallback checks passed; all writes rolled back.')
})().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => prisma.$disconnect())
