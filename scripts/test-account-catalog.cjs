const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const admin = { user: { id: 'admin', role: 'ADMIN' } }
const customer = { user: { id: 'customer', role: 'USER' } }
const context = (id = 'target') => ({ params: Promise.resolve({ id }) })
const request = (body) => new Request('http://localhost/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const pricingSnapshot = row => ({ price: row.price, salePrice: row.salePrice ?? null, saleStartsAt: row.saleStartsAt ?? null, saleEndsAt: row.saleEndsAt ?? null })

// Execute the real modules against isolated auth/database/filesystem doubles.
// No account, order, image upload, or database row is changed by this suite.
function load(file, { session = admin, prisma = {}, bcrypt = {}, files = {}, now = () => Date.now() } = {}) {
  const cache = new Map()
  let authConfig
  const dependencies = {
    'next/server': { NextResponse: Response },
    '@/lib/prisma': { prisma }, './prisma': { prisma },
    '@/lib/auth': { auth: async () => session },
    '@/lib/payments': { expireUnpaidOrders: async () => 0 },
    'bcryptjs': { hash: async () => 'hash', compare: async () => true, ...bcrypt },
    'next-auth': (config) => { authConfig = config; return {} },
    'next-auth/providers/credentials': (config) => config,
    'fs/promises': files,
    path,
  }
  function readModule(filename) {
    const absolute = path.resolve(root, filename)
    if (cache.has(absolute)) return cache.get(absolute)
    const testModule = { exports: {} }
    cache.set(absolute, testModule.exports)
    const source = readFileSync(absolute, 'utf8')
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
    const requireDependency = (name) => {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('@/lib/')) return readModule(`src/lib/${name.slice(6)}.ts`)
      if (name.startsWith('./')) return readModule(path.relative(root, path.join(path.dirname(absolute), `${name}.ts`)))
      throw new Error(`Unexpected dependency ${name}`)
    }
    vm.runInNewContext(code, { module: testModule, require: requireDependency, Response, Buffer, URL,
      Date: class extends Date { static now() { return now() } },
      process: { env: {}, cwd: () => root } }, { filename: absolute })
    cache.set(absolute, testModule.exports)
    return testModule.exports
  }
  return { handlers: readModule(file), authConfig: () => authConfig }
}

test('Existing JWT uses the current DB role and identity, ignoring stale ADMIN and client updates', async () => {
  const queried = []
  const { authConfig } = load('src/lib/auth.ts', { prisma: { user: { findUnique: async (query) => {
    queried.push(query)
    return { id: 'customer', role: 'USER', name: 'New name', email: 'current@example.com' }
  } } } })
  const token = await authConfig().callbacks.jwt({ token: { id: 'customer', role: 'ADMIN', name: 'Old name', iat: Math.floor(Date.now() / 1000) }, session: { role: 'ADMIN' }, trigger: 'update' })
  assert.equal(token.role, 'USER')
  assert.equal(token.name, 'New name')
  assert.equal(queried[0].where.id, 'customer')
  const session = await authConfig().callbacks.session({ session: { user: {} }, token })
  assert.equal(session.user.email, 'current@example.com')
  assert.equal(session.user.role, 'USER')
})

test('Deleted account invalidates its old JWT', async () => {
  const { authConfig } = load('src/lib/auth.ts', { prisma: { user: { findUnique: async () => null } } })
  assert.equal(await authConfig().callbacks.jwt({ token: { id: 'deleted', role: 'ADMIN', iat: Math.floor(Date.now() / 1000) } }), null)
  assert.equal(await authConfig().callbacks.jwt({ token: {} }), null)
})

function idleAuth(clock, role = 'USER') {
  let queries = 0
  const { authConfig } = load('src/lib/auth.ts', { now: () => clock.now, prisma: {
    user: { findUnique: async () => {
      queries++
      return { id: 'customer', role, name: 'Current name', email: 'current@example.com' }
    } },
  } })
  return { config: authConfig(), queries: () => queries }
}

const idleTimeout = 30 * 60 * 1000
const clockStart = 1_800_000_000_000

