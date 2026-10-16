const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Exercise production logic with isolated dependencies. This suite never connects to PostgreSQL.
function loadModule(relativePath, dependencies = {}) {
  const source = readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  }
  vm.runInNewContext(code, context)
  return context.module.exports
}

const shipping = loadModule('src/lib/shipping.ts')
const pricing = loadModule('src/lib/pricing.ts')
const coupons = loadModule('src/lib/coupons.ts')
const method = {
  id: 'shipping-1', name: 'پست پیشتاز', description: null,
  baseCost: 90000, additionalItemCost: 15000,
  freeShippingThreshold: null, isActive: true, sortOrder: 0,
}

test('One pair pays only the base rate; further pairs each add their configured rate', () => {
  assert.equal(shipping.calculateShippingCost(method, 1000000, 1), 90000)
  assert.equal(shipping.calculateShippingCost(method, 3000000, 3), 120000)
  assert.equal(shipping.calculateShippingCost(method, 6000000, 6), 165000)
})

test('Free shipping begins exactly at the method threshold', () => {
  const freeMethod = { ...method, freeShippingThreshold: 2000000 }
  assert.equal(shipping.calculateShippingCost(freeMethod, 1999999, 2), 105000)
  assert.equal(shipping.calculateShippingCost(freeMethod, 2000000, 2), 0)
  assert.equal(shipping.calculateShippingCost(freeMethod, 3000000, 7), 0)
})

test('Zero rates remain free without requiring an order threshold', () => {
  const freeMethod = { ...method, baseCost: 0, additionalItemCost: 0 }
  assert.equal(shipping.calculateShippingCost(freeMethod, 100000, 1), 0)
  assert.equal(shipping.calculateShippingCost(freeMethod, 500000, 5), 0)
})

test('A zero free-shipping threshold explicitly makes every order free', () => {
  assert.equal(shipping.calculateShippingCost({ ...method, freeShippingThreshold: 0 }, 1000000, 3), 0)
})

test('Invalid or overflowing monetary values and quantities fail instead of producing an unsafe fee', () => {
  const MAX = shipping.MAX_SHIPPING_AMOUNT
  for (const subtotal of [-1, 1.5, Infinity, NaN, MAX + 1]) {
    assert.throws(() => shipping.calculateShippingCost(method, subtotal, 1), shipping.ShippingValidationError)
  }
  for (const count of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => shipping.calculateShippingCost(method, 1000000, count), shipping.ShippingValidationError)
  }
  assert.throws(() => shipping.calculateShippingCost({ ...method, baseCost: MAX, additionalItemCost: 1 }, 1000, 2), shipping.ShippingValidationError)
  assert.equal(shipping.calculateShippingCost({ ...method, baseCost: MAX }, 1000, 1), MAX)
  for (const key of ['baseCost', 'additionalItemCost', 'freeShippingThreshold']) {
    for (const value of [-1, 1.5, Infinity, NaN, MAX + 1]) {
      assert.throws(() => shipping.calculateShippingCost({ ...method, [key]: value }, 1000, 1), shipping.ShippingValidationError)
    }
  }
})

const validInput = {
  name: '  پست پیشتاز  ', description: '  تحویل درب منزل  ',
  baseCost: 90000, additionalItemCost: 15000,
  freeShippingThreshold: 2000000, isActive: true, sortOrder: 2,
}
const plain = (value) => JSON.parse(JSON.stringify(value))

test('Method input trims text and retains all configured billing fields', () => {
  assert.deepEqual(plain(shipping.parseShippingMethodInput(validInput)), {
    ...validInput, name: 'پست پیشتاز', description: 'تحویل درب منزل',
  })
})

