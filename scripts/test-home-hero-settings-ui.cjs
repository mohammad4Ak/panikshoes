const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const products = Array.from({ length: 12 }, (_, index) => ({ id: 'shoe-' + (index + 1), name: 'مدل کفش ' + (index + 1), stock: index === 1 ? 0 : 2, images: ['/uploads/shoe-' + (index + 1) + '.jpg'], category: { name: index % 2 ? 'رسمی' : 'کتانی' } }))
const noPhoto = { id: 'no-photo', name: 'مدل بدون تصویر', stock: 3, images: [], category: { name: 'کوهنوردی' } }
const contract = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/site-settings-contract.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, contract)

// Real controlled picker handlers run with isolated hooks and fetch; no application/database writes.
function mount(options = {}) {
  const slots = [], effects = [], requests = [], timers = new Map(), selections = [], intervals = []
  const queue = [...(options.queue ?? [])]
  let cursor = 0, tree, stateWrites = 0, nextTimer = 0
  let props = { productIds: [], intervalSeconds: 10, disabled: false, active: true, ...options.props,
    onProductIdsChange(value) { selections.push(value); props = { ...props, productIds: value } },
    onIntervalChange(value) { intervals.push(value); props = { ...props, intervalSeconds: value } },
  }
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { stateWrites++; slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }] },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const jsx = (type, props) => ({ type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'next/image': { __esModule: true, default: 'Image' }, 'lucide-react': new Proxy({}, { get: (_, name) => name }), '@/lib/site-settings-contract': contract.module.exports, './home-hero-settings.module.css': css }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/HomeHeroSettings.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, Error, TypeError,
    async fetch(url, init = {}) { requests.push({ url, ...init }); const value = queue.length ? queue.shift() : response([...products, noPhoto]); if (value instanceof Error) throw value; return typeof value === 'function' ? value(init) : value },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout(id) { timers.delete(id) },
    require(name) { assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] },
  })
  const app = {
    render() { cursor = 0; tree = compiled.exports.default(props); effects.splice(0).forEach(effect => effect()); return tree },
    setProps(next) { props = { ...props, ...next }; return app.render() },
    get tree() { return tree }, get props() { return props }, get stateWrites() { return stateWrites },
    requests, selections, intervals,
    timeout() { for (const callback of [...timers.values()]) callback() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
  app.render(); return app
}
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return tree == null || typeof tree === 'boolean' ? '' : String(tree) }
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, name) => find(app, node => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name))
const checkbox = (app, id) => find(app, node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === 'انتخاب ' + [...products, noPhoto].find(product => product.id === id).name + ' برای بخش اصلی')
const selected = app => nodes(app.tree).filter(node => node.type === 'li')
const field = (app, id) => find(app, node => node.props.id === id)
async function ready(options) { const app = mount(options); await settle(); app.render(); return app }

test('The product picker waits for the homepage section and reads catalog without a save', async () => {
  const app = mount({ props: { active: false } })
  assert.equal(app.requests.length, 0)
  app.setProps({ active: true }); await settle(); app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].url, '/api/products')
  assert.equal(app.requests[0].cache, 'no-store')
  assert.equal(app.requests[0].method, undefined)
  assert.match(text(app.tree), /انتخاب خودکار فروشگاه/)
  assert.equal(selected(app).length, 0)
  app.unmount()
})

test('All categories and unavailable photo products can be selected while products without photos cannot', async () => {
  const app = await ready()
  checkbox(app, 'shoe-1').props.onChange({ target: { checked: true } }); app.render()
  checkbox(app, 'shoe-2').props.onChange({ target: { checked: true } }); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-1', 'shoe-2'])
  assert.equal(checkbox(app, 'shoe-2').props.disabled, false)
  assert.match(text(selected(app)[1]), /ناموجود · قابل نمایش برای معرفی/)
  assert.match(text(app.tree), /نمایش آن امکان خرید را فعال نمی‌کند و موجودی را تغییر نمی‌دهد/)
  assert.equal(checkbox(app, 'no-photo').props.disabled, true)
  checkbox(app, 'no-photo').props.onChange({ target: { checked: true } }); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-1', 'shoe-2'])
  assert.equal(app.requests.length, 1)
  app.unmount()
})

