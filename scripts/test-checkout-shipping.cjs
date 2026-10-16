const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { webcrypto } = require('node:crypto')

function compile(file, dependencies, globals = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  const { code } = transformSync(source, { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  const context = { module: { exports: {} }, AbortController, crypto: webcrypto, TextEncoder, Uint8Array, ...globals, require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } }
  vm.runInNewContext(code, context)
  return context.module.exports
}

const shipping = compile('src/lib/shipping.ts', {})
const quoteContract = compile('src/lib/checkout-quote-contract.ts', {})
const method = (overrides = {}) => ({ id: 'post', name: 'پست پیشتاز', description: null, baseCost: 50000, additionalItemCost: 10000, freeShippingThreshold: null, isActive: true, sortOrder: 0, ...overrides })
const currency = (value) => new Intl.NumberFormat('fa-IR').format(value)

// This small hook harness exercises the real checkout handlers without installing a DOM
// test runtime or contacting auth, the database, payment providers, or delivery services.
function checkout({ methods = [method()], paymentMethods = [{ id: 'bank_transfer', name: 'کارت به کارت', description: null }], paymentResponses = [], quantity = 3, shippingResponses = [], orderResponses = [], addresses = [], addressResponses = [], addressSavePending = false, authenticated = false, quoteResponses = [], couponDiscount = 0 } = {}) {
  const slots = []
  const effects = []
  let cursor = 0
  let tree
  let cleared = false
  const removedItems = []
  const pushes = []
  const requests = []
  const savedAddressRequests = []
  const addressReads = []
  const quoteReads = []
  const timers = new Map()
  let timerId = 0
  let currentMethods = methods
  let session = authenticated ? { user: { id: 'customer' } } : null
  let attemptKey
  let attemptCount = 0
  const cart = {
    checkoutAttempt: null,
    items: [{ productId: 'shoe-1', name: 'کفش', price: 100000, quantity, size: 42, color: 'سبز', image: '' }],
    getTotal: () => cart.items.reduce((sum, item) => sum + item.quantity * item.price, 0),
    clearCart: () => { cleared = true },
    removeItem: (productId, size, color) => {
      removedItems.push({ productId, size, color })
      cart.items = cart.items.filter((item) => !(item.productId === productId && item.size === size && item.color === color))
    },
    beginCheckout: async () => {
      if (!attemptKey) {
        attemptKey = `00000000-0000-4000-8000-${String(++attemptCount).padStart(12, '0')}`
        cart.checkoutAttempt = { key: attemptKey }
      }
      return attemptKey
    },
    syncPrices: (prices) => {
      cart.items = cart.items.map((item) => {
        const updated = prices.find((entry) => entry.productId === item.productId)
        return updated ? { ...item, price: updated.price, originalPrice: updated.originalPrice ?? updated.price } : item
      })
    },
  }
  const sameDependencies = (previous, next) => previous && previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]))
  const react = {
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { current: initial }
      return slots[index]
    },
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = {
        value: typeof initial === 'function' ? initial() : initial,
        setter: (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next },
      }
      return [slots[index].value, slots[index].setter]
    },
    useCallback(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !sameDependencies(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies }
      return slots[index].callback
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !sameDependencies(slots[index].dependencies, dependencies)) {
        const previousCleanup = slots[index]?.cleanup
        slots[index] = { dependencies }
        effects.push(() => {
          previousCleanup?.()
          slots[index].cleanup = callback()
        })
      }
    },
  }
  const responses = [methods, ...shippingResponses]
  const fetch = async (url, options) => {
    if (url === '/api/checkout/quote') {
      const body = JSON.parse(options.body)
      quoteReads.push({ body, signal: options.signal })
      if (quoteResponses.length) {
        const result = quoteResponses.shift()
        if (result instanceof Error) throw result
        return typeof result === 'function' ? result(options) : { status: result.status ?? 200, ok: (result.status ?? 200) < 400, json: async () => result.data ?? result }
      }
      const prices = [...new Map(cart.items.map(item => [item.productId, { productId: item.productId, price: item.price, originalPrice: item.originalPrice ?? item.price }])).values()]
      const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
      const grossSubtotal = cart.items.reduce((sum, item) => sum + (item.originalPrice ?? item.price) * item.quantity, 0)
      const discount = body.couponCode ? couponDiscount : 0
      try {
        const selected = currentMethods.find(method => method.id === body.shippingMethodId)
        const cost = shipping.calculateShippingCost(selected, subtotal - discount, cart.items.reduce((sum, item) => sum + item.quantity, 0))
        return { status: 200, ok: true, json: async () => ({ grossSubtotal, subtotal, productDiscount: grossSubtotal - subtotal, couponDiscount: discount, couponCode: body.couponCode || null, shippingCost: cost, total: subtotal - discount + cost, productPrices: prices }) }
      } catch {
        return { status: 400, ok: false, json: async () => ({ error: 'هزینهٔ ارسال قابل محاسبه نیست' }) }
      }
    }
    if (url === '/api/payment-methods') {
      const value = paymentResponses.length ? paymentResponses.shift() : paymentMethods
      if (value instanceof Error) throw value
      return { ok: true, json: async () => value }
    }
    if (url === '/api/addresses') {
      if (options?.method === 'POST') {
        savedAddressRequests.push(JSON.parse(options.body))
        if (addressSavePending) return new Promise(() => {})
        return { ok: true, json: async () => ({ id: 'address-1' }) }
      }
      addressReads.push({ userId: session?.user.id, signal: options?.signal })
      const response = addressResponses.length ? addressResponses.shift() : addresses
      return { ok: !!session, json: async () => response }
    }
    if (url === '/api/shipping-methods') {
      const value = responses.shift() ?? methods
      if (value instanceof Error) throw value
      currentMethods = value
      return { ok: true, json: async () => value }
    }
    assert.equal(url, '/api/orders')
    requests.push(JSON.parse(options.body))
    const response = orderResponses.shift() ?? { status: 201, data: { id: 'order-1', paymentMethod: 'bank_transfer' } }
    if (response instanceof Error) throw response
    return { status: response.status, ok: response.status < 400, json: async () => response.data }
  }
  const jsx = (type, props) => ({ type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' }, 'next/image': { __esModule: true, default: 'Image' },
    'next/navigation': { useRouter: () => ({ push: (url) => pushes.push(url) }) },
    '@/components/ui/BrandIcons': { SneakerIcon: 'SneakerIcon', HikingBootIcon: 'HikingBootIcon' },
    '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session }) },
    '@/lib/cart': { useCart: () => cart }, '@/lib/toast': { toast: () => {} },
    '@/lib/utils': { formatPrice: currency }, '@/lib/shipping': shipping,
    '@/lib/checkout-quote-contract': quoteContract,
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/shop/commerce.module.css': css, '@/components/shop/shipping.module.css': css,
    './coupon.module.css': css,
  }
  const source = readFileSync(path.join(__dirname, '../src/app/(shop)/checkout/page.tsx'), 'utf8')
  const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  const context = { module: { exports: {} }, AbortController, fetch,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    require: (name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
    return dependencies[name]
  } }
  vm.runInNewContext(code, context)
  function render() {
    cursor = 0
    tree = context.module.exports.default()
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  render()
  return {
    render, cart, requests, savedAddressRequests, addressReads, quoteReads, removedItems, pushes, cleared: () => cleared,
    timeoutQuote() { for (const callback of [...timers.values()]) callback(); timers.clear() },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
    setUser(userId) { session = userId ? { user: { id: userId } } : null; return render() },
    get tree() { return tree },
  }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree === undefined || tree === null || typeof tree === 'boolean' ? '' : String(tree)
}

const find = (app, predicate) => nodes(app.tree).find(predicate)
const submit = (app) => find(app, (node) => node.type === 'button' && node.props.type === 'submit')
const radio = (app, id) => find(app, (node) => node.type === 'input' && node.props.type === 'radio' && node.props.value === id)
const summaryTotal = (app) => text(find(app, (node) => node.props.className === 'summaryTotal'))
const settle = () => new Promise(setImmediate)
const settleCheckout = async app => { for (let index = 0; index < 4; index++) { await settle(); app.render() } }
const sendOrder = (app) => find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })

