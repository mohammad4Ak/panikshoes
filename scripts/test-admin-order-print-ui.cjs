const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const settle = () => new Promise(setImmediate)
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, name) => find(app, node => node.type === 'button' && text(node).trim() === name)
const prepareButton = app => button(app, 'آماده‌سازی و پیش‌نمایش')
const printButton = app => find(app, node => node.type === 'button' && /چاپ .*مدرک \/ ذخیره PDF/.test(text(node)))
const portal = app => find(app, node => node.props.role === 'dialog')
const invoice = (id = 'order-1', extra = {}) => ({ kind: 'invoice', orderId: id, status: 'PROCESSING', invoice: { id: 12, issuedAt: '2026-11-01T09:00:00.000Z', number: 'INV-2026-000012', snapshot: { schemaVersion: 1, currency: 'تومان', seller: { name: 'فروشنده زمان صدور' }, buyer: { name: 'خریدار ثبت‌شده', email: 'buyer@example.test' }, recipient: { name: 'گیرنده ثبت‌شده', phone: '09123456789', address: 'نشانی زمان سفارش' }, orderId: id, orderCreatedAt: '2026-11-01T08:00:00.000Z', items: [{ productId: 'shoe-1', productName: 'نام کفش هنگام خرید', quantity: 2, size: 39, color: 'مشکی', unitPrice: 100_000, lineTotal: 180_000, originalUnitPrice: 120_000, productDiscount: 40_000, couponDiscount: 20_000 }], subtotal: 240_000, productDiscount: 40_000, couponDiscount: 20_000, couponCode: 'SAVE', merchandiseTotal: 180_000, shippingMethodName: 'پست زمان سفارش', shippingCost: 30_000, total: 210_000 } }, ...extra })
const fulfillment = (kind = 'packing', extra = {}) => ({ kind, orderId: 'order-1', status: 'PROCESSING', createdAt: '2026-11-01T08:00:00.000Z', seller: { name: 'کفش پانیک', phone: '04133333333', address: 'نشانی فرستنده' }, recipient: { name: 'گیرنده سفارش', address: 'نشانی سفارش', phone: '09123456789', postalCode: '1234567890' }, shippingMethodName: 'پست پیشتاز', trackingCode: '12345678901234567890', items: kind === 'packing' ? [{ productName: 'نام کفش ثبت‌شده', quantity: 2, size: 39, color: 'مشکی' }] : [], ...extra })
const row = (doc = invoice(), extra = {}) => ({ id: doc.orderId, status: doc.status, eligible: true, warnings: [], document: doc, ...extra })
const batch = (extra = {}) => ({ kind: 'invoice', generatedAt: '2026-11-15T08:00:00.000Z', limit: 100, rows: [row()], ...extra })
function loadTs(file) { const compiled = { exports: {} }; vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: compiled, Date }); return compiled.exports }

