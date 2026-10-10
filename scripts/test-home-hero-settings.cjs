const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

// Isolated contract/API regressions: no network or real store database writes.
function load(file, dependencies = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  const context = {
    module: { exports: {} }, Date, Intl, URL, URLSearchParams, Request, Response,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name); return dependencies[name] },
  }
  vm.runInNewContext(transformSync(source, { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, context, { filename: file })
  return context.module.exports
}
const contract = load('src/lib/site-settings-contract.ts')
const requestOrigin = load('src/lib/request-origin.ts')
const clone = (value) => structuredClone(value)
const plain = (value) => JSON.parse(JSON.stringify(value))
const values = (overrides = {}) => ({ ...clone(contract.defaultSiteSettings), version: 1, ...overrides })
const product = (id, overrides = {}) => ({
  id, name: 'کفش ' + id, slug: id, images: ['/uploads/' + id + '.png'], stock: 3, sizes: [38, 39], price: 1900000,
  category: { name: 'رسمی', slug: 'formal' }, createdAt: new Date('2026-10-01T00:00:00Z'), featured: false,
  ...overrides,
})

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'AND') return expected.every((part) => matches(row, part))
    if (key === 'OR') return expected.some((part) => matches(row, part))
    if (key === 'NOT') return !matches(row, expected)
    const actual = row[key]
    if (expected === null || typeof expected !== 'object' || expected instanceof Date) return actual === expected
    if ('in' in expected) return expected.in.includes(actual)
    if ('gt' in expected) return actual > expected.gt
    if ('isEmpty' in expected) return (actual.length === 0) === expected.isEmpty
    if ('not' in expected) return actual !== expected.not
    return matches(actual, expected)
  })
}
function projected(row, select) {
  if (!row) return null
  if (!select) return clone(row)
  return Object.fromEntries(Object.entries(select).filter(([, enabled]) => enabled).map(([key, enabled]) => [key,
    enabled === true ? clone(row[key]) : projected(row[key], enabled.select),
  ]))
}

function harness(options = {}) {
  let row = { ...values(), id: 1, createdAt: new Date(), updatedAt: new Date(), ...options.row }
  const products = options.products ?? [product('shoe-a'), product('shoe-b', { stock: 0 }), product('shoe-c')]
  const session = options.session === undefined ? { user: { id: 'admin', role: 'ADMIN' } } : options.session
  const invalidated = []
  const operations = []
  let transactionQueue = Promise.resolve()
  const settingsDelegate = (current) => ({
    async findUnique({ where, select }) {
      operations.push('settings-read')
      assert.equal(where.id, 1)
      if (options.readError) throw new Error('private read credentials')
      return projected(current(), select)
    },
    async updateMany({ where, data }) {
      operations.push('settings-update')
      const currentRow = current()
      if (currentRow.version !== where.version) return { count: 0 }
      const { version, ...fields } = data
      Object.assign(currentRow, clone(fields), { version: currentRow.version + version.increment })
      return { count: 1 }
    },
  })
  const productsDelegate = {
    async findMany({ where, select }) {
      operations.push('product-read-in-transaction')
      if (options.productError) throw new Error('private product database credentials')
      return products.filter((entry) => matches(entry, where)).map((entry) => projected(entry, select))
    },
  }
  const prisma = {
    siteSettings: settingsDelegate(() => row),
    product: { findMany() { throw new Error('Product validation must happen inside the settings transaction') } },
    async $transaction(callback) {
      let release
      const previous = transactionQueue
      transactionQueue = new Promise((resolve) => { release = resolve })
      await previous
      try {
        const draft = clone(row)
        const result = await callback({ siteSettings: settingsDelegate(() => draft), product: productsDelegate })
        if (options.commitError) throw new Error('private commit credentials')
        row = draft
        return result
      } finally { release() }
    },
  }
  const settings = load('src/lib/site-settings.ts', {
    react: { cache: (fn) => fn }, 'next/server': { connection: async () => {} },
    '@/lib/prisma': { prisma }, '@/lib/site-settings-contract': contract,
  })
  const dependencies = {
    'next/server': { NextResponse: Response },
    'next/cache': { revalidatePath: (...args) => invalidated.push(args) },
    '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma },
    '@/lib/request-origin': requestOrigin, '@/lib/site-settings': settings,
  }
  return {
    settings, operations, invalidated, state: () => clone(row),
    route: load('src/app/api/admin/site-settings/route.ts', dependencies),
    publicRoute: load('src/app/api/site-settings/route.ts', dependencies),
  }
}
const request = (input = values(), headers = {}) => new Request('http://localhost/api/admin/site-settings', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...headers }, body: JSON.stringify(input),
})

