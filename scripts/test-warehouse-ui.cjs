const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const variant = extra => ({ id: 'v1', color: 'مشکی', size: 38, stock: 8, reserved: 3, damagedStock: 2, lowStockThreshold: 2, isActive: true, ...extra })
const product = extra => ({ id: 'shoe', code: 'PN-00622', name: 'کفش پانیک', images: ['/shoe.webp'], inventoryVersion: 7, inventoryConfigured: true, variants: [variant()], ...extra })
const pagination = { page: 1, total: 1, pages: 1, pageSize: 20 }
const inventory = extra => ({ products: [product()], summary: { available: 8, reserved: 3, damaged: 2, inactive: 0, lowCount: 0, unconfiguredCount: 0 }, pagination, ...extra })
const history = { movements: [], pagination: { ...pagination, total: 0 } }
const stockUrl = '/api/admin/inventory?q=&filter=all&page=1'
const historyUrl = '/api/admin/inventory/movements?productId=&type=&page=1'
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : [] }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree) }
function mount({ stock = inventory(), ledger = history, queues = {}, crypto: suppliedCrypto } = {}) {
  const slots = [], effects = [], timers = new Map(), requests = [], events = new Map()
  let cursor = 0, tree, writes = 0, timerId = 0, key = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies }; return slots[index].callback },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'next/link': { __esModule: true, default: 'a' }, 'next/image': { __esModule: true, default: 'img' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }), '@/lib/utils': { formatPrice: String },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) },
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: ({ onValueChange, ...props }) => jsx('input', { ...props, 'data-formatted-number': true, onChange: event => onValueChange(event.target.value) }) },
    '@/components/admin/admin.module.css': css, './inventory.module.css': css,
  }
  const result = { exports: {} }
  const document = { activeElement: null, body: { style: { overflow: '' } }, addEventListener(name, callback) { events.set(name, callback) }, removeEventListener(name) { events.delete(name) } }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/inventory/page.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: result, AbortController, URLSearchParams, Date, Error, TypeError, Intl, document,
    crypto: suppliedCrypto ?? { randomUUID() { return `request-${++key}` } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      const queue = queues[(options.method || 'GET') + ' ' + url] || queues[url]
      const value = queue?.length ? queue.shift() : response(options.method ? { ok: true } : url.includes('/movements?') ? ledger : stock)
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value(options) : value
    },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  const render = () => { cursor = 0; tree = result.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, requests, events, document, get tree() { return tree }, get writes() { return writes }, flushTimers(maximum = 300) { const pending = [...timers.entries()].filter(([, timer]) => timer.delay <= maximum); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, timer]) => timer.callback()) }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node).trim() === label)
const field = (app, label) => nodes(find(app, node => node.type === 'label' && text(node).startsWith(label))).find(node => ['input', 'textarea', 'select'].includes(node.type))
const form = app => find(app, node => node.type === 'form')
const writes = app => app.requests.filter(request => request.method)
const reads = app => app.requests.filter(request => !request.method)
async function flush(app) { await settle(); app.render() }
async function ready(options) { const app = mount(options); app.flushTimers(); await flush(app); return app }
function change(app, label, value) { const node = field(app, label); assert.ok(node, label); node.props.onChange({ target: { value } }); app.render() }
function open(app) { button(app, 'ثبت گردش').props.onClick(); app.render() }
const submit = app => form(app).props.onSubmit({ preventDefault() {} })
function fill(app, type = 'RECEIPT', amount = '5') { change(app, 'نوع عملیات', type); change(app, type === 'ADJUSTMENT' ? 'موجودی نهایی' : 'تعداد (جفت)', amount); change(app, 'علت یا توضیح', 'ورود تولید جدید') }

