const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const pricingModule = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/pricing.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: pricingModule, Date })
const localizedInputModule = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/localized-input.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: localizedInputModule })
const contactModule = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/customer-contact.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: contactModule })
const bulkOrderContract = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/admin-order-bulk-contract.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: bulkOrderContract })
const bulkPriceContract = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/product-price-bulk-contract.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: bulkPriceContract })

// Execute the real page handlers with hook and fetch doubles. No server or DB is contacted.
const shoe = { id: 'shoe-1', code: 'PANIK-00622', name: 'کفش آدیداس', slug: 'adidas-ultra', description: 'Lightweight trail runner', price: 100000, images: [], stock: 5, inventoryConfigured: true, inventoryVersion: 1, variants: [{ id: 'variant-1', size: 42, color: 'سبز', stock: 5, isActive: true }], sizes: [42], colors: ['سبز'], featured: false, categoryId: 'cat-1', category: { name: 'کتانی' } }
const category = { id: 'cat-1', name: 'کتانی', slug: 'sneaker', image: null, _count: { products: 0 } }
const user = { id: 'user-1', name: 'مشتری نمونه', email: 'customer@example.test', phone: null, role: 'USER', _count: { orders: 1 } }
const order = (overrides = {}) => ({ id: 'order-pending', total: 150000, shippingMethodName: 'پست پیشتاز', shippingCost: 50000, status: 'PENDING', verified: false, recipientName: 'گیرنده نمونه', address: 'نشانی نمونه', phone: '09123456789', createdAt: '2026-10-01T08:00:00Z', user: { name: user.name, email: user.email }, items: [{ id: 'line-1', quantity: 1, size: 42, color: 'سبز', price: 100000, product: { name: shoe.name } }], ...overrides })
const settle = () => new Promise(setImmediate)
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const catalogEndpoint = '/api/catalog/products'
const catalogPage = (items, overrides = {}) => ({
  items, total: items.length, page: 1, hasMore: false, nextPriceChangeAt: null,
  pricedAt: new Date().toISOString(), ...overrides,
})
const orderReport = (orders, overrides = {}) => ({
  orders, pagination: { page: 1, pageSize: 20, total: orders.length, pages: 1 },
  dashboard: { date: '2026-10-08', timeZone: 'Asia/Tehran', todayOrders: orders.length, todayPaidOrders: 0, todayPaidTotal: 0, awaitingReview: 0, readyToShip: 0 },
  generatedAt: '2026-10-08T08:00:00.000Z', ...overrides,
})