test('Login starts a server-timed 30-minute session for both customers and admins', async () => {
  for (const role of ['USER', 'ADMIN']) {
    const clock = { now: clockStart }
    const { config } = idleAuth(clock, role)
    assert.equal(config.session.maxAge, 1800)
    assert.equal(config.jwt.maxAge, 1800)
    const token = await config.callbacks.jwt({
      token: { lastActivityAt: clockStart - idleTimeout * 10 },
      user: { id: 'customer', role: 'ADMIN' }, trigger: 'signIn',
    })
    assert.equal(token.lastActivityAt, clockStart)
    assert.equal(token.role, role)
    const session = await config.callbacks.session({
      session: { user: {}, expires: '2099-01-01T00:00:00.000Z' }, token,
    })
    assert.equal(session.expires, new Date(clockStart + idleTimeout).toISOString())
    assert.equal(session.serverTime, clock.now)
  }
})

test('Background session reads preserve the signed activity deadline even if AuthJS rolls iat', async () => {
  const clock = { now: clockStart + 10 * 60 * 1000 }
  const { config, queries } = idleAuth(clock)
  let token = { id: 'customer', lastActivityAt: clockStart }
  token = await config.callbacks.jwt({ token })
  assert.equal(token.lastActivityAt, clockStart)
  clock.now = clockStart + idleTimeout - 1
  token = await config.callbacks.jwt({ token: { ...token, iat: clock.now / 1000 } })
  assert.equal(token.lastActivityAt, clockStart)
  assert.equal(queries(), 2)
  clock.now++
  assert.equal(await config.callbacks.jwt({ token: { ...token, iat: clock.now / 1000 } }), null)
  assert.equal(queries(), 2)
})

test('Genuine activity before expiry renews using server time and ignores client identity/timestamps', async () => {
  const clock = { now: clockStart + idleTimeout - 1 }
  const { config } = idleAuth(clock)
  const token = await config.callbacks.jwt({
    token: { id: 'customer', lastActivityAt: clockStart, role: 'ADMIN' }, trigger: 'update',
    session: { activity: true, lastActivityAt: clockStart + idleTimeout * 20, id: 'admin', role: 'ADMIN' },
  })
  assert.equal(token.lastActivityAt, clock.now)
  assert.equal(token.id, 'customer')
  assert.equal(token.role, 'USER')
  clock.now += idleTimeout - 1
  assert.ok(await config.callbacks.jwt({ token }))
  clock.now++
  assert.equal(await config.callbacks.jwt({ token }), null)
})

test('Expired sessions cannot be revived by an activity update, including old 30-day cookies', async () => {
  const clock = { now: clockStart + idleTimeout }
  for (const token of [
    { id: 'customer', lastActivityAt: clockStart, exp: clock.now / 1000 + 30 * 86400 },
    { id: 'customer', iat: clockStart / 1000, exp: clock.now / 1000 + 30 * 86400 },
  ]) {
    const { config, queries } = idleAuth(clock)
    assert.equal(await config.callbacks.jwt({ token, trigger: 'update', session: { activity: true } }), null)
    assert.equal(queries(), 0)
  }
})

test('Updates without the explicit activity flag and GET payloads cannot renew a session', async () => {
  const clock = { now: clockStart + 1000 }
  const { config } = idleAuth(clock)
  for (const input of [
    { trigger: 'update', session: undefined },
    { trigger: 'update', session: { activity: false } },
    { trigger: 'update', session: { activity: 'true', lastActivityAt: clock.now } },
    { session: { activity: true } },
  ]) {
    const token = await config.callbacks.jwt({ token: { id: 'customer', lastActivityAt: clockStart }, ...input })
    assert.equal(token.lastActivityAt, clockStart)
  }
})

test('Recent legacy JWTs acquire a fixed activity claim from iat rather than the time of reading', async () => {
  const clock = { now: clockStart + 60 * 1000 }
  const { config } = idleAuth(clock)
  const adopted = await config.callbacks.jwt({ token: { id: 'customer', iat: clockStart / 1000 } })
  assert.equal(adopted.lastActivityAt, clockStart)
  clock.now += 60 * 1000
  const reread = await config.callbacks.jwt({ token: { ...adopted, iat: clock.now / 1000 } })
  assert.equal(reread.lastActivityAt, clockStart)
})

