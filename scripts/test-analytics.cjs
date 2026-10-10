const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')
const nodeCrypto = require('node:crypto')

// Unit/integration doubles only: this suite never connects to the store DB.
function load(file, dependencies = {}, globals = {}) {
  const { code } = transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic',
  })
  const context = {
    module: { exports: {} }, Date, Intl, URL, URLSearchParams, Request, Response, Headers,
    Buffer, TextDecoder, Uint8Array, process: { env: { AUTH_SECRET: 'isolated-test-secret' } },
    console: { error() {} }, ...globals,
    require: (name) => { assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name); return dependencies[name] },
  }
  vm.runInNewContext(code, context)
  return context.module.exports
}
const sales = load('src/lib/sales-report.ts')
const helpers = load('src/lib/analytics.ts', {
  'node:crypto': nodeCrypto, 'node:net': require('node:net'), '@/lib/sales-report': sales,
})
const origin = load('src/lib/request-origin.ts')
const plain = (value) => JSON.parse(JSON.stringify(value))
const visitor = '00000000-0000-4000-8000-000000000001'
const secondVisitor = '00000000-0000-4000-8000-000000000002'
let counter = 20
const event = (pathname = '/products/panik-498', overrides = {}) => ({
  eventId: '00000000-0000-4000-8000-' + String(++counter).padStart(12, '0'), pathname, referrer: null, ...overrides,
})
const now = new Date('2026-10-08T21:00:00.000Z')