test('Unavailable, failed, or malformed payment-method lists block checkout and retain the cart', async () => {
  for (const paymentMethods of [[], new Error('offline'), { error: 'bad response' }]) {
    const app = checkout({ paymentMethods })
    await settleCheckout(app)
    assert.equal(submit(app).props.disabled, true)
    await sendOrder(app)
    assert.equal(app.requests.length, 0)
    assert.equal(app.cleared(), false)
  }
})

test('Disabling payment during checkout refreshes options without creating or resubmitting an order', async () => {
  const app = checkout({ paymentResponses: [[{ id: 'bank_transfer', name: 'کارت به کارت', description: null }], []],
    orderResponses: [{ status: 409, data: { code: 'PAYMENT_METHOD_UNAVAILABLE', error: 'روش پرداخت غیرفعال شده است' } }] })
  await settleCheckout(app)
  await sendOrder(app)
  app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].paymentMethodId, 'bank_transfer')
  assert.equal(app.cleared(), false)
  assert.equal(submit(app).props.disabled, true)
  await sendOrder(app)
  assert.equal(app.requests.length, 1)
})

test('Shipping loading and an empty active-method list block checkout without claiming free delivery', async () => {
  const app = checkout({ methods: [] })
  assert.equal(submit(app).props.disabled, true)
  assert.ok(!text(app.tree).includes('رایگان'))
  await settleCheckout(app)
  assert.equal(submit(app).props.disabled, true)
  assert.match(text(app.tree), /روش ارسال فعالی وجود ندارد/)
  await sendOrder(app)
  assert.equal(app.requests.length, 0)
  assert.equal(app.cleared(), false)
})

