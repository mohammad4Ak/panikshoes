const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  const context = { module: { exports: {} }, Date, URL, Response, Request, Object,
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] } }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, context)
  return context.module.exports
}
const contract = load('src/lib/site-settings-contract.ts')
const requestOrigin = load('src/lib/request-origin.ts')
const clone = (value) => structuredClone(value)
const values = (extra = {}) => ({ ...clone(contract.defaultSiteSettings), version: 1, ...extra })

function harness(options = {}) {
  let row = options.missing ? null : { ...values(), id: 1, createdAt: new Date(), updatedAt: new Date(), ...options.row }
  let session = options.session === undefined ? { user: { id: 'admin', role: 'ADMIN' } } : options.session
  let reads = 0, writes = 0, connections = 0
  const invalidated = []
  let queue = Promise.resolve()
  const delegate = (current) => ({
    findUnique: async ({ where, select }) => {
      reads++
      assert.equal(where.id, 1)
      if (options.readError) throw new Error('db read unavailable')
      const record = current()
      return record ? Object.fromEntries(Object.entries(select).filter(([, enabled]) => enabled).map(([key]) => [key, clone(record[key])])) : null
    },
    updateMany: async ({ where, data }) => {
      writes++
      const record = current()
      if (!record || where.id !== 1 || record.version !== where.version) return { count: 0 }
      Object.assign(record, clone(data), { version: record.version + data.version.increment })
      return { count: 1 }
    },
  })
  const prisma = { siteSettings: delegate(() => row), $transaction: async (callback) => {
    let unlock
    const previous = queue
    queue = new Promise((resolve) => { unlock = resolve })
    await previous
    try {
      const draft = clone(row)
      const result = await callback({ siteSettings: delegate(() => draft) })
      if (options.commitError) throw new Error('commit rejected')
      row = draft
      return result
    } finally { unlock() }
  } }
  const settings = load('src/lib/site-settings.ts', { react: { cache: (fn) => fn },
    'next/server': { connection: async () => { connections++ } }, '@/lib/prisma': { prisma },
    '@/lib/site-settings-contract': contract })
  const dependencies = { 'next/server': { NextResponse: Response }, 'next/cache': { revalidatePath: (...args) => invalidated.push(args) },
    '@/lib/auth': { auth: async () => session }, '@/lib/prisma': { prisma }, '@/lib/request-origin': requestOrigin,
    '@/lib/site-settings': settings }
  return { settings, prisma, state: () => clone(row), metrics: () => ({ reads, writes, connections }), invalidated,
    user: (value) => { session = value }, route: (file) => load(`src/app/api/${file}/route.ts`, dependencies) }
}
const json = (data = values(), headers = {}) => new Request('http://localhost/api/admin/site-settings', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...headers }, body: JSON.stringify(data),
})

test('Only an authenticated administrator may read or change the general settings', async () => {
  for (const [session, status] of [[null, 401], [{ user: { role: 'ADMIN' } }, 401], [{ user: { id: 'user', role: 'USER' } }, 403]]) {
    const h = harness({ session })
    const route = h.route('admin/site-settings')
    for (const response of [await route.GET(), await route.PATCH(json())]) {
      assert.equal(response.status, status)
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    }
    assert.equal(h.metrics().reads, 0)
    assert.equal(h.metrics().writes, 0)
  }
})

test('Settings PATCH rejects foreign origins while allowing a valid LAN request', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values(), headers))).status, 403)
    assert.equal(h.metrics().writes, 0)
  }
  const h = harness()
  const response = await h.route('admin/site-settings').PATCH(json(values(), { Host: '192.168.1.101:3000', Origin: 'http://192.168.1.101:3000' }))
  assert.equal(response.status, 200)
})

