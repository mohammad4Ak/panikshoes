const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const base = '/api/admin/products/prices/'
const storageKey = (id = 'admin-a') => `panik-product-price-bulk-pending-v1:${encodeURIComponent(id)}`
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const snapshot = (extra = {}) => ({ price: 100_000, salePrice: 80_000, saleStartsAt: null, saleEndsAt: null, pricingVersion: 3, ...extra })
const settings = { operation: 'increase', unit: 'amount', value: 10_000, includeSalePrice: false }
const product = (id = 'p1', extra = {}) => ({ id, code: `CODE-${id}`, name: `مدل ${id}`, ...snapshot(), ...extra })
const row = (id = 'p1', extra = {}) => ({ id, code: `CODE-${id}`, name: `مدل ${id}`, eligible: true, before: snapshot(), after: snapshot({ price: 110_000, pricingVersion: 4 }), ...extra })
const preview = (extra = {}) => ({ token: 'signed-price-preview', batchId: 'batch-1', expiresAt: new Date(Date.now() + 600_000).toISOString(), settings, reason: 'اصلاح قیمت خرید', rows: [row()], limit: 200, ...extra })
const confirmation = (id = 'p1', extra = {}) => ({ result: { id, outcome: 'updated', before: snapshot(), after: snapshot({ price: 110_000, pricingVersion: 4 }), auditId: `audit-${id}`, ...extra } })
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node).trim() === label)
const field = (app, label) => find(app, node => node.props['aria-label'] === label)
const confirmButton = app => find(app, node => node.type === 'button' && /^تأیید و ثبت/.test(text(node)))
const mutations = app => app.requests.filter(request => request.url === base + 'confirm')

