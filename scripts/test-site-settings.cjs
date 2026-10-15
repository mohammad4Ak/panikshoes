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

const footerLink = (extra = {}) => ({ id: 'products', label: 'محصولات', href: '/products', ...extra })
const footerBadge = (extra = {}) => ({ id: 'enamad', title: 'اینماد', imageUrl: '/uploads/enamad.png', href: 'https://trustseal.enamad.ir/', enabled: true, ...extra })

test('Footer settings normalize and persist ordered links, social destinations and badge configuration', async () => {
  const h = harness()
  const input = values({ footerDescription: '  توضیح فروشگاه\nخط دوم  ', footerCopyright: '  حقوق فروشگاه  ',
    footerLinks: [footerLink({ id: ' support ', label: '  پشتیبانی  ', href: ' /contact ' }), footerLink()],
    footerBadges: [footerBadge({ title: '  اینماد  ' }), footerBadge({ id: 'snapp-pay', title: 'اسنپ پی', imageUrl: 'https://bucket.public.blob.vercel-storage.com/branding/snapp.webp', href: null, enabled: false })],
    eitaaUrl: ' https://eitaa.com/panik ', whatsappUrl: 'https://wa.me/989123456789' })
  const response = await h.route('admin/site-settings').PATCH(json(input))
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(saved.version, 2)
  assert.equal(saved.footerDescription, 'توضیح فروشگاه\nخط دوم')
  assert.equal(saved.footerCopyright, 'حقوق فروشگاه')
  assert.deepEqual(saved.footerLinks.map((link) => link.id), ['support', 'products'])
  assert.deepEqual(saved.footerLinks[0], { id: 'support', label: 'پشتیبانی', href: '/contact' })
  assert.equal(saved.footerBadges[0].title, 'اینماد')
  assert.equal(saved.footerBadges[1].href, null)
  assert.equal(saved.eitaaUrl, 'https://eitaa.com/panik')
  assert.equal(saved.whatsappUrl, input.whatsappUrl)
  assert.equal(contract.isSiteSettings(saved), true)
  assert.deepEqual(h.state().footerLinks, saved.footerLinks)
  assert.deepEqual(h.invalidated, [['/', 'layout']])
})

test('Disabled footer badges, including their draft images and destinations, remain admin-only', async () => {
  const enabled = footerBadge()
  const disabled = footerBadge({ id: 'private-draft', imageUrl: '/uploads/unpublished.png', href: '/private-promotion', enabled: false })
  const h = harness({ row: { footerBadges: [disabled, enabled] } })
  const admin = await (await h.route('admin/site-settings').GET()).json()
  const published = await (await h.route('site-settings').GET()).json()
  assert.deepEqual(admin.footerBadges, [disabled, enabled])
  assert.deepEqual(published.footerBadges, [enabled])
  assert.equal(JSON.stringify(published).includes('unpublished.png'), false)
  assert.equal(JSON.stringify(published).includes('private-promotion'), false)
  assert.equal(contract.isSiteSettings(published), true)
  assert.deepEqual(h.state().footerBadges, [disabled, enabled])
})

test('Older settings clients preserve new footer fields when omitted, while explicit empty values clear them', async () => {
  const existing = { footerDescription: 'Description', footerCopyright: 'Copyright', footerLinks: [footerLink()],
    footerBadges: [footerBadge()], eitaaUrl: 'https://eitaa.com/panik', whatsappUrl: 'https://wa.me/989123456789' }
  const h = harness({ row: existing })
  const legacy = values({ storeName: 'تغییر نام' })
  for (const key of Object.keys(existing)) delete legacy[key]
  const result = await h.route('admin/site-settings').PATCH(json(legacy))
  assert.equal(result.status, 200)
  for (const [key, value] of Object.entries(existing)) assert.deepEqual(h.state()[key], value, key)
  assert.equal(h.state().storeName, 'تغییر نام')
  const cleared = await h.route('admin/site-settings').PATCH(json(values({ version: 2, footerDescription: '', footerCopyright: '',
    footerLinks: [], footerBadges: [], eitaaUrl: null, whatsappUrl: null })))
  assert.equal(cleared.status, 200)
  const saved = await cleared.json()
  assert.deepEqual(saved.footerLinks, [])
  assert.deepEqual(saved.footerBadges, [])
  assert.equal(saved.footerDescription, '')
  assert.equal(saved.footerCopyright, '')
  assert.equal(saved.eitaaUrl, null)
  assert.equal(saved.whatsappUrl, null)
})

