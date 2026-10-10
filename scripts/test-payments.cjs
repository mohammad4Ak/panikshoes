const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  const context = { module: { exports: {} }, Date, Uint8Array, Response, Request, FormData, File, URL,
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] } }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, context)
  return context.module.exports
}
const contract = load('src/lib/payment-contract.ts')
const invoice = load('src/lib/invoice.ts')
const requestOrigin = load('src/lib/request-origin.ts')
const clone = (value) => structuredClone(value)
const submissionKey = '539fae5b-9916-4d2a-8afd-dff702bab432'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFsoAAAAASUVORK5CYII=', 'base64')
const receipt = { id: 'receipt', orderId: 'order', data: new Uint8Array(png), mimeType: 'image/png',
  payerCardLast4: null, transferReference: null, submissionKey, isLate: false, status: 'PENDING',
  reviewNote: null, reviewerId: null, reviewedAt: null, createdAt: new Date() }
const baseOrder = { id: 'order', userId: 'buyer', user: { name: 'خریدار', email: 'buyer@example.test' },
  status: 'PENDING', verified: false, paymentMethod: 'bank_transfer', paymentStatus: 'AWAITING_RECEIPT',
  paymentExpiresAt: new Date(Date.now() + 600000), updatedAt: new Date(), createdAt: new Date(),
  recipientName: 'گیرنده', address: 'نشانی نمونه', phone: '09100000000', total: 250000, shippingCost: 50000,
  shippingMethodName: 'پست', paymentCardNumber: '6037990000000006', paymentCardholderName: 'فروشگاه', paymentBankName: null,
  items: [{ id: 'item', productId: 'shoe', productName: 'نام ثبت‌شده', product: { name: 'نام فعلی', images: [] }, quantity: 2, price: 100000, size: 42, color: 'مشکی' }],
}

