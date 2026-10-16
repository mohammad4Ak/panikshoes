const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const category = { id: 'cat', name: 'کتانی' }
const product = extra => ({ id: 'shoe', name: 'کفش پانیک', slug: 'panik', description: '', price: 100_000, salePrice: null, images: ['/shoe.webp'], sizes: [40, 41], colors: ['مشکی', 'سفید'], stock: 9, inventoryConfigured: true, inventoryVersion: 7, categoryId: 'cat', category, featured: false, specifications: [], variants: [
  { id: 'v1', size: 40, color: 'مشکی', stock: 2, isActive: true },
  { id: 'v2', size: 40, color: 'سفید', stock: 3, isActive: true },
  { id: 'v3', size: 41, color: 'مشکی', stock: 4, isActive: true },
  { id: 'v4', size: 41, color: 'سفید', stock: 0, isActive: true },
], ...extra })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : [] }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree) }
function mount(initial = product(), queues = {}) {
  const slots = [], effects = [], requests = []
  let cursor = 0, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof value === 'function' ? value() : value }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(value) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index] },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const pricing = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/pricing.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: pricing, Date })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'next/link': { __esModule: true, default: 'Link' }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/lib/utils': { formatPrice: String }, '@/lib/pricing': pricing.exports,
    '@/components/admin/MultiImageInput': { __esModule: true, default: 'Images' },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: 'select' },
    '@/components/ui/PersianDatePicker': { __esModule: true, default: ({ onChange, ...props }) => jsx('input', { ...props, onChange: event => onChange(event.target.value) }) },
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: ({ onValueChange, ...props }) => jsx('input', { ...props, 'data-number': true, onChange: event => onValueChange(event.target.value) }) },
  }
  const result = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/products/page.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: result, AbortController, Date, Error, TypeError,
    fetch: async (url, options = {}) => { requests.push({ url, ...options }); const queue = queues[(options.method || 'GET') + ' ' + url]; const value = queue?.length ? queue.shift() : response(options.method ? initial : url === '/api/categories' ? [category] : [initial]); if (value instanceof Error) throw value; return typeof value === 'function' ? value(options) : value },
    confirm: () => true, require(name) { if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }; assert.ok(name in dependencies, name); return dependencies[name] },
  })
  const render = () => { cursor = 0; tree = result.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  render(); return { render, requests, get tree() { return tree }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node).trim() === label)
const field = (app, id) => find(app, node => node.props.id === id)
const cell = (app, size, color) => find(app, node => node.type === 'input' && node.props['data-variant-size'] === size && node.props['data-variant-color'] === color)
const cells = app => nodes(app.tree).filter(node => node.type === 'input' && node.props['data-variant-size'] !== undefined)
const writes = app => app.requests.filter(request => request.method === 'PUT' || request.method === 'POST')
const save = app => find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
async function ready(initial, queues) { const app = mount(initial, queues); await settle(); app.render(); return app }
function edit(app) { find(app, node => node.type === 'button' && node.props.title === 'ویرایش').props.onClick(); app.render() }
function change(app, node, value) { node.props.onChange({ target: { value } }); app.render() }