test('Selected carrier prices include additional pairs across quantities and submitted quote matches displayed total', async () => {
  const app = checkout({ methods: [method(), method({ id: 'tipax', name: 'تیپاکس', baseCost: 80000, additionalItemCost: 20000 })] })
  await settleCheckout(app)
  assert.equal(radio(app, 'post').props.checked, true)
  assert.match(summaryTotal(app), new RegExp(currency(370000)))
  radio(app, 'tipax').props.onChange()
  app.render()
  assert.equal(radio(app, 'tipax').props.checked, true)
  assert.match(summaryTotal(app), /—/, 'A changed carrier invalidates the previous quote immediately')
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(420000)))
  await sendOrder(app)
  assert.equal(app.requests[0].shippingMethodId, 'tipax')
  assert.equal(app.requests[0].expectedShippingCost, 120000)
  assert.equal(app.requests[0].expectedSubtotal, 300000)
  assert.equal(app.requests[0].items[0].quantity, 3)
  assert.equal(app.cleared(), true)
  assert.deepEqual(app.pushes, ['/payment/transfer/order-1'])
})

test('Free shipping threshold responds to cart quantity changes', async () => {
  const app = checkout({ quantity: 2, methods: [method({ freeShippingThreshold: 300000 })] })
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(260000)))
  app.cart.items[0].quantity = 3
  app.render()
  assert.equal(submit(app).props.disabled, true)
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(300000)))
  await sendOrder(app)
  assert.equal(app.requests[0].expectedShippingCost, 0)
})

test('A changed shipping quote refreshes the fee and requires review without clearing or resubmitting the cart', async () => {
  const app = checkout({ shippingResponses: [[method({ baseCost: 70000 })]], orderResponses: [{ status: 409, data: { code: 'SHIPPING_QUOTE_CHANGED', error: 'هزینهٔ ارسال تغییر کرده است' } }] })
  await settleCheckout(app)
  await sendOrder(app)
  app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].expectedShippingCost, 70000)
  assert.equal(app.cleared(), false)
  assert.equal(app.pushes.length, 0)
  assert.match(text(app.tree), /هزینهٔ ارسال تغییر کرده است/)
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(390000)))
  await sendOrder(app)
  assert.equal(app.requests[1].expectedShippingCost, 90000)
})

test('A carrier removed during checkout disables submission when no active replacement remains', async () => {
  const app = checkout({ shippingResponses: [[]], orderResponses: [{ status: 409, data: { code: 'SHIPPING_METHOD_UNAVAILABLE', error: 'این روش ارسال دیگر در دسترس نیست' } }] })
  await settleCheckout(app)
  await sendOrder(app)
  app.render()
  assert.equal(app.cleared(), false)
  assert.equal(submit(app).props.disabled, true)
  assert.equal(nodes(app.tree).filter((node) => node.props.type === 'radio' && node.props.name === 'shipping-method').length, 0)
  await sendOrder(app)
  assert.equal(app.requests.length, 1)
})

test('Updated product prices crossing the free-shipping threshold are shown for review before a second submit', async () => {
  const app = checkout({ quantity: 2, methods: [method({ freeShippingThreshold: 300000 })], orderResponses: [{ status: 409, data: { code: 'ORDER_PRICES_CHANGED', error: 'قیمت محصولات تغییر کرده است', productPrices: [{ productId: 'shoe-1', price: 160000 }], shippingCost: 0 } }] })
  await settleCheckout(app)
  await sendOrder(app)
  app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].expectedSubtotal, 200000)
  assert.equal(app.requests[0].expectedShippingCost, 60000)
  assert.equal(app.cleared(), false)
  assert.equal(app.pushes.length, 0)
  assert.equal(app.cart.items[0].quantity, 2)
  assert.equal(app.cart.items[0].size, 42)
  assert.equal(app.cart.items[0].color, 'سبز')
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(320000)))
  assert.match(text(app.tree), /قیمت محصولات تغییر کرده است/)
  await sendOrder(app)
  assert.equal(app.requests[1].expectedSubtotal, 320000)
  assert.equal(app.requests[1].expectedShippingCost, 0)
})

test('Request errors and rate overflow cannot submit or crash the checkout', async () => {
  const failed = checkout({ methods: new Error('Offline') })
  await settleCheckout(failed)
  assert.equal(submit(failed).props.disabled, true)
  assert.match(text(failed.tree), /روش‌های ارسال بارگذاری نشدند/)
  const overflow = checkout({ methods: [method({ baseCost: 2_000_000_000, additionalItemCost: 1_000_000_000 })] })
  await settleCheckout(overflow)
  assert.equal(submit(overflow).props.disabled, true)
  assert.equal(radio(overflow, 'post').props.checked, true)
  assert.match(text(overflow.tree), /قابل محاسبه نیست/)
})

test('A cart cleared while methods are loading renders the empty state safely', async () => {
  const app = checkout()
  app.cart.items = []
  await settleCheckout(app)
  assert.match(text(app.tree), /اول، جفت دلخواهت رو انتخاب کن/)
  assert.equal(app.requests.length, 0)
})