function harness(options = {}) {
  let state = { order: { ...clone(baseOrder), ...clone(options.order ?? {}) },
    receipts: clone(options.receipts ?? []), invoice: clone(options.invoice ?? null), stock: options.stock ?? 8, invoiceCount: 0,
    method: { id: 'bank_transfer', name: 'کارت به کارت', description: null, isActive: false,
      cardNumber: null, cardholderName: null, bankName: null, sortOrder: 0, updatedAt: new Date(), ...options.method } }
  let session = options.session === undefined ? { user: { id: 'buyer', role: 'USER' } } : options.session
  let queue = Promise.resolve()
  const pick = (record, select) => !record ? null : select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, clone(record[key])])) : clone(record)
  function matches(record, where) {
    if (!record) return false
    return Object.entries(where ?? {}).every(([key, value]) => {
      if (key === 'order') return !value.userId || state.order.userId === value.userId
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('in' in value) return value.in.includes(record[key])
        if ('lte' in value) return record[key] !== null && record[key] <= value.lte
        if ('gt' in value) return record[key] !== null && record[key] > value.gt
      }
      return value instanceof Date ? record[key]?.getTime() === value.getTime() : record[key] === value
    })
  }
  function client(current) {
    const fullOrder = () => current.order ? { ...clone(current.order), receipts: current.receipts.map((r) => pick(r, payments.receiptMetadataSelect)), invoice: clone(current.invoice) } : null
    return {
      order: {
        findUnique: async ({ where, select }) => current.order?.id === where.id ? pick(fullOrder(), select) : null,
        findFirst: async ({ where, select }) => matches(current.order, where) ? pick(fullOrder(), select) : null,
        findMany: async ({ where, select }) => matches(current.order, where) ? [pick(fullOrder(), select)] : [],
        updateMany: async ({ where, data }) => {
          if (options.loseClaim || !matches(current.order, where)) return { count: 0 }
          Object.assign(current.order, clone(data)); return { count: 1 }
        },
      },
      paymentReceipt: {
        findUnique: async ({ where, select }) => pick(current.receipts.find((r) => r.orderId === where.orderId_submissionKey.orderId && r.submissionKey === where.orderId_submissionKey.submissionKey), select),
        findFirst: async ({ where, select }) => pick(current.receipts.find((r) => matches(r, where)), select),
        count: async ({ where }) => current.receipts.filter((r) => r.orderId === where.orderId).length,
        create: async ({ data, select }) => {
          const row = { ...clone(receipt), ...clone(data), id: `receipt-${current.receipts.length + 1}`, createdAt: new Date() }
          current.receipts.push(row); return pick(row, select)
        },
        updateMany: async ({ where, data }) => {
          const row = current.receipts.find((r) => matches(r, where))
          if (!row) return { count: 0 }
          Object.assign(row, clone(data)); return { count: 1 }
        },
      },
      product: {
        update: async ({ data }) => {
          if (options.stockError) throw new Error('inventory update failure')
          current.stock += data.stock.increment; return {}
        },
        updateMany: async ({ where, data }) => {
          if (current.stock < where.stock.gte) return { count: 0 }
          current.stock -= data.stock.decrement; return { count: 1 }
        },
      },
      invoice: { create: async ({ data }) => {
        if (options.invoiceError) throw new Error('invoice failure')
        assert.equal(current.invoice, null)
        current.invoice = { id: 1, issuedAt: new Date(), ...clone(data) }; current.invoiceCount++; return clone(current.invoice)
      } },
      paymentMethod: {
        findUnique: async ({ where }) => current.method.id === where.id ? clone(current.method) : null,
        findUniqueOrThrow: async () => clone(current.method),
        findMany: async () => [clone(current.method)],
        updateMany: async ({ where, data }) => {
          if (options.loseClaim || !matches(current.method, where)) return { count: 0 }
          Object.assign(current.method, clone(data)); return { count: 1 }
        },
      },
    }
  }
  const prisma = new Proxy({}, { get: (_target, property) => property === '$transaction' ? async (callback) => {
    let unlock
    const previous = queue
    queue = new Promise((resolve) => { unlock = resolve })
    await previous
    try {
      const draft = clone(state)
      const result = await callback(client(draft))
      state = draft
      return result
    } finally { unlock() }
  } : client(state)[property] })
  const payments = load('src/lib/payments.ts', { '@/lib/prisma': { prisma }, '@/lib/payment-contract': contract, '@/lib/request-origin': requestOrigin })
  const dependencies = { 'next/server': { NextResponse: Response }, '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': { prisma }, '@/lib/payments': payments, '@/lib/payment-contract': contract, '@/lib/invoice': invoice,
    '@/lib/site-settings': { readSiteSettings: async () => ({ storeName: options.storeName ?? 'کفش لند' }) } }
  return { state: () => state, payments, asAdmin: () => { session = { user: { id: 'admin', role: 'ADMIN' } } },
    route: (file) => load(`src/app/api/${file}/route.ts`, dependencies) }
}
function uploadRequest(fields = {}, file = new File([png], 'receipt.png', { type: 'image/png' }), headers = {}) {
  const form = new FormData()
  form.set('file', file); form.set('submissionKey', submissionKey)
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return new Request('http://localhost/api/orders/order/receipts', { method: 'POST', body: form, headers })
}
const params = { params: Promise.resolve({ id: 'order' }) }
function reviewRequest(action = 'approve', note, receiptId = 'receipt') {
  return new Request('http://localhost/api/admin/payments/order/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, note, receiptId }) })
}
function cancelRequest(headers = {}) {
  return new Request('http://localhost/api/orders/order/cancel', { method: 'POST', headers })
}

test('Customer cancellation preserves the order, releases grouped inventory and is idempotent', async () => {
  const h = harness({ order: { items: [
    { ...baseOrder.items[0], quantity: 1 }, { ...baseOrder.items[0], id: 'second-size', quantity: 1, size: 43 },
  ] } })
  const route = h.route('orders/[id]/cancel')
  const responses = await Promise.all([route.POST(cancelRequest(), params), route.POST(cancelRequest(), params)])
  for (const response of responses) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    const body = await response.json()
    assert.equal(body.order.id, 'order')
    assert.equal(body.order.status, 'CANCELLED')
    assert.equal(body.order.paymentStatus, 'UNPAID')
    assert.equal(body.order.paymentExpiresAt, null)
    assert.equal(body.order.verified, false)
    assert.equal('items' in body.order, false)
    assert.ok(Number.isFinite(Date.parse(body.serverTime)))
  }
  assert.equal(h.state().stock, 10)
  assert.equal(h.state().order.id, 'order')
  assert.equal(await h.payments.expireUnpaidOrders(new Date(Date.now() + 600001)), 0)
  assert.equal(h.state().stock, 10)
})