const badIds = [null, undefined, '', 'shoe-a', {}, [null], [1], [''], [' '], ['shoe a'], [' shoe-a'], ['shoe-a '],
  ['shoe-a', 'shoe-a'], ['bad\u0000id'], ['bad\nid'], ['x'.repeat(129)], Array.from({ length: 11 }, (_, index) => 'shoe-' + index)]
const badIntervals = [null, undefined, true, '10', '', 0, -1, 3, 4, 4.99, 10.5, 121, 999, Number.NaN, Number.POSITIVE_INFINITY, {}, []]

test('Hero defaults keep automatic selection and a ten-second interval', () => {
  assert.deepEqual(plain(contract.defaultSiteSettings.homeHeroProductIds), [])
  assert.equal(contract.defaultSiteSettings.homeHeroIntervalSeconds, 10)
  assert.equal(contract.isSiteSettings(values()), true)
})

test('The public settings guard rejects malformed selection arrays and unsafe interval values', () => {
  assert.equal(contract.isHomeHeroProductIds(new Array(1)), false, 'Sparse arrays must not bypass element validation')
  assert.equal(contract.isSiteSettings(values({ homeHeroProductIds: new Array(1) })), false)
  for (const homeHeroProductIds of badIds) assert.equal(contract.isSiteSettings(values({ homeHeroProductIds })), false, JSON.stringify(homeHeroProductIds))
  for (const homeHeroIntervalSeconds of badIntervals) assert.equal(contract.isSiteSettings(values({ homeHeroIntervalSeconds })), false, String(homeHeroIntervalSeconds))
  assert.equal(contract.isSiteSettings(values({ homeHeroProductIds: ['shoe-b', 'shoe-a'], homeHeroIntervalSeconds: 5 })), true)
  assert.equal(contract.isSiteSettings(values({ homeHeroProductIds: Array.from({ length: 10 }, (_, index) => 'shoe-' + index), homeHeroIntervalSeconds: 120 })), true)
})

test('The server parser preserves selected product order and accepts both interval boundaries', () => {
  const fixture = harness()
  for (const homeHeroIntervalSeconds of [5, 10, 120]) {
    const parsed = fixture.settings.parseSiteSettings(values({ homeHeroProductIds: ['shoe-c', 'shoe-a', 'shoe-b'], homeHeroIntervalSeconds }))
    assert.deepEqual(plain(parsed.values.homeHeroProductIds), ['shoe-c', 'shoe-a', 'shoe-b'])
    assert.equal(parsed.values.homeHeroIntervalSeconds, homeHeroIntervalSeconds)
  }
  assert.deepEqual(plain(fixture.settings.parseSiteSettings(values({ homeHeroProductIds: ['x'.repeat(128)] })).values.homeHeroProductIds), ['x'.repeat(128)])
})

test('Malformed hero fields fail before product lookup, settings write, or storefront invalidation', async () => {
  for (const homeHeroProductIds of badIds) {
    const fixture = harness()
    const response = await fixture.route.PATCH(request(values({ homeHeroProductIds })))
    assert.equal(response.status, 400, JSON.stringify(homeHeroProductIds))
    assert.deepEqual(fixture.operations, [])
    assert.equal(fixture.state().version, 1)
    assert.equal(fixture.invalidated.length, 0)
  }
  for (const homeHeroIntervalSeconds of badIntervals) {
    const fixture = harness()
    const response = await fixture.route.PATCH(request(values({ homeHeroIntervalSeconds })))
    assert.equal(response.status, 400, String(homeHeroIntervalSeconds))
    assert.deepEqual(fixture.operations, [])
    assert.equal(fixture.invalidated.length, 0)
  }
})