function databaseFixture() {
  const rows = []
  const products = new Map([['panik-498', { id: 'shoe-a', viewCount: 0 }], ['panik-620', { id: 'shoe-b', viewCount: 0 }]])
  const locks = new Map()
  const calls = []
  let failIncrement = false
  const database = {
    async $transaction(operation, options) {
      assert.equal(options.isolationLevel, 'ReadCommitted')
      const pending = []
      const increments = []
      const releases = []
      const tx = {
        async $queryRaw(strings, key) {
          assert.match(strings.join(''), /pg_advisory_xact_lock\(hashtextextended\(/)
          calls.push({ operation: 'lock', key })
          const preceding = locks.get(key) || Promise.resolve()
          let release
          const gate = new Promise((resolve) => { release = resolve })
          locks.set(key, preceding.then(() => gate))
          await preceding
          releases.push(release)
          return []
        },
        pageView: {
          async findUnique({ where }) { calls.push({ operation: 'event', id: where.id }); return [...rows, ...pending].find((row) => row.id === where.id) ?? null },
          async findFirst({ where }) { calls.push({ operation: 'recent', where }); return [...rows, ...pending].find((row) => row.visitorId === where.visitorId && row.pathname === where.pathname && row.createdAt > where.createdAt.gt) ?? null },
          async create({ data }) { pending.push(data); return data },
        },
        product: {
          async findUnique({ where }) { calls.push({ operation: 'product', slug: where.slug }); return products.get(where.slug) ?? null },
          async update({ where, data }) {
            if (failIncrement) throw new Error('private database failure')
            assert.equal(data.viewCount.increment, 1)
            increments.push(where.id)
          },
        },
      }
      try {
        const result = await operation(tx)
        if (pending.some((row) => rows.some((stored) => stored.id === row.id))) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        rows.push(...pending)
        for (const id of increments) [...products.values()].find((product) => product.id === id).viewCount++
        return result
      } finally { releases.forEach((release) => release()) }
    },
  }
  return { database, rows, products, calls, failIncrement: () => { failIncrement = true } }
}
const record = (db, input, identity = visitor, time = now) => helpers.recordPageView(db, input, identity, '192.168.1.15', 'Mozilla/5.0 Chrome/140.0', time)

test('Only public page paths are accepted and URL queries/hashes never enter logs', () => {
  assert.equal(helpers.analyticsPath('/products/panik-498?email=private#receipt'), '/products/panik-498')
  assert.equal(helpers.analyticsPath('/products/کفش'), '/products/' + encodeURIComponent('کفش'))
  assert.equal(helpers.analyticsPath('/products/%DA%A9%D9%81%D8%B4/'), '/products/' + encodeURIComponent('کفش'))
  for (const value of ['/profile', '/admin', '/checkout', '/payment/result', '/api/products', '//attacker.test', 'https://attacker.test/', '/products/a/b', '/products/%2f', '/products/%5c', '/products/%00', '/products/..', '/products/%E0%A4%A', '/products/a\\b']) assert.equal(helpers.analyticsPath(value), null, value)
})

test('Referrers retain only a public HTTP origin, never path, credentials, or query tokens', () => {
  assert.equal(helpers.analyticsReferrer('https://search.example.test/private/person?token=abc#part'), 'https://search.example.test')
  for (const value of ['javascript:alert(1)', 'file:///private', 'https://user:pass@example.test', '/profile', null]) assert.equal(helpers.analyticsReferrer(value), null)
})

test('Visitor cookies are signed server identities; malformed, duplicated and forged cookies are rejected', () => {
  const signed = helpers.signVisitor(visitor)
  assert.equal(helpers.readVisitorCookie('other=x; shop_visitor=' + signed), visitor)
  for (const value of [null, 'shop_visitor=' + visitor, 'shop_visitor=' + signed + '.extra', 'shop_visitor=' + signed.replace(visitor, secondVisitor), 'shop_visitor=' + signed + '; shop_visitor=' + signed]) assert.equal(helpers.readVisitorCookie(value), null)
  assert.throws(() => helpers.signVisitor('attacker-controlled'), helpers.AnalyticsValidationError)
})

test('Reported IP validation accepts IPv4/IPv6 and rejects arbitrary forwarded strings', () => {
  assert.equal(helpers.reportedVisitIp(new Headers({ 'x-forwarded-for': '192.168.1.7, 10.0.0.1' })), '192.168.1.7')
  assert.equal(helpers.reportedVisitIp(new Headers({ 'x-forwarded-for': '::ffff:192.168.1.7' })), '192.168.1.7')
  assert.equal(helpers.reportedVisitIp(new Headers({ 'x-real-ip': '2001:db8::1' })), '2001:db8::1')
  for (const value of ['<script>', '1.2.3.999', 'not-ip, 1.2.3.4', '127.0.0.1:3000']) assert.equal(helpers.reportedVisitIp(new Headers({ 'x-forwarded-for': value })), null)
})

test('Known bots and empty user agents are ignored without claiming bot filtering is exhaustive', () => {
  for (const value of ['', null, 'Googlebot/2.1', 'Mozilla/5.0 HeadlessChrome/140', 'curl/8.1', 'facebookexternalhit']) assert.equal(helpers.isHumanVisit(value), false)
  assert.equal(helpers.isHumanVisit('Mozilla/5.0 Chrome/140.0 Safari/537.36'), true)
})

test('Public event input never trusts client product IDs, counts, identity or time', () => {
  const input = event('/products/panik-498?private=1', { productId: 'wrong-shoe', viewCount: 900, visitorId: 'forged', createdAt: '1900-01-01', referrer: 'https://search.test/token' })
  assert.deepEqual(plain(helpers.parseVisit(input)), { eventId: input.eventId, pathname: '/products/panik-498', referrer: 'https://search.test' })
  for (const value of [null, [], { pathname: '/', eventId: 'fake' }, { pathname: '/admin', eventId: event().eventId }]) assert.throws(() => helpers.parseVisit(value), helpers.AnalyticsValidationError)
})

test('A genuine product visit resolves the current product server-side and increments exactly once', async () => {
  const fixture = databaseFixture()
  const input = event()
  assert.equal(await record(fixture.database, input), true)
  assert.equal(fixture.rows.length, 1)
  assert.equal(fixture.rows[0].productId, 'shoe-a')
  assert.equal(fixture.rows[0].createdAt, now)
  assert.equal(fixture.products.get('panik-498').viewCount, 1)
  assert.equal(await record(fixture.database, input), false)
  assert.equal(fixture.products.get('panik-498').viewCount, 1)
})

test('Parallel refreshes on separate server transactions deduplicate under the visitor/path lock', async () => {
  const fixture = databaseFixture()
  const results = await Promise.all(Array.from({ length: 12 }, () => record(fixture.database, event())))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(fixture.rows.length, 1)
  assert.equal(fixture.products.get('panik-498').viewCount, 1)
  assert.equal(new Set(fixture.calls.filter((call) => call.operation === 'lock').map((call) => call.key)).size, 1)
})

test('Different real browser visitors can each count the same product once', async () => {
  const fixture = databaseFixture()
  assert.deepEqual(await Promise.all([record(fixture.database, event()), record(fixture.database, event(), secondVisitor)]), [true, true])
  assert.equal(fixture.products.get('panik-498').viewCount, 2)
})

test('The deduplication window is rolling and expires exactly after thirty minutes', async () => {
  const fixture = databaseFixture()
  assert.equal(await record(fixture.database, event()), true)
  assert.equal(await record(fixture.database, event(), visitor, new Date(now.getTime() + 1_799_999)), false)
  assert.equal(await record(fixture.database, event(), visitor, new Date(now.getTime() + 1_800_000)), true)
  assert.equal(fixture.products.get('panik-498').viewCount, 2)
})

test('Other public pages count visits without incrementing a product, missing products count neither', async () => {
  const fixture = databaseFixture()
  assert.equal(await record(fixture.database, event('/')), true)
  assert.equal(await record(fixture.database, event('/products/missing')), false)
  assert.equal(fixture.rows.length, 1)
  assert.equal(fixture.rows[0].productId, null)
  assert.equal(fixture.products.get('panik-498').viewCount, 0)
})

test('Duplicate event IDs across different visitor/path locks do not double-count', async () => {
  const fixture = databaseFixture()
  const input = event()
  const results = await Promise.all([record(fixture.database, input), record(fixture.database, { ...input, pathname: '/products/panik-620' }, secondVisitor)])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(fixture.rows.length, 1)
  assert.equal([...fixture.products.values()].reduce((sum, product) => sum + product.viewCount, 0), 1)
})

test('An increment failure rolls the event insertion back rather than leaving contradictory counters', async () => {
  const fixture = databaseFixture()
  fixture.failIncrement()
  await assert.rejects(record(fixture.database, event()), /private database failure/)
  assert.equal(fixture.rows.length, 0)
  assert.equal(fixture.products.get('panik-498').viewCount, 0)
})

test('Analytics filters use Tehran civil days with strict bounded ranges/pages', () => {
  const filters = helpers.parseAnalyticsFilters(new URLSearchParams({ range: '7d' }), now)
  assert.equal(filters.range.to, '2026-10-09')
  assert.equal(filters.todayStart.toISOString(), '2026-10-08T20:30:00.000Z')
  assert.equal(filters.todayEnd.toISOString(), '2026-10-09T20:30:00.000Z')
  assert.equal(filters.range.days, 7)
  assert.equal(helpers.parseAnalyticsFilters(new URLSearchParams(), new Date('2026-10-08T20:29:59.999Z')).range.to, '2026-10-08')
  for (const query of ['range=all', 'range=7d&range=90d', 'page=0', 'page=-1', 'page=1.5', 'page=1000001', 'page=1&page=2', 'from=2026-10-01']) assert.throws(() => helpers.parseAnalyticsFilters(new URLSearchParams(query), now), helpers.AnalyticsValidationError)
})

const nextResponses = {
  json(data, options = {}) {
    const response = { status: options.status ?? 200, headers: new Headers(options.headers), json: async () => data, savedCookies: [] }
    response.cookies = { set(name, value, options) { response.savedCookies.push({ name, value, options }) } }
    return response
  },
}
function publicHarness({ cookie, database, overrides = {} } = {}) {
  const fixture = databaseFixture()
  const route = load('src/app/api/analytics/page-view/route.ts', {
    'node:crypto': nodeCrypto, 'next/server': { NextResponse: nextResponses },
    '@/lib/prisma': { prisma: database || fixture.database }, '@/lib/request-origin': origin, '@/lib/analytics': helpers,
  })
  const request = (body = event('/'), customHeaders = {}) => new Request('http://shop.example.test/api/analytics/page-view', {
    method: 'POST', headers: { host: 'shop.example.test', origin: 'http://shop.example.test', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/140', ...(cookie ? { cookie } : {}), ...customHeaders }, body: JSON.stringify(body), ...overrides,
  })
  return { route, request, ...fixture }
}

test('A new visitor receives an HttpOnly cookie without logging until the browser retains it', async () => {
  const fixture = publicHarness()
  const response = await fixture.route.POST(fixture.request())
  assert.equal(response.status, 202)
  assert.equal(fixture.rows.length, 0)
  assert.equal(response.savedCookies.length, 1)
  const cookie = response.savedCookies[0]
  assert.equal(cookie.name, 'shop_visitor')
  assert.equal(cookie.options.httpOnly, true)
  assert.equal(cookie.options.sameSite, 'lax')
  assert.equal(cookie.options.path, '/')
  assert.equal(cookie.options.maxAge, 31_536_000)
  assert.ok(helpers.readVisitorCookie(cookie.name + '=' + cookie.value))
})

test('Cookie retry logs one visit; the public response never reveals IP, visitor identity or diagnostics', async () => {
  const fixture = publicHarness({ cookie: 'shop_visitor=' + helpers.signVisitor(visitor) })
  const input = event('/')
  const response = await fixture.route.POST(fixture.request(input, { 'x-forwarded-for': '192.168.1.15' }))
  assert.equal(response.status, 200)
  assert.deepEqual(plain(await response.json()), { accepted: true, ignored: false })
  assert.equal(fixture.rows[0].ipAddress, '192.168.1.15')
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.deepEqual(plain(await (await fixture.route.POST(fixture.request(input))).json()), { accepted: false, ignored: true })
})

test('Tracking rejects cross-site/invalid content and drops known bot/prefetch traffic before DB access', async () => {
  const fixture = publicHarness({ cookie: 'shop_visitor=' + helpers.signVisitor(visitor) })
  assert.equal((await fixture.route.POST(fixture.request(event('/'), { origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' }))).status, 403)
  assert.equal((await fixture.route.POST(fixture.request(event('/'), { 'content-type': 'text/plain' }))).status, 415)
  assert.equal((await fixture.route.POST(fixture.request(event('/'), { 'user-agent': 'Googlebot/2.1' }))).status, 200)
  assert.equal((await fixture.route.POST(fixture.request(event('/'), { 'sec-purpose': 'prefetch;prerender' }))).status, 200)
  assert.equal(fixture.rows.length, 0)
  assert.equal(fixture.calls.length, 0)
})

test('Invalid private routes, oversized payloads and database failures do not leak errors', async () => {
  const fixture = publicHarness({ cookie: 'shop_visitor=' + helpers.signVisitor(visitor) })
  assert.equal((await fixture.route.POST(fixture.request(event('/profile')))).status, 400)
  assert.equal((await fixture.route.POST(fixture.request(event('/', { referrer: 'a'.repeat(5000) })))).status, 413)
  fixture.failIncrement()
  const response = await fixture.route.POST(fixture.request(event('/products/panik-498')))
  assert.equal(response.status, 503)
  assert.deepEqual(plain(await response.json()), { accepted: false, ignored: true })
})

function adminHarness(session) {
  let queries = 0
  const route = load('src/app/api/admin/analytics/route.ts', {
    'next/server': { NextResponse: nextResponses }, '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': { prisma: { $transaction() { queries++; throw new Error('private PostgreSQL credentials') } } }, '@/lib/analytics': helpers,
  })
  return { route, queries: () => queries, request: (query = '') => new Request('http://shop.test/api/admin/analytics?' + query) }
}

test('Visitor IP reports require a current administrator and use private no-store responses', async () => {
  for (const [session, status] of [[null, 401], [{ user: { id: 'customer', role: 'USER' } }, 403]]) {
    const fixture = adminHarness(session)
    const response = await fixture.route.GET(fixture.request('range=invalid'))
    assert.equal(response.status, status)
    assert.equal(fixture.queries(), 0)
    assert.match(response.headers.get('cache-control'), /private, no-store/)
  }
  const fixture = adminHarness({ user: { id: 'admin', role: 'ADMIN' } })
  assert.equal((await fixture.route.GET(fixture.request('range=all'))).status, 400)
  assert.equal(fixture.queries(), 0)
  const response = await fixture.route.GET(fixture.request())
  assert.equal(response.status, 500)
  assert.doesNotMatch(JSON.stringify(await response.json()), /PostgreSQL|credentials/)
})

test('Report aggregates remain in SQL, missing calendar days zero-fill, and recent logs are bounded', async () => {
  const filters = helpers.parseAnalyticsFilters(new URLSearchParams({ range: '7d', page: '999' }), now)
  const sql = []
  let logQuery
  const tx = {
    async $queryRaw(strings) {
      const query = strings.join('?'); sql.push(query)
      if (query.includes('"firstTrackedAt"')) return [{ totalViews: 4n, totalVisitors: 2n, todayViews: 2n, todayVisitors: 1n, rangeViews: 4n, rangeVisitors: 2n, firstTrackedAt: new Date('2026-10-08T21:00:00Z') }]
      if (query.includes('to_char')) return [{ date: '2026-10-09', views: 2n, visitors: 1n }]
      if (query.includes('JOIN "Product"')) return [{ productId: 'shoe-a', name: 'کفش', slug: 'panik-498', views: 2n, totalViews: 2 }]
      return [{ pathname: '/', views: 2n }]
    },
    pageView: {
      async count() { return 26 },
      async findMany(query) { logQuery = query; return [{ id: 'event', pathname: '/', ipAddress: '192.168.1.15', referrer: null, createdAt: now }] },
    },
  }
  const report = await helpers.readAnalyticsReport(tx, filters, now)
  assert.equal(sql.length, 4)
  assert.match(sql[0], /COUNT\(DISTINCT "visitorId"\)/)
  assert.match(sql[1], /AT TIME ZONE/)
  assert.match(sql[2], /LIMIT 8/)
  assert.equal(report.trend.length, 7)
  assert.equal(report.trend[0].views, 0)
  assert.equal(report.trend.at(-1).views, 2)
  assert.equal(report.trend.at(-1).date, '2026-10-09')
  assert.deepEqual(plain(report.pagination), { page: 2, pageSize: 25, total: 26, pages: 2 })
  assert.equal(logQuery.take, 25)
  assert.equal(logQuery.skip, 25)
  assert.equal(logQuery.select.visitorId, undefined)
  assert.equal(report.recent[0].createdAt, now.toISOString())
  assert.equal(report.summary.rangeViews, 4)
  assert.doesNotThrow(() => JSON.stringify(report), 'No SQL BigInt leaks into JSON')
})

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function trackerHarness({ pathname = '/', hidden = false, statuses = [200], lan = false } = {}) {
  let currentPath = pathname
  const effects = []
  const timers = new Map()
  const listeners = new Map()
  const requests = []
  let nextTimer = 0
  const document = { visibilityState: hidden ? 'hidden' : 'visible', referrer: 'https://search.test/private?token=abc',
    addEventListener: (event, listener) => listeners.set(event, listener), removeEventListener: (event) => listeners.delete(event) }
  const component = load('src/components/shop/VisitTracker.tsx', {
    react: { useEffect: (effect) => effects.push(effect) }, 'next/navigation': { usePathname: () => currentPath },
  }, {
    crypto: { ...(lan ? {} : { randomUUID: nodeCrypto.randomUUID }), getRandomValues: (bytes) => nodeCrypto.webcrypto.getRandomValues(bytes) }, document,
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, ...options }); return { status: statuses[requests.length - 1] ?? 200 } },
  }).default
  const mount = () => { component(); return effects.pop()() }
  return { mount, document, requests, timers, setPath: (value) => { currentPath = value },
    async flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); await settle() },
    visible() { document.visibilityState = 'visible'; listeners.get('visibilitychange')?.() } }
}

test('Actual tracker ignores private paths and hidden pages, then counts a real visible navigation', async () => {
  const privateFixture = trackerHarness({ pathname: '/profile' })
  privateFixture.mount(); await privateFixture.flush()
  assert.equal(privateFixture.requests.length, 0)
  const fixture = trackerHarness({ pathname: '/products/panik-498', hidden: true })
  fixture.mount(); await fixture.flush()
  assert.equal(fixture.requests.length, 0)
  fixture.visible(); await fixture.flush()
  assert.equal(fixture.requests.length, 1)
  assert.equal(JSON.parse(fixture.requests[0].body).pathname, '/products/panik-498')
  assert.equal(JSON.parse(fixture.requests[0].body).referrer, 'https://search.test')
})

test('StrictMode cleanup cancels duplicate effects, bootstrap retries keep one event ID, LAN HTTP gets valid UUIDs', async () => {
  const fixture = trackerHarness({ statuses: [202, 200], lan: true })
  const cleanup = fixture.mount(); cleanup(); fixture.mount()
  assert.equal(fixture.timers.size, 1)
  await fixture.flush()
  assert.equal(fixture.requests.length, 2)
  const input = JSON.parse(fixture.requests[0].body)
  assert.equal(fixture.requests[1].body, fixture.requests[0].body)
  assert.ok(helpers.parseVisit(input))
  assert.equal(fixture.requests[0].credentials, 'same-origin')
  assert.equal(fixture.requests[0].keepalive, true)
})

test('Cookie-blocked browsers stop after one bootstrap retry instead of looping forever', async () => {
  const fixture = trackerHarness({ statuses: [202, 202, 202] })
  fixture.mount(); await fixture.flush()
  assert.equal(fixture.requests.length, 2)
})
