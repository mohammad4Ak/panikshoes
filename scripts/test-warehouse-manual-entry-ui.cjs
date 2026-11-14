const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')

const endpoint = '/api/admin/inventory/import/products'
const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const product = (extra = {}) => ({ id: 'p1', code: 'PN-001', name: 'مدل اول', variantsTruncated: false, variants: [{ id: 'v1', size: 38, color: 'مشکی', stock: 8, isActive: false }, { id: 'v2', size: 39, color: 'مشکی', stock: 3, isActive: true }, { id: 'v3', size: 40, color: 'سفید', stock: 4, isActive: true }], ...extra })
const lookup = (products = [product()], pagination = {}) => ({ products, pagination: { page: 1, pages: 1, total: products.length, pageSize: 20, ...pagination } })
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const find = (app, predicate) => nodes(app.tree).find(predicate)
const field = (app, label) => find(app, node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label)
const button = (app, label) => find(app, node => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label))
const addButton = (app, name = 'مدل اول', code = 'PN-001') => button(app, `افزودن ردیف برای ${name}، کد ${code}`)
const search = (app, value) => change(app, 'جست‌وجوی محصول برای ورود دستی', value)

function compile(file, dependencies = {}, globals = {}) {
  const result = { exports: {} }
  const scope = { module: result, require(name) { assert.ok(name in dependencies, name); return dependencies[name] }, ...globals }
  Function(...Object.keys(scope), transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code)(...Object.values(scope))
  return result.exports
}

function mount({ queue = [], props = {} } = {}) {
  const contexts = new Map(), effects = [], timers = new Map(), requests = []
  let active, tree, now = 0, timerId = 0, writes = 0, latest = [], changeCount = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useRef(value) { const index = active.cursor++; return active.slots[index] ??= { current: value } },
    useState(initial) { const index = active.cursor++, context = active; context.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [context.slots[index].value, next => { writes++; context.slots[index].value = typeof next === 'function' ? next(context.slots[index].value) : next }] },
    useEffect(callback, dependencies) { const index = active.cursor++, context = active; if (!context.slots[index] || !same(context.slots[index].dependencies, dependencies)) { context.slots[index]?.cleanup?.(); context.slots[index] = { dependencies }; effects.push(() => { context.slots[index].cleanup = callback() }) } },
  }
  function renderComponent(component, props, key) {
    const previous = active
    active = contexts.get(key) ?? { slots: [], cursor: 0 }
    contexts.set(key, active); active.cursor = 0
    const result = component(props)
    active = previous
    return result
  }
  const jsx = (type, props) => typeof type === 'function' ? renderComponent(type, props, `${type.name}:${props['aria-label'] ?? ''}`) : { type, props }
  const numbers = compile('src/lib/localized-input.ts')
  const contract = compile('src/lib/warehouse-import-contract.ts')
  const shared = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@/lib/localized-input': numbers }
  const numeric = compile('src/components/ui/FormattedNumberInput.tsx', shared, { document: { activeElement: null }, queueMicrotask() {} })
  const component = compile('src/components/admin/WarehouseManualEntry.tsx', {
    ...shared,
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) },
    '@/components/ui/FormattedNumberInput': numeric,
    '@/lib/warehouse-import-contract': contract,
    './warehouse-manual-entry.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }, {
    AbortController,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options) => { requests.push({ url, ...options }); const value = queue.length ? queue.shift() : response(lookup()); if (value instanceof Error) throw value; return typeof value === 'function' ? value(url, options) : value },
  }).default
  let currentProps = { onChange(value) { latest = value; changeCount++ }, ...props }
  const render = () => { tree = renderComponent(component, currentProps, 'editor'); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return {
    render, requests,
    get tree() { return tree }, get latest() { return latest }, get changeCount() { return changeCount }, get writes() { return writes },
    setProps(next) { currentProps = { ...currentProps, ...next }; render() },
    async advance(milliseconds) {
      const until = now + milliseconds
      while (true) {
        const first = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!first) break
        now = first[1].at; timers.delete(first[0]); first[1].callback(); render(); await settle(); render()
      }
      now = until; await settle(); render()
    },
    unmount() { for (const context of contexts.values()) context.slots.forEach(slot => slot?.cleanup?.()) },
  }
}