test('Hero changes keep the existing admin authorization and same-origin protections', async () => {
  for (const [session, status] of [[null, 401], [{ user: { role: 'ADMIN' } }, 401], [{ user: { id: 'user', role: 'USER' } }, 403]]) {
    const fixture = harness({ session })
    assert.equal((await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-a'], homeHeroIntervalSeconds: 15 })))).status, status)
    assert.deepEqual(fixture.operations, [])
    assert.equal(fixture.invalidated.length, 0)
  }
  for (const headers of [{ Origin: 'https://attacker.test' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    const fixture = harness()
    assert.equal((await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-a'] }), headers))).status, 403)
    assert.deepEqual(fixture.operations, [])
  }
})

test('An empty selection saves automatic mode without a catalog query', async () => {
  const fixture = harness({ row: { homeHeroProductIds: ['shoe-a'], homeHeroIntervalSeconds: 20 } })
  const response = await fixture.route.PATCH(request(values({ homeHeroProductIds: [], homeHeroIntervalSeconds: 10 })))
  assert.equal(response.status, 200)
  assert.deepEqual(plain(fixture.state().homeHeroProductIds), [])
  assert.equal(fixture.state().homeHeroIntervalSeconds, 10)
  assert.equal(fixture.operations.includes('product-read-in-transaction'), false)
  assert.deepEqual(fixture.invalidated, [['/', 'layout']])
})

test('Explicit selections save all categories and out-of-stock products in their chosen order', async () => {
  const fixture = harness()
  const response = await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-b', 'shoe-c', 'shoe-a'], homeHeroIntervalSeconds: 25 })))
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(saved.version, 2)
  assert.deepEqual(saved.homeHeroProductIds, ['shoe-b', 'shoe-c', 'shoe-a'])
  assert.equal(saved.homeHeroIntervalSeconds, 25)
  assert.equal(fixture.operations.includes('product-read-in-transaction'), true)
  assert.deepEqual(fixture.invalidated, [['/', 'layout']])
})

test('Unknown or imageless product selections reject the whole settings draft', async () => {
  for (const products of [[product('shoe-a')], [product('shoe-a'), product('shoe-b', { images: [] })]]) {
    const fixture = harness({ products, row: { storeName: 'نام قبلی' } })
    const response = await fixture.route.PATCH(request(values({ storeName: 'نام ذخیره‌نشده', homeHeroProductIds: ['shoe-a', 'shoe-b'], homeHeroIntervalSeconds: 35 })))
    assert.equal(response.status, 400)
    assert.equal(fixture.state().storeName, 'نام قبلی')
    assert.deepEqual(plain(fixture.state().homeHeroProductIds), [])
    assert.equal(fixture.state().homeHeroIntervalSeconds, 10)
    assert.equal(fixture.state().version, 1)
    assert.equal(fixture.invalidated.length, 0)
  }
})

test('Legacy blank image entries do not qualify as hero product photography', async () => {
  for (const images of [[''], ['   '], ['', '/uploads/secondary.png']]) {
    const fixture = harness({ products: [product('shoe-a', { images })] })
    assert.equal((await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-a'] })))).status, 400)
    assert.equal(fixture.state().version, 1)
    assert.equal(fixture.invalidated.length, 0)
  }
})

test('A valid LAN request saves the ordered hero settings using the existing shared version', async () => {
  const fixture = harness()
  const response = await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-a'], homeHeroIntervalSeconds: 5 }), {
    Host: '192.168.1.101:3000', Origin: 'http://192.168.1.101:3000',
  }))
  assert.equal(response.status, 200)
  assert.equal(fixture.state().version, 2)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
})

test('Competing admins cannot mix one carousel order with the other carousel interval', async () => {
  const fixture = harness()
  const drafts = [values({ homeHeroProductIds: ['shoe-b', 'shoe-a'], homeHeroIntervalSeconds: 15 }),
    values({ homeHeroProductIds: ['shoe-a', 'shoe-c'], homeHeroIntervalSeconds: 60 })]
  const replies = await Promise.all(drafts.map((draft) => fixture.route.PATCH(request(draft))))
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409])
  const winner = drafts[replies.findIndex((reply) => reply.status === 200)]
  assert.deepEqual(plain(fixture.state().homeHeroProductIds), winner.homeHeroProductIds)
  assert.equal(fixture.state().homeHeroIntervalSeconds, winner.homeHeroIntervalSeconds)
  assert.equal(fixture.state().version, 2)
  assert.equal(fixture.invalidated.length, 1)
})

test('A stale carousel draft cannot revert newer branding or carousel settings', async () => {
  const fixture = harness({ row: { version: 8, storeName: 'برند تازه', homeHeroProductIds: ['shoe-c'], homeHeroIntervalSeconds: 40 } })
  const response = await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-a'], homeHeroIntervalSeconds: 5 })))
  assert.equal(response.status, 409)
  assert.equal(fixture.state().storeName, 'برند تازه')
  assert.deepEqual(plain(fixture.state().homeHeroProductIds), ['shoe-c'])
  assert.equal(fixture.state().homeHeroIntervalSeconds, 40)
  assert.equal(fixture.state().version, 8)
  assert.equal(fixture.invalidated.length, 0)
})

test('Product lookup or transaction failures do not publish a partial hero draft or private diagnostics', async () => {
  for (const options of [{ productError: true }, { commitError: true }, { readError: true }]) {
    const fixture = harness(options)
    const response = await fixture.route.PATCH(request(values({ homeHeroProductIds: ['shoe-a'], homeHeroIntervalSeconds: 45 })))
    assert.equal(response.status, 500)
    assert.doesNotMatch(JSON.stringify(await response.json()), /private|credentials/)
    assert.deepEqual(plain(fixture.state().homeHeroProductIds), [])
    assert.equal(fixture.state().homeHeroIntervalSeconds, 10)
    assert.equal(fixture.state().version, 1)
    assert.equal(fixture.invalidated.length, 0)
  }
})

test('Hero fields keep the same ordered values through admin, SSR and public settings reads', async () => {
  const fixture = harness({ row: { homeHeroProductIds: ['shoe-c', 'shoe-b'], homeHeroIntervalSeconds: 50 } })
  const published = await (await fixture.publicRoute.GET()).json()
  const admin = await (await fixture.route.GET()).json()
  const server = await fixture.settings.getSiteSettings()
  for (const result of [published, admin, server]) {
    assert.deepEqual(plain(result.homeHeroProductIds), ['shoe-c', 'shoe-b'])
    assert.equal(result.homeHeroIntervalSeconds, 50)
    assert.equal(contract.isSiteSettings(result), true)
  }
  assert.equal(published.id, undefined)
  assert.equal(published.createdAt, undefined)
  assert.equal(published.updatedAt, undefined)
})

const hero = load('src/lib/home-hero.ts')

test('Hero slides preserve editorial order despite unordered database results and duplicate caller IDs', () => {
  const slides = hero.resolveHomeHeroSlides(['shoe-c', 'shoe-a', 'shoe-c'], [product('shoe-a'), product('shoe-c'), product('shoe-b')], product('fallback'), 'پانیک')
  assert.deepEqual(plain(slides.map((slide) => slide.id)), ['shoe-c', 'shoe-a'])
  assert.equal(slides[0].image, '/uploads/shoe-c.png')
  assert.equal(slides[0].eyebrow, 'از مجموعهٔ رسمی')
})

test('Deleted or blank-cover selections are skipped without discarding usable selected products', () => {
  const slides = hero.resolveHomeHeroSlides(['deleted', 'blank', 'empty', 'shoe-b'], [
    product('blank', { images: ['   ', '/uploads/second.png'] }), product('empty', { images: [] }), product('shoe-b'),
  ], product('fallback'), 'پانیک')
  assert.deepEqual(plain(slides.map((slide) => slide.id)), ['shoe-b'])
})

test('Out-of-stock editorial selections remain a showcase and do not mutate product availability', () => {
  const selected = product('sold-out', { stock: 0, category: { name: 'کتانی', slug: 'sneaker' } })
  const before = clone(selected)
  const slides = hero.resolveHomeHeroSlides(['sold-out'], [selected], product('fallback'), 'پانیک')
  assert.deepEqual(plain(slides.map((slide) => slide.id)), ['sold-out'])
  assert.deepEqual(selected, before)
  assert.equal(slides[0].eyebrow, 'از مجموعهٔ کتانی')
})

test('Automatic mode or an entirely unusable selection yields exactly one supplied fallback', () => {
  for (const [ids, candidates] of [[[], [product('unselected')]], [['deleted'], []], [['blank'], [product('blank', { images: [''] })]]]) {
    const slides = hero.resolveHomeHeroSlides(ids, candidates, product('fallback'), 'پانیک')
    assert.deepEqual(plain(slides.map((slide) => slide.id)), ['fallback'])
  }
})

test('An empty or imageless catalog yields no broken hero image', () => {
  for (const fallback of [null, undefined, product('empty', { images: [] }), product('blank', { images: [' '] })]) {
    assert.deepEqual(plain(hero.resolveHomeHeroSlides(['deleted'], [], fallback, 'پانیک')), [])
  }
})

test('Missing product categories use the configured storefront name in the hero caption', () => {
  const slides = hero.resolveHomeHeroSlides(['shoe-a'], [product('shoe-a', { category: undefined })], null, 'فروشگاه تازه')
  assert.equal(slides[0].eyebrow, 'از ویترین فروشگاه تازه')
  assert.deepEqual(Object.keys(slides[0]).sort(), ['eyebrow', 'id', 'image', 'name', 'slug'])
})

function orderedProducts(rows, args = {}) {
  const filtered = rows.filter((row) => matches(row, args.where))
  const ordered = [...filtered].sort((left, right) => {
    for (const rule of args.orderBy || []) {
      const [key, direction] = Object.entries(rule)[0]
      if (left[key] === right[key]) continue
      const comparison = left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0
      if (comparison) return direction === 'desc' ? -comparison : comparison
    }
    return 0
  })
  return args.take ? ordered.slice(0, args.take) : ordered
}
function homeHarness(rows, overrides = {}) {
  const calls = []
  const settings = values(overrides)
  const jsx = (type, props) => ({ type, props })
  const homepage = load('src/app/(shop)/page.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/components/ui/BrandIcons': { SneakerIcon: 'SneakerIcon' },
    'next/image': { __esModule: true, default: 'Image' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/server': { connection: async () => {} },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/lib/prisma': { prisma: {
      product: {
        async findMany(args) { calls.push({ operation: 'findMany', ...args }); return orderedProducts(rows, args) },
        async findFirst(args) { calls.push({ operation: 'findFirst', ...args }); return orderedProducts(rows, args)[0] ?? null },
      },
      category: { findMany: async () => [] }, shippingMethod: { findMany: async () => [] }, paymentMethod: { findMany: async () => [] },
    } },
    '@/lib/payments': { expireUnpaidOrders: async () => 0, methodAvailability: () => ({ available: true }) },
    '@/components/shop/HomeContent': { HomeBanner: 'HomeBanner', HomeSelectionGuide: 'HomeSelectionGuide', HomePurchaseInfo: 'HomePurchaseInfo' },
    '@/lib/site-settings': { getSiteSettings: async () => settings },
    '@/lib/home-hero': hero,
    '@/components/shop/HomeHeroCarousel': { __esModule: true, default: 'HomeHeroCarousel' },
    './home.module.css': { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) },
  }).default
  return { render: homepage, calls }
}
function treeNodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...treeNodes(tree.props.children)]
}
const carousel = (tree) => treeNodes(tree).find((node) => node.type === 'HomeHeroCarousel')