test('Cancellation requires authentication, ownership and a same-origin request', async () => {
  for (const [options, headers, expected] of [
    [{ session: null }, {}, 401], [{ session: { user: { id: 'other', role: 'USER' } } }, {}, 404],
    [{ session: { user: { id: 'admin', role: 'ADMIN' } } }, {}, 404],
    [{}, { Origin: 'https://foreign.example' }, 403],
    [{}, { 'Sec-Fetch-Site': 'cross-site' }, 403], [{}, { 'Sec-Fetch-Site': 'same-site' }, 403],
  ]) {
    const h = harness(options)
    assert.equal((await h.route('orders/[id]/cancel').POST(cancelRequest(headers), params)).status, expected)
    assert.equal(h.state().order.status, 'PENDING')
    assert.equal(h.state().stock, 8)
  }
})

test('Rejected receipt history survives cancellation without becoming refundable payment', async () => {
  const rejected = { ...receipt, status: 'REJECTED', reviewNote: 'رسید نامعتبر است', reviewerId: 'admin', reviewedAt: new Date() }
  const h = harness({ order: { paymentStatus: 'REJECTED' }, receipts: [rejected] })
  assert.equal((await h.route('orders/[id]/cancel').POST(cancelRequest(), params)).status, 200)
  assert.equal(h.state().stock, 10)
  assert.deepEqual(h.state().receipts, [rejected])
  assert.equal(h.state().invoiceCount, 0)
})

test('Paid, submitted, invoiced, legacy and fulfilled orders cannot use unpaid cancellation', async () => {
  for (const options of [
    { order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] },
    { order: { status: 'CANCELLED', paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [{ ...receipt, isLate: true }] },
    { order: { paymentStatus: 'PAID' } }, { order: { verified: true } }, { invoice: { id: 1 } },
    { order: { status: 'PROCESSING' } }, { order: { status: 'SHIPPED' } }, { order: { status: 'DELIVERED' } },
    { order: { paymentMethod: null } }, { order: { paymentMethod: 'zarinpal' } },
    { order: { paymentStatus: 'UNPAID' } }, { order: { paymentExpiresAt: null } },
  ]) {
    const h = harness(options)
    const original = clone(h.state())
    const response = await h.route('orders/[id]/cancel').POST(cancelRequest(), params)
    assert.equal(response.status, 409)
    assert.deepEqual(h.state(), original)
  }
})

test('Cancellation of already expired or rejected late-payment orders never restores stock again', async () => {
  for (const paymentStatus of ['EXPIRED', 'UNPAID', 'REJECTED']) {
    const h = harness({ stock: 10, order: { status: 'CANCELLED', paymentStatus, paymentExpiresAt: null } })
    assert.equal((await h.route('orders/[id]/cancel').POST(cancelRequest(), params)).status, 200)
    assert.equal(h.state().stock, 10)
    assert.equal(h.state().order.paymentStatus, paymentStatus)
  }
})

test('An inventory failure rolls back customer cancellation and preserves the deadline', async () => {
  const h = harness({ stockError: true })
  const original = clone(h.state())
  assert.equal((await h.route('orders/[id]/cancel').POST(cancelRequest(), params)).status, 500)
  assert.deepEqual(h.state(), original)
})

test('A cancellation claim lost to another mutation never releases inventory', async () => {
  const h = harness({ loseClaim: true })
  assert.equal((await h.route('orders/[id]/cancel').POST(cancelRequest(), params)).status, 409)
  assert.equal(h.state().order.status, 'PENDING')
  assert.equal(h.state().stock, 8)
})

test('Cancellation racing expiration releases only the single reservation', async () => {
  const h = harness({ order: { paymentExpiresAt: new Date(Date.now() - 1) } })
  const [response] = await Promise.all([
    h.route('orders/[id]/cancel').POST(cancelRequest(), params), h.payments.expireUnpaidOrders(),
  ])
  assert.equal(response.status, 200)
  assert.equal(h.state().order.status, 'CANCELLED')
  assert.equal(h.state().stock, 10)
})