function page(file = 'src/app/(shop)/products/page.tsx', { queues = {}, search = '', autoLoad = false } = {}) {
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
  const scrollTrigger = { id: 'catalog-scroll-trigger' }
  const observers = []
  if (autoLoad) {
    window.IntersectionObserver = class {
      constructor(callback) {
        this.callback = callback
        this.targets = new Set()
        observers.push(this)
      }
      observe(target) { this.targets.add(target) }
      unobserve(target) { this.targets.delete(target) }
      disconnect() { this.targets.clear() }
      notify(isIntersecting) { this.callback([{ target: scrollTrigger, isIntersecting }], this) }
    }
  }
  const defaults = { '/api/products': [shoe], [catalogEndpoint]: catalogPage([shoe]), '/api/categories': [category], '/api/users': [user], '/api/admin/orders': orderReport([order()]) }
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
    '@/components/admin/OrderDocumentsPrint': { __esModule: true, default: 'OrderDocumentsPrint' },
    '@/components/admin/MultiImageInput': { __esModule: true, default: 'MultiImageInput' },
    '@/components/admin/ProductPriceBulk': { __esModule: true, default: 'ProductPriceBulk' },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', { ...props, 'data-enhanced-select': true }) },
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: ({ onValueChange, ...props }) => jsx('input', { ...props, type: 'text', 'data-formatted-number': true, onChange: event => onValueChange(event.target.value) }) },
    '@/components/ui/PersianDatePicker': { __esModule: true, default: ({ onChange, ...props }) => jsx('input', { ...props, type: 'text', 'data-persian-date': true, onChange: event => onChange(event.target.value) }) },
    '@/lib/utils': { formatPrice: (value) => String(value) },
    '@/lib/pricing': pricingModule.exports,
    '@/lib/localized-input': localizedInputModule.exports,
    '@/lib/customer-contact': contactModule.exports,
    '@/lib/admin-order-bulk-contract': bulkOrderContract.exports,
    '@/lib/product-price-bulk-contract': bulkPriceContract.exports,
    '@/lib/session-actions': { signOutWithSessionLock: async () => {} },
    '@/components/shop/commerce.module.css': css,
    '@/components/admin/admin.module.css': css,
  }
  // Exercise page selection handlers through the shared control's unchanged
  // native change-event contract; its desktop/mobile rendering has its own suite.
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  const context = {
    module: { exports: {} }, AbortController, Error, TypeError, URLSearchParams, fetch, window,
    IntersectionObserver: window.IntersectionObserver,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    confirm: (message) => { confirmations.push(message); return true },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(code, context)
  function render() {
    cursor = 0
    tree = context.module.exports.default()
    // React sets DOM refs before the effect that starts observing the trigger.
    const ref = nodes(tree).find(node => node.props.id === scrollTrigger.id)?.props.ref
    if (typeof ref === 'function') ref(scrollTrigger)
    else if (ref) ref.current = scrollTrigger
    pendingEffects.splice(0).forEach((effect) => effect())
    return tree
  }
  render()
  return {
    render, requests, confirmations, location,
    get scrollObserver() { return observers.findLast(observer => observer.targets.has(scrollTrigger)) },
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
const loadMore = (app) => find(app, (node) => node.type === 'button' && text(node).includes('نمایش محصولات بیشتر'))
const catalogRequests = (app) => app.requests.filter((request) => request.url.split('?')[0] === catalogEndpoint)
const requestParams = (request) => Object.fromEntries(new URL(request.url, 'http://localhost').searchParams)

test('Order printing shares selection with status tools, carries complete filters, and locks stale page handlers', async () => {
  const app = page('src/app/admin/orders/page.tsx')
  await settle(); app.render()
  find(app, node => node.type === 'button' && text(node) === 'چاپ دسته‌ای مدارک').props.onClick(); app.render()
  const selected = find(app, node => node.type === 'input' && node.props['aria-label'] === `انتخاب سفارش ${order().id.slice(-6)}`)
  selected.props.onChange(); app.render()
  let panel = find(app, node => node.type === 'OrderDocumentsPrint')
  assert.equal(panel.props.open, true)
  assert.deepEqual(Array.from(panel.props.selectedIds), [order().id])
  assert.equal(new URLSearchParams(panel.props.filterQuery).has('page'), false)
  assert.equal(new URLSearchParams(panel.props.filterQuery).has('pageSize'), false)
  const oldDelete = find(app, node => node.type === 'button' && node.props['aria-label'] === `حذف سفارش ${order().id.slice(-6)}`)
  const oldSearch = find(app, node => node.props.id === 'orders-search')
  const oldRefresh = find(app, node => node.type === 'button' && text(node).includes('تازه‌سازی'))
  const requestCount = app.requests.length
  panel.props.onBusyChange(true)
  selected.props.onChange(); oldSearch.props.onChange({ target: { value: 'different buyer' } }); oldRefresh.props.onClick()
  assert.ok(oldDelete)
  await oldDelete.props.onClick()
  app.render()
  assert.equal(app.requests.length, requestCount, 'Locked stale handlers cannot mutate or reload the order list')
  assert.equal(find(app, node => node.props.id === 'orders-search').props.value, '')
  assert.deepEqual(Array.from(find(app, node => node.type === 'OrderDocumentsPrint').props.selectedIds), [order().id])
  panel.props.onBusyChange(false); app.render()
  find(app, node => node.type === 'button' && text(node) === 'تغییر گروهی وضعیت').props.onClick(); app.render()
  assert.equal(find(app, node => node.type === 'OrderDocumentsPrint').props.open, false)
  find(app, node => node.type === 'button' && text(node) === 'چاپ دسته‌ای مدارک').props.onClick(); app.render()
  panel = find(app, node => node.type === 'OrderDocumentsPrint')
  assert.deepEqual(Array.from(panel.props.selectedIds), [order().id], 'Switching tools preserves deliberate selection')
  panel.props.onClearSelection(); app.render()
  assert.equal(find(app, node => node.type === 'OrderDocumentsPrint').props.selectedIds.length, 0)
  app.unmount()
})

test('Bulk prices selects exactly the current category/search results and shows selections outside the filter', async () => {
  const other = { ...shoe, id: 'shoe-2', code: 'PANIK-00620', name: 'لوفر', categoryId: 'cat-2' }
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([shoe, other])], '/api/categories': [response([category, { id: 'cat-2', name: 'رسمی' }])] } })
  await settle(); app.render()
  find(app, node => node.type === 'input' && node.props['aria-label'] === `انتخاب ${other.name}، کد ${other.code}`).props.onChange({ target: { checked: true } }); app.render()
  find(app, node => node.props['aria-label'] === 'فیلتر دسته‌بندی محصولات').props.onChange({ target: { value: category.id } }); app.render()
  assert.match(text(app.tree), /۱ انتخاب خارج از فیلتر فعلی/)
  find(app, node => node.type === 'button' && text(node) === 'انتخاب همه نتایج فیلتر').props.onClick(); app.render()
  assert.deepEqual(Array.from(find(app, node => node.type === 'ProductPriceBulk').props.selectedIds), [shoe.id])
  find(app, node => node.props['aria-label'] === 'جستجو با نام یا کد محصول').props.onChange({ target: { value: '۰۰۶۲۰' } }); app.render()
  assert.equal(nodes(app.tree).filter(node => node.props.title === 'ویرایش').length, 0, 'Search and category must be combined')
  assert.equal(find(app, node => node.type === 'button' && text(node) === 'انتخاب همه نتایج فیلتر').props.disabled, true)
  app.unmount()
})