test('Losing concurrent stock keeps the complete cart and shows an apology instead of navigating to payment', async () => {
  const app = checkout({ orderResponses: [{ status: 409, data: {
    code: 'STOCK_UNAVAILABLE', outOfStock: ['shoe-1'],
    outOfStockDetails: [{ productId: 'shoe-1', name: 'کفش', availableQuantity: 0 }],
  } }] })
  await settleCheckout(app)
  const cartBefore = JSON.stringify(app.cart.items)
  await sendOrder(app)
  app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.cleared(), false)
  assert.deepEqual(app.removedItems, [])
  assert.equal(JSON.stringify(app.cart.items), cartBefore)
  assert.deepEqual(app.pushes, [])
  const notice = find(app, (node) => node.props.role === 'alert')
  assert.match(text(notice), /متأسفیم، موجودی «کفش» فعلاً به پایان رسیده است/)
  assert.match(text(notice), /سبد خریدت حفظ شده/)
  assert.equal(notice.props.tabIndex, -1)
  assert.ok(nodes(notice).some((node) => node.props.href === '/cart'))
  assert.ok(nodes(notice).some((node) => node.props.href === '/products'))
  await settleCheckout(app)
  assert.equal(submit(app).props.disabled, false)
})

test('Insufficient quantity is explained accurately and retains every variant of the affected product', async () => {
  const app = checkout({ orderResponses: [{ status: 409, data: {
    code: 'STOCK_UNAVAILABLE', outOfStock: ['shoe-1'],
    outOfStockDetails: [{ productId: 'shoe-1', name: 'کفش', availableQuantity: 1 }],
  } }] })
  app.cart.items.push({ ...app.cart.items[0], size: 43, color: 'آبی', quantity: 1 })
  await settleCheckout(app)
  const cartBefore = JSON.stringify(app.cart.items)
  await sendOrder(app)
  app.render()
  assert.equal(JSON.stringify(app.cart.items), cartBefore)
  assert.deepEqual(app.removedItems, [])
  assert.match(text(find(app, (node) => node.props.role === 'alert')), /برای تعداد انتخابی تو کافی نیست/)
  assert.ok(!text(app.tree).includes('فعلاً به پایان رسیده'))
  assert.deepEqual(app.pushes, [])
})

test('Legacy stock responses retain the cart and show the same helpful apology', async () => {
  const app = checkout({ orderResponses: [{ status: 400, data: {
    outOfStock: ['shoe-1'], error: 'این اقلام از سبد شما حذف شدند',
  } }] })
  await settleCheckout(app)
  await sendOrder(app)
  app.render()
  assert.match(text(app.tree), /متأسفیم، موجودی «کفش»/)
  assert.ok(!text(app.tree).includes('حذف شدند'))
  assert.equal(app.cart.items.length, 1)
  assert.equal(app.cleared(), false)
  assert.deepEqual(app.removedItems, [])
  assert.deepEqual(app.pushes, [])
})

test('Unrelated order conflicts keep their own error without claiming that stock is exhausted', async () => {
  for (const response of [
    { status: 409, data: { code: 'INVALID_PRODUCT_VARIANT', error: 'سایز انتخاب‌شده در دسترس نیست' } },
    { status: 500, data: { error: 'خطا در ثبت سفارش', outOfStock: 'invalid' } },
  ]) {
    const app = checkout({ orderResponses: [response] })
    await settleCheckout(app)
    await sendOrder(app)
    app.render()
    const notice = find(app, (node) => node.props.role === 'alert')
    assert.equal(text(notice).trim(), response.data.error)
    assert.ok(!text(notice).includes('موجودی'))
    assert.ok(!nodes(notice).some((node) => node.props.href === '/products'))
    assert.equal(app.cleared(), false)
    assert.deepEqual(app.removedItems, [])
    assert.deepEqual(app.pushes, [])
  }
})

