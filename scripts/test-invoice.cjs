const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const context = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/invoice.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022',
}).code, context)
const { buildInvoiceSnapshot, formatInvoiceNumber, isInvoiceEligibleStatus } = context.module.exports
const plain = (value) => JSON.parse(JSON.stringify(value))
const order = {
  id: 'order-private-123', createdAt: new Date('2026-09-29T10:30:00Z'),
  user: { name: 'خریدار', email: 'buyer@example.test' }, recipientName: 'گیرنده',
  address: 'تهران، خیابان نمونه', phone: '09123456789',
  shippingMethodName: 'پست پیشتاز', shippingCost: 50000, total: 350000,
  items: [
    { productId: 'shoe-1', productName: 'نام هنگام خرید', product: { name: 'نام جدید در ویترین', price: 1 }, price: 100000, quantity: 2, size: 42, color: 'سبز' },
    { productId: 'shoe-2', productName: null, product: { name: 'نام محصول قدیمی', price: 999999 }, price: 100000, quantity: 1, size: 43, color: 'مشکی' },
  ],
}

test('Invoice freezes checkout names, historical prices, variants, totals, recipient and buyer separately', () => {
  const snapshot = plain(buildInvoiceSnapshot(order))
  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.currency, 'تومان')
  assert.equal(snapshot.seller.name, 'کفش لند')
  assert.deepEqual(snapshot.buyer, order.user)
  assert.deepEqual(snapshot.recipient, { name: 'گیرنده', address: order.address, phone: order.phone })
  assert.equal(snapshot.orderCreatedAt, '2026-09-29T10:30:00.000Z')
  assert.equal(snapshot.items[0].productName, 'نام هنگام خرید')
  assert.equal(snapshot.items[1].productName, 'نام محصول قدیمی')
  assert.deepEqual(snapshot.items[0], {
    productId: 'shoe-1', productName: 'نام هنگام خرید', quantity: 2, size: 42, color: 'سبز', unitPrice: 100000, lineTotal: 200000,
  })
  assert.equal(snapshot.subtotal, 300000)
  assert.equal(snapshot.shippingMethodName, 'پست پیشتاز')
  assert.equal(snapshot.shippingCost, 50000)
  assert.equal(snapshot.total, 350000)
  assert.equal('verified' in snapshot, false)
  assert.equal('tax' in snapshot, false)
})

test('The snapshot shares no mutable object references with catalog, buyer or order data', () => {
  const original = structuredClone(order)
  const snapshot = buildInvoiceSnapshot(original)
  const frozen = plain(snapshot)
  original.user.name = 'نام تازه'
  original.recipientName = 'گیرنده تازه'
  original.items[0].productName = 'مدل تازه'
  original.items[0].price = 1
  original.items[0].quantity = 100
  original.shippingCost = 0
  original.total = 1
  assert.deepEqual(plain(snapshot), frozen)
})

test('New invoices freeze the configured seller name while previously issued snapshots retain their branding', () => {
  const oldInvoice = plain(buildInvoiceSnapshot(order))
  const newInvoice = plain(buildInvoiceSnapshot(order, 'برند تازه'))
  assert.equal(oldInvoice.seller.name, 'کفش لند')
  assert.equal(newInvoice.seller.name, 'برند تازه')
  buildInvoiceSnapshot(order, 'نام بعدی')
  assert.equal(newInvoice.seller.name, 'برند تازه')
  assert.deepEqual(newInvoice.items, oldInvoice.items)
})

test('Legacy recipient fallback, free shipping and absent carrier remain explicit', () => {
  const snapshot = buildInvoiceSnapshot({ ...order, recipientName: null, shippingMethodName: null, shippingCost: 0, total: 300000 })
  assert.equal(snapshot.recipient.name, order.user.name)
  assert.equal(snapshot.shippingMethodName, null)
  assert.equal(snapshot.shippingCost, 0)
  assert.equal(snapshot.total, 300000)
})

test('Stable invoice numbers use UTC issue year and sequence without truncation or order-placement dates', () => {
  assert.equal(formatInvoiceNumber({ id: 42, issuedAt: '2026-01-01T00:15:00+03:30' }), 'INV-2025-000042')
  assert.equal(formatInvoiceNumber({ id: 42, issuedAt: new Date('2026-10-01T00:00:00Z') }), 'INV-2026-000042')
  assert.equal(formatInvoiceNumber({ id: 1000001, issuedAt: '2026-10-01T00:00:00Z' }), 'INV-2026-1000001')
})

test('Approval eligibility is independent from payment and excludes pending/cancelled states', () => {
  for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) assert.equal(isInvoiceEligibleStatus(status), true)
  for (const status of ['PENDING', 'CANCELLED', 'paid', 'processing', '']) assert.equal(isInvoiceEligibleStatus(status), false)
})
