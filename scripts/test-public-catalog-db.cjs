// Run with npm run test:catalog:db. Fixtures use transaction-local temporary tables.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient, Prisma } = require('@prisma/client')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.protocol !== 'postgresql:' || target.hostname !== '192.168.1.105'
    || target.pathname !== '/shoes_shop' || (target.searchParams.get('schema') || 'public') !== 'public') {
  throw new Error('Catalog integration requires the designated local development database')
}

const prisma = new PrismaClient()
const now = new Date('2026-11-19T12:00:00.000Z')
const later = (minutes) => new Date(now.getTime() + minutes * 60_000)
const modelId = (number) => 'model-' + String(number).padStart(2, '0')

function catalogReader(db) {
  const cache = new Map()
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports
    const compiled = { exports: {} }
    cache.set(name, compiled)
    const file = path.resolve(__dirname, '..', 'src/lib', name + '.ts')
    const { code } = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' })
    vm.runInNewContext(code, {
      module: compiled, Date,
      require(dependency) {
        if (dependency === 'next/server') return { NextResponse: Response }
        if (dependency === '@prisma/client') return { Prisma }
        if (dependency === './prisma') return { prisma: db }
        if (dependency.startsWith('./')) return load(dependency.slice(2))
        throw new Error('Unexpected test dependency: ' + dependency)
      },
    }, { filename: file })
    return compiled.exports
  }
  return load('public-catalog').readPublicCatalog
}

async function insertFixtures(tx) {
  await tx.$executeRaw`CREATE TEMP TABLE "Category" (LIKE public."Category" INCLUDING DEFAULTS) ON COMMIT DROP`
  await tx.$executeRaw`CREATE TEMP TABLE "Product" (LIKE public."Product" INCLUDING DEFAULTS) ON COMMIT DROP`
  await tx.$executeRaw`CREATE TEMP TABLE "ProductReview" (LIKE public."ProductReview" INCLUDING DEFAULTS) ON COMMIT DROP`
  await tx.$executeRaw`CREATE TEMP TABLE "Order" (LIKE public."Order" INCLUDING DEFAULTS) ON COMMIT DROP`
  await tx.$executeRaw`CREATE TEMP TABLE "OrderItem" (LIKE public."OrderItem" INCLUDING DEFAULTS) ON COMMIT DROP`
  const [guard] = await tx.$queryRaw`SELECT
    'pg_temp."Product"'::regclass = '"Product"'::regclass
    AND 'pg_temp."Category"'::regclass = '"Category"'::regclass
    AND 'pg_temp."ProductReview"'::regclass = '"ProductReview"'::regclass
    AND 'pg_temp."Order"'::regclass = '"Order"'::regclass
    AND 'pg_temp."OrderItem"'::regclass = '"OrderItem"'::regclass AS "isolated"`
  assert.equal(guard.isolated, true)

  await tx.$executeRaw`INSERT INTO pg_temp."Category" ("id", "name", "slug")
    VALUES ('daily', 'روزمره', 'daily'), ('formal', 'رسمی', 'formal')`
  const sales = new Map([
    [48, { price: 0, start: later(5), end: later(60) }], // invalid promotion
    [49, { price: 100, start: now, end: later(60) }],  // starts now
    [50, { price: 80, start: later(15), end: later(120) }],
    [51, { price: 50, start: later(-60), end: now }], // expired at now
  ])
  const products = Array.from({ length: 52 }, (_, index) => {
    const number = index + 1
    const id = modelId(number)
    const sale = sales.get(number)
    const code = number === 2 ? 'PNK_0002' : 'PNK-' + number
    const name = number === 2 ? 'كفش ۶٢۲ کتان' : 'کفش ' + number
    const description = number === 3 ? 'یادداشت ویژه' : 'Fixture description'
    const viewCount = number === 49 ? 50 : number >= 50 ? 42 : 0
    return Prisma.sql`(${id}, ${code}, ${name}, ${id}, ${description}, ${1000 + number},
      ${sale?.price ?? null}, ${sale?.start ?? null}, ${sale?.end ?? null},
      ARRAY[${'/cover/' + id + '.webp'}, '/unneeded-gallery.webp'],
      ${number === 52 ? 'formal' : 'daily'}, ${number !== 47}, ${number === 46 ? 0 : 7},
      ${viewCount}, ${now}, ${now})`
  })
  await tx.$executeRaw(Prisma.sql`INSERT INTO pg_temp."Product"
    ("id", "code", "name", "slug", "description", "price", "salePrice", "saleStartsAt", "saleEndsAt",
      "images", "categoryId", "inventoryConfigured", "stock", "viewCount", "createdAt", "updatedAt")
    VALUES ${Prisma.join(products)}`)

  await tx.$executeRaw`INSERT INTO pg_temp."ProductReview" ("id", "productId", "userId", "rating", "status", "updatedAt") VALUES
    ('review-1', 'model-51', 'reader-a', 5, 'APPROVED', ${now}),
    ('review-2', 'model-51', 'reader-b', 5, 'APPROVED', ${now}),
    ('review-3', 'model-50', 'reader-a', 5, 'APPROVED', ${now}),
    ('review-4', 'model-49', 'reader-a', 4, 'APPROVED', ${now}),
    ('review-5', 'model-02', 'reader-a', 5, 'PENDING', ${now}),
    ('review-6', 'model-02', 'reader-b', 2, 'APPROVED', ${now})`
}

