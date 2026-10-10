const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const file = path.join(__dirname, '../src/components/shop/HomeContent.tsx')
const imageCalls = []
const code = transformSync(readFileSync(file, 'utf8'), {
  loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic',
}).code
const compiled = { exports: {} }
const dependencies = {
  'react/jsx-runtime': require('react/jsx-runtime'),
  'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
  'next/image': { __esModule: true, default: (props) => {
    imageCalls.push(props)
    const { fill, sizes, unoptimized, ...imageProps } = props
    return React.createElement('img', imageProps)
  } },
  'lucide-react': require('lucide-react'),
  './HomeContent.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
}
vm.runInNewContext(code, { module: compiled, require: (name) => {
  if (!(name in dependencies)) throw new Error('Unexpected homepage dependency: ' + name)
  return dependencies[name]
} }, { filename: file })
const { HomeBanner, HomeSelectionGuide, HomePurchaseInfo } = compiled.exports
const bannerSettings = {
  homeBannerEnabled: true,
  homeBannerImageUrl: null,
  homeBannerEyebrow: 'یک مسیر تازه',
  homeBannerTitle: 'از شهر تا مسیر بعدی',
  homeBannerDescription: 'کفش را متناسب با برنامه‌ات انتخاب کن.',
  homeBannerLink: '/products?stock=1',
  homeBannerLinkLabel: 'دیدن مدل‌ها',
  homeBannerImageAlt: 'کفش طبیعت‌گردی در مسیر کوهستانی',
}
const renderBanner = (settings = {}) => renderToStaticMarkup(React.createElement(HomeBanner, { settings: { ...bannerSettings, ...settings } }))
const renderGuide = (categories) => renderToStaticMarkup(React.createElement(HomeSelectionGuide, { categories }))
const renderPurchase = (props = {}) => renderToStaticMarkup(React.createElement(HomePurchaseInfo, {
  shippingMethods: [], paymentMethods: [], storeName: 'کفش پانیک', ...props,
}))

test('Disabling the banner or clearing its title removes its image, message and action', () => {
  imageCalls.length = 0
  assert.equal(renderBanner({ homeBannerEnabled: false }), '')
  assert.equal(renderBanner({ homeBannerTitle: ' \n ' }), '')
  assert.equal(imageCalls.length, 0)
})

test('Banner uses the built-in image until an uploaded image is configured', () => {
  imageCalls.length = 0
  const html = renderBanner()
  assert.match(html, /src="\/brand\/panik-trail-banner\.png"/)
  assert.equal(imageCalls[0].unoptimized, false)
  imageCalls.length = 0
  const uploaded = renderBanner({ homeBannerImageUrl: '/uploads/banner.webp', homeBannerImageAlt: 'تصویر انتخابی فروشگاه' })
  assert.match(uploaded, /src="\/uploads\/banner\.webp"/)
  assert.match(uploaded, /alt="تصویر انتخابی فروشگاه"/)
  assert.equal(imageCalls[0].unoptimized, true, 'Uploaded URLs must not cause an image-optimizer server fetch')
})

test('Banner content stays escaped and only labeled actions create links', () => {
  const html = renderBanner({
    homeBannerTitle: '<script>alert(1)</script>',
    homeBannerDescription: '<img src=x onerror=alert(1)>',
  })
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<script>|<img src=x/)
  assert.match(html, /href="\/products\?stock=1"/)
  assert.doesNotMatch(renderBanner({ homeBannerLinkLabel: '  ' }), /<a /)
  assert.doesNotMatch(renderBanner({ homeBannerLink: null }), /<a /)
})

test('Selection guide links only real catalog categories using encoded IDs and available-stock filtering', () => {
  const html = renderGuide([
    { id: 'hiking &/1', name: 'کوهنوردی <آزمایشی>', slug: 'hiking' },
    { id: 'formal', name: 'رسمی', slug: 'formal' },
    { id: 'daily', name: 'کتانی', slug: 'sneaker' },
  ])
  assert.match(html, /href="\/products\?cat=hiking%20%26%2F1&amp;stock=1"/)
  assert.match(html, /href="\/products\?cat=daily&amp;stock=1"/)
  assert.match(html, /کوهنوردی &lt;آزمایشی&gt;/)
  assert.doesNotMatch(html, /cat=formal|cat=waterproofs|بزن به دلِ طبیعت/)
  assert.equal(renderGuide([]), '')
  assert.equal(renderGuide([{ id: 'formal', name: 'رسمی', slug: 'formal' }]), '')
})

test('Purchase information uses supplied active methods and describes manual review and invoice timing', () => {
  const html = renderPurchase({
    storeName: 'پانیک <جدید>',
    shippingMethods: [{ name: 'تیپاکس' }, { name: 'پست پیشتاز' }],
    paymentMethods: [{ id: 'bank_transfer', name: 'انتقال کارت‌به‌کارت' }],
  })
  assert.match(html, /تیپاکس/)
  assert.match(html, /پست پیشتاز/)
  assert.match(html, /انتقال کارت‌به‌کارت/)
  assert.match(html, /پرداخت پس از بررسی فروشگاه تأیید می‌شود/)
  assert.match(html, /پس از تأیید سفارش و شروع پردازش/)
  assert.match(html, /href="\/profile"/)
  assert.match(html, /href="\/contact"/)
  assert.match(html, /پانیک &lt;جدید&gt;/)
  assert.doesNotMatch(html, /زرین|تأیید خودکار|ارسال رایگان|تضمین|شماره کارت/)
})

test('No active shipping or payment methods yields honest unavailability without invented offerings', () => {
  const html = renderPurchase()
  assert.match(html, /در حال حاضر روش ارسال فعالی نداریم/)
  assert.match(html, /در حال حاضر روش پرداخت فعالی نداریم/)
  assert.doesNotMatch(html, /پست پیشتاز|تیپاکس|ماهکس|کارت‌به‌کارت|بارگذاری کن|تأیید خودکار/)
})

test('Non-transfer payment does not show bank-transfer instructions, and many shipping methods stay summarized', () => {
  const html = renderPurchase({
    shippingMethods: Array.from({ length: 6 }, (_, index) => ({ name: 'ارسال ' + (index + 1) })),
    paymentMethods: [{ id: 'future_gateway', name: 'درگاه آزمایشی' }],
  })
  assert.match(html, /درگاه آزمایشی/)
  assert.match(html, /روش پرداخت را هنگام ثبت سفارش انتخاب کن/)
  assert.doesNotMatch(html, /رسید را همان‌جا|ارسال 5|ارسال 6/)
  assert.match(html, /روش‌های بیشتر را در تسویه‌حساب ببین/)
})