test('Bulk prices refuses oversized filtered selection instead of silently selecting a truncated set', async () => {
  const products = Array.from({ length: 201 }, (_, index) => ({ ...shoe, id: `shoe-${index}`, code: `PANIK-${index}` }))
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response(products)] } })
  await settle(); app.render()
  const select = find(app, node => node.type === 'button' && text(node) === 'انتخاب همه نتایج فیلتر')
  assert.equal(select.props.disabled, true)
  select.props.onClick(); app.render()
  assert.equal(find(app, node => node.type === 'ProductPriceBulk').props.selectedIds.length, 0)
  assert.match(text(app.tree), /نتایج بیشتر از ۲۰۰ محصول است/)
  app.unmount()
})

test('Bulk prices locks product edits and selection synchronously, then refreshes canonical products after saving', async () => {
  const fresh = { ...shoe, price: 110000, pricingVersion: 1 }
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([shoe]), response([fresh])] } })
  await settle(); app.render()
  const oldEdit = find(app, node => node.props.title === 'ویرایش')
  const oldSelect = find(app, node => node.type === 'button' && text(node) === 'انتخاب همه نتایج فیلتر')
  let panel = find(app, node => node.type === 'ProductPriceBulk')
  panel.props.onBusyChange(true)
  oldEdit.props.onClick(); oldSelect.props.onClick(); app.render()
  assert.equal(find(app, node => node.type === 'form'), undefined)
  assert.equal(find(app, node => node.type === 'ProductPriceBulk').props.selectedIds.length, 0)
  assert.equal(find(app, node => node.props.title === 'ویرایش').props.disabled, true)
  panel.props.onBusyChange(false)
  panel.props.onCompleted(); app.render(); await settle(); app.render()
  panel = find(app, node => node.type === 'ProductPriceBulk')
  assert.equal(panel.props.products[0].price, fresh.price)
  assert.equal(panel.props.products[0].pricingVersion, 1)
  assert.equal(app.requests.filter(request => request.url === '/api/products').length, 2)
  assert.equal(app.requests.some(request => request.method === 'PUT' || request.method === 'DELETE'), false)
  app.unmount()
})

test('Individual price edits include the pricing revision from the original product snapshot', async () => {
  const versioned = { ...shoe, pricingVersion: 7 }
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([versioned])], 'PUT /api/products/shoe-1': [response({ ...versioned, price: 120000, pricingVersion: 8 })] } })
  await settle(); app.render()
  find(app, node => node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, node => node.type === 'input' && node.props['data-formatted-number'] && node.props.value === '100000').props.onChange({ target: { value: '120000' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const saved = JSON.parse(app.requests.find(request => request.method === 'PUT').body)
  assert.equal(saved.expectedPricing.pricingVersion, 7)
  assert.equal(saved.expectedPricing.price, 100000)
  app.unmount()
})

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
  assert.equal(Object.hasOwn(saved, 'code'), false, 'Unrelated edits must not overwrite a code changed by another admin')
  assert.equal(Object.hasOwn(saved, 'stock'), false)
  assert.equal(Object.hasOwn(saved, 'expectedStock'), false)
  app.unmount()
})

for (const search of ['panik-00622', 'PANIK-۰۰۶۲۲', 'panik-٠٠٦٢٢', '  00622  ']) {
  test('Admin finds a product by its code with equivalent digits and case: ' + search, async () => {
    const app = page('src/app/admin/products/page.tsx')
    await settle(); app.render()
    find(app, node => node.type === 'input' && node.props['aria-label'] === 'جستجو با نام یا کد محصول').props.onChange({ target: { value: search } }); app.render()
    assert.equal(nodes(app.tree).filter(node => node.type === 'button' && node.props.title === 'ویرایش').length, 1)
    assert.ok(text(app.tree).includes(shoe.code))
    app.unmount()
  })
}