test('The real cart price sync preserves product variants and rejects invalid returned amounts', () => {
  const { useCart } = compile('src/lib/cart.ts', {
    zustand: { create: () => (initialize) => {
      let state
      const set = (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
      state = initialize(set, () => state)
      return () => state
    } },
    'zustand/middleware': { persist: (initialize) => initialize },
  })
  for (const item of [
    { productId: 'shoe-1', name: 'کفش', price: 100000, quantity: 2, size: 42, color: 'سبز', image: '' },
    { productId: 'shoe-1', name: 'کفش', price: 100000, quantity: 1, size: 43, color: 'آبی', image: '' },
    { productId: 'shoe-2', name: 'بوت', price: 200000, quantity: 1, size: 44, color: 'مشکی', image: '' },
  ]) useCart().addItem(item)
  useCart().syncPrices([{ productId: 'shoe-1', price: 160000 }, { productId: 'shoe-2', price: -1 }])
  const items = useCart().items
  assert.equal(items.length, 3)
  assert.equal(items[0].price, 160000)
  assert.equal(items[1].price, 160000)
  assert.equal(items[2].price, 200000)
  assert.equal(items[0].quantity, 2)
  assert.equal(items[1].size, 43)
  assert.equal(items[1].color, 'آبی')
  assert.equal(items[2].name, 'بوت')
  assert.equal(useCart().getTotal(), 680000)
})

function realCart({ crypto = webcrypto, restored = {} } = {}) {
  return compile('src/lib/cart.ts', {
    zustand: { create: () => (initialize) => {
      let state
      const set = (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
      state = { ...initialize(set, () => state), ...restored }
      return () => state
    } },
    'zustand/middleware': { persist: (initialize) => initialize },
  }, { crypto }).useCart
}

test('Real cart retains an unresolved retry key across reload, quote changes and cart edits; completed or emptied carts start fresh', async () => {
  const store = realCart()
  const payload = JSON.stringify({ recipientName: 'گیرنده', address: 'نشانی خصوصی', phone: '09123456789', expectedSubtotal: 300000 })
  const [first, concurrent] = await Promise.all([store().beginCheckout(payload), store().beginCheckout(payload)])
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(concurrent, first)
  const persisted = JSON.stringify(store())
  assert.ok(!persisted.includes('نشانی خصوصی'))
  assert.ok(!persisted.includes('09123456789'))
  const restored = realCart({ restored: JSON.parse(persisted) })
  assert.equal(await restored().beginCheckout(payload), first)
  assert.equal(await restored().beginCheckout(payload.replace('300000', '400000')), first)
  restored().addItem({ productId: 'shoe-1', name: 'کفش', price: 100000, quantity: 1, size: 42, color: '-', image: '' })
  restored().syncPrices([{ productId: 'shoe-1', price: 200000 }])
  restored().updateQuantity('shoe-1', 42, '-', 2)
  assert.equal(await restored().beginCheckout(), first)
  restored().removeItem('shoe-1', 42, '-')
  assert.notEqual(await restored().beginCheckout(), first)
  restored().clearCart()
  assert.notEqual(await restored().beginCheckout(payload), first)
})

test('Plain HTTP LAN previews can issue and reuse valid keys without SubtleCrypto', async () => {
  const store = realCart({ crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } })
  const first = await store().beginCheckout('same request')
  assert.match(first, /^[0-9a-f-]{36}$/)
  assert.equal(await store().beginCheckout('same request'), first)
  assert.equal(await store().beginCheckout('changed request'), first)
  store().clearCart()
  assert.notEqual(await store().beginCheckout(), first)
})

test('Synchronous double submits send one request; network retries reuse the key without losing the cart', async () => {
  const app = checkout({ orderResponses: [new Error('Lost response')] })
  await settleCheckout(app)
  await Promise.all([sendOrder(app), sendOrder(app)])
  app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.cleared(), false)
  assert.match(text(app.tree), /خطای ارتباط با سرور/)
  await settleCheckout(app)
  await sendOrder(app)
  assert.equal(app.requests.length, 2)
  assert.equal(app.requests[1].checkoutKey, app.requests[0].checkoutKey)
  assert.equal(app.cleared(), true)
})

const fill = (app, id, value) => {
  find(app, (node) => node.props.id === id).props.onChange({ target: { value } })
  app.render()
}

const quoteValue = (overrides = {}) => ({ grossSubtotal: 300000, subtotal: 300000, productDiscount: 0, couponDiscount: 0, couponCode: null, shippingCost: 70000, total: 370000, productPrices: [{ productId: 'shoe-1', price: 100000, originalPrice: 100000 }], ...overrides })
const applyCode = (app, code) => {
  fill(app, 'checkout-coupon', code)
  find(app, node => node.type === 'button' && text(node) === 'اعمال کد').props.onClick()
  app.render()
}

test('Coupon quotes apply to discounted goods and free-shipping thresholds use the discounted net amount', async () => {
  const app = checkout({ authenticated: true, couponDiscount: 50000, methods: [method({ freeShippingThreshold: 300000 })] })
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(300000)))
  applyCode(app, ' panik10 ')
  assert.equal(submit(app).props.disabled, true)
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(320000)))
  assert.match(text(app.tree), /اعمال شد/)
  assert.match(text(app.tree), /تخفیف کد/)
  await sendOrder(app)
  assert.equal(app.requests[0].couponCode, 'PANIK10')
  assert.equal(app.requests[0].expectedCouponDiscount, 50000)
  assert.equal(app.requests[0].expectedSubtotal, 300000)
  assert.equal(app.requests[0].expectedShippingCost, 70000)
  assert.equal(app.cleared(), true)
  app.unmount()
})

test('Canonical product discounts synchronize variant prices without changing quantities or the original price', async () => {
  const app = checkout({ quoteResponses: [quoteValue({ grossSubtotal: 300000, subtotal: 240000, productDiscount: 60000, total: 310000, productPrices: [{ productId: 'shoe-1', price: 80000, originalPrice: 100000 }] })] })
  await settleCheckout(app)
  assert.equal(app.cart.items[0].price, 80000)
  assert.equal(app.cart.items[0].originalPrice, 100000)
  assert.equal(app.cart.items[0].quantity, 3)
  assert.equal(app.cart.items[0].size, 42)
  assert.match(text(app.tree), /تخفیف محصولات/)
  assert.match(summaryTotal(app), new RegExp(currency(310000)))
  assert.ok(app.quoteReads.length <= 2, 'Price synchronization settles without an infinite quote loop')
  await sendOrder(app)
  assert.equal(app.requests[0].expectedSubtotal, 240000)
  assert.equal(app.requests[0].expectedCouponDiscount, 0)
  app.unmount()
})