test('Public settings omit row metadata and hide the unpublished announcement draft', async () => {
  const h = harness({ row: { announcementText: 'draft', announcementLink: '/products', announcementLinkLabel: 'Draft link' } })
  const publicResponse = await h.route('site-settings').GET()
  assert.equal(publicResponse.status, 200)
  assert.equal(publicResponse.headers.get('Cache-Control'), 'no-store')
  const published = await publicResponse.json()
  assert.equal(published.announcementText, '')
  assert.equal(published.announcementLink, null)
  assert.equal(published.announcementLinkLabel, '')
  assert.equal('id' in published, false)
  assert.equal('createdAt' in published, false)
  assert.equal('updatedAt' in published, false)
  const admin = await (await h.route('admin/site-settings').GET()).json()
  assert.equal(admin.announcementText, 'draft')
  assert.equal('id' in admin, false)
})

test('Enabled announcements are publicly readable as plain text and a safe link', async () => {
  const h = harness({ row: { announcementEnabled: true, announcementText: '<b>خبر</b>', announcementLink: '/products?featured=true', announcementLinkLabel: 'محصولات' } })
  const published = await (await h.route('site-settings').GET()).json()
  assert.equal(published.announcementText, '<b>خبر</b>')
  assert.equal(published.announcementLink, '/products?featured=true')
})

test('A complete validated save normalizes contacts and invalidates the shared layout', async () => {
  const h = harness()
  const input = values({ storeName: '  برند من  ', phone: '+۹۸ (۹۱۲) ۳۴۵-۶۷۸۹', email: '  Support@Example.COM ',
    logoUrl: '/uploads/1234-logo.webp', logoLightUrl: 'https://example.public.blob.vercel-storage.com/products/1234-logo.png',
    instagramUrl: 'https://www.instagram.com/mybrand/', telegramUrl: 'https://t.me/mybrand',
    announcementEnabled: true, announcementText: 'ارسال رایگان\nبرای خرید امروز', announcementLink: '/products', announcementLinkLabel: 'خرید' })
  const response = await h.route('admin/site-settings').PATCH(json(input))
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.version, 2)
  assert.equal(result.storeName, 'برند من')
  assert.equal(result.phone, '+989123456789')
  assert.equal(result.email, 'support@example.com')
  assert.equal(result.announcementText, input.announcementText)
  assert.equal('updatedAt' in result, false)
  assert.deepEqual(h.invalidated, [['/', 'layout']])
})

test('Missing, oversized, malformed and non-boolean fields fail before a database write', async () => {
  const inputs = [null, [], { version: 1 }, values({ version: '1' }), values({ version: 0 }), values({ version: 2147483647 }),
    values({ extra: true }), values({ constructor: 'unexpected' }), values({ toString: 'unexpected' }),
    values({ announcementEnabled: 'false' }), values({ announcementEnabled: true }),
    values({ storeName: ' ' }), values({ storeName: 'x'.repeat(81) }), values({ tagline: 'bad\nline' }),
    values({ announcementText: 'bad\u0000text' }), values({ email: 'invalid' }), values({ phone: 'call me' }),
    values({ phone: '123' }), values({ phone: '1'.repeat(16) }), values({ seoTitle: '' }), values({ seoDescription: 'x'.repeat(301) }),
    values({ announcementLink: '/products', announcementLinkLabel: '' })]
  for (const input of inputs) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(input))).status, 400, JSON.stringify(input))
    assert.equal(h.metrics().writes, 0)
    assert.equal(h.state().version, 1)
  }
  const h = harness()
  const badJson = new Request('http://localhost/api/admin/site-settings', { method: 'PATCH', body: '{' })
  assert.equal((await h.route('admin/site-settings').PATCH(badJson)).status, 400)
  assert.equal(h.metrics().writes, 0)
})