test('Footer arrays enforce exact object fields, unique bounded IDs, text bounds and counts', async () => {
  const invalid = [{ footerDescription: 'x'.repeat(801) }, { footerDescription: 'bad\u0000text' },
    { footerDescription: null }, { footerCopyright: 'x'.repeat(201) }, { footerCopyright: 'bad\nline' },
    { footerLinks: null }, { footerLinks: {} }, { footerLinks: [null] }, { footerLinks: [footerLink({ id: 'bad id' })] },
    { footerLinks: [footerLink({ id: 'x'.repeat(65) })] }, { footerLinks: [footerLink({ label: '' })] },
    { footerLinks: [footerLink({ label: 'x'.repeat(81) })] }, { footerLinks: [footerLink({ html: '<b>injection</b>' })] },
    { footerLinks: [footerLink(), footerLink()] }, { footerLinks: Array.from({ length: 11 }, (_, i) => footerLink({ id: `item-${i}` })) },
    { footerBadges: null }, { footerBadges: {} }, { footerBadges: [null] }, { footerBadges: [footerBadge({ id: 'bad/id' })] },
    { footerBadges: [footerBadge({ title: '' })] }, { footerBadges: [footerBadge({ title: 'x'.repeat(81) })] },
    { footerBadges: [footerBadge({ enabled: 'false' })] }, { footerBadges: [footerBadge({ html: '<script>bad</script>' })] },
    { footerBadges: [footerBadge(), footerBadge()] }, { footerBadges: Array.from({ length: 9 }, (_, i) => footerBadge({ id: `badge-${i}` })) }]
  for (const changes of invalid) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values(changes)))).status, 400, JSON.stringify(changes))
    assert.equal(h.metrics().writes, 0)
  }
  const h = harness()
  const response = await h.route('admin/site-settings').PATCH(json(values({ footerDescription: 'x'.repeat(800), footerCopyright: 'x'.repeat(200),
    footerLinks: Array.from({ length: 10 }, (_, i) => footerLink({ id: `item-${i}`, label: 'x'.repeat(80) })),
    footerBadges: Array.from({ length: 8 }, (_, i) => footerBadge({ id: `badge-${i}`, title: 'x'.repeat(80) })) })))
  assert.equal(response.status, 200)
})

test('Footer destinations reject unsafe schemes and encoded escapes for both links and badges', async () => {
  const invalid = ['http://example.com', 'javascript:alert(1)', 'data:text/html,bad', '//evil.example', '/\\evil.example',
    '/%2fevil.example', '/%2525252fevil.example', '/products%0d%0aHost:evil', 'https://u:p@example.com',
    '/products\\evil', 'https://example.com/\\evil', 'https://example.com/has space', '/%broken', '']
  for (const href of invalid) {
    for (const changes of [{ footerLinks: [footerLink({ href })] }, ...(href ? [{ footerBadges: [footerBadge({ href })] }] : [])]) {
      const h = harness()
      assert.equal((await h.route('admin/site-settings').PATCH(json(values(changes)))).status, 400, href)
      assert.equal(h.metrics().writes, 0)
    }
    assert.equal(contract.isFooterLinks([footerLink({ href })]), false, href)
    assert.equal(contract.isFooterBadges([footerBadge({ href })]), false, href)
  }
  for (const href of ['/contact', '/products?cat=formal#list', 'https://example.com/partner']) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ footerLinks: [footerLink({ href })], footerBadges: [footerBadge({ href })] })))).status, 200, href)
  }
})