test('Metadata-only edits omit inventory, dimensions and legacy total counters', async () => {
  const app = await ready(); edit(app)
  assert.equal(cells(app).length, 4); assert.equal(cell(app, 40, 'مشکی').props.value, '2')
  change(app, find(app, node => node.type === 'input' && node.props.value === 'کفش پانیک'), 'نام تازه')
  await save(app)
  const payload = JSON.parse(writes(app)[0].body)
  for (const key of ['variants', 'sizes', 'colors', 'stock', 'expectedStock', 'expectedInventoryVersion']) assert.equal(Object.hasOwn(payload, key), false, key)
  assert.equal(payload.name, 'نام تازه'); app.unmount()
})
test('Editing one cell submits the complete matrix with its inventory version and no aggregate stock', async () => {
  const app = await ready(); edit(app); change(app, cell(app, 40, 'مشکی'), '12'); await save(app)
  const payload = JSON.parse(writes(app)[0].body)
  assert.equal(payload.expectedInventoryVersion, 7)
  assert.deepEqual(payload.variants.map(row => [row.size, row.color, row.stock]), [[40, 'مشکی', 12], [40, 'سفید', 3], [41, 'مشکی', 4], [41, 'سفید', 0]])
  assert.equal(Object.hasOwn(payload, 'stock'), false); assert.equal(Object.hasOwn(payload, 'expectedStock'), false); app.unmount()
})
test('Dimension edits preserve matching draft counts, zero new combinations and exclude removed rows', async () => {
  const app = await ready(); edit(app); change(app, cell(app, 40, 'سفید'), '8')
  change(app, field(app, 'product-inventory-sizes'), '۴۰،۴۲'); change(app, field(app, 'product-inventory-colors'), 'سفید، قرمز')
  assert.equal(cell(app, 40, 'سفید').props.value, '8'); assert.equal(cell(app, 42, 'قرمز').props.value, '0'); assert.equal(cell(app, 41, 'مشکی'), undefined)
  await save(app); const payload = JSON.parse(writes(app)[0].body)
  assert.deepEqual(payload.sizes, [40, 42]); assert.deepEqual(payload.colors, ['سفید', 'قرمز'])
  assert.deepEqual(payload.variants.map(row => [row.size, row.color, row.stock]), [[40, 'سفید', 8], [40, 'قرمز', 0], [42, 'سفید', 0], [42, 'قرمز', 0]])
  app.unmount()
})
test('Colorless products use the canonical dash; archived counts stay hidden until that size is re-added', async () => {
  const app = await ready(product({ colors: [], variants: [{ id: 'active', size: 40, color: '-', stock: 2, isActive: true }, { id: 'empty', size: 41, color: '-', stock: 0, isActive: true }, { id: 'old', size: 42, color: '-', stock: 8, isActive: false }] })); edit(app)
  assert.equal(cell(app, 41, '-').props.value, '0'); assert.equal(cell(app, 42, '-'), undefined)
  change(app, field(app, 'product-inventory-sizes'), '40, 41, 42')
  assert.equal(cell(app, 42, '-').props.value, '8', 'Known archived inventory must not silently become zero')
  change(app, cell(app, 40, '-'), '3'); await save(app)
  assert.deepEqual(JSON.parse(writes(app)[0].body).variants, [{ size: 40, color: '-', stock: 3 }, { size: 41, color: '-', stock: 0 }, { size: 42, color: '-', stock: 8 }]); app.unmount()
})
test('Legacy stock is never guessed into cells; explicit activation can configure an intentionally empty matrix', async () => {
  const legacy = product({ inventoryConfigured: false, inventoryVersion: 0, stock: 0, legacyStock: 12, variants: [] })
  const app = await ready(legacy); edit(app)
  assert.ok(cells(app).every(node => node.props.value === '0')); assert.match(text(app.tree), /12 جفت موجودی قبلی/)
  button(app, 'فعال‌سازی موجودی تفکیکی').props.onClick(); app.render(); await save(app)
  const payload = JSON.parse(writes(app)[0].body); assert.equal(payload.expectedInventoryVersion, 0); assert.equal(payload.variants.length, 4); assert.ok(payload.variants.every(row => row.stock === 0)); app.unmount()
  const metadata = await ready(legacy); edit(metadata); await save(metadata)
  assert.equal(Object.hasOwn(JSON.parse(writes(metadata)[0].body), 'variants'), false); metadata.unmount()
})
test('Creation sends a complete explicit zero-based matrix rather than a legacy total', async () => {
  const app = await ready(); button(app, 'محصول جدید').props.onClick(); app.render()
  assert.equal(cells(app).length, 8); change(app, cell(app, 40, 'مشکی'), '5'); await save(app)
  const payload = JSON.parse(writes(app)[0].body); assert.equal(writes(app)[0].method, 'POST'); assert.equal(payload.variants.length, 8); assert.equal(payload.variants[0].stock, 5); assert.equal(Object.hasOwn(payload, 'stock'), false); assert.equal(Object.hasOwn(payload, 'expectedInventoryVersion'), false); app.unmount()
})
test('Inventory conflict blocks repeat saves until refresh, then preserves metadata and reloads dimensions and version', async () => {
  const fresh = product({ inventoryVersion: 9, sizes: [42], colors: ['قرمز'], stock: 6, variants: [{ id: 'new', size: 42, color: 'قرمز', stock: 6, isActive: true }] })
  const app = await ready(product(), { 'PUT /api/products/shoe': [response({ code: 'PRODUCT_INVENTORY_CHANGED', error: 'موجودی تغییر کرده است' }, 409), response(fresh)], 'GET /api/products/shoe': [response(fresh)] })
  edit(app); change(app, find(app, node => node.type === 'input' && node.props.value === 'کفش پانیک'), 'پیش‌نویس محفوظ'); change(app, cell(app, 40, 'مشکی'), '7')
  await save(app); app.render(); assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  await save(app); assert.equal(writes(app).length, 1)
  button(app, 'تازه‌سازی موجودی').props.onClick(); await settle(); app.render()
  assert.ok(find(app, node => node.type === 'input' && node.props.value === 'پیش‌نویس محفوظ')); assert.equal(field(app, 'product-inventory-sizes').props.value, '42'); assert.equal(cells(app).length, 1)
  change(app, cell(app, 42, 'قرمز'), '8'); await save(app)
  const payload = JSON.parse(writes(app)[1].body); assert.equal(payload.name, 'پیش‌نویس محفوظ'); assert.equal(payload.expectedInventoryVersion, 9); assert.deepEqual(payload.variants, [{ size: 42, color: 'قرمز', stock: 8 }]); app.unmount()
})
test('Invalid or oversized matrices and overflowing counts never send an inventory write', async () => {
  for (const scenario of ['fraction', 'empty', 'overflow', 'matrix']) {
    const app = await ready(); edit(app)
    if (scenario === 'matrix') { change(app, field(app, 'product-inventory-sizes'), Array.from({ length: 84 }, (_, index) => String(index + 1)).join(',')); change(app, field(app, 'product-inventory-colors'), 'a,b,c,d,e,f') }
    else change(app, cell(app, 40, 'مشکی'), scenario === 'fraction' ? '1.5' : scenario === 'empty' ? '' : '2147483647')
    await save(app); app.render(); assert.equal(writes(app).length, 0); assert.match(text(app.tree), scenario === 'matrix' ? /۵۰۰ ترکیب/ : /موجودی هر ترکیب/); app.unmount()
  }
})