test('Warehouse uses independent uncached inventory/history reads and explains reserved stock', async () => {
  const app = await ready()
  assert.deepEqual(reads(app).map(request => request.url), [stockUrl, historyUrl]); assert.ok(reads(app).every(request => request.cache === 'no-store'))
  assert.match(text(app.tree), /تا زمان ارسال/); assert.match(text(app.tree), /کالای معیوب قابل خرید نیست/)
  assert.match(text(app.tree), /کد محصول: PN-00622/)
  assert.equal(button(app, 'ثبت گردش').props.disabled, false); app.unmount()
})
test('Failed inventory read preserves the server reason and does not pretend the warehouse is empty', async () => {
  const app = await ready({ queues: { [stockUrl]: [response({ error: 'سرویس موقتاً قطع است' }, 503)] } })
  assert.match(text(app.tree), /سرویس موقتاً قطع است/); assert.ok(!text(app.tree).includes('محصولی با این شرایط پیدا نشد'))
  button(app, 'تلاش دوباره').props.onClick(); await flush(app); assert.ok(button(app, 'ثبت گردش')); app.unmount()
})
test('Receipt sends current inventory revision and canonical quantity, then refreshes both panels', async () => {
  const app = await ready(); open(app); fill(app); await submit(app); await flush(app)
  const request = writes(app)[0], payload = JSON.parse(request.body)
  assert.equal(request.method, 'POST'); assert.equal(payload.productId, 'shoe'); assert.equal(payload.variantId, 'v1'); assert.equal(payload.inventoryVersion, 7)
  assert.equal(payload.type, 'RECEIPT'); assert.equal(payload.quantity, 5); assert.equal(payload.note, 'ورود تولید جدید'); assert.equal(payload.requestKey, 'request-1')
  assert.equal(form(app), undefined); assert.equal(reads(app).length, 4); app.unmount()
})
test('Synchronous write guard prevents double submission before React renders', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve })
  const app = await ready({ queues: { 'POST /api/admin/inventory': [() => pending] } }); open(app); fill(app)
  const first = submit(app), second = submit(app); app.render()
  assert.equal(writes(app).length, 1); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, true)
  complete(response({ ok: true })); await Promise.all([first, second]); await flush(app); assert.equal(form(app), undefined); app.unmount()
})
test('Lost response preserves draft and request key; editing payload generates a new idempotency key', async () => {
  const app = await ready({ queues: { 'POST /api/admin/inventory': [new TypeError('network'), new TypeError('network'), response({ ok: true })] } }); open(app); fill(app)
  await submit(app); await flush(app); assert.equal(field(app, 'تعداد (جفت)').props.value, '5'); assert.match(text(app.tree), /ارتباط با سرور/)
  await submit(app); await flush(app); change(app, 'علت یا توضیح', 'تغییر توضیح'); await submit(app); await flush(app)
  const keys = writes(app).map(request => JSON.parse(request.body).requestKey)
  assert.deepEqual(keys, ['request-1', 'request-1', 'request-2']); app.unmount()
})
test('Conflict blocks blind resubmission; explicit refresh retains draft and uses the new version', async () => {
  const fresh = inventory({ products: [product({ inventoryVersion: 8, variants: [variant({ stock: 6 })] })] })
  const app = await ready({ queues: { [stockUrl]: [response(inventory()), response(fresh)], 'POST /api/admin/inventory': [response({ error: 'موجودی هم‌زمان تغییر کرد' }, 409), response({ ok: true })] } })
  open(app); fill(app); await submit(app); await flush(app); await submit(app); assert.equal(writes(app).length, 1)
  assert.equal(button(app, 'تأیید و ثبت گردش').props.disabled, true)
  await button(app, 'دریافت موجودی تازه و بازبینی').props.onClick(); await flush(app)
  assert.equal(field(app, 'تعداد (جفت)').props.value, '5'); assert.match(text(app.tree), /مقدار و پیش‌نمایش را دوباره بررسی/)
  await submit(app); await flush(app); assert.equal(JSON.parse(writes(app)[1].body).inventoryVersion, 8); assert.notEqual(JSON.parse(writes(app)[0].body).requestKey, JSON.parse(writes(app)[1].body).requestKey); app.unmount()
})
test('Damaged return preserves sellable count, requires full order ID, and sends no client refund', async () => {
  const app = await ready(); open(app); fill(app, 'RETURN_DAMAGED', '2')
  const preview = find(app, node => node.props['aria-label'] === 'پیش‌نمایش موجودی')
  assert.match(text(preview), /قابل فروش 8 ← 8/); assert.match(text(preview), /معیوب 2 ← 4/)
  await submit(app); await flush(app); assert.equal(writes(app).length, 0); assert.match(text(app.tree), /شناسهٔ کامل سفارش/)
  change(app, 'شناسهٔ کامل سفارش مرجوعی', ' order-full-id '); await submit(app); await flush(app)
  const payload = JSON.parse(writes(app)[0].body); assert.equal(payload.orderId, 'order-full-id'); assert.equal(payload.refund, undefined); assert.equal(payload.quantity, 2); app.unmount()
})
test('Historical inactive variants accept returns without automatic activation', async () => {
  const app = await ready({ stock: inventory({ products: [product({ variants: [variant({ isActive: false })] })] }) }); open(app)
  assert.match(text(app.tree), /موجودی آن تا فعال‌سازی/); fill(app, 'RETURN_SELLABLE', '1'); change(app, 'شناسهٔ کامل سفارش مرجوعی', 'order-id')
  await submit(app); await flush(app); const payload = JSON.parse(writes(app)[0].body); assert.equal(payload.isActive, undefined); assert.equal(payload.type, 'RETURN_SELLABLE'); app.unmount()
})
test('Damage, repair and disposal cannot overdraw the respective stock pool', async () => {
  for (const [type, amount] of [['DAMAGE', '9'], ['REPAIR', '3'], ['DISPOSAL', '3']]) {
    const app = await ready(); open(app); fill(app, type, amount); await submit(app); await flush(app)
    assert.equal(writes(app).length, 0); assert.match(text(app.tree), /از موجودی فعلی بیشتر/); app.unmount()
  }
})
test('Stocktaking is an absolute available count and permits zero without touching reservations', async () => {
  const app = await ready(); open(app); fill(app, 'ADJUSTMENT', '0')
  const preview = find(app, node => node.props['aria-label'] === 'پیش‌نمایش موجودی'); assert.match(text(preview), /قابل فروش 8 ← 0/); assert.match(text(preview), /رزرو سفارش‌ها: 3 جفت/)
  await submit(app); await flush(app); const payload = JSON.parse(writes(app)[0].body); assert.equal(payload.quantity, 0); assert.equal(payload.type, 'ADJUSTMENT'); assert.equal(payload.reserved, undefined); app.unmount()
})
test('Threshold supports zero and uses PATCH with the product version', async () => {
  const app = await ready(); find(app, node => node.type === 'button' && node.props['aria-label']?.startsWith('تنظیم حد هشدار')).props.onClick(); app.render()
  change(app, 'حد هشدار (جفت)', '0'); await submit(app); await flush(app)
  const request = writes(app)[0], payload = JSON.parse(request.body); assert.equal(request.method, 'PATCH'); assert.equal(payload.lowStockThreshold, 0); assert.equal(payload.inventoryVersion, 7); assert.equal(payload.quantity, undefined); app.unmount()
})
test('Unconfigured products link to configuration and cannot be changed from warehouse', async () => {
  const app = await ready({ stock: inventory({ products: [product({ inventoryConfigured: false })] }) })
  assert.equal(button(app, 'ثبت گردش'), undefined); assert.ok(find(app, node => node.type === 'a' && node.props.href === '/admin/products')); app.unmount()
})
test('Unsafe or fractional quantities and empty reasons never send inventory writes', async () => {
  for (const amount of ['1.5', '-1', '', '2147483648', '9007199254740992']) {
    const app = await ready(); open(app); fill(app, 'RECEIPT', amount); await submit(app); await flush(app); assert.equal(writes(app).length, 0); app.unmount()
  }
  const app = await ready(); open(app); fill(app); change(app, 'علت یا توضیح', ' '); await submit(app); await flush(app); assert.equal(writes(app).length, 0); app.unmount()
})
test('Search waits for debounce and aborts obsolete reads; stale responses cannot replace new stock', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve })
  const app = mount({ queues: { [stockUrl]: [() => pending] } }); app.flushTimers(); app.render()
  change(app, 'جستجوی محصول', 'سلین'); assert.equal(reads(app).length, 2)
  app.flushTimers(); app.render(); app.flushTimers(); await flush(app)
  assert.equal(reads(app)[0].signal.aborted, true); assert.match(reads(app).at(-1).url, /q=%D8%B3%D9%84%DB%8C%D9%86/)
  complete(response(inventory({ products: [product({ name: 'قدیمی' })] }))); await flush(app); assert.ok(!text(app.tree).includes('قدیمی')); app.unmount()
})
test('Unmount aborts pending reads and suppresses late updates', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve })
  const app = mount({ queues: { [stockUrl]: [() => pending] } }); app.flushTimers(); await settle(); app.unmount()
  const before = app.writes; assert.equal(reads(app)[0].signal.aborted, true); complete(response(inventory())); await settle(); assert.equal(app.writes, before)
})
test('History filters can target a product and type without changing warehouse search', async () => {
  const app = await ready(); button(app, 'گردش این محصول').props.onClick(); app.render(); app.flushTimers(); await flush(app)
  assert.match(reads(app).at(-1).url, /productId=shoe/); change(app, 'نوع گردش', 'RECEIPT'); app.flushTimers(); await flush(app)
  assert.match(reads(app).at(-1).url, /type=RECEIPT/); assert.equal(field(app, 'جستجوی محصول').props.value, ''); app.unmount()
})
test('Return validation errors allow correcting the order without unnecessary inventory conflict refresh', async () => {
  const app = await ready({ queues: { 'POST /api/admin/inventory': [response({ error: 'سفارش هنوز ارسال نشده', code: 'RETURN_NOT_SHIPPED' }, 409), response({ ok: true })] } })
  open(app); fill(app, 'RETURN_SELLABLE', '1'); change(app, 'شناسهٔ کامل سفارش مرجوعی', 'pending-order'); await submit(app); await flush(app)
  assert.equal(button(app, 'دریافت موجودی تازه و بازبینی'), undefined); change(app, 'شناسهٔ کامل سفارش مرجوعی', 'shipped-order'); await submit(app); await flush(app)
  assert.equal(writes(app).length, 2); assert.equal(JSON.parse(writes(app)[1].body).orderId, 'shipped-order'); app.unmount()
})
test('Read timeout clears loading and surfaces retry; unmount aborts an in-flight write without late updates', async () => {
  const app = mount({ queues: { [stockUrl]: [options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort'))))] } })
  app.flushTimers(); app.render(); app.flushTimers(15000); await flush(app)
  assert.match(text(app.tree), /دریافت موجودی طول کشید/); app.unmount()
  let complete; const pending = new Promise(resolve => { complete = resolve })
  const writing = await ready({ queues: { 'POST /api/admin/inventory': [() => pending] } }); open(writing); fill(writing)
  const command = submit(writing); writing.render(); writing.unmount(); const before = writing.writes
  assert.equal(writes(writing)[0].signal.aborted, true); complete(response({ ok: true })); await command; await settle(); assert.equal(writing.writes, before)
})
test('Plain HTTP LAN without randomUUID generates a secure key with getRandomValues and reuses it on retry', async () => {
  let generated = 0
  const app = await ready({ crypto: { getRandomValues(bytes) { generated++; bytes.fill(0xab); return bytes } }, queues: { 'POST /api/admin/inventory': [new TypeError('lost response'), response({ ok: true })] } })
  open(app); fill(app); await submit(app); await flush(app); await submit(app); await flush(app)
  assert.equal(writes(app).length, 2); assert.equal(generated, 1)
  assert.deepEqual(writes(app).map(request => JSON.parse(request.body).requestKey), ['abababababababababababababababab', 'abababababababababababababababab']); app.unmount()
})
test('Unexpected request key generator failure leaves the draft usable and releases the synchronous write lock', async () => {
  let attempts = 0
  const app = await ready({ crypto: { randomUUID() { if (++attempts === 1) throw new Error('unexpected generator failure'); return 'request-recovered' } } })
  open(app); fill(app); await submit(app); await flush(app)
  assert.equal(writes(app).length, 0); assert.match(text(app.tree), /ساخت شناسهٔ درخواست ممکن نشد/); assert.equal(field(app, 'تعداد (جفت)').props.value, '5')
  assert.equal(find(app, node => node.type === 'fieldset').props.disabled, false)
  await submit(app); await flush(app); assert.equal(writes(app).length, 1); assert.equal(JSON.parse(writes(app)[0].body).requestKey, 'request-recovered'); app.unmount()
})
test('No cryptographic browser API fails safely without emitting a weak or missing idempotency key', async () => {
  const app = await ready({ crypto: {} }); open(app); fill(app); await submit(app); await flush(app)
  assert.equal(writes(app).length, 0); assert.match(text(app.tree), /ساخت شناسهٔ درخواست ممکن نشد/); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, false); app.unmount()
})