test('Announcement links reject executable schemes, credentials and authority/control escapes', async () => {
  const invalid = ['javascript:alert(1)', 'data:text/html,bad', '//evil.example', '/\\evil.example', '/%2fevil.example',
    '/%252fevil.example', '/products%0d%0aHost:evil', 'https://u:p@example.com', 'https://example.com/\\evil', '/products\u0000']
  for (const link of invalid) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ announcementLink: link, announcementLinkLabel: 'خرید' })))).status, 400, link)
  }
  for (const link of ['/products?type=SNEAKER#list', 'https://example.com/promotion', 'http://localhost:3000/products']) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ announcementLink: link, announcementLinkLabel: 'خرید' })))).status, 200, link)
  }
})

test('Logos must be uploaded raster images, with null restoring the built-in brand', async () => {
  const invalid = ['/uploads/../logo.png', '/uploads/file.svg', '/uploads/a.png?x=1', '/uploads/a%2epng',
    'https://evil.example/logo.png', 'https://bucket.public.blob.vercel-storage.com.evil.example/products/logo.png',
    'http://bucket.public.blob.vercel-storage.com/products/logo.png', 'https://u:p@bucket.public.blob.vercel-storage.com/products/logo.png',
    'https://bucket.public.blob.vercel-storage.com/products/logo.svg']
  for (const logo of invalid) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ logoUrl: logo })))).status, 400, logo)
  }
  const h = harness({ row: { logoUrl: '/uploads/old.png', logoLightUrl: '/uploads/old-light.png' } })
  assert.equal((await h.route('admin/site-settings').PATCH(json(values({ logoUrl: null, logoLightUrl: null })))).status, 200)
  assert.equal(h.state().logoUrl, null)
  assert.equal(h.state().logoLightUrl, null)
})

test('Social links must belong to the selected HTTPS service and contacts may be removed', async () => {
  for (const changes of [{ instagramUrl: 'https://instagram.com.evil.example/user' }, { instagramUrl: 'https://evilinstagram.com/user' },
    { instagramUrl: 'http://instagram.com/user' }, { telegramUrl: 'https://t.me.evil.example/user' }, { telegramUrl: 'https://u:p@t.me/user' },
    { telegramUrl: 'https://t.me:8443/user' }]) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values(changes)))).status, 400)
  }
  const h = harness()
  assert.equal((await h.route('admin/site-settings').PATCH(json(values({ phone: '', email: '', address: '', supportHours: '', instagramUrl: null, telegramUrl: null })))).status, 200)
  assert.equal(h.state().phone, '')
})

test('Concurrent administrators cannot silently overwrite one another', async () => {
  const h = harness()
  const route = h.route('admin/site-settings')
  const responses = await Promise.all([route.PATCH(json(values({ storeName: 'اول' }))), route.PATCH(json(values({ storeName: 'دوم' })))])
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409])
  assert.equal(h.state().version, 2)
  assert.ok(['اول', 'دوم'].includes(h.state().storeName))
  assert.equal(h.invalidated.length, 1)
  const stale = await route.PATCH(json(values({ storeName: 'سوم' })))
  assert.equal(stale.status, 409)
  assert.notEqual(h.state().storeName, 'سوم')
  assert.equal((await route.PATCH(json(values({ version: 2, storeName: 'سوم' })))).status, 200)
  assert.equal(h.state().version, 3)
})

test('A failed transaction does not change settings or invalidate the storefront', async () => {
  const h = harness({ commitError: true })
  assert.equal((await h.route('admin/site-settings').PATCH(json(values({ storeName: 'new' })))).status, 500)
  assert.equal(h.state().storeName, contract.defaultSiteSettings.storeName)
  assert.equal(h.state().version, 1)
  assert.equal(h.invalidated.length, 0)
})