test('Admin normalizes a changed product code, preserves leading zeros and omits unchanged inventory and pricing', async () => {
  const app = page('src/app/admin/products/page.tsx', { queues: { 'PUT /api/products/shoe-1': [response(shoe)] } })
  await settle(); app.render()
  find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  const field = find(app, node => node.props.id === 'product-code')
  assert.equal(field.props.type, 'text')
  assert.equal(field.props.required, true)
  assert.equal(field.props.dir, 'ltr')
  field.props.onChange({ target: { value: '  panik-۰۰۰۶۲۰  ' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const saved = JSON.parse(app.requests.find(item => item.method === 'PUT').body)
  assert.equal(saved.code, 'PANIK-000620')
  for (const key of ['price', 'expectedPricing', 'variants', 'expectedInventoryVersion']) assert.equal(Object.hasOwn(saved, key), false, key)
  app.unmount()
})

for (const code of ['', '  ', 'کد-622', 'PANIK 622', 'x'.repeat(65), 'ß', 'ß'.repeat(65)]) {
  test('Admin rejects an invalid product code without losing the form: ' + JSON.stringify(code).slice(0, 80), async () => {
    const app = page('src/app/admin/products/page.tsx')
    await settle(); app.render()
    find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
    find(app, node => node.props.id === 'product-code').props.onChange({ target: { value: code } }); app.render()
    await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
    assert.equal(app.requests.filter(item => item.method === 'PUT').length, 0)
    assert.ok(find(app, node => node.props.role === 'alert'))
    assert.equal(find(app, node => node.props.id === 'product-code').props.value, code)
    app.unmount()
  })
}

test('A duplicate-code response preserves the draft and lets the admin correct only the code', async () => {
  const app = page('src/app/admin/products/page.tsx', { queues: { 'PUT /api/products/shoe-1': [response({ error: 'این کد محصول قبلاً ثبت شده است.', code: 'PRODUCT_CODE_EXISTS' }, 409), response(shoe)] } })
  await settle(); app.render()
  find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, node => node.type === 'input' && node.props.value === shoe.name).props.onChange({ target: { value: 'نام اصلاح‌شده' } }); app.render()
  find(app, node => node.props.id === 'product-code').props.onChange({ target: { value: 'taken-622' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
  assert.ok(find(app, node => node.props.role === 'dialog'))
  assert.match(text(app.tree), /این کد محصول قبلاً ثبت شده است/)
  assert.equal(find(app, node => node.props.id === 'product-code').props.value, 'taken-622')
  assert.ok(find(app, node => node.type === 'input' && node.props.value === 'نام اصلاح‌شده'))
  find(app, node => node.props.id === 'product-code').props.onChange({ target: { value: 'new-622' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
  const saved = JSON.parse(app.requests.filter(item => item.method === 'PUT')[1].body)
  assert.equal(saved.code, 'NEW-622')
  assert.equal(saved.name, 'نام اصلاح‌شده')
  app.unmount()
})

test('Creating a product requires and includes its admin-defined code without a numeric conversion', async () => {
  const app = page('src/app/admin/products/page.tsx', { queues: { 'POST /api/products': [response(shoe)] } })
  await settle(); app.render()
  find(app, node => node.type === 'button' && text(node).includes('محصول جدید')).props.onClick(); app.render()
  assert.equal(find(app, node => node.props.id === 'product-code').props.value, '')
  find(app, node => node.props.id === 'product-code').props.onChange({ target: { value: '۰۰۶۲۲' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(JSON.parse(app.requests.find(item => item.method === 'POST').body).code, '00622')
  app.unmount()
})

test('An intentional inventory edit carries its original count and conflict recovery preserves other changes', async () => {
  const app = page('src/app/admin/products/page.tsx', { queues: {
    'PUT /api/products/shoe-1': [response({ code: 'PRODUCT_INVENTORY_CHANGED', error: 'موجودی تغییر کرده است' }, 409), response(shoe)],
    'GET /api/products/shoe-1': [response({ ...shoe, stock: 4, inventoryVersion: 2, variants: [{ ...shoe.variants[0], stock: 4 }] })],
  } })
  await settle(); app.render()
  find(app, (node) => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, (node) => node.type === 'input' && node.props.value === shoe.name).props.onChange({ target: { value: 'New product name' } }); app.render()
  find(app, (node) => node.type === 'input' && node.props.value === String(shoe.stock)).props.onChange({ target: { value: '9' } }); app.render()
  await find(app, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
  assert.equal(JSON.parse(app.requests.find((item) => item.method === 'PUT').body).expectedInventoryVersion, 1)
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
  assert.deepEqual(saved.variants, [{ size: 42, color: 'سبز', stock: 8 }])
  assert.equal(saved.expectedInventoryVersion, 2)
  assert.equal(Object.hasOwn(saved, 'stock'), false)
  assert.equal(Object.hasOwn(saved, 'expectedStock'), false)
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

test('Listing keeps results found by the server even when the query matches only an internal product code', async () => {
  const app = page(undefined, { search: '?q=' + encodeURIComponent(' ۰۰۶۲۲ ') })
  await settle(); app.render()
  assert.deepEqual(requestParams(catalogRequests(app)[0]), { q: '۰۰۶۲۲', page: '1' })
  assert.deepEqual(cards(app).map((node) => node.props.product.id), [shoe.id])
  assert.ok(!app.requests.some((request) => request.url === '/api/products'))
  app.unmount()
})

for (const [label, failure] of [
  ['network failure', new TypeError('Failed to fetch')],
  ['HTTP failure', response({ error: 'سرور در دسترس نیست' }, 503)],
  ['invalid JSON data', response({ unexpected: true })],
]) {
  test(`Listing ${label} displays an error and retries while preserving URL filters`, async () => {
    const app = page(undefined, { search: '?q=TRAIL&stock=1', queues: { [catalogEndpoint]: [failure, response(catalogPage([shoe]))] } })
    await settle(); app.render()
    assert.match(text(app.tree), /ویترین فعلاً در دسترس نیست/)
    assert.ok(find(app, (node) => node.props.role === 'alert'))
    assert.ok(!text(app.tree).includes('هنوز محصولی ثبت نشده است'))
    assert.equal(cards(app).length, 0)
    retry(app).props.onClick(); app.render()
    await settle(); app.render()
    assert.equal(cards(app).length, 1)
    assert.equal(app.location.search, '?q=TRAIL&stock=1')
    assert.deepEqual(catalogRequests(app).map(requestParams), [
      { q: 'TRAIL', stock: '1', page: '1' },
      { q: 'TRAIL', stock: '1', page: '1' },
    ])
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
    const endpoint = file.includes('(shop)') ? catalogEndpoint : file.includes('categories') ? '/api/categories' : file.includes('users') ? '/api/users' : '/api/products'
    let finish
    const delayed = new Promise((resolve) => { finish = resolve })
    const app = page(file, { queues: { [endpoint]: [() => delayed] } })
    const writes = app.stateWrites
    app.unmount()
    assert.ok(app.requests.every((request) => request.signal.aborted))
    const data = endpoint === catalogEndpoint ? catalogPage([shoe]) : endpoint === '/api/users' ? [user] : endpoint === '/api/categories' ? [category] : [shoe]
    finish(response(data))
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
  const toggle = find(app, (node) => node.type === 'button' && node.props.className?.includes('detailsButton') && node.props['aria-expanded'] === false)
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
  assert.equal(nodes(app.tree).filter(node => node.props['data-persian-date']).length, 2)
  assert.ok(!text(app.tree).includes('میلادی'))
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

for (const [sort, label, expected] of [
  ['popular', 'محبوب‌ترین', ['highest-rated', 'more-reviews', 'stable-rated-tie', 'latest', 'most-viewed', 'no-feedback']],
  ['views', 'پربازدیدترین', ['most-viewed', 'more-reviews', 'stable-rated-tie', 'highest-rated', 'latest', 'no-feedback']],
  ['bestselling', 'پرفروش‌ترین', ['no-feedback', 'latest', 'most-viewed', 'highest-rated', 'more-reviews', 'stable-rated-tie']],
]) {
  test('Catalog sends bookmarked ' + sort + ' sorting and preserves the server order and rating values', async () => {
    const rows = expected.map((id) => sortedProducts.find((product) => product.id === id))
    const app = page(undefined, { search: '?sort=' + sort + '&stock=1', queues: { [catalogEndpoint]: [response(catalogPage(rows))] } })
    await settle(); app.render()
    assert.deepEqual(requestParams(catalogRequests(app)[0]), { sort, stock: '1', page: '1' })
    assert.deepEqual(cards(app).map((node) => node.props.product.id), expected)
    assert.equal(sortSelect(app).props.value, sort)
    assert.equal(cards(app)[0].props.product.ratingAverage, sortedProducts.find((product) => product.id === expected[0]).ratingAverage)
    assert.equal(cards(app)[0].props.product.ratingCount, sortedProducts.find((product) => product.id === expected[0]).ratingCount)
    assert.ok(nodes(sortSelect(app)).some((node) => node.type === 'option' && node.props.value === sort && text(node) === label))
    app.unmount()
  })
}

test('Changing sort preserves other URL filters and requests newest results again when reset', async () => {
  const popular = [sortedProducts[2], sortedProducts[0]]
  const app = page(undefined, { search: '?cat=cat-1&q=TRAIL&min=1&max=500000&stock=1', queues: { [catalogEndpoint]: [
    response(catalogPage(sortedProducts)), response(catalogPage(popular)), response(catalogPage(sortedProducts)),
  ] } })
  await settle(); app.render()
  sortSelect(app).props.onChange({ target: { value: 'popular' } }); app.render()
  await settle(); app.render()
  const changed = new URLSearchParams(app.location.search)
  assert.equal(changed.get('sort'), 'popular')
  const filters = { cat: 'cat-1', q: 'TRAIL', min: '1', max: '500000', stock: '1' }
  for (const [key, value] of Object.entries(filters)) assert.equal(changed.get(key), value)
  assert.deepEqual(cards(app).map((node) => node.props.product.id), popular.map((product) => product.id))
  sortSelect(app).props.onChange({ target: { value: 'newest' } }); app.render()
  await settle(); app.render()
  assert.equal(new URLSearchParams(app.location.search).has('sort'), false)
  assert.deepEqual(cards(app).map((node) => node.props.product.id), sortedProducts.map((product) => product.id))
  assert.deepEqual(catalogRequests(app).map(requestParams), [
    { ...filters, page: '1' },
    { ...filters, sort: 'popular', page: '1' },
    { ...filters, page: '1' },
  ])
  app.unmount()
})

test('Legacy catalog products without metrics retain their order and display zero feedback', async () => {
  const app = page(undefined, { search: '?sort=popular', queues: { [catalogEndpoint]: [response(catalogPage([{ ...shoe, id: 'legacy-first' }, { ...shoe, id: 'legacy-second' }]))] } })
  await settle(); app.render()
  assert.deepEqual(cards(app).map((node) => node.props.product.id), ['legacy-first', 'legacy-second'])
  assert.equal(cards(app)[0].props.product.ratingAverage, 0)
  assert.equal(cards(app)[0].props.product.ratingCount, 0)
  app.unmount()
})

test('Server-filtered sale results preserve the original price for the product card', async () => {
  const active = { ...shoe, id: 'active', price: 300000, salePrice: 50000 }
  const app = page(undefined, {
    search: '?sort=cheap&min=40000&max=60000',
    queues: { [catalogEndpoint]: [response(catalogPage([active]))] },
  })
  await settle(); app.render()
  assert.deepEqual(requestParams(catalogRequests(app)[0]), { sort: 'cheap', min: '40000', max: '60000', page: '1' })
  assert.equal(cards(app).length, 1)
  assert.equal(cards(app)[0].props.product.price, 300000)
  assert.equal(cards(app)[0].props.product.salePrice, 50000)
  app.unmount()
})

test('Opening a sale can refresh an empty price-filtered listing and bring in a newly matching product', async () => {
  const onSale = { ...shoe, id: 'on-sale', price: 300000, salePrice: 50000 }
  const now = Date.now()
  const app = page(undefined, {
    search: '?min=40000&max=60000',
    queues: { [catalogEndpoint]: [
      response(catalogPage([], {
        pricedAt: new Date(now).toISOString(),
        nextPriceChangeAt: new Date(now + 60000).toISOString(),
      })),
      response(catalogPage([onSale])),
    ] },
  })
  await settle(); app.render()
  assert.equal(cards(app).length, 0)
  assert.equal(catalogRequests(app).length, 1)

  app.flushTimers(); app.render(); await settle(); app.render()
  assert.deepEqual(catalogRequests(app).map(requestParams), [
    { min: '40000', max: '60000', page: '1' },
    { min: '40000', max: '60000', page: '1' },
  ])
  assert.deepEqual(cards(app).map((node) => node.props.product.id), [onSale.id])
  app.unmount()
})

test('Listing debounces typing and renders a dedicated empty result state for unmatched searches', async () => {
  const app = page(undefined, {
    queues: { [catalogEndpoint]: [response(catalogPage([shoe])), response(catalogPage([]))] },
  })
  await settle(); app.render()
  const search = () => find(app, (node) => node.props['aria-label'] === 'جستجوی محصولات')
  search().props.onChange({ target: { value: 'کفش' } }); app.render()
  search().props.onChange({ target: { value: 'کتانی' } }); app.render()
  assert.equal(catalogRequests(app).length, 1)
  app.flushTimers(); app.render(); await settle(); app.render()
  assert.deepEqual(catalogRequests(app).map(requestParams), [{ page: '1' }, { q: 'کتانی', page: '1' }])
  assert.equal(search().props.value, 'کتانی')
  assert.equal(cards(app).length, 0)
  assert.match(text(app.tree), /این ترکیب، نتیجه‌ای نداشت/)
  assert.doesNotMatch(text(app.tree), /هنوز محصولی ثبت نشده است/)
  app.unmount()
})

const firstBatch = Array.from({ length: 24 }, (_, index) => ({ ...shoe, id: `first-${index}` }))

test('More products reports the total before all cards load and appends only unique products after retry', async () => {
  const moreProducts = [{ ...shoe, id: 'new-first' }, { ...shoe, id: 'new-second' }]
  const app = page(undefined, {
    search: '?cat=cat-1&stock=1',
    queues: { [catalogEndpoint]: [
      response(catalogPage(firstBatch, { total: 26, hasMore: true })),
      response({ error: 'صفحهٔ بعد در دسترس نیست' }, 503),
      response(catalogPage([firstBatch.at(-1), ...moreProducts], { total: 26, page: 2 })),
    ] },
  })
  await settle(); app.render()
  assert.equal(cards(app).length, 24)
  assert.match(text(app.tree), /۲۶ مدل/)

  const clickMore = loadMore(app).props.onClick
  clickMore(); clickMore(); app.render()
  await settle(); app.render()
  assert.equal(catalogRequests(app).length, 2, 'Repeated clicks must not request the same page twice')
  assert.match(text(app.tree), /صفحهٔ بعد در دسترس نیست/)
  assert.equal(cards(app).length, 24)

  retry(app).props.onClick(); app.render()
  await settle(); app.render()
  assert.deepEqual(catalogRequests(app).map(requestParams), [
    { cat: 'cat-1', stock: '1', page: '1' },
    { cat: 'cat-1', stock: '1', page: '2' },
    { cat: 'cat-1', stock: '1', page: '2' },
  ])
  assert.deepEqual(cards(app).map((node) => node.props.product.id), [...firstBatch, ...moreProducts].map(({ id }) => id))
  assert.ok(!loadMore(app))
  app.unmount()
})

test('Changing a filter while more products load cancels the old request and replaces cards from page one', async () => {
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const current = { ...shoe, id: 'matching-stock' }
  const old = { ...shoe, id: 'late-product' }
  const app = page(undefined, { autoLoad: true, queues: { [catalogEndpoint]: [
    response(catalogPage(firstBatch, { total: 25, hasMore: true })),
    () => pending,
    response(catalogPage([current])),
  ] } })
  await settle(); app.render()
  const oldObserver = app.scrollObserver
  oldObserver.notify(true); app.render()
  const oldRequest = catalogRequests(app).at(-1)
  assert.deepEqual(requestParams(oldRequest), { page: '2' })

  find(app, (node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  app.render(); await settle(); app.render()
  assert.equal(oldRequest.signal.aborted, true)
  assert.deepEqual(requestParams(catalogRequests(app).at(-1)), { stock: '1', page: '1' })
  assert.deepEqual(cards(app).map((node) => node.props.product.id), [current.id])
  assert.equal(oldObserver.targets.size, 0)
  assert.equal(app.scrollObserver, undefined)

  finish(response(catalogPage([old], { total: 25, page: 2 })))
  oldObserver.notify(true)
  await settle(); app.render()
  assert.equal(catalogRequests(app).length, 3)
  assert.deepEqual(cards(app).map((node) => node.props.product.id), [current.id])
  app.unmount()
})

test('Approaching the end requests only one page and stops observing when all products are loaded', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const lastProduct = { ...shoe, id: 'last-product' }
  const app = page(undefined, { autoLoad: true, queues: { [catalogEndpoint]: [
    response(catalogPage(firstBatch, { total: 25, hasMore: true })),
    () => pending,
  ] } })
  await settle(); app.render()
  assert.equal(loadMore(app), undefined)
  const observer = app.scrollObserver
  assert.ok(observer)
  observer.notify(false)
  assert.equal(catalogRequests(app).length, 1)

  observer.notify(true)
  observer.notify(true)
  app.render()
  assert.deepEqual(catalogRequests(app).map(requestParams), [{ page: '1' }, { page: '2' }])
  assert.equal(cards(app).length, 24)
  finish(response(catalogPage([lastProduct], { page: 2, total: 25 })))
  await settle(); app.render()

  assert.equal(cards(app).at(-1).props.product.id, lastProduct.id)
  assert.equal(observer.targets.size, 0)
  assert.equal(app.scrollObserver, undefined)
  app.unmount()
})

test('A failed automatic request pauses scrolling pagination until an explicit retry', async () => {
  const lastProduct = { ...shoe, id: 'retry-product' }
  const app = page(undefined, { autoLoad: true, queues: { [catalogEndpoint]: [
    response(catalogPage(firstBatch, { total: 25, hasMore: true })),
    response({ error: 'صفحهٔ بعد در دسترس نیست' }, 503),
    response(catalogPage([lastProduct], { page: 2, total: 25 })),
  ] } })
  await settle(); app.render()
  const observer = app.scrollObserver
  observer.notify(true)
  await settle(); app.render()
  assert.equal(app.scrollObserver, undefined)
  assert.match(text(app.tree), /صفحهٔ بعد در دسترس نیست/)
  assert.equal(cards(app).length, 24)
  observer.notify(true)
  await settle(); app.render()
  assert.equal(catalogRequests(app).length, 2)

  retry(app).props.onClick(); app.render()
  await settle(); app.render()
  assert.deepEqual(catalogRequests(app).map(requestParams), [{ page: '1' }, { page: '2' }, { page: '2' }])
  assert.equal(cards(app).at(-1).props.product.id, lastProduct.id)
  app.unmount()
})

test('Admin loads scheduled discounts in local time, serializes UTC dates and can explicitly clear the sale', async () => {
  const sale = { ...shoe, salePrice: 80000, saleStartsAt: '2026-10-15T10:00:00.000Z', saleEndsAt: '2026-10-15T12:00:00.000Z' }
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([sale])], 'PUT /api/products/shoe-1': [response(sale)] } })
  await settle(); app.render()
  find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  assert.equal(nodes(app.tree).filter(node => node.props['data-formatted-number']).length, 3)
  assert.equal(nodes(app.tree).filter(node => node.props['data-persian-date'] && node.props.includeTime).length, 2)
  assert.equal(find(app, node => node.props.id === 'product-sale-price').props.value, '80000')
  const start = find(app, node => node.props.id === 'product-sale-start').props.value
  assert.equal(new Date(start).toISOString(), sale.saleStartsAt)
  find(app, node => node.props.id === 'product-sale-price').props.onChange({ target: { value: '75000' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const saved = JSON.parse(app.requests.find(item => item.method === 'PUT').body)
  assert.equal(saved.salePrice, 75000)
  assert.equal(saved.saleStartsAt, sale.saleStartsAt)
  assert.equal(saved.saleEndsAt, sale.saleEndsAt)
  assert.deepEqual(saved.expectedPricing, { price: sale.price, salePrice: sale.salePrice, saleStartsAt: sale.saleStartsAt, saleEndsAt: sale.saleEndsAt })
  app.unmount()

  const clear = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([sale])], 'PUT /api/products/shoe-1': [response(shoe)] } })
  await settle(); clear.render()
  find(clear, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); clear.render()
  find(clear, node => node.type === 'button' && text(node) === 'حذف تخفیف محصول').props.onClick(); clear.render()
  await find(clear, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const cleared = JSON.parse(clear.requests.find(item => item.method === 'PUT').body)
  assert.equal(cleared.salePrice, null)
  assert.equal(cleared.saleStartsAt, null)
  assert.equal(cleared.saleEndsAt, null)
  assert.equal(Object.hasOwn(cleared, 'stock'), false)
  clear.unmount()
})

test('Metadata-only edits omit pricing and preserve the exact stored discount timestamps', async () => {
  const sale = { ...shoe, salePrice: 80000, saleStartsAt: '2026-10-15T10:00:32.123Z', saleEndsAt: '2026-10-15T12:00:45.999Z' }
  const app = page('src/app/admin/products/page.tsx', { queues: { '/api/products': [response([sale])], 'PUT /api/products/shoe-1': [response(sale)] } })
  await settle(); app.render()
  find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const payload = JSON.parse(app.requests.find(item => item.method === 'PUT').body)
  for (const key of ['price', 'salePrice', 'saleStartsAt', 'saleEndsAt', 'expectedPricing']) assert.equal(Object.hasOwn(payload, key), false)
  app.unmount()
})

test('Admin pricing conflict requires explicit refresh and keeps other draft fields', async () => {
  const fresh = { ...shoe, salePrice: 70000 }
  const app = page('src/app/admin/products/page.tsx', { queues: {
    'PUT /api/products/shoe-1': [response({ code: 'PRODUCT_PRICE_CHANGED', error: 'قیمت تغییر کرده است' }, 409), response(fresh)],
    '/api/products/shoe-1': [response(fresh)],
  } })
  await settle(); app.render()
  find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
  find(app, node => node.props.id === 'product-sale-price').props.onChange({ target: { value: '80000' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
  assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(app.requests.filter(item => item.method === 'PUT').length, 1)
  await find(app, node => node.type === 'button' && text(node) === 'تازه‌سازی قیمت و تخفیف').props.onClick(); await settle(); app.render()
  assert.equal(find(app, node => node.props.id === 'product-sale-price').props.value, '70000')
  find(app, node => node.props.id === 'product-sale-price').props.onChange({ target: { value: '65000' } }); app.render()
  await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  const payload = JSON.parse(app.requests.filter(item => item.method === 'PUT')[1].body)
  assert.equal(payload.salePrice, 65000)
  assert.equal(payload.expectedPricing.salePrice, 70000)
  assert.equal(payload.description, shoe.description)
  app.unmount()
})

test('Admin refuses invalid sale prices and reversed schedules without posting or discarding the draft', async () => {
  for (const scenario of [
    { price: '100000', start: '', end: '' }, { price: '0', start: '', end: '' },
    { price: '80000', start: '2026-10-15T12:00', end: '2026-10-15T10:00' },
  ]) {
    const app = page('src/app/admin/products/page.tsx')
    await settle(); app.render()
    find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render()
    for (const [id, value] of [['product-sale-price', scenario.price], ['product-sale-start', scenario.start], ['product-sale-end', scenario.end]]) {
      find(app, node => node.props.id === id).props.onChange({ target: { value } }); app.render()
    }
    await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render()
    assert.equal(app.requests.filter(item => item.method === 'PUT').length, 0)
    assert.ok(find(app, node => node.props.role === 'alert'))
    assert.equal(find(app, node => node.props.id === 'product-sale-price').props.value, scenario.price)
    app.unmount()
  }
})
