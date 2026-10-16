const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Exercise the real page with isolated auth and database dependencies; no live data changes.
const source = readFileSync(path.join(__dirname, '../src/app/(shop)/payment/result/page.tsx'), 'utf8')
const { code } = transformSync(source, {
  loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic',
})

function loadPage({ session = { user: { id: 'customer-1' } }, row = null, env = 'production', fail = false } = {}) {
  const queries = []
  let authCalls = 0
  const dependencies = {
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'next/navigation': { redirect: (url) => { throw new Error(`REDIRECT:${url}`) } },
    '@/components/shop/PaymentResult': { default: 'PaymentResult', __esModule: true },
    '@/lib/auth': { auth: async () => { authCalls++; return session } },
    '@/lib/prisma': { prisma: { order: { findFirst: async (query) => {
      queries.push(query)
      if (fail) throw new Error('Database unavailable')
      return row
    } } } },
  }
  const context = {
    module: { exports: {} }, process: { env: { NODE_ENV: env } },
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(code, context)
  return {
    render: async (params = {}) => (await context.module.exports.default({ searchParams: Promise.resolve(params) })).props,
    queries, authCalls: () => authCalls,
  }
}

const order = { id: 'order-1', total: 5200000, verified: false, status: 'PENDING', createdAt: new Date('2026-09-29T10:30:00Z') }

test('Legacy result links resume the owned bank-transfer payment page', async () => {
  const page = loadPage({ row: { ...order, paymentMethod: 'bank_transfer' } })
  await assert.rejects(page.render({ orderId: order.id }), /REDIRECT:\/payment\/transfer\/order-1/)
})

test('Missing, duplicate and oversized order IDs do not read private data', async () => {
  const page = loadPage()
  for (const orderId of [undefined, '', ['a', 'b'], 'x'.repeat(129)]) {
    assert.equal((await page.render({ orderId, status: 'success' })).status, 'unknown')
  }
  assert.equal(page.authCalls(), 0)
  assert.equal(page.queries.length, 0)
})

test('Unauthenticated visitors do not query order details', async () => {
  const page = loadPage({ session: null })
  const result = await page.render({ orderId: 'order-1' })
  assert.equal(result.requiresLogin, true)
  assert.equal(result.status, 'unknown')
  assert.equal(page.queries.length, 0)
})

test('Order lookup is always scoped to the signed-in owner', async () => {
  const page = loadPage({ session: { user: { id: 'admin-1', role: 'ADMIN' } } })
  const result = await page.render({ orderId: 'someone-elses-order' })
  assert.deepEqual(JSON.parse(JSON.stringify(page.queries[0].where)), { id: 'someone-elses-order', userId: 'admin-1' })
  assert.equal(result.status, 'unknown')
  assert.equal(result.order, undefined)
})

test('URL success, amount and reference cannot turn an unverified order into a paid receipt', async () => {
  const page = loadPage({ row: order })
  const result = await page.render({ orderId: order.id, status: 'success', amount: '1', refId: 'fake' })
  assert.equal(result.status, 'pending')
  assert.equal(result.order.amount, order.total)
  assert.equal(result.order.id, order.id)
  assert.equal(result.order.refId, undefined)
})

test('Only a verified database order shows payment success', async () => {
  const page = loadPage({ row: { ...order, verified: true, status: 'CANCELLED' } })
  const result = await page.render({ orderId: order.id, status: 'failed' })
  assert.equal(result.status, 'success')
  assert.equal(result.order.status, 'CANCELLED')
})

test('The payment receipt uses the historical shipping name and fee stored on the order', async () => {
  const page = loadPage({ row: { ...order, shippingMethodName: 'پست پیشتاز', shippingCost: 80000 } })
  const result = await page.render({ orderId: order.id })
  assert.equal(result.order.shippingMethodName, 'پست پیشتاز')
  assert.equal(result.order.shippingCost, 80000)
  assert.equal(result.order.amount, order.total)
  assert.equal(page.queries[0].select.shippingMethodName, true)
  assert.equal(page.queries[0].select.shippingCost, true)
})

test('Unverified cancelled orders show the incomplete payment state', async () => {
  const page = loadPage({ row: { ...order, status: 'CANCELLED' } })
  assert.equal((await page.render({ orderId: order.id })).status, 'failed')
})

test('Development previews are explicit and never query real orders', async () => {
  const page = loadPage({ env: 'development' })
  for (const preview of ['success', 'failed', 'pending']) {
    const result = await page.render({ preview })
    assert.equal(result.isPreview, true)
    assert.equal(result.status, preview)
    assert.match(result.order.id, /^DEMO-/)
  }
  assert.equal(page.authCalls(), 0)
  assert.equal(page.queries.length, 0)
})

test('Production ignores all preview flags', async () => {
  const page = loadPage()
  const result = await page.render({ preview: 'success' })
  assert.equal(result.status, 'unknown')
  assert.equal(result.isPreview, undefined)
  assert.equal(result.order, undefined)
})

test('Database failures are shown as unavailable, never a payment failure or success', async () => {
  const page = loadPage({ fail: true })
  const result = await page.render({ orderId: order.id })
  assert.equal(result.status, 'unknown')
  assert.equal(result.unavailable, true)
  assert.equal(result.order, undefined)
})

function receiptText(props) {
  const source = readFileSync(path.join(__dirname, '../src/components/shop/PaymentResult.tsx'), 'utf8')
  const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/BrandIcons': { PaymentStatusIcon: 'PaymentStatusIcon' },
    '@/lib/utils': { formatPrice: (value) => String(value) },
    './payment-result.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }
  const context = { module: { exports: {} }, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } }
  vm.runInNewContext(code, context)
  const text = (node) => {
    if (Array.isArray(node)) return node.map(text).join(' ')
    if (node && typeof node === 'object') return text(node.props?.children)
    return node == null || typeof node === 'boolean' ? '' : String(node)
  }
  return text(context.module.exports.default(props))
}