test('SSR reads wait for a request and transaction readers work without rendering APIs', async () => {
  const h = harness()
  assert.equal((await h.settings.getSiteSettings()).storeName, contract.defaultSiteSettings.storeName)
  assert.equal(h.metrics().connections, 1)
  assert.equal((await h.settings.readSiteSettings(h.prisma)).version, 1)
  assert.equal(h.metrics().connections, 1)
  const missing = harness({ missing: true })
  assert.equal((await missing.settings.readSiteSettings()).version, 0)
  assert.equal((await missing.route('admin/site-settings').PATCH(json())).status, 409)
  const failed = harness({ readError: true })
  assert.equal((await failed.route('site-settings').GET()).status, 500)
  assert.equal((await failed.route('admin/site-settings').GET()).status, 500)
})


test('Homepage banner settings are saved as a versioned unit and preserve query links', async () => {
  const h = harness()
  const input = values({ homeBannerEnabled: true, homeBannerImageUrl: '/uploads/trail-20261008.webp',
    homeBannerEyebrow: '  از شهر تا طبیعت  ', homeBannerTitle: '  همراه مسیر بعدی  ',
    homeBannerDescription: '  برای روزهای کاری\nو آخر هفته  ', homeBannerLink: '/products?stock=1&type=SNEAKER#list',
    homeBannerLinkLabel: '  دیدن کفش‌ها  ', homeBannerImageAlt: '  کفش کوهنوردی کنار مسیر  ' })
  const response = await h.route('admin/site-settings').PATCH(json(input))
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(saved.version, 2)
  assert.equal(saved.homeBannerImageUrl, input.homeBannerImageUrl)
  assert.equal(saved.homeBannerEyebrow, input.homeBannerEyebrow.trim())
  assert.equal(saved.homeBannerTitle, input.homeBannerTitle.trim())
  assert.equal(saved.homeBannerDescription, input.homeBannerDescription.trim())
  assert.equal(saved.homeBannerLink, input.homeBannerLink)
  assert.equal(saved.homeBannerLinkLabel, input.homeBannerLinkLabel.trim())
  assert.equal(saved.homeBannerImageAlt, input.homeBannerImageAlt.trim())
  assert.equal(h.state().homeBannerTitle, saved.homeBannerTitle)
  assert.deepEqual(h.invalidated, [['/', 'layout']])
})

test('A disabled homepage banner keeps its draft private while preserving the response shape', async () => {
  const draft = { homeBannerEnabled: false, homeBannerImageUrl: '/uploads/draft-banner.png',
    homeBannerEyebrow: 'Draft eyebrow', homeBannerTitle: 'Draft title', homeBannerDescription: 'Unpublished promotion',
    homeBannerLink: '/products?stock=1', homeBannerLinkLabel: 'Draft link', homeBannerImageAlt: 'Draft image' }
  const h = harness({ row: draft })
  const published = await (await h.route('site-settings').GET()).json()
  assert.equal(published.homeBannerEnabled, false)
  for (const key of ['homeBannerEyebrow', 'homeBannerTitle', 'homeBannerDescription', 'homeBannerLinkLabel', 'homeBannerImageAlt']) {
    assert.equal(published[key], '')
  }
  assert.equal(published.homeBannerImageUrl, null)
  assert.equal(published.homeBannerLink, null)
  assert.equal(contract.isSiteSettings(published), true)
  const admin = await (await h.route('admin/site-settings').GET()).json()
  for (const [key, value] of Object.entries(draft)) assert.equal(admin[key], value)
})

test('An enabled homepage banner exposes escaped-text data without widening the public projection', async () => {
  const h = harness({ row: { homeBannerTitle: '<script>promotion</script>', homeBannerImageUrl: null,
    homeBannerLink: '/products?stock=1', homeBannerLinkLabel: 'Available models' } })
  const published = await (await h.route('site-settings').GET()).json()
  assert.equal(published.homeBannerTitle, '<script>promotion</script>')
  assert.equal(published.homeBannerImageUrl, null)
  assert.equal(published.homeBannerLink, '/products?stock=1')
  assert.deepEqual(Object.keys(published).sort(), [...Object.keys(contract.defaultSiteSettings), 'version'].sort())
  assert.equal(contract.isSiteSettings(published), true)
})