test('Footer badge images accept managed rasters and official Enamad verification images only', async () => {
  const allowed = ['/uploads/badge.png', 'https://bucket.public.blob.vercel-storage.com/branding/badge.webp',
    'https://bucket.public.blob.vercel-storage.com/products/badge.gif', 'https://trustseal.enamad.ir/logo.aspx?id=12345&Code=abcd1234']
  const invalid = ['/uploads/../badge.png', '/uploads/badge.svg', '/uploads/badge.png?x=1', 'https://evil.example/badge.png',
    'https://trustseal.enamad.ir.evil.example/logo.aspx?id=1&Code=abc', 'http://trustseal.enamad.ir/logo.aspx?id=1&Code=abc',
    'https://trustseal.enamad.ir/logo.aspx?id=1', 'https://trustseal.enamad.ir/logo.aspx?id=abc&Code=abc',
    'https://trustseal.enamad.ir/logo.aspx?id=1&Code=abc&Code=def', 'https://trustseal.enamad.ir/logo.aspx?id=1&Code=abc&redirect=evil',
    'https://trustseal.enamad.ir/logo.aspx?id=1&Code=abc#fragment', 'https://trustseal.enamad.ir:8443/logo.aspx?id=1&Code=abc',
    'https://trustseal.enamad.ir/logo.png', 'https://bucket.public.blob.vercel-storage.com/branding/badge.svg',
    'https://bucket.public.blob.vercel-storage.com/branding/badge.png?download=1']
  for (const imageUrl of [...allowed, ...invalid]) {
    const h = harness()
    const valid = allowed.includes(imageUrl)
    assert.equal(contract.isFooterBadges([footerBadge({ imageUrl })]), valid, imageUrl)
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ footerBadges: [footerBadge({ imageUrl })] })))).status, valid ? 200 : 400, imageUrl)
    if (!valid) assert.equal(h.metrics().writes, 0)
  }
})

test('Eitaa and WhatsApp social URLs validate the service, recipient path and query phone', async () => {
  const valid = [{ eitaaUrl: 'https://eitaa.com/kafsh_panik' }, { whatsappUrl: 'https://wa.me/989123456789' },
    { whatsappUrl: 'https://wa.me/989123456789?text=hello' }, { whatsappUrl: 'https://api.whatsapp.com/send?phone=989123456789&text=hello' }]
  const invalid = [{ eitaaUrl: 'http://eitaa.com/channel' }, { eitaaUrl: 'https://eitaa.com.evil.example/channel' },
    { eitaaUrl: 'https://u:p@eitaa.com/channel' }, { eitaaUrl: 'https://eitaa.com:8443/channel' },
    { whatsappUrl: 'https://wa.me/channel' }, { whatsappUrl: 'https://wa.me/123' }, { whatsappUrl: 'https://wa.me/1234567890123456' },
    { whatsappUrl: 'https://wa.me.evil.example/989123456789' }, { whatsappUrl: 'http://wa.me/989123456789' },
    { whatsappUrl: 'https://api.whatsapp.com/send' }, { whatsappUrl: 'https://api.whatsapp.com/send?phone=invalid' },
    { whatsappUrl: 'https://api.whatsapp.com/send?phone=989123456789&phone=989111111111' },
    { whatsappUrl: 'https://api.whatsapp.com/other?phone=989123456789' }]
  for (const changes of [...valid, ...invalid]) {
    const h = harness()
    assert.equal((await h.route('admin/site-settings').PATCH(json(values(changes)))).status, valid.includes(changes) ? 200 : 400, JSON.stringify(changes))
    if (invalid.includes(changes)) assert.equal(h.metrics().writes, 0)
  }
})

test('Client footer guards and database readers reject malformed JSON collections safely', async () => {
  const malformedLinks = [null, {}, [footerLink({ id: 'bad id' })], [footerLink(), footerLink()], [footerLink({ href: 'javascript:bad' })], Array(1)]
  const malformedBadges = [null, {}, [footerBadge({ enabled: 'true' })], [footerBadge({ href: 'data:text/html,bad' })], [footerBadge({ imageUrl: 'https://evil.example/badge.png' })], Array(1)]
  for (const footerLinks of malformedLinks) {
    assert.equal(contract.isFooterLinks(footerLinks), false)
    assert.equal(contract.isSiteSettings(values({ footerLinks })), false)
    const h = harness({ row: { footerLinks } })
    assert.deepEqual((await (await h.route('admin/site-settings').GET()).json()).footerLinks, clone(contract.defaultFooterLinks))
  }
  for (const footerBadges of malformedBadges) {
    assert.equal(contract.isFooterBadges(footerBadges), false)
    assert.equal(contract.isSiteSettings(values({ footerBadges })), false)
    const h = harness({ row: { footerBadges } })
    assert.deepEqual((await (await h.route('site-settings').GET()).json()).footerBadges, [])
  }
  assert.equal(contract.isFooterLinks([]), true)
  assert.equal(contract.isFooterBadges([]), true)
})