function mount({ props = {}, queues = [], fonts = Promise.resolve(), userId = 'admin-1' } = {}) {
  const slots = [], effects = [], requests = [], busyEvents = [], timers = new Map(), attributes = new Map()
  let cursor = 0, tree, timerId = 0, currentUser = userId, contentKey, renderedContent = false, printCount = 0, closed = 0
  let currentProps
  class Element {
    constructor(tag) { this.tag = tag; this.focused = 0; this.focusable = []; this.isConnected = true }
    focus() { this.focused++; document.activeElement = this }
    getClientRects() { return [{}] }
    querySelectorAll() { return this.focusable }
  }
  const prepareTrigger = new Element('button')
  const document = { activeElement: prepareTrigger, fonts: { ready: fonts }, body: { style: { overflow: '' }, setAttribute(key, value) { attributes.set(key, value) }, removeAttribute(key) { attributes.delete(key) } } }
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(callback, deps) { const index = cursor++; if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps[i]))) { slots[index]?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  react.useLayoutEffect = react.useEffect
  const cleanup = () => { slots.forEach(slot => slot?.cleanup?.()); slots.length = 0; effects.length = 0; cursor = 0 }
  const jsx = (type, props, key) => {
    if (typeof type === 'function') {
      if (type.name === 'OrderDocumentsContent') { renderedContent = true; if (contentKey !== key) { cleanup(); contentKey = key } }
      return type(props)
    }
    if (props?.ref && typeof props.ref === 'object' && !props.ref.current) props.ref.current = new Element(type)
    return { type, props, key }
  }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-dom': { createPortal: children => jsx('portal', { children }) },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) },
    '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session: currentUser ? { user: { id: currentUser, role: 'ADMIN' } } : null }) },
    '@/lib/invoice': loadTs('../src/lib/invoice.ts'), '@/lib/admin-order-print-contract': loadTs('../src/lib/admin-order-print-contract.ts'),
    './order-documents-print.module.css': { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) },
  }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/OrderDocumentsPrint.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, Date, Error, TypeError, HTMLElement: Element, document, window: { print() { printCount++ } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    async fetch(url, options = {}) { requests.push({ url, ...options }); const result = queues.length ? queues.shift() : response(batch()); if (result instanceof Error) throw result; return typeof result === 'function' ? result(options) : result },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  currentProps = { open: true, mode: 'selected', selectedIds: ['order-1'], filterQuery: 'status=PROCESSING&range=today', filterSummary: 'سفارش‌های امروز', filtersActive: true, total: 1, ready: true, disabled: false, sourceRevision: 'orders-v1', onModeChange(value) { currentProps.mode = value }, onClearSelection() { currentProps.selectedIds = [] }, onClose() { closed++ }, onBusyChange(value) { busyEvents.push(value) }, ...props }
  const render = () => { cursor = 0; renderedContent = false; tree = compiled.exports.default(currentProps); if (!renderedContent && contentKey !== undefined) { cleanup(); contentKey = undefined } effects.splice(0).forEach(effect => effect()); return tree }
  const app = { render, requests, attributes, busyEvents, document, prepareTrigger, exports: compiled.exports, get printCount() { return printCount }, get closed() { return closed }, get tree() { return tree }, setProps(value) { currentProps = { ...currentProps, ...value }; render() }, setUser(value) { currentUser = value; render() }, flushTimers(max = 0) { const pending = [...timers.entries()].filter(([, value]) => value.delay <= max); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, value]) => value.callback()); render() }, unmount() { cleanup() } }
  render(); app.flushTimers(); return app
}
async function flush(app) { await settle(); app.render() }
async function prepare(app) { prepareButton(app).props.onClick(); app.render(); await flush(app) }
function changeKind(app, kind) { find(app, node => node.props['aria-label'] === 'نوع مدرک سفارش').props.onChange({ target: { value: kind } }); app.render(); app.flushTimers() }

test('Selected order preparation is read-only, complete, and waits for an explicit print click and fonts', async () => {
  const fonts = deferred()
  const app = mount({ fonts: fonts.promise })
  await prepare(app)
  assert.deepEqual(JSON.parse(app.requests[0].body), { kind: 'invoice', mode: 'selected', ids: ['order-1'] })
  assert.equal(app.requests[0].url, '/api/admin/orders/documents')
  assert.equal(app.requests[0].method, 'POST')
  assert.equal(app.requests[0].cache, 'no-store')
  assert.equal(app.printCount, 0, 'Preparation must not automatically open print')
  assert.ok(portal(app)); assert.equal(app.attributes.has('data-order-documents-preview'), true)
  assert.equal(app.busyEvents.at(-1), true, 'Parent controls stay locked during preview')
  const print = printButton(app)
  print.props.onClick(); print.props.onClick(); app.render(); await flush(app)
  assert.equal(app.printCount, 0)
  fonts.resolve(); await flush(app)
  assert.equal(app.printCount, 1, 'Double clicks must not open duplicate dialogs')
  button(app, 'بازگشت به سفارش‌ها').props.onClick(); app.render()
  assert.equal(portal(app), undefined); assert.equal(app.attributes.has('data-order-documents-preview'), false)
  assert.equal(app.document.body.style.overflow, '')
  assert.equal(app.busyEvents.at(-1), false)
  assert.ok(app.prepareTrigger.focused > 0)
  print.props.onClick(); await flush(app)
  assert.equal(app.printCount, 1, 'A detached old print button cannot print admin chrome')
  app.unmount()
})