test('A cancellation racing receipt submission cannot release submitted inventory', async () => {
  for (const first of ['cancel', 'receipt']) {
    const h = harness()
    const cancel = () => h.route('orders/[id]/cancel').POST(cancelRequest(), params)
    const upload = () => h.route('orders/[id]/receipts').POST(uploadRequest(), params)
    const responses = await Promise.all(first === 'cancel' ? [cancel(), upload()] : [upload(), cancel()])
    const cancelled = h.state().order.status === 'CANCELLED'
    assert.equal(h.state().stock, cancelled ? 10 : 8)
    assert.equal(h.state().receipts.length, cancelled ? 0 : 1)
    assert.equal(h.state().order.paymentStatus, cancelled ? 'UNPAID' : 'AWAITING_REVIEW')
    assert.ok(responses.some((response) => response.status === 409))
  }
})

test('A customer who transferred before cancellation can explicitly submit a late receipt without re-reserving', async () => {
  const h = harness()
  assert.equal((await h.route('orders/[id]/cancel').POST(cancelRequest(), params)).status, 200)
  const response = await h.route('orders/[id]/receipts').POST(uploadRequest({ latePayment: 'true' }), params)
  assert.equal(response.status, 201)
  assert.equal((await response.json()).receipt.isLate, true)
  assert.equal(h.state().stock, 10)
  assert.equal(h.state().order.status, 'CANCELLED')
  assert.equal(h.state().order.paymentStatus, 'AWAITING_REVIEW')
})

test('Card details normalize Persian/Arabic digits and reject checksum failures', () => {
  assert.equal(contract.normalizePaymentDigits('۱۲٣٤۵۶٧٨۹۰'), '1234567890')
  assert.equal(contract.isValidCardNumber('6037990000000006'), true)
  assert.equal(contract.isValidCardNumber('6037990000000007'), false)
  assert.equal(contract.isValidCardNumber('0000000000000000'), false)
})

test('Order versions advance even when a previous transaction timestamp is ahead of the clock', () => {
  const h = harness()
  const previous = new Date(Date.now() + 60000)
  const next = h.payments.nextOrderVersion(previous)
  assert.equal(next.getTime(), previous.getTime() + 1)
  assert.equal(h.payments.nextOrderVersion(next).getTime(), next.getTime() + 1)
})

test('Expiration releases inventory exactly once, including concurrent sweep retries', async () => {
  const h = harness({ order: { paymentExpiresAt: new Date(Date.now() - 1) } })
  const counts = await Promise.all([h.payments.expireUnpaidOrders(), h.payments.expireUnpaidOrders()])
  assert.equal(counts.reduce((a, b) => a + b, 0), 1)
  assert.equal(h.state().stock, 10)
  assert.equal(h.state().order.status, 'CANCELLED')
  assert.equal(h.state().order.paymentStatus, 'EXPIRED')
})

test('Submitted and paid orders are never expired, even with a stale deadline', async () => {
  for (const order of [{ paymentStatus: 'AWAITING_REVIEW' }, { paymentStatus: 'PAID', verified: true }]) {
    const h = harness({ order: { ...order, paymentExpiresAt: new Date(0) } })
    assert.equal(await h.payments.expireUnpaidOrders(), 0)
    assert.equal(h.state().stock, 8)
  }
})

test('Expiry excludes legacy, other-method and missing-deadline orders', async () => {
  for (const order of [{ paymentStatus: 'UNPAID' }, { paymentMethod: null }, { paymentMethod: 'zarinpal' }, { paymentExpiresAt: null }]) {
    const h = harness({ order: { paymentExpiresAt: new Date(0), ...order } })
    assert.equal(await h.payments.expireUnpaidOrders(), 0)
    assert.equal(h.state().order.status, 'PENDING')
    assert.equal(h.state().stock, 8)
  }
})

test('Losing the expiration compare-and-swap does not release stock', async () => {
  const h = harness({ loseClaim: true, order: { paymentExpiresAt: new Date(0) } })
  assert.equal(await h.payments.expireUnpaidOrders(), 0)
  assert.equal(h.state().stock, 8)
})

test('Receipt upload requires ownership and same-origin mutation', async () => {
  for (const [options, headers, expected] of [
    [{ session: null }, {}, 401], [{ session: { user: { id: 'other', role: 'USER' } } }, {}, 404],
    [{}, { Origin: 'https://foreign.example' }, 403],
    [{}, { 'Sec-Fetch-Site': 'cross-site' }, 403], [{}, { 'Sec-Fetch-Site': 'same-site' }, 403],
  ]) {
    const h = harness(options)
    assert.equal((await h.route('orders/[id]/receipts').POST(uploadRequest({}, undefined, headers), params)).status, expected)
    assert.equal(h.state().receipts.length, 0)
  }
})