function loadTs(relativePath) {
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, relativePath), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: compiled })
  return compiled.exports
}
function mount({ queues = {}, storage = new Map(), props = {}, userId = 'admin-a', storageFails = false } = {}) {
  const slots = [], effects = [], requests = [], timers = new Map(), events = new Map(), busyEvents = []
  let cursor = 0, tree, timerId = 0, completed = 0, recovered = 0, currentUserId = userId, contentKey, renderedContent
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  react.useLayoutEffect = react.useEffect
  const cleanup = () => { slots.forEach(slot => slot?.cleanup?.()); slots.length = 0; effects.length = 0; cursor = 0 }
  const jsx = (type, props, key) => {
    if (typeof type !== 'function') return { type, props, key }
    if (type.name === 'ProductPriceBulkContent') { renderedContent = true; if (contentKey !== key) { cleanup(); contentKey = key } }
    return type(props)
  }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) },
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: props => jsx('number-input', props) },
    '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session: currentUserId ? { user: { id: currentUserId } } : null }) },
    '@/lib/product-price-bulk-contract': loadTs('../src/lib/product-price-bulk-contract.ts'), '@/lib/pricing': loadTs('../src/lib/pricing.ts'),
    './product-price-bulk.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/ProductPriceBulk.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, Date, Error, TypeError, Set,
    window: { addEventListener(name, callback) { events.set(name, callback) }, removeEventListener(name) { events.delete(name) } },
    sessionStorage: { getItem(key) { return storage.get(key) ?? null }, setItem(key, value) { if (storageFails) throw new Error('storage blocked'); storage.set(key, value) }, removeItem(key) { storage.delete(key) } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      const value = queues[url]?.length ? queues[url].shift() : response(url.endsWith('preview') ? preview() : confirmation())
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value(options) : value
    },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  let currentProps = { open: true, selectedIds: ['p1'], products: [product()], onClose() {}, onRecovery() { recovered++ }, onBusyChange(value) { busyEvents.push(value) }, async onCompleted() { completed++ }, ...props }
  const render = () => { cursor = 0; renderedContent = false; tree = compiled.exports.default(currentProps); if (!renderedContent && contentKey !== undefined) { cleanup(); contentKey = undefined } effects.splice(0).forEach(effect => effect()); return tree }
  const app = { render, requests, storage, events, busyEvents, get tree() { return tree }, get completed() { return completed }, get recovered() { return recovered }, setUserId(value) { currentUserId = value; render() }, setProps(value) { currentProps = { ...currentProps, ...value }; render() }, flushTimers(maximum = 0) { const pending = [...timers.entries()].filter(([, timer]) => timer.delay <= maximum); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, timer]) => timer.callback()); render() }, unmount() { cleanup() } }
  render(); app.flushTimers(); return app
}
async function flush(app) { await settle(); app.render() }
function change(app, label, value) { const node = field(app, label); assert.ok(node, label); if (node.type === 'number-input') node.props.onValueChange(value); else node.props.onChange({ target: { value } }); app.render() }
function reason(app, value = 'اصلاح قیمت خرید') { find(app, node => node.type === 'input' && node.props.maxLength === 500).props.onChange({ target: { value } }); app.render() }
function checkbox(app, index, checked = true) { nodes(app.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox')[index].props.onChange({ target: { checked } }); app.render() }
async function makePreview(app) { await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush(app) }
async function ready(options) { const app = mount(options); change(app, 'مقدار تغییر قیمت', '10000'); reason(app); await makePreview(app); return app }
async function confirm(app) { checkbox(app, 1); const action = confirmButton(app); assert.ok(action); action.props.onClick(); app.render(); await flush(app) }

function mountProductsPage(products) {
  const slots = [], effects = [], requests = [], confirmations = []
  let cursor = 0, tree
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || dependencies.some((value, i) => !Object.is(value, slots[index].dependencies[i]))) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'next/link': { __esModule: true, default: 'Link' }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/admin/MultiImageInput': { __esModule: true, default: 'images' }, '@/components/admin/ProductPriceBulk': { __esModule: true, default: 'bulk-panel' },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) },
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: 'number-input' }, '@/components/ui/PersianDatePicker': { __esModule: true, default: 'date-input' },
    '@/lib/utils': { formatPrice: value => value.toLocaleString('fa-IR') }, '@/lib/pricing': loadTs('../src/lib/pricing.ts'), '@/lib/localized-input': loadTs('../src/lib/localized-input.ts'),
    '@/lib/product-price-bulk-contract': loadTs('../src/lib/product-price-bulk-contract.ts'),
  }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/products/page.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, Date, Error, TypeError,
    async fetch(url, options = {}) { requests.push({ url, ...options }); return response(url === '/api/products' ? products : url === '/api/categories' ? [{ id: 'cat1', name: 'کتانی' }, { id: 'cat2', name: 'رسمی' }] : {}) },
    confirm(message) { confirmations.push(message); return true },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, name); return dependencies[name] },
  })
  const render = () => { cursor = 0; tree = compiled.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, requests, confirmations, get tree() { return tree }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}
const catalogProduct = (id, extra = {}) => ({ ...product(id), slug: id, description: '', images: [], categoryId: 'cat1', category: { name: 'کتانی' }, sizes: [42], colors: ['مشکی'], stock: 2, inventoryConfigured: true, inventoryVersion: 1, variants: [{ id: `variant-${id}`, size: 42, color: 'مشکی', stock: 2, isActive: true }], featured: false, ...extra })
const panel = app => find(app, node => node.type === 'bulk-panel')

test('default base-only amount operation previews exact selected IDs, then confirms the signed token', async () => {
  const app = await ready()
  assert.deepEqual(JSON.parse(app.requests[0].body), { ids: ['p1'], settings, reason: 'اصلاح قیمت خرید' })
  assert.match(text(app.tree), /مبلغ قابل پرداختِ تخفیف فعال ممکن است تغییر نکند/)
  assert.match(text(app.tree), /۸۰٬۰۰۰/); assert.match(text(app.tree), /۱۱۰٬۰۰۰/)
  assert.equal(confirmButton(app).props.disabled, true)
  await confirm(app)
  assert.deepEqual(JSON.parse(mutations(app)[0].body), { token: 'signed-price-preview', productId: 'p1' })
  assert.equal(app.completed, 1); assert.equal(app.storage.has(storageKey()), false); assert.match(text(app.tree), /عملیات پایان یافت/)
  app.unmount()
})