test('All filtered orders use the applied filter scope and explicitly list documents omitted from printing', async () => {
  const skipped = row(invoice('order-2'), { eligible: false, document: null, reason: 'هنوز فاکتوری صادر نشده است.', warnings: [] })
  const app = mount({ props: { mode: 'filtered', selectedIds: [], total: 2 }, queues: [response(batch({ rows: [row(), skipped] }))] })
  await prepare(app)
  assert.deepEqual(JSON.parse(app.requests[0].body), { kind: 'invoice', mode: 'filtered', filters: 'status=PROCESSING&range=today' })
  assert.match(text(app.tree), /۱ مدرک آماده · ۱ سفارش بدون مدرک/)
  assert.match(text(app.tree), /چاپ نمی‌شود: هنوز فاکتوری صادر نشده است/)
  assert.match(text(app.tree), /order-2/)
  assert.equal(nodes(app.tree).filter(node => node.type === 'article').length, 1)
  app.unmount()
})

test('Empty, oversized, unready, disabled and unfiltered-all scopes cannot prepare even from an old handler', async () => {
  for (const props of [{ selectedIds: [] }, { selectedIds: Array.from({ length: 101 }, (_, i) => `o-${i}`) }, { ready: false }, { disabled: true }, { mode: 'filtered', filtersActive: false }]) {
    const app = mount({ props })
    assert.equal(prepareButton(app).props.disabled, true)
    prepareButton(app).props.onClick(); await flush(app)
    assert.equal(app.requests.length, 0)
    app.unmount()
  }
  const app = mount()
  const oldPrepare = prepareButton(app)
  app.setProps({ selectedIds: ['order-2'] })
  oldPrepare.props.onClick(); await flush(app)
  assert.equal(app.requests.length, 0)
  app.unmount()
})

test('Changing selection, filters, order revision or readiness removes old documents before effects and ignores late responses', async () => {
  for (const next of [{ selectedIds: ['order-2'] }, { filterQuery: 'status=SHIPPED' }, { sourceRevision: 'orders-v2' }, { ready: false }, { open: false }, { disabled: true }]) {
    const app = mount()
    await prepare(app)
    assert.ok(portal(app))
    app.setProps(next)
    if (next.filterQuery && app.requests.length === 1) {
      // A filter string alone is irrelevant in selected mode; selected IDs are frozen.
      assert.ok(portal(app))
    } else assert.equal(portal(app), undefined)
    app.unmount()
  }
  const pending = deferred()
  const app = mount({ queues: [() => pending.promise] })
  prepareButton(app).props.onClick(); app.render()
  app.setProps({ selectedIds: ['order-2'] })
  pending.resolve(response(batch())); await flush(app)
  assert.equal(portal(app), undefined)
  assert.equal(app.requests[0].signal.aborted, true)
  app.unmount()
})

test('A filtered preview and a font-waiting print cannot survive a filter revision or account switch', async () => {
  const fonts = deferred()
  const app = mount({ fonts: fonts.promise, props: { mode: 'filtered' } })
  await prepare(app)
  printButton(app).props.onClick(); app.render()
  app.setProps({ filterQuery: 'status=SHIPPED&range=today' })
  fonts.resolve(); await flush(app)
  assert.equal(portal(app), undefined); assert.equal(app.printCount, 0)
  app.unmount()
  const other = mount()
  await prepare(other)
  other.setUser('admin-2'); other.flushTimers()
  assert.equal(portal(other), undefined)
  assert.equal(other.requests.length, 1, 'Account changes never load old private documents automatically')
  assert.equal(other.attributes.has('data-order-documents-preview'), false)
  other.unmount()
})