test('Optional fields normalize blanks; zero thresholds and disabled methods survive parsing', () => {
  const input = { name: 'تیپاکس', baseCost: 0, additionalItemCost: 0, isActive: false }
  assert.deepEqual(plain(shipping.parseShippingMethodInput(input)), {
    ...input, description: null, freeShippingThreshold: null, sortOrder: 0,
  })
  assert.equal(shipping.parseShippingMethodInput({ ...input, description: '  ', freeShippingThreshold: 0 }).freeShippingThreshold, 0)
  assert.equal(shipping.parseShippingMethodInput({ ...input, description: '  ' }).description, null)
})

test('Method validation rejects missing fields, wrong types and out-of-range rates', () => {
  const MAX = shipping.MAX_SHIPPING_AMOUNT
  const invalid = [
    null, [], 'shipping', {},
    { ...validInput, name: '' }, { ...validInput, name: '  ' }, { ...validInput, name: 'x'.repeat(81) },
    { ...validInput, description: 'x'.repeat(501) },
    { ...validInput, isActive: 'true' }, { ...validInput, isActive: 1 },
    { ...validInput, sortOrder: -1 }, { ...validInput, sortOrder: 1.5 }, { ...validInput, sortOrder: 1000001 },
  ]
  for (const key of ['baseCost', 'additionalItemCost', 'freeShippingThreshold']) {
    for (const value of [-1, 1.5, '90000', NaN, Infinity, MAX + 1]) invalid.push({ ...validInput, [key]: value })
  }
  for (const input of invalid) assert.throws(() => shipping.parseShippingMethodInput(input), shipping.ShippingValidationError)
})

function loadRoute(relativePath, { session = { user: { id: 'admin-1', role: 'ADMIN' } }, prisma = {} } = {}) {
  return loadModule(relativePath, {
    'node:crypto': require('node:crypto'),
    'next/server': { NextResponse: Response }, '@/lib/request-origin': { isSameOriginRequest: () => true },
    '@/lib/auth': { auth: async () => session },
    '@/lib/prisma': { prisma },
    '@/lib/shipping': shipping,
    '@/lib/pricing': pricing, '@/lib/coupons': coupons,
    '@/lib/payments': { expireUnpaidOrders: async () => 0, methodAvailability: (method) => ({ available: Boolean(method.cardNumber && method.cardholderName) }) }, '@/lib/payment-contract': { PAYMENT_WINDOW_MS: 600000 },
  })
}

