// Local-only PostgreSQL regression. Every row/table lives in an isolated random
// schema, which is removed in finally; no public/business row is written.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.hostname !== '192.168.1.104' || target.pathname !== '/shoes_shop' ||
    (target.searchParams.has('schema') && target.searchParams.get('schema') !== 'public')) {
  throw new Error('Product-code integration requires the local development shoes_shop database and public source schema')
}
const schema = 'test_product_code_' + randomBytes(8).toString('hex')
assert.match(schema, /^test_product_code_[a-f0-9]{16}$/)
function identifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/)
  return '"' + value + '"'
}
const scope = identifier(schema)
const isolatedUrl = new URL(target)
isolatedUrl.searchParams.set('schema', schema)
isolatedUrl.searchParams.set('connection_limit', '4')
const source = new PrismaClient({ datasources: { db: { url: target.toString() } } })
const isolated = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } })
let createdSchema = false

const cache = new Map()
function load(relative) {
  if (cache.has(relative)) return cache.get(relative)
  const testModule = { exports: {} }
  vm.runInNewContext(transformSync(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'es2022',
  }).code, {
    module: testModule,
    require(name) {
      if (name === 'next/server') return { NextResponse: Response }
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      throw new Error('Unexpected dependency ' + name)
    },
  })
  cache.set(relative, testModule.exports)
  return testModule.exports
}
const { productCodeField, isProductCodeConflict } = load('src/lib/product-code.ts')
let fixture = 0
const data = extra => ({
  name: 'آزمایش ایزولهٔ کد محصول', slug: 'isolated-code-' + (++fixture), description: 'موقت',
  price: 100, images: [], sizes: [], colors: [], categoryId: 'isolated-unused-category', ...extra,
})
async function duplicate(operation, label) {
  let captured
  await assert.rejects(operation, error => {
    captured = error
    return error.code === 'P2002'
  })
  if (!isProductCodeConflict(captured)) console.log('CONFLICT METADATA ' + JSON.stringify(captured.meta))
  assert.equal(isProductCodeConflict(captured), true, label + ': conflict metadata must map to the product-code response')
  console.log('PASS ' + label + ' ' + JSON.stringify(captured.meta))
  return captured
}