test('Missing, malformed and future activity timestamps fail closed before DB access', async () => {
  const clock = { now: clockStart }
  const { config, queries } = idleAuth(clock)
  for (const timestamp of [null, '1800000000000', 0, -1, NaN, Infinity, clockStart + 1, clockStart - 0.5]) {
    assert.equal(await config.callbacks.jwt({
      token: { id: 'customer', lastActivityAt: timestamp, iat: clockStart / 1000 },
      trigger: 'update', session: { activity: true },
    }), null)
  }
  for (const token of [{ id: 'customer' }, { id: 'customer', iat: '1800000000' }, { id: 'customer', iat: clockStart / 1000 + 1 }]) {
    assert.equal(await config.callbacks.jwt({ token }), null)
  }
  assert.equal(queries(), 0)
})

test('Login validates credential types and finds existing mixed-case email accounts', async () => {
  let query
  const { authConfig } = load('src/lib/auth.ts', { prisma: { user: { findFirst: async (value) => {
    query = value
    return { id: 'user', email: 'Mixed@Example.com', password: 'hash', role: 'USER', name: 'Name' }
  } } } })
  const authorize = authConfig().providers[0].authorize
  assert.equal(await authorize({ email: {}, password: [] }), null)
  assert.equal((await authorize({ email: ' mixed@example.com ', password: 'abcdef' })).id, 'user')
  assert.equal(query.where.email.equals, 'mixed@example.com')
  assert.equal(query.where.email.mode, 'insensitive')
})

for (const body of [null, [], { name: 3, email: 'a@b.com', password: 'abcdef' },
  { name: 'Name', email: 'bad', password: 'abcdef' }, { name: 'Name', email: 'a@b.com', password: 123456 },
  { name: 'Name', email: 'a@b.com', password: 'ا'.repeat(37) }]) {
  test(`Registration rejects invalid data before DB access: ${JSON.stringify(body)}`, async () => {
    const { handlers } = load('src/app/api/auth/register/route.ts')
    assert.equal((await handlers.POST(request(body))).status, 400)
  })
}

test('Malformed registration JSON returns 400', async () => {
  const { handlers } = load('src/app/api/auth/register/route.ts')
  const response = await handlers.POST(new Request('http://localhost/api', { method: 'POST', body: '{broken' }))
  assert.equal(response.status, 400)
})

test('Registration normalizes email/name and cannot accept an ADMIN role or leak password', async () => {
  let created
  const { handlers } = load('src/app/api/auth/register/route.ts', { prisma: { user: {
    findFirst: async () => null,
    create: async (query) => { created = query; return { id: 'new', name: query.data.name, email: query.data.email } },
  } } })
  const response = await handlers.POST(request({ name: ' Name ', email: ' TEST@Example.com ', password: 'abcdef', role: 'ADMIN' }))
  assert.equal(response.status, 201)
  assert.equal(created.data.role, 'USER')
  assert.equal(created.data.email, 'test@example.com')
  assert.equal(created.data.name, 'Name')
  assert.ok(!('password' in (await response.json())))
})

test('Registration handles case duplicate and concurrent unique conflict as 409', async () => {
  for (const existing of [true, false]) {
    const { handlers } = load('src/app/api/auth/register/route.ts', { prisma: { user: {
      findFirst: async () => existing ? { id: 'existing' } : null,
      create: async () => { throw { code: 'P2002' } },
    } } })
    assert.equal((await handlers.POST(request({ name: 'Name', email: 'a@b.com', password: 'abcdef' }))).status, 409)
  }
})

for (const session of [null, {}, { user: {} }, customer, { user: { role: 'ADMIN' } }]) {
  test(`Admin user/catalog/upload writes reject missing identity or customer role: ${JSON.stringify(session)}`, async () => {
    for (const file of ['users', 'products', 'categories', 'upload']) {
      const { handlers } = load(`src/app/api/${file}/route.ts`, { session })
      assert.equal((await handlers.POST(request({}))).status, 401)
    }
  })
}

test('Deleting a user with order history leaves users, orders and lines untouched', async () => {
  let deletes = 0
  const user = { findUnique: async () => ({ role: 'USER', _count: { orders: 2 } }), delete: async () => { deletes++ } }
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: { $transaction: async (operation) => operation({ user }) } })
  assert.equal((await handlers.DELETE(request({}), context())).status, 409)
  assert.equal(deletes, 0)
})

test('Deleting a product with historical order lines preserves those lines', async () => {
  let deletes = 0
  const product = { findUnique: async () => ({ _count: { orderItems: 1 } }), delete: async () => { deletes++ } }
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { $transaction: async (operation) => operation({ product }) } })
  assert.equal((await handlers.DELETE(request({}), context())).status, 409)
  assert.equal(deletes, 0)
})