function request(body, method = 'POST') {
  return new Request('http://localhost/api/shipping-test', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

test('Public methods expose active options only and do not cache mutable rates', async () => {
  const queries = []
  const route = loadRoute('src/app/api/shipping-methods/route.ts', {
    session: null, prisma: { shippingMethod: { findMany: async (query) => { queries.push(query); return [method] } } },
  })
  const response = await route.GET()
  assert.equal(response.status, 200)
  assert.equal(queries[0].where.isActive, true)
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await response.json(), [method])
})

test('Every admin shipping handler rejects anonymous, incomplete and customer identities before touching data', async () => {
  const contexts = [{ session: null, status: 401 }, { session: { user: { role: 'ADMIN' } }, status: 401 },
    { session: { user: { id: 'customer-1', role: 'USER' } }, status: 403 }]
  for (const { session, status } of contexts) {
    const listRoute = loadRoute('src/app/api/admin/shipping-methods/route.ts', { session })
    const itemRoute = loadRoute('src/app/api/admin/shipping-methods/[id]/route.ts', { session })
    const params = { params: Promise.resolve({ id: method.id }) }
    for (const invoke of [
      () => listRoute.GET(), () => listRoute.POST(request(validInput)),
      () => itemRoute.PUT(request(validInput, 'PUT'), params),
      () => itemRoute.DELETE(new Request('http://localhost/api/shipping-test', { method: 'DELETE' }), params),
    ]) assert.equal((await invoke()).status, status)
  }
})

test('An admin can list, create, update and delete methods with normalized billing settings', async () => {
  const calls = []
  const prisma = { shippingMethod: {
    findMany: async (args) => { calls.push(['findMany', args]); return [method] },
    create: async (args) => { calls.push(['create', args]); return { id: method.id, ...args.data } },
    update: async (args) => { calls.push(['update', args]); return { id: method.id, ...args.data } },
    delete: async (args) => { calls.push(['delete', args]); return method },
  } }
  const listRoute = loadRoute('src/app/api/admin/shipping-methods/route.ts', { prisma })
  const itemRoute = loadRoute('src/app/api/admin/shipping-methods/[id]/route.ts', { prisma })
  const params = { params: Promise.resolve({ id: method.id }) }
  assert.equal((await listRoute.GET()).status, 200)
  assert.equal((await listRoute.POST(request(validInput))).status, 201)
  const created = calls.find(([name]) => name === 'create')[1].data
  assert.equal(created.name, 'پست پیشتاز')
  assert.equal(created.additionalItemCost, validInput.additionalItemCost)
  assert.equal(created.freeShippingThreshold, validInput.freeShippingThreshold)
  assert.equal((await itemRoute.PUT(request({ ...validInput, isActive: false }, 'PUT'), params)).status, 200)
  const updated = calls.find(([name]) => name === 'update')[1]
  assert.equal(updated.where.id, method.id)
  assert.equal(updated.data.isActive, false)
  assert.ok([200, 204].includes((await itemRoute.DELETE(new Request('http://localhost/api/shipping-test', { method: 'DELETE' }), params)).status))
  assert.equal(calls.find(([name]) => name === 'delete')[1].where.id, method.id)
})

test('Malformed JSON and invalid rates never reach admin writes', async () => {
  const prisma = { shippingMethod: { create: () => assert.fail('Invalid method was created'), update: () => assert.fail('Invalid method was updated') } }
  const listRoute = loadRoute('src/app/api/admin/shipping-methods/route.ts', { prisma })
  const itemRoute = loadRoute('src/app/api/admin/shipping-methods/[id]/route.ts', { prisma })
  const broken = () => new Request('http://localhost/api/shipping-test', { method: 'POST', body: '{broken' })
  assert.equal((await listRoute.POST(broken())).status, 400)
  assert.equal((await listRoute.POST(request({ ...validInput, baseCost: -1 }))).status, 400)
  assert.equal((await itemRoute.PUT(broken(), { params: Promise.resolve({ id: method.id }) })).status, 400)
  assert.equal((await itemRoute.PUT(request({ ...validInput, isActive: 'yes' }, 'PUT'), { params: Promise.resolve({ id: method.id }) })).status, 400)
})

test('Duplicate method names return a conflict; editing or deleting a removed method returns not found', async () => {
  const prisma = { shippingMethod: {
    create: async () => { throw { code: 'P2002' } },
    update: async () => { throw { code: 'P2025' } },
    delete: async () => { throw { code: 'P2025' } },
  } }
  const listRoute = loadRoute('src/app/api/admin/shipping-methods/route.ts', { prisma })
  const itemRoute = loadRoute('src/app/api/admin/shipping-methods/[id]/route.ts', { prisma })
  const params = { params: Promise.resolve({ id: method.id }) }
  assert.equal((await listRoute.POST(request(validInput))).status, 409)
  assert.equal((await itemRoute.PUT(request(validInput, 'PUT'), params)).status, 404)
  assert.equal((await itemRoute.DELETE(new Request('http://localhost/api/shipping-test', { method: 'DELETE' }), params)).status, 404)
  prisma.shippingMethod.update = async () => { throw { code: 'P2002' } }
  assert.equal((await itemRoute.PUT(request(validInput, 'PUT'), params)).status, 409)
})

function orderHarness({ selectedMethod = method, products, session = { user: { id: 'customer-1', role: 'USER' } }, loseStock = false } = {}) {
  const initialProducts = products ?? [{ id: 'product-1', name: 'کفش', price: 1000000, stock: 8, sizes: [42], colors: ['مشکی'] }]
  const committed = { products: new Map(initialProducts.map((row) => [row.id, { ...row }])), orders: [] }
  const events = []
  const read = (rows, args) => rows.get(args.where.id) ?? null
  const prisma = {
    product: { findUnique: async (args) => { events.push('preflight-product'); return read(committed.products, args) } },
    $transaction: async (callback) => {
      events.push('transaction')
      const draftProducts = new Map([...committed.products].map(([id, row]) => [id, { ...row }]))
      const draftOrders = [...committed.orders]
      const tx = {
        paymentMethod: { findUnique: async () => ({ id: 'bank_transfer', isActive: true, cardNumber: '0000000000000000', cardholderName: 'آزمایشی' }) },
        shippingMethod: { findUnique: async (args) => {
          events.push('transaction-method')
          assert.equal(args.where.id, 'shipping-1')
          return selectedMethod ? { ...selectedMethod } : null
        } },
        product: {
          findUnique: async (args) => { events.push('transaction-product'); return read(draftProducts, args) },
          updateMany: async (args) => {
            events.push('transaction-stock')
            const row = draftProducts.get(args.where.id)
            assert.equal(args.data.stock.decrement, args.where.stock.gte)
            if (loseStock === true || loseStock === args.where.id || !row || row.stock < args.where.stock.gte) return { count: 0 }
            row.stock -= args.data.stock.decrement
            return { count: 1 }
          },
        },
        order: { create: async (args) => {
          events.push('transaction-order')
          const order = { id: 'order-1', ...args.data, items: args.data.items.create }
          draftOrders.push(order)
          return order
        } },
      }
      const result = await callback(tx)
      committed.products = draftProducts
      committed.orders = draftOrders
      return result
    },
  }
  const route = loadRoute('src/app/api/orders/route.ts', { session, prisma })
  return { post: (body) => route.POST(request(body)), committed, events }
}

const validOrder = {
  items: [{ productId: 'product-1', quantity: 2, size: 42, color: 'مشکی', price: 1 }],
  address: 'تهران، خیابان نمونه', phone: '09123456789',
  shippingMethodId: 'shipping-1', paymentMethodId: 'bank_transfer', expectedShippingCost: 105000,
  total: 1, shippingCost: 0, shippingMethodName: 'جعلی',
}

test('Orders use database prices and current method rates, preserve a shipping snapshot and decrement stock atomically', async () => {
  const editableMethod = { ...method }
  const h = orderHarness({ selectedMethod: editableMethod })
  const response = await h.post(validOrder)
  assert.equal(response.status, 201)
  const order = await response.json()
  assert.equal(order.total, 2105000)
  assert.equal(order.shippingCost, 105000)
  assert.equal(order.shippingMethodName, method.name)
  assert.equal(order.items[0].price, 1000000)
  assert.equal(h.committed.products.get('product-1').stock, 6)
  assert.equal(h.committed.orders.length, 1)
  assert.ok(h.events.indexOf('transaction-method') < h.events.indexOf('transaction-stock'))
  assert.ok(h.events.indexOf('transaction-stock') < h.events.indexOf('transaction-order'))
  editableMethod.name = 'نام جدید'
  editableMethod.baseCost = 500000
  assert.equal(h.committed.orders[0].shippingMethodName, method.name)
  assert.equal(h.committed.orders[0].shippingCost, 105000)
})

test('All pair quantities count toward shipping even when the same product has separate cart lines', async () => {
  const h = orderHarness()
  const response = await h.post({
    ...validOrder, expectedShippingCost: 120000,
    items: [validOrder.items[0], { ...validOrder.items[0], quantity: 1 }],
  })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).total, 3120000)
  assert.equal(h.committed.products.get('product-1').stock, 5)
})