async function testBestselling(tx, catalog, ids) {
  await tx.$executeRaw`INSERT INTO pg_temp."Order"
    ("id", "userId", "total", "status", "verified", "paymentStatus", "address", "phone", "createdAt", "updatedAt")
    VALUES
      ('processing', 'buyer', 79, 'PROCESSING', TRUE, 'PAID', '', '', ${now}, ${now}),
      ('shipping', 'buyer', 18, 'SHIPPED', TRUE, 'PAID', '', '', ${now}, ${now}),
      ('delivered', 'buyer', 8000, 'DELIVERED', TRUE, 'PAID', '', '', ${now}, ${now}),
      ('legacy', 'buyer', 2, 'PENDING', TRUE, 'UNPAID', '', '', '2024-04-15 00:00:00', ${now}),
      ('unverified', 'buyer', 200, 'PENDING', FALSE, 'AWAITING_REVIEW', '', '', ${now}, ${now}),
      ('cancelled', 'buyer', 180, 'CANCELLED', TRUE, 'PAID', '', '', ${now}, ${now}),
      ('expired', 'buyer', 160, 'CANCELLED', FALSE, 'EXPIRED', '', '', ${now}, ${now})`
  await tx.$executeRaw`INSERT INTO pg_temp."OrderItem"
    ("id", "orderId", "productId", "variantId", "quantity", "size", "color", "price")
    VALUES
      ('line-1', 'processing', 'model-50', 'black-38', 4, 38, 'مشکی', 1),
      ('line-2', 'processing', 'model-50', 'green-40', 3, 40, 'سبز', 1),
      ('line-3', 'legacy', 'model-50', NULL, 2, 38, 'مشکی', 1),
      ('line-4', 'processing', 'model-49', NULL, 8, 38, 'مشکی', 9),
      ('line-5', 'shipping', 'model-48', NULL, 8, 38, 'مشکی', 1),
      ('line-6', 'delivered', 'model-51', NULL, 8, 38, 'مشکی', 1000),
      ('line-7', 'shipping', 'model-46', NULL, 10, 38, 'مشکی', 1),
      ('line-8', 'processing', 'model-52', NULL, 11, 38, 'مشکی', 1),
      ('line-9', 'unverified', 'model-01', NULL, 200, 38, 'مشکی', 1),
      ('line-10', 'cancelled', 'model-02', NULL, 180, 38, 'مشکی', 1),
      ('line-11', 'expired', 'model-03', NULL, 160, 38, 'مشکی', 1)`
  await tx.$executeRaw`UPDATE pg_temp."Product" SET "createdAt" = ${later(1)} WHERE "id" IN ('model-51', 'model-05')`

  const sort = 'bestselling'
  const first = await catalog({ sort })
  const second = await catalog({ sort, page: '2' })
  const third = await catalog({ sort, page: '3' })
  const bestsellers = ['model-52', 'model-46', 'model-50', 'model-51', 'model-48', 'model-49']
  const remaining = Array.from({ length: 52 }, (_, index) => modelId(index + 1))
    .filter(id => id !== 'model-05' && !bestsellers.includes(id))
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [24, 24, 4])
  assert.deepEqual([...ids(first), ...ids(second), ...ids(third)], [...bestsellers, 'model-05', ...remaining])
  assert.equal(first.total, 52)

  const inStockDaily = await catalog({ sort, cat: 'daily', stock: '1', min: '1000' })
  assert.deepEqual(ids(inStockDaily).slice(0, 3), ['model-50', 'model-51', 'model-48'])
  const card = first.items.find(item => item.id === 'model-50')
  const [ordinaryCard] = (await catalog({ q: 'pnk-50' })).items
  assert.deepEqual(card, ordinaryCard, 'Bestselling should not add internal sales information to cards')
  console.log('PASS all-time paid quantities across variants, cancellation exclusions and ranked pagination')
}