async function main() {
  try {
    await source.$executeRawUnsafe('CREATE SCHEMA ' + scope)
    createdSchema = true
    // LIKE includes the actual installed checks, defaults and unique indexes.
    // Foreign keys are intentionally not copied; the category string is isolated.
    await source.$executeRawUnsafe('CREATE TABLE ' + scope + '."Product" (LIKE "public"."Product" INCLUDING ALL)')
    const indexes = await source.$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ${schema} AND tablename = 'Product'`
    const caseIndex = indexes.find(index => /\bUNIQUE\b/i.test(index.indexdef) && /\bupper\s*\(/i.test(index.indexdef))
    const exactIndex = indexes.find(index => /\bUNIQUE\b/i.test(index.indexdef) && /\(\s*"?code"?\s*\)/i.test(index.indexdef))
    assert.ok(caseIndex, 'The installed migration must include case-insensitive code uniqueness')
    assert.ok(exactIndex, 'The installed migration must include Prisma code uniqueness')
    // LIKE may choose fresh expression-index names; match production constraint
    // names to exercise the real Prisma error metadata, not a test-only alias.
    for (const [index, name] of [[exactIndex, 'Product_code_key'], [caseIndex, 'Product_code_upper_key']]) {
      if (index.indexname !== name) await source.$executeRawUnsafe('ALTER INDEX ' + scope + '.' + identifier(index.indexname) + ' RENAME TO ' + identifier(name))
    }
    assert.equal(await isolated.product.count(), 0)

    const fallback = await isolated.product.create({ data: data() })
    assert.match(fallback.code, /^c[a-z0-9]{20,}$/)
    assert.ok(fallback.code.length <= 64)
    console.log('PASS existing direct Prisma imports/seeds receive a nonblank unique fallback code')

    const first = await isolated.product.create({ data: data({ code: productCodeField(' sku-۰۰۶۲۲ ') }) })
    assert.equal(first.code, 'SKU-00622')
    await duplicate(() => isolated.product.create({ data: data({ code: 'SKU-00622' }) }), 'exact duplicate is rejected by PostgreSQL')
    await duplicate(() => isolated.product.create({ data: data({ code: 'sku-00622' }) }), 'mixed-case bypass is rejected by the UPPER index')

    const second = await isolated.product.create({ data: data({ code: 'SKU-00620', stock: 7, inventoryVersion: 3 }) })
    await duplicate(() => isolated.$transaction(async tx => {
      await tx.product.update({ where: { id: second.id }, data: { name: 'نباید باقی بماند', stock: 9, inventoryVersion: { increment: 1 } } })
      return tx.product.update({ where: { id: second.id }, data: { code: 'SKU-00622' } })
    }), 'conflicting edit rolls the full transaction back')
    assert.deepEqual(await isolated.product.findUniqueOrThrow({ where: { id: second.id } }), second)
    const same = await isolated.product.update({ where: { id: second.id }, data: { code: 'SKU-00620' } })
    assert.equal(same.id, second.id); assert.equal(same.slug, second.slug); assert.equal(same.stock, 7)
    const changed = await isolated.product.update({ where: { id: second.id }, data: { code: productCodeField(' new-٠٠٦٢٠ ') } })
    assert.equal(changed.code, 'NEW-00620'); assert.equal(changed.id, second.id); assert.equal(changed.slug, second.slug)
    console.log('PASS same-code saves and valid code changes preserve product identity, slug and inventory')

    for (const code of [null, '', ' ', 'WITH SPACE', 'الف', '۶۲۲', 'A'.repeat(65)]) {
      await assert.rejects(isolated.$executeRawUnsafe('UPDATE ' + scope + '."Product" SET "code" = $1 WHERE "id" = $2', code, second.id))
      assert.equal((await isolated.product.findUniqueOrThrow({ where: { id: second.id } })).code, 'NEW-00620')
    }
    console.log('PASS PostgreSQL itself rejects blank/null, non-ASCII, invalid and oversized codes')

    // Start both transactions before either insert. The unique index must
    // arbitrate concurrent writes, even without a vulnerable preflight check.
    let arrived = 0, release
    const ready = new Promise(resolve => { release = resolve })
    const results = await Promise.allSettled([' race-۰۰۶۲۲ ', 'RACE-00622'].map(code => isolated.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1`
      if (++arrived === 2) release()
      await ready
      return tx.product.create({ data: data({ code: productCodeField(code) }) })
    }, { maxWait: 10000, timeout: 20000 })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'P2002'); assert.equal(isProductCodeConflict(rejected.reason), true)
    assert.equal(await isolated.product.count({ where: { code: 'RACE-00622' } }), 1)
    console.log('PASS true concurrent transactions produce one code winner and one unique conflict')

    await isolated.product.create({ data: data({ code: 'LITERAL_00622' }) })
    await isolated.product.create({ data: data({ code: 'LITERALX00622' }) })
    const matches = await isolated.product.findMany({ where: { code: { contains: 'LITERAL\\_00622', mode: 'insensitive' } } })
    assert.deepEqual(matches.map(product => product.code), ['LITERAL_00622'])
    console.log('PASS code search escapes underscores as literal identifier characters')
  } finally {
    await isolated.$disconnect()
    if (createdSchema) {
      assert.match(schema, /^test_product_code_[a-f0-9]{16}$/)
      await source.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
      const remaining = await source.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`
      assert.equal(remaining.length, 0)
      console.log('PASS isolated schema removed; no public/business row was written')
    }
  }
}

main().catch(error => {
  console.error(error.name, error.code || '', error.message)
  process.exitCode = 1
}).finally(() => source.$disconnect())