test('A paid cancelled receipt explicitly distinguishes payment confirmation from cancellation and refunds', () => {
  const text = receiptText({ status: 'success', order: {
    id: 'cancelled-paid-order', amount: 5200000, createdAt: '2026-09-29T10:30:00Z', status: 'CANCELLED',
  } })
  assert.match(text, /پرداختت موفق بود/)
  assert.match(text, /سفارش لغو شده است/)
  assert.match(text, /تأیید پرداخت به معنی تأیید بازگشت وجه نیست/)
  assert.match(text, /وضعیت سفارش لغو شده/)
  assert.match(text, /مبلغ پرداخت‌شده 5200000/)
})

test('Login-required and unavailable receipts suppress private order details and cancelled payment text', () => {
  for (const flag of ['requiresLogin', 'unavailable']) {
    const text = receiptText({ status: 'success', [flag]: true, order: {
      id: 'private-order-id', amount: 5200000, createdAt: '2026-09-29T10:30:00Z', status: 'CANCELLED',
    } })
    assert.match(text, /وضعیت پرداخت نامشخص/)
    assert.doesNotMatch(text, /private-order-id|5200000|سفارش لغو شده است/)
  }
})

test('Payment result reads stored discount snapshots and keeps the verified amount unchanged', async () => {
  const page = loadPage({ row: { ...order, verified: true, total: 849, subtotal: 1000, productDiscount: 100,
    couponDiscount: 101, couponCode: 'PANIK101', shippingCost: 50, shippingMethodName: 'پست' } })
  const result = await page.render({ orderId: order.id, couponCode: 'FORGED', amount: '1' })
  assert.equal(result.status, 'success')
  assert.equal(result.order.amount, 849)
  assert.equal(result.order.subtotal, 1000)
  assert.equal(result.order.productDiscount, 100)
  assert.equal(result.order.couponDiscount, 101)
  assert.equal(result.order.couponCode, 'PANIK101')
  const text = receiptText(result)
  assert.match(text, /جمع اولیهٔ کالاها 1000/)
  assert.match(text, /تخفیف محصولات −\s*100/)
  assert.match(text, /PANIK101/)
  assert.match(text, /−\s*101/)
  assert.match(text, /مبلغ پرداخت‌شده 849/)
  assert.doesNotMatch(text, /FORGED/)
})