test('Free-shipping eligibility uses server product subtotal instead of a client-supplied total', async () => {
  const h = orderHarness({ selectedMethod: { ...method, freeShippingThreshold: 2000000 } })
  const response = await h.post({ ...validOrder, expectedShippingCost: 0, total: 1 })
  assert.equal(response.status, 201)
  const order = await response.json()
  assert.equal(order.shippingCost, 0)
  assert.equal(order.total, 2000000)
})

test('An inflated client subtotal cannot obtain free shipping below the real product threshold', async () => {
  const h = orderHarness({ selectedMethod: { ...method, freeShippingThreshold: 2000000 } })
  const response = await h.post({ ...validOrder, items: [{ ...validOrder.items[0], quantity: 1 }], expectedShippingCost: 0, total: 9000000 })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).shippingCost, 90000)
  assert.equal(h.committed.orders.length, 0)
  assert.equal(h.committed.products.get('product-1').stock, 8)
})

test('An order whose subtotal plus shipping overflows the database amount fails before inventory changes', async () => {
  const h = orderHarness({ products: [{ id: 'product-1', name: 'کفش', price: shipping.MAX_SHIPPING_AMOUNT, stock: 8, sizes: [42], colors: ['مشکی'] }] })
  const response = await h.post({ ...validOrder, items: [{ ...validOrder.items[0], quantity: 1 }], expectedShippingCost: 90000 })
  assert.equal(response.status, 400)
  assert.equal(h.committed.orders.length, 0)
  assert.equal(h.committed.products.get('product-1').stock, 8)
  assert.ok(!h.events.includes('transaction-stock'))
})