test('An invalid coupon keeps its editable code and cart, blocks stale totals and can be removed to continue', async () => {
  const queued = []
  const app = checkout({ authenticated: true, quoteResponses: queued })
  await settleCheckout(app)
  queued.push({ status: 400, data: { error: 'کد تخفیف منقضی شده است', code: 'COUPON_EXPIRED' } })
  applyCode(app, 'OLD10')
  await settleCheckout(app)
  assert.equal(find(app, node => node.props.id === 'checkout-coupon').props.value, 'OLD10')
  assert.match(text(app.tree), /کد تخفیف منقضی شده است/)
  assert.match(summaryTotal(app), /—/)
  assert.equal(submit(app).props.disabled, true)
  await sendOrder(app)
  assert.equal(app.requests.length, 0)
  find(app, node => node.type === 'button' && text(node) === 'حذف کد').props.onClick(); app.render()
  await settleCheckout(app)
  assert.equal(find(app, node => node.props.id === 'checkout-coupon').props.value, '')
  assert.equal(submit(app).props.disabled, false)
  assert.match(summaryTotal(app), new RegExp(currency(370000)))
  assert.equal(app.cleared(), false)
  app.unmount()
})

test('Guest coupon rejection gives a checkout login destination and never submits an unauthorized discount', async () => {
  const queued = []
  const app = checkout({ quoteResponses: queued })
  await settleCheckout(app)
  queued.push({ status: 401, data: { error: 'برای استفاده از کد تخفیف ابتدا وارد حساب شوید' } })
  applyCode(app, 'PANIK10'); await settleCheckout(app)
  assert.ok(find(app, node => node.props.href === '/login?callbackUrl=%2Fcheckout'))
  assert.equal(submit(app).props.disabled, true)
  assert.equal(app.requests.length, 0)
  assert.equal(app.cart.items.length, 1)
  app.unmount()
})

test('Delayed quotes for an older cart are aborted and cannot overwrite the newer quantity or total', async () => {
  let finish
  const app = checkout({ quoteResponses: [() => new Promise(resolve => { finish = resolve })] })
  await settleCheckout(app)
  assert.equal(submit(app).props.disabled, true)
  app.cart.items[0].quantity = 4
  app.render(); await settleCheckout(app)
  assert.equal(app.quoteReads[0].signal.aborted, true)
  assert.match(summaryTotal(app), new RegExp(currency(480000)))
  finish({ ok: true, status: 200, json: async () => quoteValue() })
  await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(480000)))
  assert.equal(app.cart.items[0].quantity, 4)
  await sendOrder(app)
  assert.equal(app.requests[0].expectedSubtotal, 400000)
  app.unmount()
})

test('A stalled quote times out, aborts its request and can retry without clearing the basket', async () => {
  let finish
  const app = checkout({ quoteResponses: [() => new Promise(resolve => { finish = resolve })] })
  await settleCheckout(app)
  app.timeoutQuote(); app.render()
  assert.equal(app.quoteReads[0].signal.aborted, true)
  assert.match(text(app.tree), /بیش از حد طول کشید/)
  assert.equal(submit(app).props.disabled, true)
  find(app, node => node.type === 'button' && text(node) === 'محاسبهٔ دوباره').props.onClick(); app.render()
  await settleCheckout(app)
  assert.equal(submit(app).props.disabled, false)
  finish({ ok: true, status: 200, json: async () => quoteValue({ total: 1 }) }); await settleCheckout(app)
  assert.match(summaryTotal(app), new RegExp(currency(370000)))
  assert.equal(app.cleared(), false)
  app.unmount()
})

test('Malformed quotes and mismatched product totals never authorize checkout', async () => {
  for (const data of [null, { ...quoteValue(), total: 1 }, quoteValue({ productPrices: [{ productId: 'another-product', price: 100000, originalPrice: 100000 }] }), quoteValue({ productPrices: [{ productId: 'shoe-1', price: 80000, originalPrice: 100000 }] })]) {
    const app = checkout({ quoteResponses: [{ data }] })
    await settleCheckout(app)
    assert.equal(submit(app).props.disabled, true)
    await sendOrder(app)
    assert.equal(app.requests.length, 0)
    assert.equal(app.cleared(), false)
    app.unmount()
  }
})

test('Coupon expiry during order creation refreshes the quote and preserves the cart and retry key', async () => {
  const queued = []
  const app = checkout({ authenticated: true, couponDiscount: 50000, quoteResponses: queued, orderResponses: [{ status: 409, data: { code: 'COUPON_EXPIRED', error: 'زمان استفاده از کد تمام شد' } }] })
  await settleCheckout(app)
  applyCode(app, 'PANIK10'); await settleCheckout(app)
  queued.push({ status: 400, data: { code: 'COUPON_EXPIRED', error: 'زمان استفاده از کد تمام شد' } })
  await sendOrder(app); app.render(); await settleCheckout(app)
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].couponCode, 'PANIK10')
  assert.equal(app.cart.checkoutAttempt.key, app.requests[0].checkoutKey)
  assert.equal(app.cleared(), false)
  assert.equal(submit(app).props.disabled, true)
  assert.match(text(app.tree), /زمان استفاده از کد تمام شد/)
  app.unmount()
})