test('Uploading a receipt keeps reserved inventory, clears the deadline, and exposes no image bytes', async () => {
  const h = harness()
  const response = await h.route('orders/[id]/receipts').POST(uploadRequest({ payerCardLast4: '۱۲۳۴', transferReference: '۹۸۷۶' }), params)
  assert.equal(response.status, 201)
  const result = await response.json()
  assert.equal(result.paymentStatus, 'AWAITING_REVIEW')
  assert.equal(result.receipt.payerCardLast4, '1234')
  assert.equal(result.receipt.transferReference, '9876')
  assert.equal('data' in result.receipt, false)
  assert.equal(h.state().stock, 8)
  assert.equal(h.state().order.paymentExpiresAt, null)
  assert.equal(h.state().order.verified, false)
})

test('Retrying the same upload cannot create another receipt or alter its review state', async () => {
  const h = harness()
  const route = h.route('orders/[id]/receipts')
  const first = await route.POST(uploadRequest(), params)
  const second = await route.POST(uploadRequest(), params)
  assert.equal(first.status, 201); assert.equal(second.status, 201)
  assert.equal((await first.json()).receipt.id, (await second.json()).receipt.id)
  assert.equal(h.state().receipts.length, 1)
})

test('A second upload while pending review is rejected without replacing evidence', async () => {
  const h = harness({ order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] })
  const response = await h.route('orders/[id]/receipts').POST(uploadRequest({ submissionKey: 'e4df0d75-60dd-4fab-b7ac-e6400c65b929' }), params)
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'PAYMENT_AWAITING_REVIEW')
  assert.equal(h.state().receipts.length, 1)
})

test('Non-image uploads, invalid sender digits, oversized files and oversized streaming requests are rejected', async () => {
  const h = harness()
  const route = h.route('orders/[id]/receipts')
  assert.equal((await route.POST(uploadRequest({}, new File(['<svg/>'], 'fake.png', { type: 'image/png' })), params)).status, 400)
  assert.equal((await route.POST(uploadRequest({ payerCardLast4: '12345' }), params)).status, 400)
  assert.equal((await route.POST(uploadRequest({}, new File([new Uint8Array(contract.MAX_RECEIPT_BYTES + 1)], 'large.png')), params)).status, 413)
  const huge = new Request('http://localhost/upload', { method: 'POST', body: new Uint8Array(6 * 1024 * 1024 + 1), headers: { 'Content-Type': 'multipart/form-data; boundary=test' } })
  await assert.rejects(h.payments.boundedReceiptForm(huge), (error) => error.status === 413)
  assert.equal(h.state().receipts.length, 0)
})

test('Expired payment requires explicit late flow and keeps inventory unreserved while awaiting review', async () => {
  const h = harness({ order: { paymentExpiresAt: new Date(0) } })
  const route = h.route('orders/[id]/receipts')
  const denied = await route.POST(uploadRequest(), params)
  assert.equal(denied.status, 409)
  assert.equal((await denied.json()).code, 'PAYMENT_EXPIRED')
  assert.equal(h.state().stock, 10)
  const accepted = await route.POST(uploadRequest({ latePayment: 'true' }), params)
  assert.equal(accepted.status, 201)
  assert.equal((await accepted.json()).receipt.isLate, true)
  assert.equal(h.state().order.status, 'CANCELLED')
  assert.equal(h.state().stock, 10)
})

test('Upload compare-and-swap loss preserves order and never stores evidence', async () => {
  const h = harness({ loseClaim: true })
  assert.equal((await h.route('orders/[id]/receipts').POST(uploadRequest(), params)).status, 409)
  assert.equal(h.state().receipts.length, 0)
  assert.equal(h.state().order.paymentStatus, 'AWAITING_RECEIPT')
})

