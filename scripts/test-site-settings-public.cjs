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
    vm.runInNewContext(code, { module: testModule, require: requireModule, URLSearchParams, URL }, { filename: absolute })
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

test('Footer renders configured copy and ordered links, with an icon and accessible name for each social destination', () => {
  const html = render('src/components/layout/Footer.tsx', {
    footerDescription: 'معرفی <پانیک>\nتولیدی کفش زنانه', footerCopyright: 'حقوق سفارشی <فروشگاه>',
    footerLinks: [{ id: 'size', label: 'راهنمای سایز', href: '/products?q=size' }, { id: 'external', label: 'صفحهٔ برند', href: 'https://example.test/panik' }],
    instagramUrl: 'https://instagram.com/example', telegramUrl: 'https://t.me/example',
    eitaaUrl: 'https://eitaa.com/example', whatsappUrl: 'https://wa.me/989123456789',
  })
  assert.match(html, /معرفی &lt;پانیک&gt;\nتولیدی کفش زنانه/)
  assert.match(html, /حقوق سفارشی &lt;فروشگاه&gt;/)
  assert.doesNotMatch(html, /شعار فروشگاه آزمایشی|KEEP MOVING|MADE FOR/)
  assert.ok(html.indexOf('راهنمای سایز') < html.indexOf('صفحهٔ برند'))
  assert.match(html, /href="https:\/\/example.test\/panik" target="_blank" rel="noopener noreferrer"/)
  for (const name of ['اینستاگرام', 'تلگرام', 'ایتا', 'واتساپ']) {
    assert.match(html, new RegExp(`aria-label="${name} نام فروشگاه آزمایشی"><svg`))
  }
})

test('Footer badges show only enabled managed images, retain verification links and allow unlinked service logos', () => {
  const html = render('src/components/layout/Footer.tsx', {
    footerBadges: [
      { id: 'enamad', title: 'اینماد', imageUrl: 'https://trustseal.enamad.ir/logo.aspx?id=123&Code=abc', href: 'https://trustseal.enamad.ir/?id=123&Code=abc', enabled: true },
      { id: 'service', title: 'نشان پرداخت', imageUrl: '/uploads/service.png', href: null, enabled: true },
      { id: 'hidden', title: 'پیش‌نویس خصوصی', imageUrl: '/uploads/hidden.png', href: 'https://example.test/private', enabled: false },
    ],
  })
  assert.match(html, /aria-label="نشان‌ها و خدمات فروشگاه"/)
  assert.match(html, /href="https:\/\/trustseal.enamad.ir\/\?id=123&amp;Code=abc" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /src="https:\/\/trustseal.enamad.ir\/logo.aspx\?id=123&amp;Code=abc"/)
  assert.match(html, /referrerPolicy="origin"/)
  assert.match(html, /src="\/uploads\/service.png"/)
  assert.doesNotMatch(html, /پیش‌نویس خصوصی|hidden.png|example.test\/private/)
  assert.equal((html.match(/aria-label="مشاهدهٔ /g) ?? []).length, 1)
  assert.doesNotMatch(render('src/components/layout/Footer.tsx', { footerBadges: [] }), /نشان‌ها و خدمات فروشگاه/)
})

test('Footer social labels are optional and custom destinations have an uploaded icon with accessible fallback names', () => {
  const html = render('src/components/layout/Footer.tsx', {
    footerSocialLinks: [
      { id: 'instagram', label: '', href: 'https://instagram.com/panik', icon: 'instagram', iconUrl: null, enabled: true },
      { id: 'custom', label: 'کانال <ما>', href: 'https://example.test/channel', icon: 'custom', iconUrl: '/uploads/custom-social.png', enabled: true },
      { id: 'empty-custom', label: ' ', href: 'https://social.example.test/channel', icon: 'custom', iconUrl: '/uploads/other.png', enabled: true },
      { id: 'disabled', label: 'پیش‌نویس', href: 'https://example.test/disabled', icon: 'link', iconUrl: null, enabled: false },
    ],
  })
  assert.match(html, /class="socialIconOnly" href="https:\/\/instagram.com\/panik"/)
  assert.match(html, /aria-label="اینستاگرام نام فروشگاه آزمایشی" title="اینستاگرام"/)
  assert.doesNotMatch(html, /<span>اینستاگرام<\/span>/)
  assert.match(html, /<span>کانال &lt;ما&gt;<\/span>/)
  assert.match(html, /src="\/uploads\/custom-social.png"/)
  assert.match(html, /aria-label="social.example.test نام فروشگاه آزمایشی"/)
  assert.doesNotMatch(html, /پیش‌نویس|example.test\/disabled/)
})

test('An explicitly cleared dynamic social list does not resurrect old fixed social links', () => {
  const html = render('src/components/layout/Footer.tsx', { footerSocialLinks: [], instagramUrl: 'https://instagram.com/old', telegramUrl: 'https://t.me/old' })
  assert.doesNotMatch(html, /شبکه‌های اجتماعی فروشگاه|instagram.com\/old|t.me\/old/)
})

test('Contact page uses the same enabled custom social list and does not revive legacy destinations', async () => {
  const html = await renderServer('src/app/(shop)/contact/page.tsx', {
    instagramUrl: 'https://instagram.com/old', telegramUrl: 'https://t.me/old',
    footerSocialLinks: [
      { id: 'custom', label: 'کانال پانیک', href: 'https://example.test/panik', icon: 'custom', iconUrl: '/uploads/social.png', enabled: true },
      { id: 'disabled', label: 'غیرفعال', href: 'https://example.test/disabled', icon: 'telegram', iconUrl: null, enabled: false },
    ],
  })
  assert.match(html, /href="https:\/\/example.test\/panik"/)
  assert.match(html, /src="\/uploads\/social.png"/)
  assert.match(html, /کانال پانیک/)
  assert.doesNotMatch(html, /instagram.com\/old|t.me\/old|example.test\/disabled/)
  const cleared = await renderServer('src/app/(shop)/contact/page.tsx', { footerSocialLinks: [], instagramUrl: 'https://instagram.com/old' })
  assert.doesNotMatch(cleared, /instagram.com\/old/)
  assert.match(cleared, /راه‌های ارتباط با فروشگاه به‌زودی/)
})

test('Footer can omit every configurable collection and contact without leaving empty navigation or social links', () => {
  const html = render('src/components/layout/Footer.tsx', {
    footerLinks: [], footerBadges: [], footerDescription: '', tagline: '',
    instagramUrl: null, telegramUrl: null, eitaaUrl: null, whatsappUrl: null,
  })
  assert.doesNotMatch(html, /<nav|شبکه‌های اجتماعی فروشگاه|نشان‌ها و خدمات فروشگاه|tel:|mailto:/)
  assert.match(html, /نام فروشگاه آزمایشی · تمامی حقوق محفوظ است./)
  assert.match(html, /ارتباط با فروشگاه/)
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