test('Banner validation enforces field bounds, enabled title, link label and boolean types before writing', async () => {
  const invalid = [{ homeBannerEnabled: 'true' }, { homeBannerEnabled: null },
    { homeBannerTitle: '' }, { homeBannerTitle: '   ' }, { homeBannerTitle: 'x'.repeat(141) },
    { homeBannerEyebrow: 'x'.repeat(81) }, { homeBannerDescription: 'x'.repeat(501) },
    { homeBannerImageAlt: 'x'.repeat(201) }, { homeBannerLinkLabel: 'x'.repeat(81) },
    { homeBannerLink: '/' + 'x'.repeat(2048) }, { homeBannerLinkLabel: '' },
    { homeBannerTitle: 'bad\nline' }, { homeBannerDescription: 'bad\u0000description' },
    { homeBannerImageAlt: 'bad\nalt' }, { homeBannerTitle: null }]
  for (const overrides of invalid) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values(overrides)))).status, 400, JSON.stringify(overrides))
    assert.equal(h.metrics().writes, 0)
  }
  const h = harness()
  const draft = values({ homeBannerEnabled: false, homeBannerTitle: '', homeBannerEyebrow: 'x'.repeat(80),
    homeBannerDescription: 'x'.repeat(500), homeBannerImageAlt: 'x'.repeat(200), homeBannerLink: null, homeBannerLinkLabel: '' })
  assert.equal((await h.route('admin/site-settings').PATCH(json(draft))).status, 200)
  const h2 = harness()
  assert.equal((await h2.route('admin/site-settings').PATCH(json(values({ homeBannerTitle: 'x'.repeat(140), homeBannerLinkLabel: 'x'.repeat(80) })))).status, 200)
})

test('Banner images use only managed rasters and null restores the built-in artwork', async () => {
  const invalid = ['/brand/panik-trail-banner.png', '/uploads/../banner.png', '/uploads/banner.svg',
    '/uploads/banner.png?download=1', 'https://evil.example/banner.png',
    'https://bucket.public.blob.vercel-storage.com.evil.example/branding/banner.png',
    'https://bucket.public.blob.vercel-storage.com/branding/banner.png?x=1']
  for (const image of invalid) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ homeBannerImageUrl: image })))).status, 400, image)
    assert.equal(h.metrics().writes, 0)
  }
  for (const image of [null, '/uploads/banner.png', 'https://bucket.public.blob.vercel-storage.com/branding/banner.webp']) {
    const h = harness({ row: { homeBannerImageUrl: '/uploads/old-banner.png' } })
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ homeBannerImageUrl: image })))).status, 200)
    assert.equal(h.state().homeBannerImageUrl, image)
  }
})

test('Banner action links reject executable schemes and encoded authority escapes but allow product queries', async () => {
  const invalid = ['javascript:alert(1)', 'data:text/html,promotion', '//evil.example', '/%252fevil.example',
    '/products%0d%0aHost:evil', 'https://u:p@example.com/banner', '/products\\evil', '/%broken']
  for (const link of invalid) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ homeBannerLink: link })))).status, 400, link)
    assert.equal(h.metrics().writes, 0)
  }
  for (const link of [null, '/products?stock=1', '/products?category=trail&stock=1#products', 'https://example.com/promotion']) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ homeBannerLink: link })))).status, 200, String(link))
    const published = await (await h.route('site-settings').GET()).json()
    assert.equal(published.homeBannerLink, link)
    assert.equal(contract.isSiteSettings(published), true)
  }
})