test('Approval is admin-only and idempotently records payment, invoice and audit identity', async () => {
  const h = harness({ order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] })
  const route = h.route('admin/payments/[id]/review')
  assert.equal((await route.POST(reviewRequest(), params)).status, 403)
  h.asAdmin()
  const responses = await Promise.all([route.POST(reviewRequest(), params), route.POST(reviewRequest(), params)])
  assert.ok(responses.every((r) => r.status === 200))
  assert.equal(h.state().order.verified, true)
  assert.equal(h.state().order.status, 'PROCESSING')
  assert.equal(h.state().order.paymentStatus, 'PAID')
  assert.equal(h.state().receipts[0].reviewerId, 'admin')
  assert.equal(h.state().receipts[0].status, 'APPROVED')
  assert.equal(h.state().invoiceCount, 1)
  assert.equal(h.state().invoice.snapshot.items[0].productName, 'نام ثبت‌شده')
  assert.equal(h.state().stock, 8)
})

test('Payment approval stores the current seller brand once and retries never rewrite an issued invoice', async () => {
  const options = { storeName: 'فروشگاه تازه', order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] }
  const h = harness(options)
  h.asAdmin()
  const route = h.route('admin/payments/[id]/review')
  assert.equal((await route.POST(reviewRequest(), params)).status, 200)
  assert.equal(h.state().invoice.snapshot.seller.name, 'فروشگاه تازه')
  options.storeName = 'نام بعدی'
  assert.equal((await route.POST(reviewRequest(), params)).status, 200)
  assert.equal(h.state().invoice.snapshot.seller.name, 'فروشگاه تازه')
  assert.equal(h.state().invoiceCount, 1)
})

test('Malformed review bodies and cross-origin requests never approve a payment', async () => {
  const h = harness({ order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] })
  h.asAdmin()
  const route = h.route('admin/payments/[id]/review')
  const inputs = [null, [], {}, 'approve', { receiptId: 'receipt', action: true },
    { receiptId: 'receipt', action: 'approve', note: {} }, { receiptId: 'receipt', action: 'approve', note: '\u0000' },
    { receiptId: 'receipt', action: 'approve', note: 'a'.repeat(1001) },
    { receiptId: 'receipt', action: 'reject', note: '   ' }]
  for (const body of inputs) {
    const response = await route.POST(new Request('http://localhost/review', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), params)
    assert.equal(response.status, 400)
  }
  const invalidJson = new Request('http://localhost/review', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })
  assert.equal((await route.POST(invalidJson, params)).status, 400)
  const foreign = new Request('http://localhost/review', { method: 'POST', body: JSON.stringify({ receiptId: 'receipt', action: 'approve' }), headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' } })
  assert.equal((await route.POST(foreign, params)).status, 403)
  assert.equal(h.state().order.verified, false)
  assert.equal(h.state().order.paymentStatus, 'AWAITING_REVIEW')
  assert.equal(h.state().receipts[0].status, 'PENDING')
  assert.equal(h.state().invoiceCount, 0)
  assert.equal(h.state().stock, 8)
})

test('Invoice failure rolls back approval, receipt audit and late inventory reservation together', async () => {
  const h = harness({ invoiceError: true, stock: 10,
    order: { status: 'CANCELLED', paymentStatus: 'AWAITING_REVIEW' }, receipts: [{ ...receipt, isLate: true }] })
  h.asAdmin()
  assert.equal((await h.route('admin/payments/[id]/review').POST(reviewRequest(), params)).status, 500)
  assert.equal(h.state().order.verified, false)
  assert.equal(h.state().order.status, 'CANCELLED')
  assert.equal(h.state().receipts[0].status, 'PENDING')
  assert.equal(h.state().stock, 10)
})

test('Late approval reacquires stock once and insufficient stock keeps payment awaiting resolution', async () => {
  for (const stock of [1, 10]) {
    const h = harness({ stock, order: { status: 'CANCELLED', paymentStatus: 'AWAITING_REVIEW' }, receipts: [{ ...receipt, isLate: true }] })
    h.asAdmin()
    const route = h.route('admin/payments/[id]/review')
    const response = await route.POST(reviewRequest(), params)
    assert.equal(response.status, stock === 1 ? 409 : 200)
    if (stock === 1) {
      assert.equal((await response.json()).code, 'INSUFFICIENT_STOCK')
      assert.equal(h.state().order.verified, false)
      assert.equal(h.state().receipts[0].status, 'PENDING')
    } else {
      assert.equal((await route.POST(reviewRequest(), params)).status, 200)
      assert.equal(h.state().invoiceCount, 1)
    }
    assert.equal(h.state().stock, stock === 1 ? 1 : 8)
  }
})

