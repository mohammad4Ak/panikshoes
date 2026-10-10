const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Execute the real page handlers with hook and fetch doubles. No server or DB is contacted.
const shoe = { id: 'shoe-1', name: 'کفش آدیداس', slug: 'adidas-ultra', description: 'Lightweight trail runner', price: 100000, images: [], stock: 5, sizes: [42], colors: ['سبز'], featured: false, categoryId: 'cat-1', category: { name: 'کتانی' } }
const category = { id: 'cat-1', name: 'کتانی', slug: 'sneaker', image: null, _count: { products: 0 } }
const user = { id: 'user-1', name: 'مشتری نمونه', email: 'customer@example.test', phone: null, role: 'USER', _count: { orders: 1 } }
const order = (overrides = {}) => ({ id: 'order-pending', total: 150000, shippingMethodName: 'پست پیشتاز', shippingCost: 50000, status: 'PENDING', verified: false, recipientName: 'گیرنده نمونه', address: 'نشانی نمونه', phone: '09123456789', createdAt: '2026-10-01T08:00:00Z', user: { name: user.name, email: user.email }, items: [{ id: 'line-1', quantity: 1, size: 42, color: 'سبز', price: 100000, product: { name: shoe.name } }], ...overrides })
const settle = () => new Promise(setImmediate)
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const orderReport = (orders, overrides = {}) => ({
  orders, pagination: { page: 1, pageSize: 20, total: orders.length, pages: 1 },
  dashboard: { date: '2026-10-08', timeZone: 'Asia/Tehran', todayOrders: orders.length, todayPaidOrders: 0, todayPaidTotal: 0, awaitingReview: 0, readyToShip: 0 },
  generatedAt: '2026-10-08T08:00:00.000Z', ...overrides,
})