test('Competing banner drafts cannot partially overwrite one another', async () => {
  const h = harness()
  const route = h.route('admin/site-settings')
  const versions = [values({ homeBannerTitle: 'First title', homeBannerImageUrl: '/uploads/first.png' }),
    values({ homeBannerTitle: 'Second title', homeBannerImageUrl: '/uploads/second.png' })]
  const replies = await Promise.all(versions.map(input => route.PATCH(json(input))))
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409])
  const winner = versions[replies.findIndex(reply => reply.status === 200)]
  assert.equal(h.state().homeBannerTitle, winner.homeBannerTitle)
  assert.equal(h.state().homeBannerImageUrl, winner.homeBannerImageUrl)
  assert.equal(h.state().version, 2)
  assert.equal(h.invalidated.length, 1)
})


test('Existing settings and the missing-row fallback keep the forest palette', async () => {
  assert.equal(contract.defaultSiteSettings.colorTheme, 'forest')
  assert.equal(contract.initialSiteSettings.colorTheme, 'forest')
  const h = harness({ missing: true })
  assert.equal((await h.settings.readSiteSettings()).colorTheme, 'forest')
})

test('Both configured color themes save and appear in admin, SSR and public settings', async () => {
  const h = harness()
  const route = h.route('admin/site-settings')
  for (const [colorTheme, version] of [['honey', 1], ['forest', 2]]) {
    const response = await route.PATCH(json(values({ colorTheme, version })))
    assert.equal(response.status, 200)
    const saved = await response.json()
    assert.equal(saved.colorTheme, colorTheme)
    assert.equal(saved.version, version + 1)
    assert.equal(contract.isSiteSettings(saved), true)
    assert.equal((await (await route.GET()).json()).colorTheme, colorTheme)
    assert.equal((await h.settings.readSiteSettings()).colorTheme, colorTheme)
    const published = await (await h.route('site-settings').GET()).json()
    assert.equal(published.colorTheme, colorTheme)
    assert.equal(contract.isSiteSettings(published), true)
  }
  assert.deepEqual(h.invalidated, [['/', 'layout'], ['/', 'layout']])
})

test('Unsupported, missing and non-string themes are rejected before any write and by the client response guard', async () => {
  for (const colorTheme of [undefined, null, true, 1, '', 'Forest', 'HONEY', ' honey ', 'purple', ['honey'], { name: 'honey' }]) {
    const h = harness()
    const input = values({ colorTheme })
    assert.equal(contract.isSiteColorTheme(colorTheme), false)
    assert.equal(contract.isSiteSettings(input), false)
    assert.equal((await h.route('admin/site-settings').PATCH(json(input))).status, 400)
    assert.equal(h.metrics().writes, 0)
    assert.equal(h.state().colorTheme, 'forest')
    assert.equal(h.state().version, 1)
  }
  for (const colorTheme of ['forest', 'honey']) {
    assert.equal(contract.isSiteColorTheme(colorTheme), true)
    assert.equal(contract.isSiteSettings(values({ colorTheme })), true)
  }
})

test('Changing unrelated presentation settings keeps the selected theme and increments the shared version', async () => {
  const h = harness({ row: { colorTheme: 'honey', version: 8 } })
  const route = h.route('admin/site-settings')
  const existing = await (await route.GET()).json()
  const response = await route.PATCH(json({ ...existing, phone: '09123456789', storeName: 'نام تازه' }))
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(saved.colorTheme, 'honey')
  assert.equal(saved.version, 9)
  assert.equal(saved.phone, '09123456789')
  assert.equal(saved.storeName, 'نام تازه')
  assert.equal(h.state().colorTheme, 'honey')
})

test('A stale administrator cannot revert a newly saved palette', async () => {
  const h = harness()
  const route = h.route('admin/site-settings')
  const stale = await (await route.GET()).json()
  assert.equal((await route.PATCH(json({ ...stale, colorTheme: 'honey' }))).status, 200)
  const response = await route.PATCH(json({ ...stale, storeName: 'تغییر قدیمی' }))
  assert.equal(response.status, 409)
  assert.equal(h.state().colorTheme, 'honey')
  assert.equal(h.state().version, 2)
  assert.equal(h.state().storeName, stale.storeName)
  assert.equal(h.invalidated.length, 1)
})