test('explicit discounted-price option and percent decrease use the same preview flow', async () => {
  const chosen = { operation: 'decrease', unit: 'percent', value: 15, includeSalePrice: true }
  const app = mount({ queues: { [base + 'preview']: [response(preview({ settings: chosen }))] } })
  change(app, 'نوع تغییر قیمت', 'decrease'); change(app, 'روش محاسبه قیمت', 'percent'); change(app, 'مقدار تغییر قیمت', '15'); checkbox(app, 0); reason(app)
  await makePreview(app)
  assert.deepEqual(JSON.parse(app.requests[0].body).settings, chosen)
  assert.match(text(app.tree), /نیم تومان رو به بالا/); assert.match(text(app.tree), /زمان شروع و پایان تخفیف حفظ می‌شود/)
  app.unmount()
})

test('reason, integer amount, percent decrease and the selection limit are validated before sending', async () => {
  const app = mount()
  change(app, 'مقدار تغییر قیمت', '10000'); await makePreview(app); assert.equal(app.requests.length, 0)
  reason(app); change(app, 'مقدار تغییر قیمت', '1.5'); await makePreview(app); assert.equal(app.requests.length, 0)
  change(app, 'نوع تغییر قیمت', 'decrease'); change(app, 'روش محاسبه قیمت', 'percent'); change(app, 'مقدار تغییر قیمت', '100'); await makePreview(app); assert.equal(app.requests.length, 0)
  change(app, 'مقدار تغییر قیمت', '99'); app.setProps({ selectedIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }); await makePreview(app); assert.equal(app.requests.length, 0)
  app.unmount()
})

test('invalid rows stay visible and acknowledgment explicitly limits registration to valid products', async () => {
  const data = preview({ rows: [row(), row('p2', { eligible: false, reason: 'تخفیف از قیمت اصلی کمتر نیست.', after: null })] })
  const app = await ready({ props: { selectedIds: ['p1', 'p2'], products: [product(), product('p2')] }, queues: { [base + 'preview']: [response(data)] } })
  assert.match(text(app.tree), /قابل ثبت نیست: تخفیف/); assert.match(text(app.tree), /۱ محصول خطادار ثبت نشود و فقط ۱ محصول معتبر/)
  await confirm(app)
  assert.deepEqual(mutations(app).map(request => JSON.parse(request.body).productId), ['p1'])
  app.unmount()
})

test('all-invalid previews render their errors and cannot authorize a mutation', async () => {
  const app = await ready({ queues: { [base + 'preview']: [response(preview({ token: null, rows: [row('p1', { eligible: false, reason: 'قیمت منفی است.', after: null })] }))] } })
  assert.match(text(app.tree), /قیمت منفی/); assert.equal(confirmButton(app).props.disabled, true)
  confirmButton(app).props.onClick(); await flush(app); assert.equal(mutations(app).length, 0)
  app.unmount()
})

test('source input changes discard preview and acknowledgment', async () => {
  const app = await ready(); checkbox(app, 1)
  reason(app, 'علت تازه'); assert.equal(confirmButton(app), undefined)
  assert.equal(find(app, node => node.type === 'input' && node.props.maxLength === 500).props.value, 'علت تازه')
  app.unmount()
})

test('selection and refreshed price version invalidate previews while unrelated refresh preserves the draft', async () => {
  const app = await ready(); checkbox(app, 1)
  app.setProps({ products: [product('p1', { name: 'نام تازه' }), product('other')] }); app.render()
  assert.ok(confirmButton(app)); assert.equal(confirmButton(app).props.disabled, false)
  const staleConfirm = confirmButton(app).props.onClick
  app.setProps({ products: [product('p1', { pricingVersion: 4 })] }); app.render(); staleConfirm(); await flush(app)
  assert.equal(confirmButton(app), undefined); assert.equal(mutations(app).length, 0)
  assert.equal(field(app, 'مقدار تغییر قیمت').props.value, '10000')
  app.setProps({ selectedIds: ['p2'], products: [product('p2')] }); app.render(); assert.equal(confirmButton(app), undefined)
  app.unmount()
})