test('Search matches trimmed case-insensitive product names and category names without changing the draft', async () => {
  const app = await ready()
  field(app, 'settings-hero-search').props.onChange({ target: { value: '  رسمی  ' } }); app.render()
  assert.equal(nodes(app.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 6)
  assert.equal(selected(app).length, 0)
  field(app, 'settings-hero-search').props.onChange({ target: { value: 'مدل کفش 12' } }); app.render()
  assert.equal(nodes(app.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 1)
  assert.equal(app.selections.length, 0)
  assert.equal(app.requests.length, 1)
  app.unmount()
})

test('Selected products reorder without mutating their original array and can be removed or reset to automatic', async () => {
  const original = ['shoe-1', 'shoe-2', 'shoe-3']
  const app = await ready({ props: { productIds: original } })
  assert.equal(button(app, 'بالا بردن محصول 1').props.disabled, true)
  assert.equal(button(app, 'پایین بردن محصول 3').props.disabled, true)
  button(app, 'بالا بردن محصول 3').props.onClick(); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-1', 'shoe-3', 'shoe-2'])
  assert.deepEqual(original, ['shoe-1', 'shoe-2', 'shoe-3'])
  button(app, 'حذف محصول 1 از بخش اصلی').props.onClick(); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-3', 'shoe-2'])
  checkbox(app, 'shoe-2').props.onChange({ target: { checked: false } }); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-3'])
  button(app, 'انتخاب خودکار').props.onClick(); app.render()
  assert.deepEqual(Array.from(app.props.productIds), [])
  assert.match(text(app.tree), /انتخاب خودکار فروشگاه/)
  app.unmount()
})

test('Ten selections disable only additions and repeated adds cannot duplicate an ID', async () => {
  const ids = products.slice(0, 10).map(product => product.id)
  const app = await ready({ props: { productIds: ids } })
  assert.equal(checkbox(app, 'shoe-11').props.disabled, true)
  assert.equal(checkbox(app, 'shoe-1').props.disabled, false)
  checkbox(app, 'shoe-11').props.onChange({ target: { checked: true } }); app.render()
  checkbox(app, 'shoe-1').props.onChange({ target: { checked: true } }); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ids)
  checkbox(app, 'shoe-1').props.onChange({ target: { checked: false } }); app.render()
  assert.equal(checkbox(app, 'shoe-11').props.disabled, false)
  checkbox(app, 'shoe-11').props.onChange({ target: { checked: true } }); app.render()
  assert.equal(app.props.productIds.length, 10)
  assert.equal(new Set(app.props.productIds).size, 10)
  app.unmount()
})

test('Saved deleted product IDs remain visible and removable rather than silently disappearing', async () => {
  const app = await ready({ props: { productIds: ['deleted-product', 'shoe-1'] } })
  assert.equal(selected(app).length, 2)
  assert.match(text(selected(app)[0]), /محصول حذف‌شده/)
  assert.match(text(selected(app)[0]), /از انتخاب‌ها حذف کن/)
  button(app, 'حذف محصول 1 از بخش اصلی').props.onClick(); app.render()
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-1'])
  app.unmount()
})

test('An existing product whose image was removed can be explicitly deselected', async () => {
  const app = await ready({ props: { productIds: ['no-photo'] } })
  assert.match(text(selected(app)[0]), /بدون عکس/)
  assert.equal(checkbox(app, 'no-photo').props.disabled, false)
  checkbox(app, 'no-photo').props.onChange({ target: { checked: false } }); app.render()
  assert.deepEqual(Array.from(app.props.productIds), [])
  app.unmount()
})

for (const [name, failure] of [['network', new TypeError('ارتباط برقرار نشد')], ['HTTP', response({ error: 'ویترین در دسترس نیست' }, 503)], ['invalid shape', response({ products: [] })], ['invalid product', response([{ id: 1 }])]]) {
  test('Catalog ' + name + ' failure preserves saved selections and offers an isolated retry', async () => {
    const app = await ready({ props: { productIds: ['shoe-1'] }, queue: [failure, response(products)] })
    assert.ok(find(app, node => node.props.role === 'alert'))
    assert.equal(selected(app).length, 1)
    assert.ok(!text(selected(app)[0]).includes('محصول حذف‌شده'))
    button(app, 'تلاش دوباره').props.onClick(); app.render(); await settle(); app.render()
    assert.equal(app.requests.length, 2)
    assert.equal(find(app, node => node.props.role === 'alert'), undefined)
    assert.match(text(selected(app)[0]), /مدل کفش 1/)
    assert.deepEqual(Array.from(app.props.productIds), ['shoe-1'])
    app.unmount()
  })
}

test('Disabled controls cannot change products, order or timing during a parent request', async () => {
  const app = await ready({ props: { productIds: ['shoe-1', 'shoe-2'], disabled: true } })
  assert.equal(checkbox(app, 'shoe-3').props.disabled, true)
  checkbox(app, 'shoe-3').props.onChange({ target: { checked: true } })
  button(app, 'بالا بردن محصول 2').props.onClick()
  button(app, 'حذف محصول 1 از بخش اصلی').props.onClick()
  button(app, 'انتخاب خودکار').props.onClick()
  field(app, 'settings-homeHeroIntervalSeconds').props.onChange({ target: { value: '15' } })
  assert.deepEqual(Array.from(app.props.productIds), ['shoe-1', 'shoe-2'])
  assert.equal(app.props.intervalSeconds, 10)
  assert.equal(app.selections.length, 0)
  assert.equal(app.intervals.length, 0)
  app.unmount()
})

test('Timing input exposes the integer range and preserves an empty draft for form validation', async () => {
  const app = await ready()
  const timing = field(app, 'settings-homeHeroIntervalSeconds')
  assert.equal(timing.props.min, 5)
  assert.equal(timing.props.max, 120)
  assert.equal(timing.props.step, 1)
  assert.equal(timing.props.required, true)
  timing.props.onChange({ target: { value: '18' } }); app.render()
  assert.equal(app.props.intervalSeconds, 18)
  field(app, 'settings-homeHeroIntervalSeconds').props.onChange({ target: { value: '' } }); app.render()
  assert.equal(Number.isNaN(app.props.intervalSeconds), true)
  assert.equal(field(app, 'settings-homeHeroIntervalSeconds').props.value, '')
  app.unmount()
})

test('Leaving the homepage aborts its catalog request and ignores a stale response after re-entry', async () => {
  const old = deferred()
  const app = mount({ queue: [old.promise, response(products)] })
  const first = app.requests[0]
  app.setProps({ active: false }); app.setProps({ active: true }); await settle(); app.render()
  assert.equal(first.signal.aborted, true)
  assert.ok(checkbox(app, 'shoe-1'))
  old.resolve(response([{ ...products[0], name: 'متن قدیمی' }])); await settle(); app.render()
  assert.ok(checkbox(app, 'shoe-1'))
  assert.ok(!text(app.tree).includes('متن قدیمی'))
  app.unmount()
})

test('Unmount aborts the catalog request without processing its late response', async () => {
  const pending = deferred()
  const app = mount({ queue: [pending.promise] })
  app.unmount()
  const writes = app.stateWrites
  assert.equal(app.requests[0].signal.aborted, true)
  pending.resolve(response(products)); await settle()
  assert.equal(app.stateWrites, writes)
})

test('Catalog timeout offers retry instead of retaining an endless loading state', async () => {
  const app = mount({ queue: [options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))] })
  app.timeout(); await settle(); app.render()
  assert.match(text(app.tree), /دریافت محصولات طول کشید/)
  assert.ok(button(app, 'تلاش دوباره'))
  app.unmount()
})


test('Enter in the hero product search cannot implicitly save the shared settings form, while other keys retain their native behavior', async () => {
  const app = await ready({ props: { productIds: ['shoe-1'] } })
  const search = field(app, 'settings-hero-search')
  let prevented = 0
  search.props.onKeyDown({ key: 'Enter', preventDefault() { prevented++ } })
  assert.equal(prevented, 1)
  for (const key of ['a', 'Backspace', 'Escape', 'ArrowDown', 'Tab', ' ']) search.props.onKeyDown({ key, preventDefault() { prevented++ } })
  assert.equal(prevented, 1)
  assert.equal(app.requests.length, 1)
  assert.equal(app.selections.length, 0)
  assert.equal(app.intervals.length, 0)
  app.unmount()
})
