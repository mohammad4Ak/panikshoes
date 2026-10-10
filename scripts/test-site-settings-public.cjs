const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const root = path.join(__dirname, '..')
const baseSettings = {
  colorTheme: 'forest', storeName: 'نام فروشگاه آزمایشی', tagline: 'شعار فروشگاه آزمایشی',
  logoUrl: null, logoLightUrl: null,
  announcementEnabled: false, announcementText: '', announcementLink: null, announcementLinkLabel: '',
  homeHeroProductIds: [], homeHeroIntervalSeconds: 10,
  homeBannerEnabled: true, homeBannerImageUrl: null, homeBannerEyebrow: 'مسیرهای تازه',
  homeBannerTitle: 'عنوان بنر آزمایشی', homeBannerDescription: 'توضیح بنر آزمایشی',
  homeBannerLink: '/products?stock=1', homeBannerLinkLabel: 'مدل‌های موجود', homeBannerImageAlt: 'کفش در طبیعت',
  phone: '', email: '', address: '', supportHours: '', instagramUrl: null, telegramUrl: null,
  seoTitle: 'فروشگاه آزمایشی', seoDescription: '', version: 1,
}

// Render the real customer components with isolated public settings, without
// touching the site's database, users, uploaded files or persisted settings.
function load(file, settings = baseSettings) {
  const modules = new Map()
  const anchor = ({ children, ...props }) => React.createElement('a', props, children)
  const image = ({ fill, preload, unoptimized, ...props }) => React.createElement('img', props)
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const product = { id: 'product', name: 'کفش نمونه', slug: 'sample', images: ['/sample.png'],
    sizes: [42], stock: 2, price: 100000, category: { name: 'رسمی' } }
  const dependencies = {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'next/link': { __esModule: true, default: anchor },
    'next/image': { __esModule: true, default: image },
    'next/navigation': { usePathname: () => '/', useRouter: () => ({ push() {} }), useSearchParams: () => new URLSearchParams() },
    'next/server': { connection: async () => {} },
    'lucide-react': require('lucide-react'),
    '@/components/layout/SiteSettingsProvider': { useSiteSettings: () => settings },
    './SiteSettingsProvider': { useSiteSettings: () => settings },
    '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session: null, refresh: async () => null }) },
    '@/lib/site-settings': { getSiteSettings: async () => settings },
    '@/components/shop/HomeHeroCarousel': { __esModule: true, default: ({ products }) => React.createElement('div', { 'data-home-hero': true },
      products.map((item) => React.createElement('a', { key: item.id, href: '/products/' + encodeURIComponent(item.slug) }, item.name))), },
    '@/lib/cart': { useCart: (select) => select({ getItemsCount: () => 0 }) },
    '@/lib/session-actions': { signOutWithSessionLock: async () => {} },
    '@/lib/payments': { expireUnpaidOrders: async () => 0, methodAvailability: (method) => ({ available: method.id === 'bank_transfer' }) },
    '@/lib/prisma': { prisma: {
      product: { findMany: async () => [product], findFirst: async () => null },
      category: { findMany: async () => [] },
      shippingMethod: { findMany: async () => [] },
      paymentMethod: { findMany: async () => [] },
    } },
  }
  function readModule(absolute) {
    if (modules.has(absolute)) return modules.get(absolute)
    const testModule = { exports: {} }
    modules.set(absolute, testModule.exports)
    function requireModule(name) {
      if (name in dependencies) return dependencies[name]
      if (name.endsWith('.css')) return css
      if (name.startsWith('@/') || name.startsWith('./')) {
        const filename = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.join(path.dirname(absolute), name)
        for (const extension of ['.tsx', '.ts']) {
          try { readFileSync(filename + extension); return readModule(filename + extension) }
          catch (error) { if (error.code !== 'ENOENT') throw error }
        }
      }
      return require(name)
    }
    const source = readFileSync(absolute, 'utf8')
    const code = transformSync(source, { loader: absolute.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'cjs', target: 'es2022', jsx: 'automatic' }).code
    vm.runInNewContext(code, { module: testModule, require: requireModule, URLSearchParams }, { filename: absolute })
    modules.set(absolute, testModule.exports)
    return testModule.exports
  }
  return readModule(path.join(root, file)).default
}

function render(file, overrides = {}, props = {}) {
  return renderToStaticMarkup(React.createElement(load(file, { ...baseSettings, ...overrides }), props))
}
async function renderServer(file, overrides = {}) {
  const Component = load(file, { ...baseSettings, ...overrides })
  return renderToStaticMarkup(await Component())
}

test('An inactive or empty announcement is absent, even if an action link is configured', () => {
  for (const overrides of [
    { announcementText: 'خبر مهم', announcementEnabled: false },
    { announcementText: ' \n ', announcementEnabled: true },
  ]) {
    assert.equal(render('src/components/layout/AnnouncementBar.tsx', {
      ...overrides, announcementLink: '/products', announcementLinkLabel: 'محصولات',
    }), '')
  }
})