test('an in-flight preview cannot attach to a changed selection and stale source handlers cannot edit', async () => {
  const pending = deferred(), app = mount({ queues: { [base + 'preview']: [() => pending.promise] } })
  change(app, 'مقدار تغییر قیمت', '10000'); reason(app)
  const staleEdit = field(app, 'مقدار تغییر قیمت').props.onValueChange
  const work = makePreview(app); staleEdit('99999'); app.render()
  assert.equal(field(app, 'مقدار تغییر قیمت').props.value, '10000'); assert.equal(app.busyEvents.at(-1), true)
  app.setProps({ selectedIds: ['p2'], products: [product('p2')] })
  pending.resolve(response(preview())); await work; await flush(app)
  assert.equal(confirmButton(app), undefined); assert.equal(mutations(app).length, 0)
  app.unmount()
})

test('duplicate confirmation clicks dispatch once, persist recovery before sending and block stale input handlers', async () => {
  const pending = deferred()
  const app = await ready({ queues: { [base + 'confirm']: [options => { assert.equal(JSON.parse(app.storage.get(storageKey())).pendingProductId, 'p1'); return pending.promise }] } })
  checkbox(app, 1)
  const action = confirmButton(app).props.onClick, edit = field(app, 'مقدار تغییر قیمت').props.onValueChange
  action(); action(); edit('70000'); app.render()
  assert.equal(mutations(app).length, 1); assert.equal(field(app, 'مقدار تغییر قیمت').props.value, '10000'); assert.equal(app.busyEvents.at(-1), true)
  pending.resolve(response(confirmation())); await flush(app)
  assert.equal(app.completed, 1); assert.equal(app.storage.has(storageKey()), false)
  app.unmount()
})

test('products confirm sequentially; known failures remain visible without reapplying successful products', async () => {
  const first = deferred(), data = preview({ rows: [row(), row('p2')] })
  const app = await ready({ props: { selectedIds: ['p2', 'p1'], products: [product(), product('p2')] }, queues: { [base + 'preview']: [response(data)], [base + 'confirm']: [() => first.promise, response({ error: 'قیمت محصول تغییر کرده است.' }, 409)] } })
  checkbox(app, 1); confirmButton(app).props.onClick(); app.render(); assert.equal(mutations(app).length, 1)
  first.resolve(response(confirmation())); await flush(app)
  assert.deepEqual(mutations(app).map(request => JSON.parse(request.body).productId), ['p1', 'p2'])
  assert.match(text(app.tree), /ثبت نشد: قیمت محصول تغییر کرده/); assert.equal(app.storage.has(storageKey()), false)
  assert.equal(app.completed, 1); app.unmount()
})

test('lost confirmation response requires manual recovery of the exact token and product', async () => {
  const storage = new Map(), app = await ready({ storage, queues: { [base + 'confirm']: [new Error('offline')] } })
  await confirm(app)
  assert.ok(button(app, 'پیگیری دوبارهٔ همان عملیات')); assert.equal(mutations(app).length, 1)
  assert.equal(app.busyEvents.at(-1), true); assert.equal(storage.has(storageKey()), true)
  const persisted = JSON.parse(storage.get(storageKey())); assert.equal(persisted.preview.token, 'signed-price-preview')
  app.unmount()
  const restored = mount({ storage, props: { open: false, selectedIds: ['unrelated'], products: [product('unrelated')] }, queues: { [base + 'confirm']: [response(confirmation('p1', { outcome: 'already_applied' }))] } })
  assert.equal(restored.recovered, 1); assert.equal(restored.requests.length, 0)
  restored.setProps({ open: true }); button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
  assert.deepEqual(JSON.parse(mutations(restored)[0].body), { token: 'signed-price-preview', productId: 'p1' })
  assert.match(text(restored.tree), /قبلاً ثبت شده؛ دوباره اعمال نشد/); assert.equal(storage.has(storageKey()), false)
  restored.unmount()
})