test('Unreferenced product deletes; new FK reference during deletion returns 409', async () => {
  for (const conflict of [false, true]) {
    const product = { findUnique: async () => ({ _count: { orderItems: 0 } }), delete: async () => {
      if (conflict) throw { code: 'P2003' }
    } }
    const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { $transaction: async (operation) => operation({ product }) } })
    assert.equal((await handlers.DELETE(request({}), context())).status, conflict ? 409 : 200)
  }
})

test('Self/admin deletion and self-demotion remain blocked on the server', async () => {
  const user = { findUnique: async () => ({ role: 'ADMIN', _count: { orders: 0 } }) }
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: { $transaction: async (operation) => operation({ user }) } })
  assert.equal((await handlers.DELETE(request({}), context('admin'))).status, 400)
  assert.equal((await handlers.DELETE(request({}), context('other-admin'))).status, 409)
  assert.equal((await handlers.PATCH(request({ role: 'USER' }), context('admin'))).status, 400)
})

test('Admin demotion checks the current actor and keeps at least one admin inside a serializable transaction', async () => {
  for (const scenario of [{ actorRole: 'ADMIN', admins: 1, expected: 409 },
    { actorRole: 'USER', admins: 2, expected: 401 }, { actorRole: 'ADMIN', admins: 2, expected: 200 }]) {
    let updates = 0
    const user = {
      findUnique: async ({ where }) => ({ role: where.id === 'admin' ? scenario.actorRole : 'ADMIN' }),
      count: async () => scenario.admins,
      update: async () => { updates++; return { id: 'target', role: 'USER' } },
    }
    const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: { $transaction: async (operation, config) => {
      assert.equal(config.isolationLevel, 'Serializable')
      return operation({ user })
    } } })
    assert.equal((await handlers.PATCH(request({ role: 'USER' }), context())).status, scenario.expected)
    assert.equal(updates, scenario.expected === 200 ? 1 : 0)
  }
})

test('A demotion conflict retries the permission check instead of trusting the old ADMIN session', async () => {
  let attempts = 0
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: { $transaction: async (operation) => {
    if (++attempts === 1) throw { code: 'P2034' }
    return operation({ user: { findUnique: async () => ({ role: 'USER' }) } })
  } } })
  assert.equal((await handlers.PATCH(request({ role: 'USER' }), context())).status, 401)
  assert.equal(attempts, 2)
})

const invalidProductValues = [
  { price: -1 }, { price: 0 }, { price: 1.5 }, { price: 2_147_483_648 }, { price: 'NaN' }, { price: true },
  { stock: -1 }, { stock: 1.5 }, { stock: null }, { featured: 'false' }, { featured: null },
  { sizes: '40' }, { sizes: [0] }, { sizes: ['no'] }, { sizes: [41.5] },
  { colors: 'black' }, { colors: [''] }, { images: [{}] }, { images: ['javascript:alert(1)'] },
  { name: 1 }, { categoryId: {} },
]
for (const body of invalidProductValues) {
  test(`Product create/update rejects invalid business value before DB access: ${JSON.stringify(body)}`, async () => {
    const { handlers: create } = load('src/app/api/products/route.ts')
    const { handlers: update } = load('src/app/api/products/[id]/route.ts')
    assert.equal((await create.POST(request({ name: 'Name', price: 100, categoryId: 'cat', ...body }))).status, 400)
    assert.equal((await update.PUT(request(body), context())).status, 400)
  })
}

test('Valid numeric form values normalize without turning false into true', async () => {
  let written
  const { handlers } = load('src/app/api/products/route.ts', { prisma: {
    category: { findUnique: async () => ({ id: 'cat' }) },
    product: { create: async (query) => { written = query.data; return { id: 'new', ...query.data } } },
  } })
  const response = await handlers.POST(request({ name: ' Name ', price: '100', categoryId: 'cat', stock: '0',
    sizes: ['40', 40, 41], colors: [' black ', 'black'], images: [], featured: false }))
  assert.equal(response.status, 201)
  assert.equal(written.price, 100)
  assert.equal(written.stock, 0)
  assert.equal(written.featured, false)
  assert.deepEqual(Array.from(written.sizes), [40, 41])
  assert.deepEqual(Array.from(written.colors), ['black'])
  assert.equal(written.images.length, 1)
})