function change(app, label, value) {
  const control = field(app, label)
  assert.ok(control, label)
  if (control.type === 'input' && control.props.inputMode === 'numeric') {
    const target = { value, selectionStart: value.length, selectionEnd: value.length, setCustomValidity(message) { this.validationMessage = message }, setSelectionRange() {} }
    control.props.onChange({ currentTarget: target })
  } else control.props.onChange({ target: { value } })
  app.render()
}
function add(app, name, code) { const control = addButton(app, name, code); assert.ok(control, 'Product result'); control.props.onClick(); app.render() }
function select(app, row = '۱', color = 'مشکی', size = '38', quantity = '۵') { change(app, `رنگ ردیف ${row}`, color); change(app, `سایز ردیف ${row}`, size); change(app, `تعداد ردیف ${row}`, quantity) }
async function ready(options) { const app = mount(options); await app.advance(300); return app }

test('Name/code lookup is debounced, read-only and adds an incomplete row without choosing a variant', async () => {
  const app = mount()
  assert.equal(app.changeCount, 0)
  assert.equal(field(app, 'جست‌وجوی محصول برای ورود دستی').props.maxLength, 120)
  search(app, 'PN'); await app.advance(150); search(app, ' PN-001 ')
  await app.advance(299); assert.equal(app.requests.length, 0)
  await app.advance(1)
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].url, endpoint + '?q=PN-001&page=1')
  assert.equal(app.requests[0].cache, 'no-store'); assert.ok(app.requests[0].signal)
  add(app)
  assert.deepEqual(app.latest.map(({ sourceError, ...row }) => row), [{ rowNumber: 1, code: 'PN-001', color: '', size: '', quantity: '' }])
  assert.match(app.latest[0].sourceError, /رنگ.*سایز.*عدد/)
  assert.equal(field(app, 'سایز ردیف ۱').props.disabled, true)
  assert.ok(text(app.tree).includes('مدل اول'))
  assert.equal(nodes(app.tree).some(node => node.type === 'input' && node.props.value === 'PN-001'), false)
  assert.equal(app.requests.every(request => !request.method || request.method === 'GET'), true)
  app.unmount()
})

test('Dependent selections emit exact code/variant values and the real formatted input emits canonical quantities', async () => {
  const app = await ready(); add(app)
  change(app, 'رنگ ردیف ۱', 'مشکی')
  assert.deepEqual(nodes(field(app, 'سایز ردیف ۱')).filter(node => node.type === 'option').map(node => node.props.value), ['', '38', '39'])
  assert.equal(field(app, 'سایز ردیف ۱').props.value, '')
  change(app, 'سایز ردیف ۱', '38'); change(app, 'تعداد ردیف ۱', '۱٬۲۵۰')
  assert.deepEqual(app.latest, [{ rowNumber: 1, code: 'PN-001', color: 'مشکی', size: '38', quantity: '1250' }])
  assert.equal(field(app, 'تعداد ردیف ۱').props.value, '۱٬۲۵۰')
  assert.match(text(app.tree), /تنوع غیرفعال است؛ ثبت موجودی آن را فعال نمی‌کند/)
  const count = app.changeCount
  change(app, 'سایز ردیف ۱', '99'); assert.equal(app.changeCount, count)
  change(app, 'سایز ردیف ۱', '38'); assert.equal(app.changeCount, count); assert.equal(app.latest[0].quantity, '1250')
  change(app, 'رنگ ردیف ۱', 'مشکی'); assert.equal(app.changeCount, count); assert.equal(app.latest[0].quantity, '1250')
  change(app, 'سایز ردیف ۱', '39')
  assert.equal(app.latest[0].size, '39'); assert.equal(app.latest[0].quantity, '')
  change(app, 'تعداد ردیف ۱', '۳')
  change(app, 'رنگ ردیف ۱', 'سفید')
  assert.equal(app.latest[0].size, ''); assert.equal(app.latest[0].quantity, '')
  assert.match(app.latest[0].sourceError, /سایز.*عدد/)
  assert.deepEqual(nodes(field(app, 'سایز ردیف ۱')).filter(node => node.type === 'option').map(node => node.props.value), ['', '40'])
  app.unmount()
})