test('A lost committed order response can be recovered even if its own coupon reservation uses the last slot', async () => {
  const queued = []
  const app = checkout({ authenticated: true, couponDiscount: 50000, quoteResponses: queued, orderResponses: [new Error('Response lost after commit')] })
  await settleCheckout(app)
  applyCode(app, 'LASTONE'); await settleCheckout(app)
  queued.push({ status: 409, data: { code: 'CHECKOUT_ALREADY_CREATED', existingOrderId: 'already-created', error: 'سفارش شما قبلاً ثبت شده است؛ پرداخت آن را ادامه دهید' } })
  await sendOrder(app); app.render(); await settleCheckout(app)
  assert.equal(app.requests.length, 1)
  assert.equal(app.quoteReads.at(-1).body.checkoutKey, app.requests[0].checkoutKey)
  assert.equal(submit(app).props.disabled, true)
  assert.equal(app.cleared(), false)
  assert.deepEqual(app.pushes, [])
  const resume = find(app, node => node.props.href === '/payment/result?orderId=already-created')
  assert.ok(resume)
  resume.props.onClick()
  assert.equal(app.cleared(), true, 'The user acknowledges the existing order before removing the cart')
  app.unmount()
})

test('Real cart price synchronization validates original prices and clears stale strike-through discounts', () => {
  const store = realCart()
  store().addItem({ productId: 'shoe-1', name: 'کفش', price: 80000, originalPrice: 100000, quantity: 1, size: 42, color: '-', image: '' })
  store().syncPrices([{ productId: 'shoe-1', price: 90000, originalPrice: 110000 }])
  assert.equal(store().items[0].price, 90000)
  assert.equal(store().items[0].originalPrice, 110000)
  store().syncPrices([{ productId: 'shoe-1', price: 120000 }])
  assert.equal(store().items[0].originalPrice, 120000)
  store().syncPrices([{ productId: 'shoe-1', price: 120000, originalPrice: 1 }])
  assert.equal(store().items[0].originalPrice, 120000)
  store().addItem({ productId: 'shoe-1', name: 'کفش', price: 100000, originalPrice: 120000, quantity: 1, size: 42, color: '-', image: '' })
  assert.equal(store().items[0].quantity, 2)
  assert.equal(store().items[0].price, 100000)
  assert.equal(store().items[0].originalPrice, 120000)
})

test('A stalled optional profile address save cannot delay the ten-minute payment page', async () => {
  const app = checkout({ authenticated: true, addressSavePending: true })
  await settleCheckout(app)
  fill(app, 'checkout-name', 'گیرنده')
  fill(app, 'checkout-address', 'تهران، نشانی آزمایشی')
  fill(app, 'checkout-phone', '09123456789')
  const completed = await Promise.race([sendOrder(app).then(() => true), settle().then(() => false)])
  assert.equal(completed, true)
  assert.equal(app.savedAddressRequests.length, 1)
  assert.deepEqual(app.pushes, ['/payment/transfer/order-1'])
  assert.equal(app.cleared(), true)
})

test('Recipient name is submitted and the first typed address is saved when the profile checkbox is checked', async () => {
  const app = checkout({ authenticated: true })
  await settleCheckout(app)
  fill(app, 'checkout-name', '  گیرندهٔ سفارش  ')
  fill(app, 'checkout-address', 'نشانی کامل')
  fill(app, 'checkout-phone', '09123456789')
  await sendOrder(app)
  assert.equal(app.requests[0].recipientName, 'گیرندهٔ سفارش')
  assert.equal(app.savedAddressRequests.length, 1)
  assert.equal(app.savedAddressRequests[0].address, 'نشانی کامل')
})

test('Late saved-address loading never overwrites the address the buyer has started entering', async () => {
  let completeAddresses
  const addresses = new Promise((resolve) => { completeAddresses = resolve })
  const app = checkout({ authenticated: true, addresses })
  fill(app, 'checkout-address', 'نشانی تازهٔ خریدار')
  fill(app, 'checkout-phone', '09123456789')
  completeAddresses([{ id: 'old-address', title: 'قدیمی', address: 'نشانی قبلی', phone: '09120000000', isDefault: true }])
  await settleCheckout(app)
  assert.equal(find(app, (node) => node.props.id === 'checkout-address').props.value, 'نشانی تازهٔ خریدار')
  assert.equal(find(app, (node) => node.props.id === 'checkout-phone').props.value, '09123456789')
})