test('Stocked products require a size using merged existing and updated values', async () => {
  const { handlers: create } = load('src/app/api/products/route.ts')
  assert.equal((await create.POST(request({ name: 'Name', price: 100, categoryId: 'cat', stock: 1, sizes: [] }))).status, 400)
  for (const scenario of [
    { existing: { stock: 5, sizes: [41] }, body: { sizes: [] }, expected: 400 },
    { existing: { stock: 0, sizes: [] }, body: { stock: 2, expectedStock: 0 }, expected: 400 },
    { existing: { stock: 0, sizes: [] }, body: { stock: 2, sizes: [42], expectedStock: 0 }, expected: 200 },
    { existing: { stock: 5, sizes: [41], price: 100 }, body: { price: 200, expectedPricing: pricingSnapshot({ price: 100 }) }, expected: 200 },
  ]) {
    let updates = 0
    const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
      findUnique: async () => scenario.existing,
      update: async () => { updates++; return { id: 'target' } },
    } } })
    assert.equal((await handlers.PUT(request(scenario.body), context())).status, scenario.expected)
    assert.equal(updates, scenario.expected === 200 ? 1 : 0)
  }
})

test('Product sale creation rejects invalid money and calendar schedules before writing', async () => {
  for (const sale of [
    { salePrice: 0 }, { salePrice: 100 }, { salePrice: 101 }, { salePrice: 1.5 },
    { salePrice: 80, saleStartsAt: 'not-a-date' },
    { salePrice: 80, saleStartsAt: '2026-10-15T10:00' },
    { salePrice: 80, saleStartsAt: '2026-02-30T10:00:00Z' },
    { salePrice: 80, saleStartsAt: '2026-10-15T10:00:00Z', saleEndsAt: '2026-10-15T09:00:00Z' },
    { salePrice: 80, saleStartsAt: '2026-10-15T10:00:00Z', saleEndsAt: '2026-10-15T10:00:00Z' },
    { saleStartsAt: '2026-10-15T10:00:00Z' },
  ]) {
    const { handlers } = load('src/app/api/products/route.ts')
    assert.equal((await handlers.POST(request({ name: 'Name', price: 100, categoryId: 'cat', ...sale }))).status, 400, JSON.stringify(sale))
  }
})

test('Partial price and schedule edits validate against the current product sale; clearing removes its schedule', async () => {
  const row = { id: 'target', price: 100, salePrice: 80, saleStartsAt: new Date('2026-10-15T10:00:00Z'), saleEndsAt: new Date('2026-10-15T12:00:00Z'), sizes: [], stock: 0 }
  const writes = []
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
    findUnique: async () => ({ ...row }),
    update: async ({ data, where }) => { writes.push({ data, where }); return Object.assign(row, data) },
  } } })
  for (const changes of [{ price: 70 }, { salePrice: 100 }, { saleStartsAt: '2026-10-15T13:00:00Z' }, { saleEndsAt: '2026-10-15T09:00:00Z' }]) {
    assert.equal((await handlers.PUT(request({ ...changes, expectedPricing: pricingSnapshot(row) }), context())).status, 400, JSON.stringify(changes))
  }
  assert.equal(writes.length, 0)
  assert.equal((await handlers.PUT(request({ salePrice: 75, expectedPricing: pricingSnapshot(row) }), context())).status, 200)
  assert.equal(row.price, 100)
  assert.equal(row.salePrice, 75)
  assert.equal(writes[0].where.salePrice, 80, 'The merge is protected against concurrent pricing edits')
  assert.equal((await handlers.PUT(request({ salePrice: null, price: 70, expectedPricing: pricingSnapshot(row) }), context())).status, 200)
  assert.equal(row.salePrice, null)
  assert.equal(row.saleStartsAt, null)
  assert.equal(row.saleEndsAt, null)
  assert.equal(row.price, 70)
})