test('Quantity editing preserves zero, rejects malformed input and keeps over-limit/blank rows for preview errors', async () => {
  const app = await ready(); add(app); select(app)
  change(app, 'تعداد ردیف ۱', '٠'); assert.equal(app.latest[0].quantity, '0'); assert.equal(app.latest[0].sourceError, undefined)
  const count = app.changeCount
  for (const value of ['-2', '1e3', '۱٫۵']) change(app, 'تعداد ردیف ۱', value)
  assert.equal(app.changeCount, count); assert.equal(app.latest[0].quantity, '0')
  change(app, 'تعداد ردیف ۱', '۲٬۱۴۷٬۴۸۳٬۶۴۸')
  assert.equal(app.latest[0].quantity, '2147483648'); assert.match(app.latest[0].sourceError, /بیشتر/)
  change(app, 'تعداد ردیف ۱', '')
  assert.equal(app.latest.length, 1); assert.equal(app.latest[0].quantity, ''); assert.match(app.latest[0].sourceError, /وارد/)
  app.unmount()
})

test('Every duplicate row remains invalid, and removing one restores the survivor and renumbers source rows', async () => {
  const app = await ready(); add(app); select(app); add(app)
  change(app, 'رنگ ردیف ۲', 'مشکی'); change(app, 'سایز ردیف ۲', '38')
  assert.equal(app.latest.length, 2)
  assert.ok(app.latest.every(row => /تکراری/.test(row.sourceError)))
  assert.equal(app.latest[0].quantity, '5'); assert.equal(app.latest[1].quantity, '')
  change(app, 'تعداد ردیف ۲', '۷')
  assert.equal(app.latest[0].quantity, '5'); assert.equal(app.latest[1].quantity, '7')
  button(app, 'حذف ردیف ۱').props.onClick(); app.render()
  assert.deepEqual(app.latest, [{ rowNumber: 1, code: 'PN-001', color: 'مشکی', size: '38', quantity: '7' }])
  button(app, 'حذف ردیف ۱').props.onClick(); app.render(); assert.deepEqual(app.latest, [])
  app.unmount()
})

test('Single variants still require explicit selections; inactive and truncated variants remain visible with warnings', async () => {
  const app = await ready({ queue: [response(lookup([product({ variants: [product().variants[0]], variantsTruncated: true })]))] })
  assert.match(text(app.tree), /۵۰۰ تنوع نخست نمایش داده می‌شود/)
  add(app)
  assert.equal(app.latest[0].color, ''); assert.equal(app.latest[0].size, '')
  assert.match(text(app.tree), /سایر تنوع‌ها را با اکسل وارد کنید/)
  select(app)
  assert.equal(app.latest[0].sourceError, undefined)
  assert.match(text(app.tree), /غیرفعال/)
  app.unmount()
})

test('A changed search aborts the old request and ignores late results and stale selection handlers', async () => {
  const pending = deferred()
  const fresh = product({ id: 'p2', code: 'PN-002', name: 'مدل دوم' })
  const app = mount({ queue: [() => pending.promise, response(lookup([fresh]))] })
  await app.advance(300)
  search(app, 'PN-002'); assert.equal(app.requests[0].signal.aborted, true)
  await app.advance(300)
  assert.ok(addButton(app, 'مدل دوم', 'PN-002'))
  pending.resolve(response(lookup())); await settle(); app.render()
  assert.equal(addButton(app), undefined)
  const stale = addButton(app, 'مدل دوم', 'PN-002')
  search(app, 'جست‌وجوی تازه'); stale.props.onClick(); app.render()
  assert.equal(app.changeCount, 0)
  app.unmount()
})

test('Disabling the editor blocks captured handlers, aborts lookup and preserves the draft when enabled again', async () => {
  const pending = deferred(), app = await ready({ queue: [response(lookup()), () => pending.promise, response(lookup())] })
  add(app); select(app)
  const addOld = addButton(app), colorOld = field(app, 'رنگ ردیف ۱'), sizeOld = field(app, 'سایز ردیف ۱'), quantityOld = field(app, 'تعداد ردیف ۱'), removeOld = button(app, 'حذف ردیف ۱'), searchOld = field(app, 'جست‌وجوی محصول برای ورود دستی')
  search(app, 'PN'); await app.advance(300)
  app.setProps({ disabled: true })
  assert.equal(app.requests.at(-1).signal.aborted, true)
  assert.ok(nodes(app.tree).filter(node => ['button', 'input', 'select'].includes(node.type)).every(node => node.props.disabled))
  const count = app.changeCount
  addOld.props.onClick(); colorOld.props.onChange({ target: { value: 'سفید' } }); sizeOld.props.onChange({ target: { value: '39' } })
  quantityOld.props.onChange({ currentTarget: { value: '۹', selectionStart: 1, setCustomValidity() {} } })
  removeOld.props.onClick(); searchOld.props.onChange({ target: { value: 'تغییر ممنوع' } }); app.render()
  assert.equal(app.changeCount, count)
  assert.equal(app.latest[0].quantity, '5'); assert.equal(field(app, 'جست‌وجوی محصول برای ورود دستی').props.value, 'PN')
  const writes = app.writes
  pending.resolve(response(lookup([product({ name: 'پاسخ قدیمی' })]))); await settle(); app.render()
  assert.equal(app.writes, writes); assert.doesNotMatch(text(app.tree), /پاسخ قدیمی/)
  app.setProps({ disabled: false }); await app.advance(300)
  assert.equal(field(app, 'تعداد ردیف ۱').props.value, '۵')
  assert.ok(addButton(app)); assert.equal(app.requests.length, 3)
  app.unmount()
})