test('Rejection requires a reason, preserves audit history and does not extend deadline on retry', async () => {
  const h = harness({ order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] })
  h.asAdmin()
  const route = h.route('admin/payments/[id]/review')
  assert.equal((await route.POST(reviewRequest('reject'), params)).status, 400)
  assert.equal((await route.POST(reviewRequest('reject', 'مبلغ رسید مطابقت ندارد'), params)).status, 200)
  const deadline = h.state().order.paymentExpiresAt.getTime()
  assert.ok(deadline > Date.now() + 590000)
  assert.equal(h.state().receipts[0].reviewNote, 'مبلغ رسید مطابقت ندارد')
  assert.equal((await route.POST(reviewRequest('reject', 'متن متفاوت'), params)).status, 200)
  assert.equal(h.state().order.paymentExpiresAt.getTime(), deadline)
  assert.equal(h.state().receipts[0].reviewNote, 'مبلغ رسید مطابقت ندارد')
  assert.equal(h.state().stock, 8)
  assert.equal(h.state().invoiceCount, 0)
})

test('Rejected evidence stays immutable across resubmission and historical review retries', async () => {
  const h = harness({ order: { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [receipt] })
  h.asAdmin()
  const review = h.route('admin/payments/[id]/review')
  assert.equal((await review.POST(reviewRequest('reject', 'تصویر خوانا نیست'), params)).status, 200)
  const original = clone(h.state().receipts[0])
  const newKey = 'e4df0d75-60dd-4fab-b7ac-e6400c65b929'
  // Admin submits only their own purchases, so switch back to the owner.
  const owner = harness({ order: h.state().order, receipts: h.state().receipts })
  const submitted = await owner.route('orders/[id]/receipts').POST(uploadRequest({ submissionKey: newKey }), params)
  assert.equal(submitted.status, 201)
  const newReceipt = (await submitted.json()).receipt
  assert.equal((await owner.route('orders/[id]/receipts').POST(uploadRequest({ submissionKey: newKey }), params)).status, 201)
  assert.equal(owner.state().receipts.length, 2)
  assert.deepEqual(owner.state().receipts[0], original)
  owner.asAdmin()
  const currentVersion = owner.state().order.updatedAt.getTime()
  assert.equal((await owner.route('admin/payments/[id]/review').POST(reviewRequest('reject', 'تلاش مجدد'), params)).status, 200)
  assert.equal((await owner.route('admin/payments/[id]/review').POST(reviewRequest('approve'), params)).status, 409)
  assert.equal(owner.state().order.updatedAt.getTime(), currentVersion)
  assert.equal(owner.state().order.paymentStatus, 'AWAITING_REVIEW')
  assert.equal(owner.state().receipts.find((candidate) => candidate.id === newReceipt.id).status, 'PENDING')
  assert.equal(owner.state().invoiceCount, 0)
  assert.equal(owner.state().stock, 8)
})

test('Rejecting a late receipt leaves cancellation and released inventory intact', async () => {
  const h = harness({ stock: 10, order: { status: 'CANCELLED', paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, receipts: [{ ...receipt, isLate: true }] })
  h.asAdmin()
  assert.equal((await h.route('admin/payments/[id]/review').POST(reviewRequest('reject', 'رسید خوانا نیست'), params)).status, 200)
  assert.equal(h.state().order.status, 'CANCELLED')
  assert.equal(h.state().order.paymentExpiresAt, null)
  assert.equal(h.state().stock, 10)
})

test('Review compare-and-swap loss cannot mark receipt or issue invoice', async () => {
  const h = harness({ loseClaim: true, order: { paymentStatus: 'AWAITING_REVIEW' }, receipts: [receipt] })
  h.asAdmin()
  assert.equal((await h.route('admin/payments/[id]/review').POST(reviewRequest(), params)).status, 409)
  assert.equal(h.state().receipts[0].status, 'PENDING')
  assert.equal(h.state().invoiceCount, 0)
})

test('Receipt image access is private to owner/admin and never allows cross-order access', async () => {
  for (const [session, expected] of [[null, 401], [{ user: { id: 'other', role: 'USER' } }, 404], [{ user: { id: 'buyer', role: 'USER' } }, 200], [{ user: { id: 'admin', role: 'ADMIN' } }, 200]]) {
    const h = harness({ session, receipts: [receipt] })
    const response = await h.route('orders/[id]/receipts/[receiptId]').GET(new Request('http://localhost/receipt'), { params: Promise.resolve({ id: 'order', receiptId: 'receipt' }) })
    assert.equal(response.status, expected)
    if (expected === 200) {
      assert.match(response.headers.get('Cache-Control'), /private, no-store/)
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
      assert.equal(response.headers.get('Content-Type'), 'image/png')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
    }
  }
  const h = harness({ receipts: [receipt] })
  h.asAdmin()
  assert.equal((await h.route('orders/[id]/receipts/[receiptId]').GET(new Request('http://localhost/receipt'), { params: Promise.resolve({ id: 'another-order', receiptId: 'receipt' }) })).status, 404)
})

test('Payment settings require valid recipient details and cannot activate unimplemented Zarinpal', async () => {
  async function patch(h, body, id = 'bank_transfer') {
    h.asAdmin()
    return h.route('admin/payment-methods/[id]').PATCH(new Request('http://localhost/methods', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
  }
  const h = harness()
  assert.equal((await patch(h, { isActive: true })).status, 400)
  assert.equal((await patch(h, { cardNumber: '6037990000000007', cardholderName: 'صاحب حساب', isActive: true })).status, 400)
  assert.equal((await patch(h, { cardNumber: '۶۰۳۷۹۹۰۰۰۰۰۰۰۰۰۶', cardholderName: 'صاحب حساب', isActive: true })).status, 200)
  assert.equal(h.state().method.cardNumber, '6037990000000006')
  assert.equal(h.state().method.isActive, true)
  assert.equal((await patch(h, { cardholderName: '   ' })).status, 400)
  assert.equal((await patch(h, { cardNumber: null })).status, 400)
  assert.equal((await patch(h, { cardholderName: 'holder\u0000' })).status, 400)
  assert.equal(h.state().method.cardholderName, 'صاحب حساب')
  assert.equal(h.state().method.cardNumber, '6037990000000006')
  assert.equal((await patch(h, { isActive: false })).status, 200)
  assert.equal((await patch(h, { cardNumber: null, cardholderName: null })).status, 200)
  const zarinpal = harness({ method: { id: 'zarinpal' } })
  assert.equal((await patch(zarinpal, { isActive: true }, 'zarinpal')).status, 400)
})

test('Invalid saved recipient details do not make a payment method available', () => {
  const h = harness()
  for (const method of [
    { id: 'bank_transfer', cardNumber: '0000000000000000', cardholderName: 'holder' },
    { id: 'bank_transfer', cardNumber: '6037990000000007', cardholderName: 'holder' },
    { id: 'bank_transfer', cardNumber: '6037990000000006', cardholderName: '   ' },
    { id: 'zarinpal', cardNumber: '6037990000000006', cardholderName: 'holder' },
  ]) assert.equal(h.payments.methodAvailability(method).available, false)
  assert.equal(h.payments.methodAvailability({ id: 'bank_transfer', cardNumber: '6037990000000006', cardholderName: 'holder' }).available, true)
})

test('Admin payment filters reject inherited object properties and unknown statuses', async () => {
  const h = harness()
  h.asAdmin()
  const route = h.route('admin/payments')
  for (const status of ['toString', 'constructor', '__proto__', 'UNKNOWN']) {
    assert.equal((await route.GET(new Request(`http://localhost/admin/payments?status=${status}`))).status, 400)
  }
  assert.equal((await route.GET(new Request('http://localhost/admin/payments?status=AWAITING_RECEIPT'))).status, 200)
})

test('Payment and admin list JSON omit receipt bytes and private public-method details', async () => {
  const h = harness({ receipts: [receipt], method: { isActive: true, cardNumber: '6037990000000006', cardholderName: 'صاحب کارت' } })
  const payment = await h.route('orders/[id]/payment').GET(new Request('http://localhost/payment'), params)
  const detail = await payment.json()
  assert.equal('data' in detail.receipts[0], false)
  assert.ok(detail.serverTime)
  const methods = await (await h.route('payment-methods').GET()).json()
  assert.equal('cardNumber' in methods[0], false)
  h.asAdmin()
  const orders = await (await h.route('admin/payments').GET(new Request('http://localhost/admin/payments'))).json()
  assert.equal('data' in orders[0].receipts[0], false)
})