test('recovery is isolated by administrator identity and no request is retried on account switch', async () => {
  const storage = new Map(), saved = { version: 1, preview: preview(), results: {}, pendingProductId: 'p1' }
  storage.set(storageKey(), JSON.stringify(saved))
  const app = mount({ storage, userId: 'admin-b' })
  assert.equal(app.recovered, 0); assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined)
  reason(app, 'حساب دوم'); app.setUserId('admin-a'); app.flushTimers()
  assert.equal(app.recovered, 1); assert.ok(button(app, 'پیگیری دوبارهٔ همان عملیات')); assert.equal(app.requests.length, 0)
  app.setUserId(null); assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined); assert.equal(storage.has(storageKey()), true)
  app.setUserId('admin-b'); app.flushTimers(); assert.equal(find(app, node => node.type === 'input' && node.props.maxLength === 500).props.value, '')
  app.unmount()
})

test('malformed recovery is removed and malformed or mismatched server preview never authorizes writes', async () => {
  const storage = new Map([[storageKey(), JSON.stringify({ version: 1, preview: preview(), results: {}, pendingProductId: 'other' })]])
  const app = await ready({ storage, queues: { [base + 'preview']: [response(preview({ rows: [row('p2')] }))] } })
  assert.equal(storage.has(storageKey()), false); assert.equal(app.recovered, 0); assert.equal(confirmButton(app), undefined)
  assert.match(text(app.tree), /مطابق انتخاب/); assert.equal(mutations(app).length, 0)
  app.unmount()
})

test('malformed confirmation stays pending and storage failure prevents sending a mutation', async () => {
  const app = await ready({ queues: { [base + 'confirm']: [response(confirmation('other'))] } })
  await confirm(app); assert.ok(button(app, 'پیگیری دوبارهٔ همان عملیات')); assert.equal(app.storage.has(storageKey()), true)
  app.unmount()
  const blocked = await ready({ storageFails: true }); await confirm(blocked)
  assert.equal(mutations(blocked).length, 0); assert.match(text(blocked.tree), /نتوانست اطلاعات بازیابی/)
  blocked.unmount()
})

for (const [label, incomplete] of [
  ['missing audit receipt', { auditId: undefined }],
  ['blank audit receipt', { auditId: '   ' }],
  ['missing prior prices', { before: undefined }],
  ['missing resulting prices', { after: undefined }],
  ['malformed resulting prices', { after: { price: '110000' } }],
  ['incomplete replay receipt', { outcome: 'already_applied', auditId: undefined }],
]) {
  test(`a success with ${label} remains uncertain until the exact signed operation returns a full receipt`, async () => {
    const storage = new Map(), app = await ready({ storage, queues: { [base + 'confirm']: [response(confirmation('p1', incomplete))] } })
    await confirm(app)
    assert.equal(app.completed, 0); assert.equal(app.busyEvents.at(-1), true)
    assert.equal(mutations(app).length, 1); assert.ok(button(app, 'پیگیری دوبارهٔ همان عملیات'))
    const saved = JSON.parse(storage.get(storageKey()))
    assert.equal(saved.pendingProductId, 'p1'); assert.deepEqual(saved.results, {})
    app.unmount()
    const restored = mount({ storage, queues: { [base + 'confirm']: [response(confirmation('p1', { outcome: 'already_applied' }))] } })
    assert.equal(restored.recovered, 1); assert.equal(restored.requests.length, 0)
    button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
    assert.deepEqual(JSON.parse(mutations(restored)[0].body), { token: saved.preview.token, productId: saved.pendingProductId })
    assert.equal(restored.completed, 1); assert.equal(storage.has(storageKey()), false)
    assert.match(text(restored.tree), /قبلاً ثبت شده؛ دوباره اعمال نشد/)
    restored.unmount()
  })
}

test('a definitive skipped result may omit a success receipt and price snapshots', async () => {
  const app = await ready({ queues: { [base + 'confirm']: [response({ result: { id: 'p1', outcome: 'skipped' } })] } })
  await confirm(app)
  assert.equal(app.storage.has(storageKey()), false); assert.equal(app.completed, 0)
  assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined); assert.match(text(app.tree), /ثبت نشد/)
  app.unmount()
})