test('A concurrent pricing edit cannot write a discount validated against an obsolete base price', async () => {
  let writes = 0
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
    findUnique: async () => ({ id: 'target', price: 100, salePrice: null, saleStartsAt: null, saleEndsAt: null, sizes: [], stock: 0 }),
    update: async ({ where }) => { assert.equal(where.price, 100); writes++; throw { code: 'P2025' } },
  } } })
  const response = await handlers.PUT(request({ salePrice: 80, expectedPricing: pricingSnapshot({ price: 100 }) }), context())
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'PRODUCT_PRICE_CHANGED')
  assert.equal(writes, 1)
})

test('A stale admin pricing snapshot cannot overwrite a sale changed before saving the form', async () => {
  const row = { id: 'target', price: 100, salePrice: 70, saleStartsAt: new Date('2026-10-15T10:00:32Z'), saleEndsAt: null, stock: 0, sizes: [] }
  let writes = 0
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
    findUnique: async () => ({ ...row }), update: async ({ data }) => { writes++; return Object.assign(row, data) },
  } } })
  for (const stale of [
    { ...pricingSnapshot(row), salePrice: 80 },
    { ...pricingSnapshot(row), price: 110 },
    { ...pricingSnapshot(row), saleStartsAt: '2026-10-15T10:00:00Z' },
    { ...pricingSnapshot(row), saleEndsAt: '2026-10-16T10:00:00Z' },
  ]) {
    const result = await handlers.PUT(request({ description: 'New description', salePrice: 60, expectedPricing: stale }), context())
    assert.equal(result.status, 409)
    assert.equal((await result.json()).code, 'PRODUCT_PRICE_CHANGED')
  }
  assert.equal(writes, 0)
  assert.equal(row.salePrice, 70)
  assert.equal((await handlers.PUT(request({ description: 'Metadata only' }), context())).status, 200)
  assert.equal(row.salePrice, 70)
  assert.equal(row.description, 'Metadata only')
})

test('Pricing writes require a complete valid original snapshot', async () => {
  let writes = 0
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
    findUnique: async () => ({ price: 100, stock: 0, sizes: [] }), update: async () => { writes++; return {} },
  } } })
  for (const expectedPricing of [undefined, null, [], {}, { price: 100 }, { ...pricingSnapshot({ price: 100 }), salePrice: -1 }, { ...pricingSnapshot({ price: 100 }), saleEndsAt: 'not-a-date' }]) {
    assert.equal((await handlers.PUT(request({ salePrice: 80, expectedPricing }), context())).status, 400)
  }
  assert.equal(writes, 0)
})

test('Stale admin inventory edits never restore stock consumed by a checkout', async () => {
  let writes = 0
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
    findUnique: async () => ({ stock: 7, sizes: [42] }),
    update: async () => { writes++; return {} },
  } } })
  const result = await handlers.PUT(request({ name: 'Renamed shoe', stock: 10, expectedStock: 8 }), context())
  assert.equal(result.status, 409)
  assert.equal((await result.json()).code, 'PRODUCT_STOCK_CHANGED')
  assert.equal(writes, 0)
})

test('Inventory writes require a valid previous count, while metadata edits preserve current inventory', async () => {
  const row = { id: 'target', stock: 7, sizes: [42], name: 'Original' }
  let writes = 0
  const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
    findUnique: async () => ({ ...row }),
    update: async ({ data }) => { writes++; return Object.assign(row, data) },
  } } })
  for (const expectedStock of [undefined, null, -1, 1.5, 'invalid']) {
    assert.equal((await handlers.PUT(request({ stock: 9, expectedStock }), context())).status, 400)
  }
  assert.equal(writes, 0)
  assert.equal((await handlers.PUT(request({ name: 'Renamed shoe' }), context())).status, 200)
  assert.equal(row.stock, 7)
  assert.equal(row.name, 'Renamed shoe')
  assert.equal((await handlers.PUT(request({ stock: 9, expectedStock: 7 }), context())).status, 200)
  assert.equal(row.stock, 9)
})

test('A checkout racing after the inventory read is caught atomically without partial metadata writes', async () => {
  for (const body of [{ stock: 10, expectedStock: 8, name: 'New name' }, { sizes: [], name: 'New name' }]) {
    const row = { stock: body.stock === undefined ? 0 : 8, sizes: [42], name: 'Original' }
    const { handlers } = load('src/app/api/products/[id]/route.ts', { prisma: { product: {
      findUnique: async () => ({ ...row }),
      update: async ({ where, data }) => {
        // Simulate checkout/reservation release after validation but before UPDATE.
        row.stock += body.stock === undefined ? 1 : -1
        if (where.stock !== undefined && where.stock !== row.stock) throw { code: 'P2025' }
        return Object.assign(row, data)
      },
    } } })
    const result = await handlers.PUT(request(body), context())
    assert.equal(result.status, 409)
    assert.equal((await result.json()).code, 'PRODUCT_STOCK_CHANGED')
    assert.equal(row.stock, body.stock === undefined ? 1 : 7)
    assert.equal(row.name, 'Original')
    assert.deepEqual(row.sizes, [42])
  }
})