test('A stale or tampered quote returns the current fee before reserving stock or creating an order', async () => {
  const h = orderHarness()
  const response = await h.post({ ...validOrder, expectedShippingCost: 0 })
  assert.equal(response.status, 409)
  const error = await response.json()
  assert.equal(error.code, 'SHIPPING_QUOTE_CHANGED')
  assert.equal(error.shippingCost, 105000)
  assert.deepEqual(error.productPrices, [{ productId: 'product-1', price: 1000000, originalPrice: 1000000 }])
  assert.equal(h.committed.products.get('product-1').stock, 8)
  assert.equal(h.committed.orders.length, 0)
  assert.ok(!h.events.includes('transaction-stock'))
})

test('Changed product prices require subtotal confirmation even when the shipping fee stays the same', async () => {
  const h = orderHarness()
  const response = await h.post({ ...validOrder, expectedSubtotal: 1800000 })
  assert.equal(response.status, 409)
  const error = await response.json()
  assert.equal(error.code, 'ORDER_PRICES_CHANGED')
  assert.equal(error.shippingCost, 105000)
  assert.deepEqual(error.productPrices, [{ productId: 'product-1', price: 1000000, originalPrice: 1000000 }])
  assert.equal(h.committed.orders.length, 0)
  assert.equal(h.committed.products.get('product-1').stock, 8)
  assert.ok(!h.events.includes('transaction-stock'))
})

test('A subtotal conflict returns fresh database prices for every product in the cart', async () => {
  const h = orderHarness({ products: [
    { id: 'product-1', name: 'کفش اول', price: 1000000, stock: 8, sizes: [42], colors: ['مشکی'] },
    { id: 'product-2', name: 'کفش دوم', price: 500000, stock: 4, sizes: [42], colors: ['مشکی'] },
  ] })
  const response = await h.post({ ...validOrder, expectedSubtotal: 2000000, expectedShippingCost: 120000,
    items: [validOrder.items[0], { ...validOrder.items[0], productId: 'product-2', quantity: 1, price: 1 }],
  })
  assert.equal(response.status, 409)
  const error = await response.json()
  assert.equal(error.code, 'ORDER_PRICES_CHANGED')
  assert.equal(error.shippingCost, 120000)
  assert.deepEqual(error.productPrices, [
    { productId: 'product-1', price: 1000000, originalPrice: 1000000 }, { productId: 'product-2', price: 500000, originalPrice: 500000 },
  ])
  assert.equal(h.committed.orders.length, 0)
  assert.ok(!h.events.includes('transaction-stock'))
})