function page(file = 'src/app/(shop)/products/page.tsx', { queues = {}, search = '' } = {}) {
  const slots = [], pendingEffects = [], requests = [], confirmations = [], timers = new Map()
  let nextTimer = 0
  let cursor = 0, tree, stateWrites = 0
  const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    Suspense: 'Suspense',
    Fragment: 'Fragment',
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, (next) => { stateWrites++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useMemo(callback) { cursor++; return callback() },
    useCallback(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies }
      return slots[index].callback
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.()
        slots[index] = { dependencies }
        pendingEffects.push(() => { slots[index].cleanup = callback() })
      }
    },
  }
  const location = { pathname: '/products', search, hash: '' }
  const window = {
    location,
    history: { replaceState(_state, _title, value) { const url = new URL(value, 'http://localhost'); location.search = url.search } },
  }
  const defaults = { '/api/products': [shoe], '/api/categories': [category], '/api/users': [user], '/api/admin/orders': orderReport([order()]) }
  const fetch = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`
    requests.push({ url, ...options })
    const pathname = new URL(url, 'http://localhost').pathname
    const baseKey = `${options.method || 'GET'} ${pathname}`
    const queue = queues[key] || queues[url] || queues[baseKey] || queues[pathname]
    const value = queue?.length ? queue.shift() : response(defaults[pathname] || {})
    if (value instanceof Error) throw value
    if (typeof value === 'function') return value(options)
    return value
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/navigation': { useSearchParams: () => new URLSearchParams(location.search) },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/BrandIcons': { SneakerIcon: 'SneakerIcon' },
    '@/components/shop/ProductCard': { __esModule: true, default: 'ProductCard' },
    '@/components/layout/SiteSettingsProvider': { useSiteSettings: () => ({ storeName: 'کفش لند' }) },
    '@/components/shop/InvoiceDownload': { __esModule: true, default: 'InvoiceDownload' },
    '@/components/admin/MultiImageInput': { __esModule: true, default: 'MultiImageInput' },
    '@/lib/utils': { formatPrice: (value) => String(value) },
    '@/components/shop/commerce.module.css': css,
    '@/components/admin/admin.module.css': css,
  }
  const selectModule = { exports: {} }
  const selectSource = readFileSync(path.join(__dirname, '..', 'src/components/ui/EnhancedSelect.tsx'), 'utf8')
  vm.runInNewContext(transformSync(selectSource, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: selectModule,
    require(name) {
      if (name.endsWith('.css')) return css
      assert.ok(name in dependencies, 'Unexpected EnhancedSelect dependency ' + name)
      return dependencies[name]
    },
  })
  dependencies['@/components/ui/EnhancedSelect'] = selectModule.exports
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  const context = {
    module: { exports: {} }, AbortController, Error, TypeError, URLSearchParams, fetch, window,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    confirm: (message) => { confirmations.push(message); return true },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(code, context)
  function render() {
    cursor = 0
    tree = context.module.exports.default()
    pendingEffects.splice(0).forEach((effect) => effect())
    return tree
  }
  render()
  return {
    render, requests, confirmations, location,
    flushTimers() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback() },
    get tree() { return tree }, get stateWrites() { return stateWrites },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
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
const retry = (app) => find(app, (node) => node.type === 'button' && text(node) === 'تلاش دوباره')
const cards = (app) => nodes(app.tree).filter((node) => node.type === 'ProductCard')

test('Renaming a product does not resend the stale stock shown when the edit modal opened', async () => {
  const app = page('src/app/admin/products/page.tsx', {
    queues: { 'PUT /api/products/shoe-1': [response(shoe)] },
  })
  await settle(); app.render()
  find(app, (node) => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, (node) => node.type === 'input' && node.props.value === shoe.name).props.onChange({ target: { value: 'New product name' } }); app.render()
  await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const saved = JSON.parse(app.requests.find((item) => item.method === 'PUT').body)
  assert.equal(saved.name, 'New product name')
  assert.equal(Object.hasOwn(saved, 'stock'), false)
  assert.equal(Object.hasOwn(saved, 'expectedStock'), false)
  app.unmount()
})

test('An intentional inventory edit carries its original count and conflict recovery preserves other changes', async () => {
  const app = page('src/app/admin/products/page.tsx', { queues: {
    'PUT /api/products/shoe-1': [response({ code: 'PRODUCT_STOCK_CHANGED', error: 'موجودی تغییر کرده است' }, 409), response(shoe)],
    'GET /api/products/shoe-1': [response({ ...shoe, stock: 4 })],
  } })
  await settle(); app.render()
  find(app, (node) => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, (node) => node.type === 'input' && node.props.value === shoe.name).props.onChange({ target: { value: 'New product name' } }); app.render()
  find(app, (node) => node.type === 'input' && node.props.value === String(shoe.stock)).props.onChange({ target: { value: '9' } }); app.render()
  await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
  assert.deepEqual(JSON.parse(app.requests.find((item) => item.method === 'PUT').body).expectedStock, 5)
  assert.equal(find(app, (node) => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(app.requests.filter((item) => item.method === 'PUT').length, 1)
  find(app, (node) => node.type === 'button' && text(node) === 'تازه‌سازی موجودی').props.onClick()
  await settle(); app.render()
  assert.ok(find(app, (node) => node.type === 'input' && node.props.value === 'New product name'))
  const freshStock = find(app, (node) => node.type === 'input' && node.props.value === '4')
  assert.ok(freshStock)
  freshStock.props.onChange({ target: { value: '8' } }); app.render()
  await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const saved = JSON.parse(app.requests.filter((item) => item.method === 'PUT').at(-1).body)
  assert.equal(saved.stock, 8)
  assert.equal(saved.expectedStock, 4)
  assert.equal(saved.name, 'New product name')
  app.unmount()
})

for (const invalidSizes of ['42.5', '42abc', '42,,43', '۰،۴۲', '۴۲٫۵', '41,', '2147483648']) {
  test(`Admin rejects malformed size entries without truncating or dropping them: ${invalidSizes}`, async () => {
    const app = page('src/app/admin/products/page.tsx')
    await settle(); app.render()
    find(app, (node) => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
    find(app, (node) => node.type === 'input' && node.props.value === '42').props.onChange({ target: { value: invalidSizes } }); app.render()
    await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
    assert.match(text(app.tree), /سایزها باید عدد صحیح/)
    assert.ok(find(app, (node) => node.props.role === 'dialog'))
    assert.ok(find(app, (node) => node.type === 'input' && node.props.value === invalidSizes))
    assert.equal(app.requests.filter((item) => item.method === 'PUT' || item.method === 'POST').length, 0)
    assert.equal(find(app, (node) => node.type === 'button' && node.props.type === 'submit').props.disabled, false)
    app.unmount()
  })
}

test('Admin size input accepts Persian, Arabic and Latin digits with either comma separator', async () => {
  const app = page('src/app/admin/products/page.tsx', {
    queues: { 'PUT /api/products/shoe-1': [response(shoe)] },
  })
  await settle(); app.render()
  find(app, (node) => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, (node) => node.type === 'input' && node.props.value === '42').props.onChange({ target: { value: ' ۴۲، ٤٣, 44 ' } }); app.render()
  await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(JSON.parse(app.requests.find((item) => item.method === 'PUT').body).sizes, [42, 43, 44])
  app.unmount()
})

for (const search of ['کفش', 'ADIDAS-ULTRA', ' TRAIL ', 'lightweight']) {
  test(`Listing search includes names, slugs and descriptions with trimmed case-insensitive terms: ${search}`, async () => {
    const app = page(undefined, { search: `?q=${encodeURIComponent(search)}` })
    await settle(); app.render()
    assert.equal(cards(app).length, 1)
    assert.equal(cards(app)[0].props.product.id, shoe.id)
    app.unmount()
  })
}

for (const [label, failure] of [
  ['network failure', new TypeError('Failed to fetch')],
  ['HTTP failure', response({ error: 'سرور در دسترس نیست' }, 503)],
  ['invalid JSON data', response({ unexpected: true })],
]) {
  test(`Listing ${label} displays an error and retries while preserving URL filters`, async () => {
    const app = page(undefined, { search: '?q=TRAIL&stock=1', queues: { '/api/products': [failure, response([shoe])] } })
    await settle(); app.render()
    assert.match(text(app.tree), /ویترین فعلاً در دسترس نیست/)
    assert.ok(find(app, (node) => node.props.role === 'alert'))
    assert.ok(!text(app.tree).includes('هنوز محصولی ثبت نشده است'))
    assert.equal(cards(app).length, 0)
    retry(app).props.onClick(); app.render()
    await settle(); app.render()
    assert.equal(cards(app).length, 1)
    assert.equal(app.location.search, '?q=TRAIL&stock=1')
    app.unmount()
  })
}

test('Category failure is visible instead of pretending the store has no products', async () => {
  const app = page(undefined, { queues: { '/api/categories': [response({ error: 'دسته‌بندی‌ها دریافت نشدند' }, 500)] } })
  await settle(); app.render()
  assert.match(text(app.tree), /دسته‌بندی‌ها دریافت نشدند/)
  assert.equal(cards(app).length, 0)
  assert.ok(retry(app))
  app.unmount()
})

for (const file of ['src/app/(shop)/products/page.tsx', 'src/app/admin/products/page.tsx', 'src/app/admin/categories/page.tsx', 'src/app/admin/users/page.tsx']) {
  test(`${file} aborts pending loading and ignores late responses after unmount`, async () => {
    const endpoint = file.includes('categories') ? '/api/categories' : file.includes('users') ? '/api/users' : '/api/products'
    let finish
    const delayed = new Promise((resolve) => { finish = resolve })
    const app = page(file, { queues: { [endpoint]: [() => delayed] } })
    const writes = app.stateWrites
    app.unmount()
    assert.ok(app.requests.every((request) => request.signal.aborted))
    finish(response(endpoint === '/api/users' ? [user] : endpoint === '/api/categories' ? [category] : [shoe]))
    await settle()
    assert.equal(app.stateWrites, writes)
  })
}

for (const [file, endpoint, deletion, title] of [
  ['src/app/admin/products/page.tsx', '/api/products', '/api/products/shoe-1', 'حذف'],
  ['src/app/admin/categories/page.tsx', '/api/categories', '/api/categories/cat-1', 'حذف'],
  ['src/app/admin/users/page.tsx', '/api/users', '/api/users/user-1', 'حذف کاربر'],
]) {
  test(`${file} retries failed loading and exposes protected-history delete errors without removing the row`, async () => {
    const app = page(file, { queues: {
      [endpoint]: [new TypeError('Failed to fetch')],
      [`DELETE ${deletion}`]: [response({ error: 'سابقه سفارش باید حفظ شود' }, 409)],
    } })
    await settle(); app.render()
    assert.ok(retry(app))
    retry(app).props.onClick(); app.render()
    await settle(); app.render()
    const button = find(app, (node) => node.type === 'button' && node.props.title === title)
    assert.ok(button)
    await button.props.onClick(); app.render()
    assert.match(text(app.tree), /سابقه سفارش باید حفظ شود/)
    assert.ok(find(app, (node) => node.type === 'button' && node.props.title === title))
    if (file.includes('users')) {
      assert.match(app.confirmations[0], /سابقهٔ سفارش قابل حذف نیستند/)
      assert.ok(!app.confirmations[0].includes('سفارشهای او هم حذف'))
    }
    app.unmount()
  })
}

const ordersFile = 'src/app/admin/orders/page.tsx'
const orderStatus = (app, id) => find(app, (node) => node.type === 'select' && node.props['aria-label'] === `وضعیت سفارش ${id.slice(-6)}`)
const orderDelete = (app, id) => find(app, (node) => node.type === 'button' && node.props['aria-label'] === `حذف سفارش ${id.slice(-6)}`)
const statusOptions = (select) => nodes(select).filter((node) => node.type === 'option').map((node) => node.props.value)

test('Admin orders preserves paid or fulfilled history by disabling its delete controls', async () => {
  const rows = [
    order({ id: 'order-paid01', verified: true }),
    order({ id: 'order-ship02', status: 'SHIPPED' }),
    order({ id: 'order-deli03', status: 'DELIVERED' }),
    order({ id: 'order-canc04', status: 'CANCELLED', verified: true }),
    order({ id: 'order-open05' }),
  ]
  const app = page(ordersFile, { queues: { '/api/admin/orders': [response(orderReport(rows))] } })
  await settle(); app.render()
  for (const row of rows.slice(0, -1)) {
    const button = orderDelete(app, row.id)
    assert.equal(button.props.disabled, true)
    assert.match(button.props.title, /سابقهٔ سفارش.*حفظ می‌شود/)
  }
  assert.equal(orderDelete(app, rows.at(-1).id).props.disabled, false)
  assert.equal(app.requests.filter((request) => request.method === 'DELETE').length, 0)
  app.unmount()
})

test('Admin orders preserves issued invoices after cancellation or restoration even without verified payment', async () => {
  const rows = ['CANCELLED', 'PENDING', 'PROCESSING'].map((status, index) => order({
    id: `invoice-order-${index}`,
    status,
    verified: false,
    invoice: { id: index + 1, issuedAt: '2026-10-01T08:30:00Z' },
  }))
  const app = page(ordersFile, { queues: { '/api/admin/orders': [response(orderReport(rows))] } })
  await settle(); app.render()

  for (const row of rows) {
    const button = orderDelete(app, row.id)
    assert.equal(button.props.disabled, true)
    assert.match(button.props.title, /دارای فاکتور.*حفظ سابقه/)
    await button.props.onClick()
    assert.equal(app.confirmations.length, 0)
    assert.equal(app.requests.filter((request) => request.method === 'DELETE').length, 0)

    const tableRow = find(app, (node) => node.type === 'tr' && nodes(node).some((child) =>
      child.type === 'select' && child.props['aria-label'] === `وضعیت سفارش ${row.id.slice(-6)}`))
    const detailsToggle = nodes(tableRow).find((node) => node.type === 'button' && 'aria-expanded' in node.props)
    assert.ok(detailsToggle)
    detailsToggle.props.onClick(); app.render()

    const invoiceControl = find(app, (node) => node.type === 'InvoiceDownload')
    assert.ok(invoiceControl)
    assert.equal(invoiceControl.props.orderId, row.id)
    assert.equal(invoiceControl.props.status, row.status)
    assert.equal(invoiceControl.props.invoice, row.invoice)
  }
  app.unmount()
})

test('Admin orders offers only forward fulfillment states and valid cancelled restoration states', async () => {
  const rows = [order({ id: 'shipment', status: 'SHIPPED' }), order({ id: 'delivered', status: 'DELIVERED' }), order({ id: 'cancelled', status: 'CANCELLED' })]
  const app = page(ordersFile, { queues: { '/api/admin/orders': [response(orderReport(rows))] } })
  await settle(); app.render()
  assert.deepEqual(statusOptions(orderStatus(app, 'shipment')), ['SHIPPED', 'DELIVERED'])
  assert.deepEqual(statusOptions(orderStatus(app, 'delivered')), ['DELIVERED'])
  assert.deepEqual(statusOptions(orderStatus(app, 'cancelled')), ['CANCELLED', 'PENDING', 'PROCESSING'])
  app.unmount()
})

test('Admin orders labels a verified pending order as awaiting review rather than awaiting payment', async () => {
  const row = order({ verified: true })
  const app = page(ordersFile, { queues: { '/api/admin/orders': [response(orderReport([row]))] } })
  await settle(); app.render()
  const pending = nodes(orderStatus(app, row.id)).find((node) => node.type === 'option' && node.props.value === 'PENDING')
  assert.equal(text(pending), 'در انتظار بررسی')
  assert.match(text(app.tree), /پرداخت تأییدشده/)
  assert.ok(!text(pending).includes('پرداخت'))
  app.unmount()
})

for (const [label, failure] of [['offline', new TypeError('Failed to fetch')], ['HTTP failure', response({ error: 'Unavailable' }, 503)]]) {
  test(`Admin orders ${label} shows a retry that reloads the canonical order list`, async () => {
    const app = page(ordersFile, { queues: { '/api/admin/orders': [failure, response(orderReport([order()]))] } })
    await settle(); app.render()
    assert.ok(find(app, (node) => node.props.role === 'alert'))
    const button = find(app, (node) => node.type === 'button' && text(node) === 'بارگذاری دوباره')
    assert.ok(button)
    button.props.onClick(); app.render()
    await settle(); app.render()
    assert.ok(orderStatus(app, order().id))
    assert.ok(!find(app, (node) => node.props.role === 'alert'))
    assert.equal(app.requests.filter((request) => new URL(request.url, 'http://localhost').pathname === '/api/admin/orders').length, 2)
    app.unmount()
  })
}

test('An admin status conflict refreshes canonical fulfillment and payment state instead of applying the rejected choice', async () => {
  const original = order()
  const canonical = order({ status: 'DELIVERED', verified: true })
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [response(orderReport([original])), response(orderReport([canonical]))],
    [`PATCH /api/orders/${original.id}`]: [() => pending],
  } })
  await settle(); app.render()
  const update = orderStatus(app, original.id).props.onChange({ target: { value: 'CANCELLED' } })
  app.render()
  assert.equal(orderStatus(app, original.id).props.disabled, true)
  assert.equal(orderDelete(app, original.id).props.disabled, true)
  assert.equal(orderStatus(app, original.id).props.value, 'PENDING')
  finish(response({ error: 'وضعیت سفارش هم‌زمان تغییر کرده است' }, 409))
  await update; app.render()
  assert.equal(orderStatus(app, original.id).props.value, 'DELIVERED')
  assert.equal(orderStatus(app, original.id).props.disabled, false)
  assert.deepEqual(statusOptions(orderStatus(app, original.id)), ['DELIVERED'])
  assert.equal(orderDelete(app, original.id).props.disabled, true)
  assert.match(text(app.tree), /پرداخت تأییدشده/)
  assert.match(text(app.tree), /وضعیت سفارش هم‌زمان تغییر کرده است/)
  assert.equal(app.requests.filter((request) => new URL(request.url, 'http://localhost').pathname === '/api/admin/orders').length, 2)
  assert.deepEqual(JSON.parse(app.requests.find((request) => request.method === 'PATCH').body), { status: 'CANCELLED' })
  app.unmount()
})

test('A rejected admin status update retains its original state and displays the server reason', async () => {
  const row = order()
  const app = page(ordersFile, { queues: { [`PATCH /api/orders/${row.id}`]: [response({ error: 'پرداخت این سفارش تأیید نشده است' }, 400)] } })
  await settle(); app.render()
  await orderStatus(app, row.id).props.onChange({ target: { value: 'SHIPPED' } }); app.render()
  assert.equal(orderStatus(app, row.id).props.value, 'PENDING')
  assert.equal(orderStatus(app, row.id).props.disabled, false)
  assert.match(text(app.tree), /پرداخت این سفارش تأیید نشده است/)
  assert.equal(app.requests.filter((request) => new URL(request.url, 'http://localhost').pathname === '/api/admin/orders').length, 1)
  app.unmount()
})

test('An order deletion refused by the server preserves the row and shows its history protection error', async () => {
  const row = order()
  const app = page(ordersFile, { queues: { [`DELETE /api/orders/${row.id}`]: [response({ error: 'سابقه سفارش باید حفظ شود' }, 409)] } })
  await settle(); app.render()
  await orderDelete(app, row.id).props.onClick(); app.render()
  assert.ok(orderStatus(app, row.id))
  assert.equal(orderDelete(app, row.id).props.disabled, false)
  assert.match(text(app.tree), /سابقه سفارش باید حفظ شود/)
  app.unmount()
})


test('Changing an order filter aborts the previous read and ignores a stale response', async () => {
  let finish
  const delayed = new Promise((resolve) => { finish = resolve })
  const current = order({ id: 'current-processing', status: 'PROCESSING', verified: true })
  const stale = order({ id: 'stale-pending', status: 'PENDING' })
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [() => delayed, response(orderReport([current]))],
  } })
  await settle(); app.render()
  find(app, (node) => node.props.id === 'orders-status-filter').props.onChange({ target: { value: 'PROCESSING' } })
  app.render(); await settle(); app.render()
  assert.equal(app.requests[0].signal.aborted, true)
  const query = new URL(app.requests.at(-1).url, 'http://localhost').searchParams
  assert.equal(query.get('status'), 'PROCESSING')
  assert.equal(query.get('page'), '1')
  assert.ok(orderStatus(app, current.id))
  finish(response(orderReport([stale]))); await settle(); app.render()
  assert.ok(orderStatus(app, current.id))
  assert.ok(!orderStatus(app, stale.id))
  app.unmount()
})

test('Order search debounces edits and sends only the latest query to the server', async () => {
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [response(orderReport([order()])), response(orderReport([]))],
  } })
  await settle(); app.render()
  const search = () => find(app, (node) => node.type === 'input' && node.props.type === 'search')
  search().props.onChange({ target: { value: 'کفش' } }); app.render()
  search().props.onChange({ target: { value: 'کتانی' } }); app.render()
  assert.equal(app.requests.length, 1)
  app.flushTimers(); app.render(); await settle(); app.render()
  assert.equal(app.requests.length, 2)
  const query = new URL(app.requests.at(-1).url, 'http://localhost').searchParams
  assert.equal(query.get('q'), 'کتانی')
  assert.equal(query.get('page'), '1')
  assert.equal(search().props.value, 'کتانی')
  app.unmount()
})


test('Changing an order filter from a later page requests the first page', async () => {
  const first = order({ id: 'page-one' }), second = order({ id: 'page-two', status: 'SHIPPED' })
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [
      response(orderReport([first], { pagination: { page: 1, pageSize: 20, total: 41, pages: 3 } })),
      response(orderReport([second], { pagination: { page: 2, pageSize: 20, total: 41, pages: 3 } })),
      response(orderReport([second])),
    ],
  } })
  await settle(); app.render()
  find(app, (node) => node.props['aria-label'] === 'صفحهٔ بعد').props.onClick(); app.render()
  await settle(); app.render()
  assert.equal(new URL(app.requests.at(-1).url, 'http://localhost').searchParams.get('page'), '2')
  find(app, (node) => node.props.id === 'orders-status-filter').props.onChange({ target: { value: 'SHIPPED' } }); app.render()
  await settle(); app.render()
  const query = new URL(app.requests.at(-1).url, 'http://localhost').searchParams
  assert.equal(query.get('page'), '1')
  assert.equal(query.get('status'), 'SHIPPED')
  assert.ok(orderStatus(app, second.id))
  app.unmount()
})

test('A successful status change refreshes the active filter and removes an order that moved out', async () => {
  const row = order({ status: 'PROCESSING', verified: true })
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [response(orderReport([row])), response(orderReport([row])), response(orderReport([]))],
    ['PATCH /api/orders/' + row.id]: [response({ ...row, status: 'SHIPPED' })],
  } })
  await settle(); app.render()
  find(app, (node) => node.props.id === 'orders-status-filter').props.onChange({ target: { value: 'PROCESSING' } }); app.render()
  await settle(); app.render()
  await orderStatus(app, row.id).props.onChange({ target: { value: 'SHIPPED' } }); app.render()
  assert.equal(new URL(app.requests.at(-1).url, 'http://localhost').searchParams.get('status'), 'PROCESSING')
  assert.ok(!orderStatus(app, row.id))
  assert.match(text(app.tree), /سفارشی مطابق فیلترها پیدا نشد/)
  assert.equal(app.requests.filter((request) => request.method === 'PATCH').length, 1)
  app.unmount()
})

test('A confirmed status and issued invoice survive a failed summary refresh', async () => {
  const row = order(), invoice = { id: 99, issuedAt: '2026-10-08T08:00:00.000Z' }
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [response(orderReport([row])), response({ error: 'تازه‌سازی انجام نشد' }, 503)],
    ['PATCH /api/orders/' + row.id]: [response({ ...row, status: 'PROCESSING', invoice })],
  } })
  await settle(); app.render()
  await orderStatus(app, row.id).props.onChange({ target: { value: 'PROCESSING' } }); app.render()
  assert.equal(orderStatus(app, row.id).props.value, 'PROCESSING')
  assert.equal(orderDelete(app, row.id).props.disabled, true)
  assert.match(orderDelete(app, row.id).props.title, /دارای فاکتور/)
  assert.match(text(app.tree), /تازه‌سازی انجام نشد/)
  const toggle = find(app, (node) => node.type === 'button' && node.props['aria-expanded'] === false)
  toggle.props.onClick(); app.render()
  assert.equal(find(app, (node) => node.type === 'InvoiceDownload').props.invoice.id, invoice.id)
  assert.equal(app.requests.filter((request) => request.method === 'PATCH').length, 1)
  app.unmount()
})

test('Custom order dates remain drafts until a valid inclusive range is applied', async () => {
  const app = page(ordersFile, { queues: {
    '/api/admin/orders': [response(orderReport([order()])), response(orderReport([]))],
  } })
  await settle(); app.render()
  const field = (id) => find(app, (node) => node.props.id === id)
  field('orders-date-from').props.onChange({ target: { value: '2026-10-08' } })
  field('orders-date-to').props.onChange({ target: { value: '2026-10-01' } }); app.render()
  const submit = () => find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await submit(); app.render()
  assert.equal(app.requests.length, 1)
  assert.match(text(app.tree), /تاریخ شروع و پایان را به ترتیب/)
  field('orders-date-from').props.onChange({ target: { value: '2026-10-01' } })
  field('orders-date-to').props.onChange({ target: { value: '2026-10-08' } }); app.render()
  assert.equal(app.requests.length, 1)
  await submit(); app.render(); await settle(); app.render()
  const query = new URL(app.requests.at(-1).url, 'http://localhost').searchParams
  assert.equal(query.get('range'), 'custom')
  assert.equal(query.get('from'), '2026-10-01')
  assert.equal(query.get('to'), '2026-10-08')
  assert.ok(!text(app.tree).includes('تاریخ شروع و پایان را به ترتیب'))
  app.unmount()
})


const specificationNames = (app) => nodes(app.tree).filter((node) => node.type === 'input' && node.props.id?.startsWith('spec-name-'))
const specificationValues = (app) => nodes(app.tree).filter((node) => node.type === 'textarea' && node.props.id?.startsWith('spec-value-'))
const productForm = (app) => find(app, (node) => node.type === 'form')
const submitProduct = async (app) => { await productForm(app).props.onSubmit({ preventDefault() {} }); app.render() }
const buttonLabel = (app, label) => find(app, (node) => node.type === 'button' && node.props['aria-label'] === label)
async function editProductWithSpecifications(specifications, queues = {}) {
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([{ ...shoe, specifications }])], ...queues } })
  await settle(); app.render()
  find(app, (node) => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  return app
}

test('Admin loads, edits, reorders and removes specifications while preserving inventory concurrency behavior', async () => {
  const app = await editProductWithSpecifications([
    { name: 'برند', value: 'پانیک' }, { name: 'جنس رویه', value: 'ورنی' }, { name: 'ارتفاع پاشنه', value: '۱۰ سانتی‌متر' },
  ], { 'PUT /api/products/shoe-1': [response(shoe)] })
  const originalIds = specificationNames(app).map((node) => node.props.id)
  specificationValues(app)[1].props.onChange({ target: { value: '  ورنی مات  ' } }); app.render()
  buttonLabel(app, 'بالا بردن مشخصه 3').props.onClick(); app.render()
  assert.deepEqual(specificationNames(app).map((node) => node.props.id), [originalIds[0], originalIds[2], originalIds[1]])
  buttonLabel(app, 'حذف مشخصه 1').props.onClick(); app.render()
  specificationNames(app)[0].props.onChange({ target: { value: '  ارتفاع پاشنه  ' } }); app.render()
  await submitProduct(app)
  const saved = JSON.parse(app.requests.find((item) => item.method === 'PUT').body)
  assert.deepEqual(saved.specifications, [{ name: 'ارتفاع پاشنه', value: '۱۰ سانتی‌متر' }, { name: 'جنس رویه', value: 'ورنی مات' }])
  assert.equal(Object.hasOwn(saved, 'stock'), false)
  assert.equal(Object.hasOwn(saved, 'expectedStock'), false)
  app.unmount()
})

test('Admin adds presets and custom specifications without inventing a value', async () => {
  const app = await editProductWithSpecifications([], { 'PUT /api/products/shoe-1': [response(shoe)] })
  assert.equal(specificationNames(app).length, 0)
  find(app, (node) => node.type === 'button' && text(node) === 'برند').props.onClick(); app.render()
  assert.equal(specificationNames(app)[0].props.value, 'برند')
  assert.equal(specificationValues(app)[0].props.value, '')
  assert.equal(find(app, (node) => node.type === 'button' && text(node) === 'برند').props.disabled, true)
  specificationValues(app)[0].props.onChange({ target: { value: 'پانیک' } }); app.render()
  find(app, (node) => node.type === 'button' && text(node) === 'افزودن مشخصه').props.onClick(); app.render()
  specificationNames(app)[1].props.onChange({ target: { value: 'راهنمای سایز' } }); app.render()
  specificationValues(app)[1].props.onChange({ target: { value: 'قالب نیم‌سایز کوچک‌تر' } }); app.render()
  await submitProduct(app)
  assert.deepEqual(JSON.parse(app.requests.find((item) => item.method === 'PUT').body).specifications, [
    { name: 'برند', value: 'پانیک' }, { name: 'راهنمای سایز', value: 'قالب نیم‌سایز کوچک‌تر' },
  ])
  app.unmount()
})

for (const specifications of [
  [{ name: 'برند', value: '   ' }], [{ name: '  ', value: 'پانیک' }],
  [{ name: 'Brand', value: 'پانیک' }, { name: ' brand ', value: 'نمونه' }],
  [{ name: 'Brand', value: 'پانیک' }, { name: 'Ｂｒａｎｄ', value: 'نمونه' }],
  [{ name: 'نام'.repeat(41), value: 'مقدار' }], [{ name: 'نام', value: 'v'.repeat(501) }],
]) {
  test('Admin rejects incomplete, repeated or oversized specifications before saving: ' + JSON.stringify(specifications).slice(0, 90), async () => {
    const app = await editProductWithSpecifications(specifications)
    await submitProduct(app)
    assert.ok(find(app, (node) => node.props.role === 'alert'))
    assert.ok(find(app, (node) => node.props.role === 'dialog'))
    assert.equal(app.requests.filter((item) => item.method === 'PUT' || item.method === 'POST').length, 0)
    app.unmount()
  })
}

test('Removing the last specification explicitly clears the saved list', async () => {
  const app = await editProductWithSpecifications([{ name: 'برند', value: 'پانیک' }], { 'PUT /api/products/shoe-1': [response(shoe)] })
  buttonLabel(app, 'حذف مشخصه 1').props.onClick(); app.render()
  await submitProduct(app)
  assert.deepEqual(JSON.parse(app.requests.find((item) => item.method === 'PUT').body).specifications, [])
  app.unmount()
})

test('Specification limit and reorder boundaries cannot add or lose rows', async () => {
  const app = await editProductWithSpecifications(Array.from({ length: 30 }, (_, index) => ({ name: 'مشخصه ' + index, value: 'مقدار ' + index })))
  const add = find(app, (node) => node.type === 'button' && text(node) === 'افزودن مشخصه')
  assert.equal(add.props.disabled, true)
  add.props.onClick(); app.render()
  assert.equal(specificationNames(app).length, 30)
  assert.equal(buttonLabel(app, 'بالا بردن مشخصه 1').props.disabled, true)
  buttonLabel(app, 'بالا بردن مشخصه 1').props.onClick(); app.render()
  assert.equal(specificationNames(app)[0].props.value, 'مشخصه 0')
  assert.equal(buttonLabel(app, 'پایین بردن مشخصه 30').props.disabled, true)
  assert.equal(specificationNames(app).length, 30)
  app.unmount()
})

test('Specification validation errors from the server keep edited values available for correction', async () => {
  const app = await editProductWithSpecifications([{ name: 'جنس رویه', value: 'ورنی' }], {
    'PUT /api/products/shoe-1': [response({ error: 'ذخیره مشخصات انجام نشد' }, 400)],
  })
  specificationValues(app)[0].props.onChange({ target: { value: 'ورنی مات' } }); app.render()
  await submitProduct(app)
  assert.match(text(app.tree), /ذخیره مشخصات انجام نشد/)
  assert.equal(specificationValues(app)[0].props.value, 'ورنی مات')
  assert.ok(find(app, (node) => node.props.role === 'dialog'))
  app.unmount()
})

const sortSelect = (app) => find(app, (node) => node.type === 'select' && node.props['aria-label'] === 'مرتب‌سازی محصولات')
const sortedProducts = [
  { ...shoe, id: 'latest', ratingAverage: 4, ratingCount: 2, viewCount: 10 },
  { ...shoe, id: 'more-reviews', ratingAverage: 4, ratingCount: 9, viewCount: 50 },
  { ...shoe, id: 'highest-rated', ratingAverage: 5, ratingCount: 1, viewCount: 15 },
  { ...shoe, id: 'most-viewed', ratingAverage: 3, ratingCount: 1, viewCount: 100 },
  { ...shoe, id: 'stable-rated-tie', ratingAverage: 4, ratingCount: 9, viewCount: 50 },
  { ...shoe, id: 'no-feedback', ratingAverage: 0, ratingCount: 0, viewCount: 0 },
]

for (const [sort, expected] of [
  ['popular', ['highest-rated', 'more-reviews', 'stable-rated-tie', 'latest', 'most-viewed', 'no-feedback']],
  ['views', ['most-viewed', 'more-reviews', 'stable-rated-tie', 'highest-rated', 'latest', 'no-feedback']],
]) {
  test('Catalog supports bookmarked ' + sort + ' sorting, stable ties and approved rating values on cards', async () => {
    const app = page(undefined, { search: '?sort=' + sort + '&stock=1', queues: { '/api/products': [response(sortedProducts)] } })
    await settle(); app.render()
    assert.deepEqual(cards(app).map((node) => node.props.product.id), expected)
    assert.equal(sortSelect(app).props.value, sort)
    assert.equal(cards(app)[0].props.product.ratingAverage, sortedProducts.find((product) => product.id === expected[0]).ratingAverage)
    assert.equal(cards(app)[0].props.product.ratingCount, sortedProducts.find((product) => product.id === expected[0]).ratingCount)
    assert.ok(nodes(sortSelect(app)).some((node) => node.type === 'option' && node.props.value === 'popular' && text(node) === 'محبوب‌ترین'))
    assert.ok(nodes(sortSelect(app)).some((node) => node.type === 'option' && node.props.value === 'views' && text(node) === 'پربازدیدترین'))
    app.unmount()
  })
}

test('Changing sort preserves other URL filters and returning to newest restores API order', async () => {
  const app = page(undefined, { search: '?cat=cat-1&q=TRAIL&min=1&max=500000&stock=1', queues: { '/api/products': [response(sortedProducts)] } })
  await settle(); app.render()
  sortSelect(app).props.onChange({ target: { value: 'popular' } }); app.render()
  const changed = new URLSearchParams(app.location.search)
  assert.equal(changed.get('sort'), 'popular')
  for (const [key, value] of [['cat', 'cat-1'], ['q', 'TRAIL'], ['min', '1'], ['max', '500000'], ['stock', '1']]) assert.equal(changed.get(key), value)
  sortSelect(app).props.onChange({ target: { value: 'newest' } }); app.render()
  assert.equal(new URLSearchParams(app.location.search).has('sort'), false)
  assert.deepEqual(cards(app).map((node) => node.props.product.id), sortedProducts.map((product) => product.id))
  assert.equal(app.requests.length, 2)
  app.unmount()
})

test('Legacy catalog products without metrics retain their order and display zero feedback', async () => {
  const app = page(undefined, { search: '?sort=popular', queues: { '/api/products': [response([{ ...shoe, id: 'legacy-first' }, { ...shoe, id: 'legacy-second' }])] } })
  await settle(); app.render()
  assert.deepEqual(cards(app).map((node) => node.props.product.id), ['legacy-first', 'legacy-second'])
  assert.equal(cards(app)[0].props.product.ratingAverage, 0)
  assert.equal(cards(app)[0].props.product.ratingCount, 0)
  app.unmount()
})