test('Unknown product category is rejected; unavailable category deletion is 404', async () => {
  const { handlers } = load('src/app/api/products/route.ts', { prisma: { category: { findUnique: async () => null } } })
  assert.equal((await handlers.POST(request({ name: 'Name', price: 100, categoryId: 'gone' }))).status, 400)
  const { handlers: category } = load('src/app/api/categories/[id]/route.ts', {
    prisma: { $transaction: async (operation) => operation({ category: { findUnique: async () => null } }) },
  })
  assert.equal((await category.DELETE(request({}), context())).status, 404)
})

test('Profile updates reject malformed data and never accept role/password changes', async () => {
  let written
  const { handlers } = load('src/app/api/profile/route.ts', { session: customer, prisma: {
    user: { update: async (query) => { written = query; return { id: 'customer', name: query.data.name } } },
  } })
  for (const body of [{ name: 1 }, { name: '' }, { phone: {} }]) assert.equal((await handlers.PATCH(request(body))).status, 400)
  assert.equal((await handlers.PATCH(request({ name: ' New ', role: 'ADMIN', password: 'new' }))).status, 200)
  assert.equal(written.where.id, 'customer')
  assert.deepEqual(Object.keys(written.data), ['name'])
})

function addressDatabase(initial = []) {
  const rows = initial.map((row) => ({ userId: 'customer', ...row }))
  const options = []
  const matches = (row, where) => Object.entries(where).every(([key, value]) =>
    value && typeof value === 'object' && 'not' in value ? row[key] !== value.not : row[key] === value)
  const address = {
    findFirst: async ({ where }) => rows.find((row) => matches(row, where)) ?? null,
    updateMany: async ({ where, data }) => { for (const row of rows) if (matches(row, where)) Object.assign(row, data) },
    create: async ({ data }) => { const row = { id: `a${rows.length + 1}`, ...data }; rows.push(row); return row },
    update: async ({ where, data }) => { const row = rows.find((row) => matches(row, where)); assert.ok(row); Object.assign(row, data); return row },
    delete: async ({ where }) => { const index = rows.findIndex((row) => matches(row, where)); assert.ok(index >= 0); rows.splice(index, 1) },
  }
  return { rows, options, prisma: { address, $transaction: async (operation, config) => { options.push(config); return operation({ address }) } } }
}

test('Address writes reject blank text, unexpected field types and string booleans', async () => {
  const { handlers } = load('src/app/api/addresses/route.ts', { session: customer })
  const { handlers: single } = load('src/app/api/addresses/[id]/route.ts', { session: customer })
  for (const body of [{ address: '' }, { phone: {} }, { isDefault: 'false' }, { title: 3 }]) {
    assert.equal((await handlers.POST(request({ address: 'Home', phone: '123', ...body }))).status, 400)
  }
  for (const body of [{ address: '' }, { phone: '' }, { isDefault: 'false' }, { title: [] }]) {
    assert.equal((await single.PATCH(request(body), context())).status, 400)
  }
})

test('First address becomes default and selecting another default clears the old one atomically', async () => {
  const db = addressDatabase()
  const { handlers } = load('src/app/api/addresses/route.ts', { session: customer, prisma: db.prisma })
  assert.equal((await handlers.POST(request({ address: 'Home', phone: '123', isDefault: false }))).status, 201)
  assert.equal(db.rows[0].isDefault, true)
  assert.equal((await handlers.POST(request({ address: 'Work', phone: '123', isDefault: true }))).status, 201)
  assert.equal(db.rows.filter((row) => row.isDefault).length, 1)
  assert.equal(db.rows[1].isDefault, true)
  assert.ok(db.options.every((config) => config.isolationLevel === 'Serializable'))
})