test('The additive footer migration defaults match the client contract without replacing existing settings', () => {
  const sql = readFileSync(path.join(__dirname, '../prisma/migrations/20261015120000_footer_customization/migration.sql'), 'utf8')
  const linksJson = sql.match(/ADD COLUMN "footerLinks" JSONB NOT NULL DEFAULT '([^']+)'::JSONB/)[1]
  assert.deepEqual(JSON.parse(linksJson), clone(contract.defaultFooterLinks))
  assert.match(sql, /ADD COLUMN "footerBadges" JSONB NOT NULL DEFAULT '\[\]'::JSONB/)
  assert.match(sql, /jsonb_array_length\("footerLinks"\) <= 10/)
  assert.match(sql, /jsonb_array_length\("footerBadges"\) <= 8/)
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|DROP|UPDATE|INSERT)\b/i)
  assert.equal(contract.defaultSiteSettings.footerDescription, '')
  assert.equal(contract.defaultSiteSettings.footerCopyright, '')
  assert.equal(contract.defaultSiteSettings.footerBadges.length, 0)
  assert.equal(contract.defaultSiteSettings.eitaaUrl, null)
  assert.equal(contract.defaultSiteSettings.whatsappUrl, null)
})

const footerSocial = (extra = {}) => ({ id: 'instagram', label: 'اینستاگرام', href: 'https://www.instagram.com/panik/', icon: 'instagram', iconUrl: null, enabled: true, ...extra })

test('Custom footer social entries preserve order, arbitrary HTTPS destinations and optional icon-only labels', async () => {
  const h = harness({ row: { instagramUrl: 'https://instagram.com/existing-contact', eitaaUrl: 'https://eitaa.com/existing-contact' } })
  const input = values({ instagramUrl: 'https://instagram.com/existing-contact', eitaaUrl: 'https://eitaa.com/existing-contact', footerSocialLinks: [
    footerSocial({ id: 'custom-channel', label: '  ', href: ' https://social.example/panik ', icon: 'custom', iconUrl: ' /uploads/social.png ' }),
    footerSocial({ id: 'website', label: '  سایت ما  ', href: 'https://example.com/', icon: 'link' }),
    footerSocial({ id: 'other-channel', href: 'https://another.example/channel', icon: 'telegram' }),
  ] })
  const response = await h.route('admin/site-settings').PATCH(json(input))
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(saved.version, 2)
  assert.deepEqual(saved.footerSocialLinks.map((social) => social.id), ['custom-channel', 'website', 'other-channel'])
  assert.equal(saved.footerSocialLinks[0].label, '')
  assert.equal(saved.footerSocialLinks[0].href, 'https://social.example/panik')
  assert.equal(saved.footerSocialLinks[0].iconUrl, '/uploads/social.png')
  assert.equal(saved.footerSocialLinks[1].label, 'سایت ما')
  assert.equal(saved.instagramUrl, input.instagramUrl)
  assert.equal(saved.eitaaUrl, input.eitaaUrl)
  assert.equal(contract.isSiteSettings(saved), true)
  assert.deepEqual(h.state().footerSocialLinks, saved.footerSocialLinks)
})

test('Disabled social drafts keep their label, destination and custom icon out of every public projection', async () => {
  const visible = footerSocial({ label: '' })
  const hidden = footerSocial({ id: 'private-channel', label: 'Unpublished channel', href: 'https://private.example/social-draft',
    icon: 'custom', iconUrl: '/uploads/private-social-icon.png', enabled: false })
  const h = harness({ row: { footerSocialLinks: [hidden, visible] } })
  const admin = await (await h.route('admin/site-settings').GET()).json()
  const published = await (await h.route('site-settings').GET()).json()
  assert.deepEqual(admin.footerSocialLinks, [hidden, visible])
  assert.deepEqual(published.footerSocialLinks, [visible])
  for (const draft of ['Unpublished channel', 'private.example', 'private-social-icon.png']) assert.equal(JSON.stringify(published).includes(draft), false)
  assert.equal(contract.isSiteSettings(published), true)
  assert.deepEqual(h.state().footerSocialLinks, [hidden, visible])
})