test('Enabled announcement text stays escaped and its optional action remains usable', () => {
  const html = render('src/components/layout/AnnouncementBar.tsx', {
    announcementEnabled: true, announcementText: '<img src=x onerror=alert(1)>\nفروش تازه',
    announcementLink: '/products?stock=1', announcementLinkLabel: 'دیدن مدل‌ها',
  })
  assert.match(html, /اطلاعیهٔ فروشگاه/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img src="x"/)
  assert.match(html, /href="\/products\?stock=1"/)
  assert.match(html, /دیدن مدل‌ها/)
  assert.doesNotMatch(render('src/components/layout/AnnouncementBar.tsx', {
    announcementEnabled: true, announcementText: 'خبر مهم', announcementLink: '/products',
  }), /<a /, 'An unlabeled action must not create an empty link')
})

test('Store name and custom logo appear together in navigation and footer', () => {
  for (const file of ['src/components/layout/Header.tsx', 'src/components/layout/Footer.tsx']) {
    const html = render(file, { storeName: 'فروشگاه <جدید>', logoUrl: '/uploads/logo.png' })
    assert.match(html, /فروشگاه &lt;جدید&gt;/)
    assert.match(html, /src="\/uploads\/logo.png"/)
    assert.doesNotMatch(html, /کفش لند/)
    assert.doesNotMatch(html, /<جدید>/)
  }
})

test('Dark surfaces use the light logo and removing custom logos restores the existing SVG', () => {
  const html = render('src/components/layout/Footer.tsx', {
    logoUrl: '/uploads/logo-dark.png', logoLightUrl: '/uploads/logo-light.png',
  })
  assert.match(html, /src="\/uploads\/logo-light.png"/)
  assert.doesNotMatch(html, /src="\/uploads\/logo-dark.png"/)
  for (const logoLightUrl of [null, '/uploads/main-logo.jpg']) {
    const original = render('src/components/ui/BrandLogo.tsx', { logoUrl: '/uploads/main-logo.jpg', logoLightUrl }, { variant: 'light' })
    assert.match(original, /src="\/uploads\/main-logo.jpg"/)
    assert.doesNotMatch(original, /brightness-0|invert/, 'An uploaded image must keep its original colors on dark surfaces')
  }
  assert.match(render('src/components/ui/BrandLogo.tsx'), /viewBox="0 0 80 80"/)
})

test('Footer shows configured tagline and social destinations without default brand references', () => {
  const html = render('src/components/layout/Footer.tsx', {
    instagramUrl: 'https://instagram.com/example', telegramUrl: 'https://t.me/example',
  })
  assert.match(html, /شعار فروشگاه آزمایشی/)
  assert.match(html, /href="https:\/\/instagram.com\/example"/)
  assert.match(html, /href="https:\/\/t.me\/example"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /SHOELAND/)
  assert.doesNotMatch(render('src/components/layout/Footer.tsx', { tagline: '' }), /شعار فروشگاه آزمایشی/)
})

test('Blank contact settings hide telephone, email, fake address, support hours and email action', async () => {
  const html = await renderServer('src/app/(shop)/contact/page.tsx')
  assert.doesNotMatch(html, /tel:|mailto:|02112345678|shoeland\.ir|خیابان ولیعصر|ساعات پاسخ‌گویی|نوشتن ایمیل/)
  assert.match(html, /راه‌های ارتباط با فروشگاه به‌زودی/)
})

test('Configured contact details produce working links and preserve multiline address and hours', async () => {
  const html = await renderServer('src/app/(shop)/contact/page.tsx', {
    phone: '09123456789', email: 'support@example.test', address: 'نشانی جدید\nپلاک ۵',
    supportHours: 'شنبه: ۹ تا ۵\nجمعه: تعطیل', instagramUrl: 'https://instagram.com/example',
  })
  assert.match(html, /href="tel:09123456789"/)
  assert.match(html, /۰۹۱۲۳۴۵۶۷۸۹/)
  assert.match(html, /href="mailto:support@example\.test"/)
  assert.match(html, /mailto:support@example\.test\?subject=/)
  assert.match(html, /نشانی جدید\nپلاک ۵/)
  assert.match(html, /شنبه: ۹ تا ۵\nجمعه: تعطیل/)
  assert.match(html, /اینستاگرام نام فروشگاه آزمایشی/)
  assert.doesNotMatch(html, /کفش لند|shoeland\.ir|خیابان ولیعصر/)
})

test('Login story, product showcase, about page and home fallback consistently use the configured name', async () => {
  const html = [
    render('src/components/shop/AuthShell.tsx', {}, { children: 'فرم ورود' }),
    render('src/app/(shop)/products/page.tsx'),
    await renderServer('src/app/(shop)/about/page.tsx'),
    await renderServer('src/app/(shop)/page.tsx'),
  ]
  for (const page of html) {
    assert.match(page, /نام فروشگاه آزمایشی/)
    assert.doesNotMatch(page, /کفش لند/)
  }
})