test('Session expiry immediately hides saved addresses and profile saving while preserving checkout details and cart', async () => {
  const app = checkout({ authenticated: true, addresses: [{ id: 'home', title: 'خانهٔ ذخیره‌شده', address: 'نشانی ذخیره‌شده', phone: '09120000000', isDefault: true }] })
  await settleCheckout(app)
  fill(app, 'checkout-name', 'گیرندهٔ سفارش')
  assert.ok(text(app.tree).includes('خانهٔ ذخیره‌شده'))
  const cartBefore = JSON.stringify(app.cart.items)

  app.setUser(null)
  assert.ok(!text(app.tree).includes('خانهٔ ذخیره‌شده'))
  assert.equal(find(app, (node) => node.props.type === 'checkbox'), undefined)
  assert.equal(find(app, (node) => node.props.id === 'checkout-name').props.value, 'گیرندهٔ سفارش')
  assert.equal(find(app, (node) => node.props.id === 'checkout-address').props.value, 'نشانی ذخیره‌شده')
  assert.equal(find(app, (node) => node.props.id === 'checkout-phone').props.value, '09120000000')
  assert.equal(JSON.stringify(app.cart.items), cartBefore)
  assert.equal(app.cleared(), false)
  assert.equal(app.addressReads.length, 1)
})

test('Guest checkout skips address reads; login and account changes refetch without replacing typed delivery details', async () => {
  const app = checkout({ addressResponses: [
    [{ id: 'first', title: 'آدرس حساب اول', address: 'نشانی اول', phone: '09120000001', isDefault: true }],
    [{ id: 'second', title: 'آدرس حساب دوم', address: 'نشانی دوم', phone: '09120000002', isDefault: true }],
  ] })
  await settleCheckout(app)
  assert.equal(app.addressReads.length, 0)
  fill(app, 'checkout-name', 'نام تایپ‌شده')
  fill(app, 'checkout-address', 'نشانی تایپ‌شده')
  fill(app, 'checkout-phone', '09123456789')
  const cartBefore = JSON.stringify(app.cart.items)

  app.setUser('first-user')
  await settleCheckout(app)
  assert.equal(app.addressReads.length, 1)
  assert.ok(find(app, (node) => node.props.type === 'checkbox'))
  app.setUser(null)
  assert.equal(find(app, (node) => node.props.type === 'checkbox'), undefined)
  assert.ok(!text(app.tree).includes('انتخاب از آدرسهای ذخیرهشده'))

  app.setUser('second-user')
  await settleCheckout(app)
  assert.deepEqual(app.addressReads.map((request) => request.userId), ['first-user', 'second-user'])
  assert.equal(find(app, (node) => node.props.id === 'checkout-name').props.value, 'نام تایپ‌شده')
  assert.equal(find(app, (node) => node.props.id === 'checkout-address').props.value, 'نشانی تایپ‌شده')
  assert.equal(find(app, (node) => node.props.id === 'checkout-phone').props.value, '09123456789')
  assert.equal(JSON.stringify(app.cart.items), cartBefore)
  find(app, (node) => node.type === 'button' && text(node) === 'انتخاب از آدرسهای ذخیرهشده').props.onClick()
  app.render()
  assert.ok(text(app.tree).includes('آدرس حساب دوم'))
  assert.ok(!text(app.tree).includes('آدرس حساب اول'))
})

test('Account changes and logout abort late address responses so another account cannot inherit them', async () => {
  let completeOldAddresses
  const oldAddresses = new Promise((resolve) => { completeOldAddresses = resolve })
  let completeNewAddresses
  const newAddresses = new Promise((resolve) => { completeNewAddresses = resolve })
  const app = checkout({ authenticated: true, addressResponses: [oldAddresses, newAddresses] })
  await settle()
  app.setUser('new-user')
  assert.equal(app.addressReads[0].signal.aborted, true)
  completeOldAddresses([{ id: 'old', title: 'آدرس حساب قبلی', address: 'نشانی قبلی', phone: '09120000001', isDefault: true }])
  await settleCheckout(app)
  assert.ok(!text(app.tree).includes('آدرس حساب قبلی'))
  assert.equal(find(app, (node) => node.props.id === 'checkout-address').props.value, '')

  app.setUser(null)
  assert.equal(app.addressReads[1].signal.aborted, true)
  completeNewAddresses([{ id: 'new', title: 'آدرس حساب جدید', address: 'نشانی جدید', phone: '09120000002', isDefault: true }])
  await settleCheckout(app)
  assert.ok(!text(app.tree).includes('آدرس حساب جدید'))
  assert.equal(find(app, (node) => node.props.id === 'checkout-address').props.value, '')
  assert.equal(find(app, (node) => node.props.type === 'checkbox'), undefined)
  assert.equal(app.cleared(), false)
})

test('A committed attempt with edited recipient details links its existing order and retains cart until the buyer acknowledges it', async () => {
  const app = checkout({ orderResponses: [{ status: 409, data: { code: 'CHECKOUT_KEY_REUSED', existingOrderId: 'old-order', error: 'Changed intent' } }] })
  await settleCheckout(app)
  await sendOrder(app)
  app.render()
  assert.equal(app.cleared(), false)
  assert.equal(app.pushes.length, 0)
  const link = find(app, (node) => node.props.href === '/payment/result?orderId=old-order')
  assert.ok(link)
  assert.match(text(app.tree), /سفارش تکراری ساخته نشد/)
  link.props.onClick()
  assert.equal(app.cleared(), true)
})
