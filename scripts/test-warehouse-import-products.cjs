const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const cache = new Map()
  function read(relative) {
    const absolute = path.resolve(__dirname, '..', relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const result = { exports: {} }
    vm.runInNewContext(transformSync(fs.readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
      module: result, Date, Error, URL, URLSearchParams, Response, Request, Buffer,
      require(name) {
        if (name in dependencies) return dependencies[name]
        if (name === 'next/server') return { NextResponse: Response }
        if (name === '@prisma/client') return require(name)
        if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
        if (name.startsWith('./')) return read(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), name + '.ts')))
        throw new Error('Unexpected dependency ' + name)
      },
    })
    cache.set(absolute, result.exports)
    return result.exports
  }
  return read(file)
}
const { readWarehouseImportProducts } = load('src/lib/warehouse-import-products.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const normalize = value => value.replace(/[۰-۹٠-٩]/g, digit => String('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'.indexOf(digit) % 10)).replace(/ك/g, 'ک').replace(/ي/g, 'ی').toLowerCase()
const variant = (id = 'v', active = true) => ({ id, size: 38, color: 'مشکی', stock: 3, isActive: active })
const product = (id, extra = {}) => ({ id, code: `PN-${id}`, name: `کفش ${id}`, inventoryConfigured: true, variants: [variant(`${id}-v`)], ...extra })

// This adapter only permits the lookup's bounded read operations. SQL fragments
// are inspected separately below; matching models PostgreSQL translate + ILIKE.
function database(products) {
  const queries = [], selections = []
  const ordered = products.slice()
  const client = {
    queries, selections,
    async $queryRaw(query) {
      queries.push(query)
      assert.match(query.sql, /p\."inventoryConfigured" = true/)
      assert.match(query.sql, /EXISTS \(SELECT 1 FROM "ProductVariant"/)
      const pattern = query.values.find(value => typeof value === 'string')
      const literal = pattern ? pattern.slice(1, -1).replace(/\\([\\%_])/g, '$1') : ''
      const matches = ordered.filter(row => row.inventoryConfigured && row.variants.length &&
        (normalize(row.name).includes(normalize(literal)) || normalize(row.code).includes(normalize(literal))))
      if (/SELECT count\(\*\)/.test(query.sql)) return [{ total: BigInt(matches.length) }]
      assert.match(query.sql, /ORDER BY p\."createdAt" DESC, p\."id" ASC LIMIT \? OFFSET \?/)
      const [take, skip] = query.values.slice(-2)
      assert.equal(take, 20)
      assert.ok(Number.isInteger(skip) && skip >= 0 && skip < 200_000_000)
      return matches.slice(skip, skip + take).map(({ id }) => ({ id }))
    },
    product: {
      async findMany(args) {
        selections.push(args)
        assert.equal(args.take, 20)
        assert.equal(args.select.variants.take, 501)
        assert.equal(args.where.inventoryConfigured, true)
        assert.deepEqual(plain(args.where.variants), { some: {} })
        assert.deepEqual(plain(args.select.variants.orderBy), [{ isActive: 'desc' }, { size: 'asc' }, { color: 'asc' }, { id: 'asc' }])
        assert.deepEqual(Object.keys(args.select).sort(), ['code', 'id', 'name', 'variants'])
        assert.deepEqual(Object.keys(args.select.variants.select).sort(), ['color', 'id', 'isActive', 'size', 'stock'])
        // Reverse the DB result to verify the SQL page's stable order is restored.
        return ordered.filter(row => args.where.id.in.includes(row.id)).slice(0, args.take).reverse().map(row => ({
          id: row.id, code: row.code, name: row.name,
          variants: row.variants.slice().sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.size - b.size || a.color.localeCompare(b.color) || a.id.localeCompare(b.id)).slice(0, args.select.variants.take),
        }))
      },
    },
  }
  return client
}

test('Lookup normalizes both stored and requested mixed digits and Persian/Arabic letters for code and name', async () => {
  const client = database([
    product('name-ascii', { name: 'کتانی سلین 622' }),
    product('name-persian', { name: 'كتاني سلین ۶۲۲' }),
    product('name-arabic', { name: 'کتاني سلین ٦٢٢' }),
    product('name-mixed', { name: 'كتانی سلین 6۲٢' }),
    product('code-mixed', { code: 'pn-00۶٢2', name: 'مدل دیگر' }),
    product('other', { name: 'کتانی سلین 620' }),
  ])
  for (const q of ['622', '۶۲۲', '٦٢٢', '6۲٢']) {
    assert.deepEqual(plain((await readWarehouseImportProducts(client, new URLSearchParams({ q }))).products.map(row => row.id)), ['name-ascii', 'name-persian', 'name-arabic', 'name-mixed', 'code-mixed'])
  }
  for (const q of ['کتانی سلین 622', 'كتاني سلین ۶۲۲']) {
    assert.equal((await readWarehouseImportProducts(client, new URLSearchParams({ q }))).pagination.total, 4)
  }
  for (const q of ['PN-00622', 'pn-۰۰۶۲۲', 'pn-٠٠٦٢٢']) {
    assert.deepEqual(plain((await readWarehouseImportProducts(client, new URLSearchParams({ q }))).products.map(row => row.id)), ['code-mixed'])
  }
  for (const query of client.queries) {
    for (const column of ['name', 'code']) assert.ok(query.sql.includes(`translate(p."${column}", '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩كي', '01234567890123456789کی') ILIKE ?`))
  }
})

test('Lookup treats wildcard characters literally and never interpolates search text into SQL', async () => {
  for (const character of ['%', '_', '\\']) {
    const client = database([product('literal', { name: `مدل ${character}622` }), product('other', { name: 'مدل X622' })])
    const result = await readWarehouseImportProducts(client, new URLSearchParams({ q: `${character}622` }))
    assert.deepEqual(plain(result.products.map(row => row.id)), ['literal'])
    assert.equal(client.queries[0].values[0], `%\\${character}622%`)
  }
  const q = "'; DROP TABLE Product; --"
  const client = database([product('literal', { name: q })])
  assert.equal((await readWarehouseImportProducts(client, new URLSearchParams({ q }))).pagination.total, 1)
  for (const query of client.queries) {
    assert.ok(!query.sql.includes(q))
    assert.ok(query.values.includes(`%${q}%`))
  }
})

test('Chooser excludes unconfigured and empty products, pages at the database and clamps stale pages', async () => {
  const client = database([
    ...Array.from({ length: 45 }, (_, index) => product(`p${index}`)),
    product('legacy', { inventoryConfigured: false }), product('empty', { variants: [] }),
  ])
  const second = await readWarehouseImportProducts(client, new URLSearchParams({ page: '۲' }))
  assert.deepEqual(plain(second.pagination), { page: 2, pages: 3, total: 45, pageSize: 20 })
  assert.deepEqual(plain(second.products.map(row => row.id)), Array.from({ length: 20 }, (_, index) => `p${index + 20}`))
  const last = await readWarehouseImportProducts(client, new URLSearchParams({ page: '9999999' }))
  assert.deepEqual(plain(last.pagination), { page: 3, pages: 3, total: 45, pageSize: 20 })
  assert.equal(last.products.length, 5)
  const empty = database([])
  assert.deepEqual(plain(await readWarehouseImportProducts(empty)), { products: [], pagination: { page: 1, pages: 1, total: 0, pageSize: 20 } })
  assert.equal(empty.queries.length, 1)
  assert.equal(empty.selections.length, 0)
})

test('Malformed queries fail before a database read, while the maximum query remains bounded', async () => {
  const inaccessible = new Proxy({}, { get() { throw new Error('Invalid input reached the database') } })
  for (const query of [
    { q: 'x'.repeat(121) }, { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '10000000' }, { page: 'Infinity' }, { page: '' }, { extra: 'x' },
  ]) await assert.rejects(readWarehouseImportProducts(inaccessible, new URLSearchParams(query)), { status: 400 })
  for (const query of ['q=a&q=b', 'page=1&page=2']) await assert.rejects(readWarehouseImportProducts(inaccessible, new URLSearchParams(query)), { status: 400 })
  const client = database([])
  await readWarehouseImportProducts(client, new URLSearchParams({ q: 'x'.repeat(120), page: '9999999' }))
  assert.equal(client.queries[0].values[0].length, 122)
})

test('Large retired histories retain all active variants, bound each response and flag omitted historical choices', async () => {
  const rows = [
    ...Array.from({ length: 400 }, (_, index) => ({ ...variant(`old-${index}`, false), size: 1 + index })),
    ...Array.from({ length: 200 }, (_, index) => ({ ...variant(`active-${index}`), size: 1 + index })),
  ]
  const client = database(Array.from({ length: 25 }, (_, index) => product(`p${index}`, { variants: rows })))
  const result = await readWarehouseImportProducts(client)
  assert.equal(result.products.length, 20)
  assert.equal(result.products.reduce((sum, row) => sum + row.variants.length, 0), 10_000)
  for (const row of result.products) {
    assert.equal(row.variantsTruncated, true)
    assert.equal(row.variants.filter(value => value.isActive).length, 200)
    assert.equal(row.variants.filter(value => !value.isActive).length, 300)
    assert.equal(row.variants[200].stock, 3)
  }
  const exact = await readWarehouseImportProducts(database([product('exact', { variants: rows.slice(0, 500) })]))
  assert.equal(exact.products[0].variantsTruncated, false)
  assert.equal(exact.products[0].variants.length, 500)
})

test('An oversized legacy string cannot produce an unbounded successful response', async () => {
  await assert.rejects(readWarehouseImportProducts(database([product('huge', { name: 'x'.repeat(2_500_000) })])), { status: 413 })
})

function endpoint(session, prisma) {
  return load('src/app/api/admin/inventory/import/products/route.ts', {
    '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma },
  })
}
const request = query => new Request('http://localhost/api/admin/inventory/import/products' + (query || ''))

test('Lookup authenticates a nonempty administrator ID before all database access and never caches errors', async () => {
  const inaccessible = new Proxy({}, { get() { throw new Error('Unauthorized lookup accessed the database') } })
  for (const [session, status] of [
    [null, 401], [{ user: { role: 'ADMIN' } }, 401], [{ user: { id: '', role: 'ADMIN' } }, 401], [{ user: { id: 'customer', role: 'USER' } }, 403],
  ]) {
    const response = await endpoint(session, inaccessible).GET(request())
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('vary'), 'Cookie')
  }
})

test('Authorized reads keep count, pages and variants in one read-only repeatable snapshot', async () => {
  const client = database([product('shoe')])
  let transactions = 0
  const prisma = { async $transaction(work, options) {
    transactions++
    assert.deepEqual(plain(options), { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 })
    return work(client)
  } }
  const response = await endpoint({ user: { id: 'admin', role: 'ADMIN' } }, prisma).GET(request())
  assert.equal(response.status, 200)
  assert.equal(transactions, 1)
  assert.equal((await response.json()).products[0].id, 'shoe')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert.equal(client.queries.length, 2)
})

test('Validation and unexpected database errors retain private no-store headers', async () => {
  const admin = { user: { id: 'admin', role: 'ADMIN' } }
  for (const [prisma, query, status] of [
    [{ $transaction: work => work(database([])) }, '?page=0', 400],
    [{ $transaction: async () => { throw new Error('Connection failed') } }, '', 500],
  ]) {
    const response = await endpoint(admin, prisma).GET(request(query))
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('vary'), 'Cookie')
    assert.ok((await response.json()).error)
  }
})
