const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const code = transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const context = { module: { exports: {} }, Date, Intl, Uint8Array, process,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(code, context)
  return context.module.exports
}

const { getOrderTotals, orderItemNetAmount } = load('src/lib/order-totals.ts')
const invoice = load('src/lib/invoice.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const purchase = {
  id: 'discount-order', createdAt: '2026-10-15T12:00:00Z', user: { name: 'خریدار', email: 'buyer@example.test' },
  recipientName: null, phone: '09120000000', address: 'نشانی نمونه', shippingMethodName: 'پست', shippingCost: 50,
  subtotal: 1000, productDiscount: 100, couponDiscount: 101, couponCode: 'PANIK101', total: 849,
  items: [
    { productId: 'one', productName: 'مدل یک', product: { name: 'نام فعلی' }, originalPrice: 300, price: 270, quantity: 2, couponDiscount: 61, size: 38, color: 'مشکی' },
    { productId: 'two', productName: 'مدل دو', product: { name: 'نام فعلی' }, originalPrice: 400, price: 360, quantity: 1, couponDiscount: 40, size: 39, color: 'کرم' },
  ],
}

test('Historical display totals trust stored payable amount and never use changed catalog or guessed discounts', () => {
  assert.deepEqual(plain(getOrderTotals({ total: 101, shippingCost: 1, subtotal: null, items: [{ price: 999999, quantity: 2 }] })), {
    subtotal: 100, productDiscount: 0, couponDiscount: 0, discount: 0, couponCode: null, merchandise: 100, shipping: 1, total: 101,
  })
})

test('All display totals and allocated line amounts reconcile without per-unit coupon rounding', () => {
  const totals = getOrderTotals(purchase)
  assert.equal(totals.subtotal - totals.productDiscount - totals.couponDiscount + totals.shipping, totals.total)
  assert.deepEqual(purchase.items.map(orderItemNetAmount), [479, 320])
  assert.equal(purchase.items.reduce((sum, item) => sum + orderItemNetAmount(item), 0), totals.merchandise)
  assert.equal(orderItemNetAmount({ price: 100, quantity: 2 }), 200)
})

function pdfHarness() {
  const text = []
  let pages = 1
  class Pdf {
    constructor() {
      return new Proxy(this, { get(target, name) {
        if (name in target) return target[name]
        return () => {}
      } })
    }
    text(value, x, y) { text.push({ value, x, y }) }
    getTextWidth(value) { return Array.from(value).length * 1.8 }
    addPage() { pages++ }
    getNumberOfPages() { return pages }
    output() { return new Uint8Array([37, 80, 68, 70]).buffer }
  }
  const { renderInvoicePdf } = load('src/lib/invoice-pdf.ts', {
    'node:fs/promises': { readFile: async () => Buffer.from('test-font') }, 'node:path': path,
    jspdf: { jsPDF: Pdf }, './invoice': invoice,
  })
  return { renderInvoicePdf, text, pages: () => pages }
}

test('PDF shows gross and effective prices, allocated coupon amounts and reconciled discount summary', async () => {
  const harness = pdfHarness()
  const snapshot = invoice.buildInvoiceSnapshot(purchase, 'کفش پانیک')
  await harness.renderInvoicePdf({ id: 1, issuedAt: '2026-10-15T12:01:00Z', snapshot }, 'PROCESSING')
  const printed = harness.text.map(entry => entry.value).join('\n')
  for (const label of ['اصلی:', 'با تخفیف:', 'تخفیف کد:', 'تخفیف محصول', 'PANIK101']) assert.ok(printed.includes(label), label)
  for (const amount of [300, 270, 479, 320, 1000, 100, 101, 849]) assert.ok(printed.includes(new Intl.NumberFormat('fa-IR').format(amount)), `Missing ${amount}`)
  assert.ok(harness.text.every(entry => entry.y <= 293 && entry.y >= 0))
})

test('Previously issued schemaVersion1 PDFs render without requiring any new fields', async () => {
  const harness = pdfHarness()
  const { subtotal, productDiscount, couponDiscount, couponCode, ...legacy } = purchase
  const snapshot = invoice.buildInvoiceSnapshot({ ...legacy, total: 950, items: purchase.items.map(({ originalPrice, couponDiscount, ...item }) => item) })
  assert.equal('productDiscount' in snapshot, false)
  await harness.renderInvoicePdf({ id: 2, issuedAt: '2026-10-15T12:01:00Z', snapshot }, 'PROCESSING')
  const printed = harness.text.map(entry => entry.value).join('\n')
  assert.ok(printed.includes(new Intl.NumberFormat('fa-IR').format(950)))
  assert.ok(!printed.includes('تخفیف محصول'))
  assert.ok(!printed.includes('PANIK101'))
})

test('Discount summary and expanded price cells remain within page bounds in multipage invoices', async () => {
  const harness = pdfHarness()
  const snapshot = invoice.buildInvoiceSnapshot({ ...purchase, items: Array.from({ length: 40 }, (_, index) => ({ ...purchase.items[index % 2], productName: `مدل شماره ${index + 1} کفش زنانه پانیک` })) })
  await harness.renderInvoicePdf({ id: 3, issuedAt: '2026-10-15T12:01:00Z', snapshot }, 'CANCELLED')
  assert.ok(harness.pages() > 1)
  assert.ok(harness.text.every(entry => entry.y <= 293 && entry.y >= 0))
  assert.equal(harness.text.filter(entry => entry.value === 'تخفیف محصول').length, 1)
})

test('The real renderer produces a PDF for a discounted invoice and a legacy snapshot', async () => {
  const { renderInvoicePdf } = load('src/lib/invoice-pdf.ts', {
    'node:fs/promises': require('node:fs/promises'), 'node:path': path, jspdf: require('jspdf'), './invoice': invoice,
  })
  const discounted = invoice.buildInvoiceSnapshot(purchase)
  const legacy = { ...discounted, items: discounted.items.map(({ originalUnitPrice, productDiscount, couponDiscount, ...item }) => item) }
  delete legacy.productDiscount; delete legacy.couponDiscount; delete legacy.couponCode; delete legacy.merchandiseTotal
  for (const snapshot of [discounted, legacy]) {
    const bytes = await renderInvoicePdf({ id: 4, issuedAt: '2026-10-15T12:01:00Z', snapshot }, 'PROCESSING')
    assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF')
    assert.ok(bytes.byteLength > 1000)
  }
})