test('The real homepage queries explicit products without restricting category or available stock', async () => {
  const fixture = homeHarness([product('automatic', { category: { name: 'کتانی', slug: 'sneaker' }, featured: true }), product('shoe-a'), product('sold-out', { stock: 0 })], {
    homeHeroProductIds: ['sold-out', 'shoe-a'], homeHeroIntervalSeconds: 15,
  })
  const showcase = carousel(await fixture.render())
  assert.deepEqual(plain(showcase.props.products.map((entry) => entry.id)), ['sold-out', 'shoe-a'])
  assert.equal(showcase.props.intervalSeconds, 15)
  const selectedQuery = fixture.calls.find((call) => call.where?.id?.in)
  assert.deepEqual(plain(selectedQuery.where.id.in), ['sold-out', 'shoe-a'])
  assert.equal(selectedQuery.where.stock, undefined)
  assert.equal(selectedQuery.where.category, undefined)
})

test('Automatic homepage mode keeps one featured sneaker and ignores unavailable stock', async () => {
  const fixture = homeHarness([
    product('new-formal', { createdAt: new Date('2026-10-09T00:00:00Z') }),
    product('old-featured', { category: { name: 'کتانی', slug: 'sneaker' }, featured: true }),
    product('new-sneaker', { category: { name: 'کتانی', slug: 'sneaker' }, createdAt: new Date('2026-10-08T00:00:00Z') }),
    product('sold-featured', { category: { name: 'کتانی', slug: 'sneaker' }, featured: true, stock: 0, createdAt: new Date('2026-10-09T00:00:00Z') }),
  ])
  const showcase = carousel(await fixture.render())
  assert.deepEqual(plain(showcase.props.products.map((entry) => entry.id)), ['old-featured'])
  assert.equal(fixture.calls.some((call) => call.where?.id?.in), false)
})