async function testCatalog() {
  const rollback = new Error('ROLLBACK_CATALOG_FIXTURES')
  try {
    await prisma.$transaction(async tx => {
      await insertFixtures(tx)
      const read = catalogReader(tx)
      const catalog = (params = {}, time = now) => read(new URLSearchParams(params), time)
      const ids = (result) => Array.from(result.items, item => item.id)

      const first = await catalog({ cat: 'daily' })
      const second = await catalog({ cat: 'daily', page: '۲' })
      const third = await catalog({ cat: 'daily', page: '3' })
      assert.deepEqual([first.items.length, second.items.length, third.items.length], [24, 24, 3])
      assert.deepEqual([first.hasMore, second.hasMore, third.hasMore], [true, true, false])
      assert.deepEqual([...ids(first), ...ids(second), ...ids(third)], Array.from({ length: 51 }, (_, i) => modelId(i + 1)))
      assert.equal(first.total, 51)
      assert.equal(second.total, 51)
      assert.deepEqual(ids(await catalog({ cat: 'daily', page: '4' })), [])
      assert.equal((await catalog({ cat: 'missing' })).total, 0)
      assert.equal(first.items[0].images.length, 1)
      assert.equal(Object.hasOwn(first.items[0], 'variants'), false)
      assert.equal(Object.hasOwn(first.items[0], 'description'), false)
      console.log('PASS bounded card data, stable 24-item pages, exact counts and empty results')

      assert.deepEqual(ids(await catalog({ sort: 'cheap' })).slice(0, 2), ['model-49', 'model-01'])
      assert.deepEqual(ids(await catalog({ sort: 'expensive' })).slice(0, 2), ['model-52', 'model-51'])
      const discounted = { sort: 'cheap', min: '۷۵', max: '۱۵۰' }
      assert.deepEqual(ids(await catalog(discounted)), ['model-49'])
      assert.equal((await catalog(discounted)).nextPriceChangeAt, later(15).toISOString())
      assert.deepEqual(ids(await catalog(discounted, later(15))), ['model-50', 'model-49'])
      assert.deepEqual(ids(await catalog(discounted, later(60))), ['model-50'])
      assert.deepEqual(ids(await catalog(discounted, later(120))), [])
      assert.equal((await catalog({ cat: 'daily', stock: '1' })).total, 49)
      assert.equal((await catalog({ q: 'pnk-47' })).items[0].stock, 0)
      console.log('PASS global discount-aware ordering and filtering, future price changes, legacy stock')

      const popular = await catalog({ sort: 'popular' })
      assert.deepEqual(ids(popular).slice(0, 4), ['model-51', 'model-50', 'model-49', 'model-02'])
      assert.equal(popular.items[3].ratingAverage, 2)
      assert.equal(popular.items[3].ratingCount, 1)
      assert.deepEqual(ids(await catalog({ sort: 'views' })).slice(0, 3), ['model-49', 'model-51', 'model-50'])
      for (const q of ['622', '۶۲۲', '٦٢٢', 'کفش 622', 'pnk_۰۰۰۲', '_']) {
        assert.deepEqual(ids(await catalog({ q })), ['model-02'])
      }
      assert.deepEqual(ids(await catalog({ q: 'يادداشت' })), ['model-03'])
      assert.deepEqual(ids(await catalog({ q: '%', sort: 'unknown' })), [])
      assert.deepEqual(ids(await catalog({ q: '622', cat: 'formal' })), [])
      await assert.rejects(catalog({ q: 'x'.repeat(201) }), { status: 400 })
      await assert.rejects(catalog({ page: '0' }), { status: 400 })
      console.log('PASS approved-only ratings, view ordering, localized search and input bounds')
      await testBestselling(tx, catalog, ids)
      throw rollback
    }, { timeout: 20_000 })
    throw new Error('Catalog fixture transaction unexpectedly committed')
  } catch (error) {
    if (error !== rollback) throw error
  }
  console.log('PASS temporary PostgreSQL fixtures rolled back')
}

testCatalog()
  .catch(error => { console.error(String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[database URL]')); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