test('Older saves preserve dynamic footer socials, while deleting the list never restores legacy contact links', async () => {
  const existing = [footerSocial({ label: '', icon: 'custom', iconUrl: '/uploads/social.webp' })]
  const instagramUrl = 'https://instagram.com/contact'
  const h = harness({ row: { footerSocialLinks: existing, instagramUrl } })
  const legacyInput = values({ instagramUrl, phone: '09123456789' })
  delete legacyInput.footerSocialLinks
  assert.equal((await h.route('admin/site-settings').PATCH(json(legacyInput))).status, 200)
  assert.deepEqual(h.state().footerSocialLinks, existing)
  assert.equal((await h.route('admin/site-settings').PATCH(json(values({ version: 2, instagramUrl, footerSocialLinks: [] })))).status, 200)
  assert.deepEqual(h.state().footerSocialLinks, [])
  assert.equal(h.state().instagramUrl, instagramUrl)
  assert.deepEqual((await (await h.route('site-settings').GET()).json()).footerSocialLinks, [])
})

test('Dynamic social validation enforces strict objects, unique bounded IDs, icon selection and array limits', async () => {
  const invalid = [null, {}, [null], [footerSocial({ id: '' })], [footerSocial({ id: 'bad id' })], [footerSocial({ id: 'x'.repeat(65) })],
    [footerSocial({ label: null })], [footerSocial({ label: 'x'.repeat(81) })], [footerSocial({ label: 'bad\nline' })],
    [footerSocial({ icon: 'unknown' })], [footerSocial({ icon: null })], [footerSocial({ iconUrl: undefined })],
    [footerSocial({ enabled: 'true' })], [footerSocial({ html: '<script>bad</script>' })], [footerSocial(), footerSocial()],
    Array.from({ length: 13 }, (_, index) => footerSocial({ id: `social-${index}` }))]
  for (const footerSocialLinks of invalid) {
    const h = harness()
    assert.equal(contract.isFooterSocialLinks(footerSocialLinks), false)
    assert.equal(contract.isSiteSettings(values({ footerSocialLinks })), false)
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ footerSocialLinks })))).status, 400, JSON.stringify(footerSocialLinks))
    assert.equal(h.metrics().writes, 0)
  }
  const h = harness()
  const entries = Array.from({ length: 12 }, (_, index) => footerSocial({ id: `social-${index}`, label: index ? 'x'.repeat(80) : '', icon: contract.footerSocialIcons[index % contract.footerSocialIcons.length], iconUrl: index % contract.footerSocialIcons.length === 5 ? '/uploads/custom.webp' : null }))
  assert.equal(contract.isFooterSocialLinks(entries), true)
  assert.equal((await h.route('admin/site-settings').PATCH(json(values({ footerSocialLinks: entries })))).status, 200)
  assert.equal(contract.isFooterSocialLinks([]), true)
  assert.equal(contract.isFooterSocialLinks(Array(1)), false)
})

test('Social destinations use absolute HTTPS without credentials, malformed escapes or internal paths', async () => {
  const invalid = ['/contact', '//example.com', 'http://social.example', 'https:social.example', 'javascript:alert(1)',
    'data:text/html,bad', 'https://u:p@social.example', 'https://social.example/\\evil', 'https://social.example/has space',
    'https://social.example/%0a', 'https://social.example/%250d', 'https://social.example/%broken', '']
  for (const href of invalid) {
    const h = harness()
    assert.equal(contract.isFooterSocialHref(href), false, href)
    assert.equal(contract.isFooterSocialLinks([footerSocial({ href })]), false, href)
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ footerSocialLinks: [footerSocial({ href })] })))).status, 400, href)
    assert.equal(h.metrics().writes, 0)
  }
  for (const href of ['https://custom.example/channel?name=panik#posts', 'https://another.example/path', 'HTTPS://EXAMPLE.COM/']) assert.equal(contract.isFooterSocialHref(href), true)
})