test('expired fresh previews cannot confirm, while recovery can ask the server for the original durable result', async () => {
  const expired = preview({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
  const app = await ready({ queues: { [base + 'preview']: [response(expired)] } }); await confirm(app)
  assert.equal(mutations(app).length, 0); assert.match(text(app.tree), /مهلت پیش‌نمایش تمام شده/); app.unmount()
  const storage = new Map([[storageKey(), JSON.stringify({ version: 1, preview: expired, results: {}, pendingProductId: 'p1' })]])
  const restored = mount({ storage }); button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
  assert.equal(mutations(restored).length, 1); restored.unmount()
})

test('product-page name/code and category filters select only the displayed matching IDs and clear explicitly', async () => {
  const app = mountProductsPage([catalogProduct('p1', { code: 'RUN-001' }), catalogProduct('p2', { code: 'RUN-002', categoryId: 'cat2', category: { name: 'رسمی' } }), catalogProduct('p3', { code: 'WALK-003' })])
  await flush(app)
  field(app, 'جستجو با نام یا کد محصول').props.onChange({ target: { value: 'RUN-۰۰' } }); app.render()
  field(app, 'فیلتر دسته‌بندی محصولات').props.onChange({ target: { value: 'cat2' } }); app.render()
  button(app, 'انتخاب همه نتایج فیلتر').props.onClick(); app.render()
  assert.deepEqual(Array.from(panel(app).props.selectedIds), ['p2'])
  field(app, 'فیلتر دسته‌بندی محصولات').props.onChange({ target: { value: 'cat1' } }); app.render()
  assert.match(text(app.tree), /۱ انتخاب خارج از فیلتر فعلی/)
  button(app, 'انتخاب همه نتایج فیلتر').props.onClick(); app.render()
  assert.deepEqual(Array.from(panel(app).props.selectedIds), ['p1'])
  button(app, 'پاک‌کردن انتخاب').props.onClick(); app.render(); assert.equal(panel(app).props.selectedIds.length, 0)
  app.unmount()
})

test('product-page selection rejects more than 200 results and rapid individual selections never exceed the cap', async () => {
  const app = mountProductsPage(Array.from({ length: 201 }, (_, index) => catalogProduct(`p${index}`)))
  await flush(app)
  const selectAll = button(app, 'انتخاب همه نتایج فیلتر'); assert.equal(selectAll.props.disabled, true)
  selectAll.props.onClick(); app.render(); assert.equal(panel(app).props.selectedIds.length, 0)
  assert.match(text(app.tree), /نتایج بیشتر از ۲۰۰ محصول/)
  nodes(app.tree).filter(node => node.type === 'input' && /^انتخاب مدل/.test(node.props['aria-label'])).forEach(node => node.props.onChange({ target: { checked: true } }))
  app.render(); assert.equal(panel(app).props.selectedIds.length, 200)
  const unchecked = nodes(app.tree).find(node => node.type === 'input' && /^انتخاب مدل/.test(node.props['aria-label']) && !node.props.checked)
  assert.equal(unchecked.props.disabled, true); app.unmount()
})

test('synchronous bulk busy callback blocks stale manual edit, delete, filter and selection handlers before rerender', async () => {
  const app = mountProductsPage([catalogProduct('p1')]); await flush(app)
  const edit = find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick
  const remove = find(app, node => node.type === 'button' && node.props.title === 'حذف').props.onClick
  const select = button(app, 'انتخاب همه نتایج فیلتر').props.onClick
  const search = field(app, 'جستجو با نام یا کد محصول').props.onChange
  panel(app).props.onBusyChange(true)
  edit(); await remove(); select(); search({ target: { value: 'hidden' } }); app.render()
  assert.equal(find(app, node => node.props.role === 'dialog'), undefined)
  assert.equal(app.confirmations.length, 0); assert.equal(app.requests.filter(request => request.method === 'DELETE').length, 0)
  assert.equal(panel(app).props.selectedIds.length, 0); assert.equal(field(app, 'جستجو با نام یا کد محصول').props.value, '')
  panel(app).props.onBusyChange(false); edit(); app.render()
  assert.ok(find(app, node => node.props.role === 'dialog')); app.unmount()
})