test('Clearing or deleting the default keeps one default if addresses remain', async () => {
  const db = addressDatabase([{ id: 'home', isDefault: true }, { id: 'work', isDefault: false }])
  const { handlers } = load('src/app/api/addresses/[id]/route.ts', { session: customer, prisma: db.prisma })
  assert.equal((await handlers.PATCH(request({ isDefault: false }), context('home'))).status, 200)
  assert.equal(db.rows.find((row) => row.id === 'work').isDefault, true)
  assert.equal((await handlers.DELETE(request({}), context('work'))).status, 200)
  assert.equal(db.rows[0].isDefault, true)
  const response = await handlers.PATCH(request({ isDefault: false }), context('home'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).isDefault, true)
})

test('Another customer cannot edit or delete an address', async () => {
  const db = addressDatabase([{ id: 'private', userId: 'other', isDefault: true }])
  const { handlers } = load('src/app/api/addresses/[id]/route.ts', { session: customer, prisma: db.prisma })
  assert.equal((await handlers.PATCH(request({ address: 'Changed' }), context('private'))).status, 404)
  assert.equal((await handlers.DELETE(request({}), context('private'))).status, 404)
  assert.equal(db.rows.length, 1)
})

test('Address serializable conflicts retry without treating other errors as retryable', async () => {
  let attempts = 0
  const { handlers } = load('src/lib/address-transaction.ts', { prisma: { $transaction: async (_operation, config) => {
    assert.equal(config.isolationLevel, 'Serializable')
    if (++attempts < 3) throw { code: 'P2034' }
    return 'success'
  } } })
  assert.equal(await handlers.addressTransaction(async () => null), 'success')
  assert.equal(attempts, 3)
  const { handlers: failed } = load('src/lib/address-transaction.ts', { prisma: { $transaction: async () => { throw { code: 'P2003' } } } })
  await assert.rejects(failed.addressTransaction(async () => null), (error) => error.code === 'P2003')
})

test('Uploads reject malformed forms, string file fields, empty and forged images without writing', async () => {
  let writes = 0
  const { handlers } = load('src/app/api/upload/route.ts', { files: {
    mkdir: async () => { writes++ }, writeFile: async () => { writes++ },
  } })
  assert.equal((await handlers.POST(request({}))).status, 400)
  const payloads = ['not-a-file', new File([], 'empty.png', { type: 'image/png' }),
    new File(['<html>not a png</html>'], 'fake.png', { type: 'image/png' })]
  for (const file of payloads) {
    const form = new FormData()
    form.set('file', file)
    assert.equal((await handlers.POST(new Request('http://localhost/api', { method: 'POST', body: form }))).status, 400)
  }
  assert.equal(writes, 0)
})

test('Valid PNG upload keeps the existing local upload flow using isolated file writes', async () => {
  const written = []
  const { handlers } = load('src/app/api/upload/route.ts', { files: {
    mkdir: async () => {}, writeFile: async (...args) => written.push(args),
  } })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfkgAAAAASUVORK5CYII=', 'base64')
  const form = new FormData()
  form.set('file', new File([png], 'photo.png', { type: 'image/png' }))
  const response = await handlers.POST(new Request('http://localhost/api', { method: 'POST', body: form }))
  assert.equal(response.status, 201)
  assert.equal(written.length, 1)
  assert.ok((await response.json()).url.startsWith('/uploads/'))
  assert.equal(written[0][1].equals(png), true)
})

test('Password change verifies the existing password and rejects coercion or a truncated new password', async () => {
  let updates = 0
  const prisma = { user: {
    findUnique: async () => ({ id: 'customer', password: 'existing-hash' }),
    update: async () => { updates++ },
  } }
  const { handlers } = load('src/app/api/profile/password/route.ts', {
    session: customer, prisma, bcrypt: { compare: async (value) => value === 'correct' },
  })
  assert.equal((await handlers.POST(request({ currentPassword: 'wrong', newPassword: 'abcdef' }))).status, 400)
  assert.equal((await handlers.POST(request({ currentPassword: {}, newPassword: 'abcdef' }))).status, 400)
  assert.equal((await handlers.POST(request({ currentPassword: 'correct', newPassword: 'x'.repeat(73) }))).status, 400)
  assert.equal(updates, 0)
  assert.equal((await handlers.POST(request({ currentPassword: 'correct', newPassword: 'abcdef' }))).status, 200)
  assert.equal(updates, 1)
})