test('Custom social icons require managed uploaded rasters and cannot use arbitrary external or Enamad image URLs', async () => {
  const valid = ['/uploads/social.webp', 'https://bucket.public.blob.vercel-storage.com/branding/social.png', 'https://bucket.public.blob.vercel-storage.com/products/social.gif']
  const invalid = [null, '', '/uploads/social.svg', '/uploads/../social.png', '/uploads/social.png?x=1', 'https://evil.example/social.png',
    'https://trustseal.enamad.ir/logo.aspx?id=12345&Code=abcd1234', 'https://bucket.public.blob.vercel-storage.com.evil.example/branding/social.png',
    'https://bucket.public.blob.vercel-storage.com/branding/social.png?x=1', 'http://bucket.public.blob.vercel-storage.com/branding/social.png']
  for (const iconUrl of [...valid, ...invalid]) {
    const h = harness()
    const allowed = valid.includes(iconUrl)
    assert.equal(contract.isFooterSocialIconUrl(iconUrl), allowed, String(iconUrl))
    assert.equal((await h.route('admin/site-settings').PATCH(json(values({ footerSocialLinks: [footerSocial({ icon: 'custom', iconUrl })] })))).status, allowed ? 200 : 400, String(iconUrl))
    if (!allowed) assert.equal(h.metrics().writes, 0)
  }
})

test('Legacy social fallback is ordered and only applies to a missing new field, never to empty or invalid explicit lists', async () => {
  const legacy = { instagramUrl: 'https://instagram.com/panik', telegramUrl: 'https://t.me/panik', eitaaUrl: 'https://eitaa.com/panik', whatsappUrl: 'https://wa.me/989123456789' }
  const fallback = clone(contract.resolveFooterSocialLinks(legacy))
  assert.deepEqual(fallback.map((social) => social.icon), ['instagram', 'telegram', 'eitaa', 'whatsapp'])
  assert.deepEqual(fallback.map((social) => social.href), Object.values(legacy))
  assert.equal(fallback.every((social) => social.enabled && social.iconUrl === null), true)
  assert.equal(contract.isFooterSocialLinks(fallback), true)
  assert.deepEqual(clone(contract.resolveFooterSocialLinks({ ...legacy, footerSocialLinks: [] })), [])
  assert.deepEqual(clone(contract.resolveFooterSocialLinks({ ...legacy, footerSocialLinks: null })), [])
  assert.deepEqual(clone(contract.resolveFooterSocialLinks({ ...legacy, footerSocialLinks: [footerSocial({ href: 'javascript:bad' })] })), [])
  const h = harness({ row: { ...legacy, footerSocialLinks: undefined } })
  assert.deepEqual((await (await h.route('admin/site-settings').GET()).json()).footerSocialLinks, fallback)
  assert.deepEqual((await (await h.route('site-settings').GET()).json()).footerSocialLinks, fallback)
  const bad = harness({ row: { ...legacy, footerSocialLinks: [footerSocial({ icon: 'custom', iconUrl: 'https://evil.example/icon.svg' })] } })
  assert.deepEqual((await (await bad.route('site-settings').GET()).json()).footerSocialLinks, [])
})

test('Social migration adds a bounded array and backfills existing contact links without clearing legacy data', () => {
  const sql = readFileSync(path.join(__dirname, '../prisma/migrations/20261015130000_footer_social_links/migration.sql'), 'utf8')
  assert.match(sql, /ADD COLUMN "footerSocialLinks" JSONB NOT NULL DEFAULT '\[\]'::JSONB/)
  assert.match(sql, /jsonb_typeof\("footerSocialLinks"\) = 'array'/)
  assert.match(sql, /jsonb_array_length\("footerSocialLinks"\) <= 12/)
  assert.match(sql, /jsonb_agg\(jsonb_build_object\(/)
  assert.match(sql, /ORDER BY social.position/)
  for (const key of ['instagramUrl', 'telegramUrl', 'eitaaUrl', 'whatsappUrl']) assert.match(sql, new RegExp(`settings\\."${key}"`))
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|DROP)\b/i)
  assert.deepEqual(clone(contract.defaultSiteSettings.footerSocialLinks), [])
  assert.equal(contract.footerLimits.maxSocialLinks, 12)
})