test('Unmounting aborts pending requests and ignores late responses and previously rendered edit handlers', async () => {
  const pending = deferred(), app = await ready({ queue: [response(lookup()), () => pending.promise] })
  add(app); const remove = button(app, 'حذف ردیف ۱')
  search(app, 'تازه'); await app.advance(300)
  app.unmount(); assert.equal(app.requests.at(-1).signal.aborted, true)
  const writes = app.writes, changes = app.changeCount
  remove.props.onClick(); pending.resolve(response(lookup())); await settle()
  assert.equal(app.writes, writes); assert.equal(app.changeCount, changes)
})

test('Lookup errors have a working retry; incomplete response data never becomes selectable', async () => {
  const app = await ready({ queue: [response({ error: 'دسترسی غیرمجاز' }, 403), response({ products: [], pagination: { page: 1 } }), response(lookup())] })
  assert.match(text(app.tree), /دسترسی غیرمجاز/)
  button(app, 'تلاش دوباره').props.onClick(); app.render(); await app.advance(300)
  assert.match(text(app.tree), /فهرست کامل محصولات دریافت نشد/); assert.equal(addButton(app), undefined)
  button(app, 'تلاش دوباره').props.onClick(); app.render(); await app.advance(300)
  assert.ok(addButton(app)); assert.equal(app.requests.length, 3)
  app.unmount()
})

test('A request timeout exposes retry and aborts the request', async () => {
  const app = mount({ queue: [(_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))] })
  await app.advance(300); await app.advance(15000)
  assert.equal(app.requests[0].signal.aborted, true)
  assert.match(text(app.tree), /زمان مقرر/); assert.ok(button(app, 'تلاش دوباره'))
  app.unmount()
})

test('Pagination keeps the search and safely follows a server-clamped page without a retry loop', async () => {
  const app = await ready({ queue: [response(lookup([product()], { pages: 2, total: 21 })), response(lookup([], { page: 1, pages: 1, total: 0 })), response(lookup([], { page: 1, pages: 1, total: 0 }))] })
  button(app, 'بعدی').props.onClick(); app.render(); await app.advance(300)
  assert.equal(app.requests[1].url, endpoint + '?q=&page=2')
  await app.advance(300)
  assert.equal(app.requests[2].url, endpoint + '?q=&page=1')
  assert.match(text(app.tree), /محصولی با این نام یا کد پیدا نشد/)
  assert.equal(button(app, 'تلاش دوباره'), undefined)
  await app.advance(1000); assert.equal(app.requests.length, 3)
  app.unmount()
})

test('Rapid repeated additions obey both per-product and total row limits without losing source rows', async () => {
  const second = product({ id: 'p2', name: 'مدل دوم', code: 'PN-002' }), third = product({ id: 'p3', name: 'مدل سوم', code: 'PN-003' })
  const app = await ready({ queue: [response(lookup([product(), second, third]))] })
  const firstAdd = addButton(app), secondAdd = addButton(app, 'مدل دوم', 'PN-002'), thirdAdd = addButton(app, 'مدل سوم', 'PN-003')
  for (let index = 0; index < 501; index++) firstAdd.props.onClick()
  app.render(); assert.equal(app.latest.length, 500); assert.equal(app.changeCount, 500)
  assert.match(text(app.tree), /هر محصول حداکثر ۵۰۰/)
  for (let index = 0; index < 500; index++) secondAdd.props.onClick()
  thirdAdd.props.onClick(); app.render()
  assert.equal(app.latest.length, 1000); assert.equal(app.changeCount, 1000)
  assert.equal(app.latest[999].rowNumber, 1000); assert.ok(app.latest.every(row => row.sourceError))
  assert.match(text(app.tree), /حداکثر ۱۰۰۰ ردیف/)
  app.unmount()
})