test('Kind changes invalidate prepared documents and the next request uses the new document kind', async () => {
  const app = mount({ queues: [response(batch()), response(batch({ kind: 'packing', rows: [row(fulfillment())] }))] })
  await prepare(app)
  button(app, 'بازگشت به سفارش‌ها').props.onClick(); app.render()
  changeKind(app, 'packing')
  assert.equal(button(app, 'بازکردن دوبارهٔ پیش‌نمایش'), undefined)
  await prepare(app)
  assert.equal(JSON.parse(app.requests[1].body).kind, 'packing')
  assert.match(text(app.tree), /برگهٔ جمع‌آوری و بسته‌بندی/)
  assert.equal(/تومان|۲۱۰٬۰۰۰|۱۰۰٬۰۰۰/.test(text(portal(app))), false, 'Packing docs must not expose monetary amounts')
  app.unmount()
})

test('No eligible documents keeps printing unavailable and preserves per-order reasons', async () => {
  const app = mount({ queues: [response(batch({ rows: [row(invoice(), { eligible: false, document: null, reason: 'فاکتور ذخیره‌شده ناقص است.' })] }))] })
  await prepare(app)
  assert.ok(portal(app)); assert.equal(printButton(app).props.disabled, true)
  printButton(app).props.onClick(); await flush(app)
  assert.equal(app.printCount, 0); assert.match(text(app.tree), /فاکتور ذخیره‌شده ناقص است/)
  app.unmount()
})

test('Duplicate or incomplete responses never become printable and server failures remain actionable', async () => {
  const malformed = [
    batch({ rows: [] }), batch({ kind: 'packing' }), batch({ rows: [row(), row()] }),
    batch({ rows: [row(invoice('another-order'))] }), batch({ rows: [row(invoice(), { document: null })] }),
    batch({ rows: [row({ ...invoice(), invoice: { ...invoice().invoice, snapshot: { ...invoice().invoice.snapshot, items: [] } } })] }),
    batch({ rows: [row(invoice(), { warnings: [false] })] }),
  ]
  for (const data of malformed) {
    const app = mount({ queues: [response(data)] })
    await prepare(app)
    assert.equal(portal(app), undefined); assert.match(text(app.tree), /مدارک کامل و معتبر دریافت نشدند/)
    assert.equal(app.busyEvents.at(-1), false)
    app.unmount()
  }
  const app = mount({ queues: [response({ error: 'حداکثر ۱۰۰ سفارش قابل چاپ است.' }, 413)] })
  await prepare(app)
  assert.match(text(app.tree), /حداکثر ۱۰۰ سفارش قابل چاپ است/); assert.equal(portal(app), undefined)
  app.unmount()
})

test('Escape closes preview, removes its print CSS and restores focus; unmount aborts an active request', async () => {
  const app = mount()
  await prepare(app)
  let prevented = false
  portal(app).props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true } }); app.render()
  assert.equal(prevented, true); assert.equal(portal(app), undefined)
  assert.equal(nodes(app.tree).some(node => node.type === 'style' && node.props.media === 'print'), false)
  assert.ok(app.prepareTrigger.focused > 0)
  app.unmount()
  const pending = deferred(), late = mount({ queues: [() => pending.promise] })
  prepareButton(late).props.onClick(); late.render(); late.unmount()
  assert.equal(late.requests[0].signal.aborted, true)
  pending.resolve(response(batch())); await settle()
  assert.equal(late.printCount, 0)
})

test('Historical invoices use only stored values and prominently mark cancellation or prior approval', () => {
  const app = mount()
  for (const status of ['CANCELLED', 'PENDING']) {
    const doc = invoice('historical-order', { status })
    const rendered = app.exports.OrderPrintDocument({ document: doc })
    const output = text(rendered)
    assert.match(output, /فروشنده زمان صدور|نام کفش هنگام خرید/)
    assert.match(output, /نشانی زمان سفارش/); assert.match(output, /۲۱۰٬۰۰۰/)
    assert.match(output, status === 'CANCELLED' ? /سفارش لغو شده است/ : /تأیید قبلی سفارش/)
    assert.equal(nodes(rendered).some(node => node.props.dangerouslySetInnerHTML), false)
  }
  const label = app.exports.OrderPrintDocument({ document: fulfillment('shipping-label', { total: 999999, items: [], trackingCode: '9'.repeat(200) }) })
  assert.match(text(label), /۱۲۳۴۵|1234567890/)
  assert.equal(/تومان|۹۹۹٬۹۹۹/.test(text(label)), false)
  app.unmount()
})