test('Deleted explicit products return the actual automatic fallback instead of a stale link', async () => {
  const fixture = homeHarness([product('live-sneaker', { category: { name: 'کتانی', slug: 'sneaker' } })], { homeHeroProductIds: ['deleted'] })
  const showcase = carousel(await fixture.render())
  assert.deepEqual(plain(showcase.props.products.map((entry) => entry.id)), ['live-sneaker'])
})

test('An empty homepage inventory renders its visual fallback without a broken carousel', async () => {
  const tree = await homeHarness([], { homeHeroProductIds: ['deleted'] }).render()
  assert.equal(carousel(tree), undefined)
  assert.ok(treeNodes(tree).some((node) => node.props.className === 'heroFallback'))
})

test('Ten actual selected products and the two-minute interval save at their allowed upper bounds', async () => {
  const products = Array.from({ length: 10 }, (_, index) => product('shoe-' + index))
  const ids = products.map((entry) => entry.id).reverse()
  const fixture = harness({ products })
  const response = await fixture.route.PATCH(request(values({ homeHeroProductIds: ids, homeHeroIntervalSeconds: 120 })))
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).homeHeroProductIds, ids)
  assert.equal(fixture.state().homeHeroIntervalSeconds, 120)
  assert.equal(fixture.state().version, 2)
})

test('A legacy sneaker with a blank cover cannot suppress a usable automatic fallback', async () => {
  const fixture = homeHarness([
    product('legacy-sneaker', { featured: true, category: { name: 'کتانی', slug: 'sneaker' }, images: [' '] }),
    product('live-formal', { createdAt: new Date('2026-10-09T00:00:00Z') }),
  ], { homeHeroProductIds: ['deleted'] })
  const showcase = carousel(await fixture.render())
  assert.ok(showcase)
  assert.deepEqual(plain(showcase.props.products.map((entry) => entry.id)), ['live-formal'])
})