test('Valid confirmed subtotal and shipping fee permit an order', async () => {
  const h = orderHarness()
  const response = await h.post({ ...validOrder, expectedSubtotal: 2000000 })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).total, 2105000)
  assert.equal(h.committed.orders.length, 1)
})

test('Invalid expected subtotal values are rejected before stock or order writes', async () => {
  for (const expectedSubtotal of [null, -1, 1.5, '2000000', shipping.MAX_SHIPPING_AMOUNT + 1]) {
    const h = orderHarness()
    const response = await h.post({ ...validOrder, expectedSubtotal })
    assert.equal(response.status, 400)
    assert.equal(h.committed.orders.length, 0)
    assert.ok(!h.events.includes('transaction-stock'))
  }
})

test('Inactive and deleted methods cannot be used by an old checkout', async () => {
  for (const selectedMethod of [null, { ...method, isActive: false }]) {
    const h = orderHarness({ selectedMethod })
    const response = await h.post(validOrder)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'SHIPPING_METHOD_UNAVAILABLE')
    assert.equal(h.committed.orders.length, 0)
    assert.equal(h.committed.products.get('product-1').stock, 8)
    assert.ok(!h.events.includes('transaction-stock'))
  }
})

test('Invalid or missing selected-method and expected-cost input is rejected before stock changes', async () => {
  for (const body of [
    { ...validOrder, shippingMethodId: '' }, { ...validOrder, shippingMethodId: null },
    { ...validOrder, expectedShippingCost: undefined }, { ...validOrder, expectedShippingCost: -1 },
    { ...validOrder, expectedShippingCost: 1.5 }, { ...validOrder, expectedShippingCost: '105000' },
  ]) {
    const h = orderHarness()
    const response = await h.post(body)
    assert.ok([400, 409].includes(response.status))
    assert.equal(h.committed.orders.length, 0)
    assert.ok(!h.events.includes('transaction-stock'))
  }
})

test('A stock race rolls back the complete order and preserves shipping and inventory consistency', async () => {
  const h = orderHarness({ loseStock: true })
  const response = await h.post(validOrder)
  assert.equal(response.status, 409)
  const error = await response.json()
  assert.equal(error.code, 'STOCK_UNAVAILABLE')
  assert.deepEqual(error.outOfStock, ['product-1'])
  assert.equal(error.outOfStockDetails[0].name, 'کفش')
  assert.match(error.error, /متأسفیم/)
  assert.equal(h.committed.orders.length, 0)
  assert.equal(h.committed.products.get('product-1').stock, 8)
})

test('When a later product loses its stock race, earlier stock deductions roll back too', async () => {
  const h = orderHarness({ loseStock: 'product-2', products: [
    { id: 'product-1', name: 'کفش اول', price: 1000000, stock: 8, sizes: [42], colors: ['مشکی'] },
    { id: 'product-2', name: 'کفش دوم', price: 500000, stock: 4, sizes: [42], colors: ['مشکی'] },
  ] })
  const response = await h.post({ ...validOrder, expectedShippingCost: 120000,
    items: [validOrder.items[0], { ...validOrder.items[0], productId: 'product-2', quantity: 1 }],
  })
  assert.equal(response.status, 409)
  const error = await response.json()
  assert.equal(error.code, 'STOCK_UNAVAILABLE')
  assert.deepEqual(error.outOfStock, ['product-2'])
  assert.equal(h.events.filter((event) => event === 'transaction-stock').length, 2)
  assert.equal(h.committed.orders.length, 0)
  assert.equal(h.committed.products.get('product-1').stock, 8)
  assert.equal(h.committed.products.get('product-2').stock, 4)
})

test('Incomplete signed-in identities cannot submit orders', async () => {
  for (const session of [null, {}, { user: {} }, { user: { role: 'ADMIN' } }]) {
    const h = orderHarness({ session })
    assert.equal((await h.post(validOrder)).status, 401)
    assert.equal(h.events.length, 0)
  }
})
