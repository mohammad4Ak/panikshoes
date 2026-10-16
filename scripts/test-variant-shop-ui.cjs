const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const product = {
  id: 'shoe', name: 'کفش پانیک', slug: 'shoe', description: '', price: 100000, images: [], sizes: [38, 39, 40, 41], colors: ['آبی', 'قرمز'], stock: 3,
  inventoryConfigured: true, category: { name: 'رسمی' }, variants: [
    { id: 'blue-38', size: 38, color: 'آبی', stock: 2, isActive: true },
    { id: 'red-39', size: 39, color: 'قرمز', stock: 1, isActive: true },
    { id: 'red-40', size: 40, color: 'قرمز', stock: 0, isActive: true },
    { id: 'blue-41', size: 41, color: 'آبی', stock: 5, isActive: false },
  ],
}
const line = (size, color, quantity = 1) => ({ productId: product.id, name: product.name, price: product.price, image: '', size, color, quantity })
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node) === label)

function mount(kind = 'detail', data = product, items = []) {
  const slots = [], effects = [], requests = [], added = []
  let cursor = 0, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
    useCallback(callback) { cursor++; return callback },
  }
  const cart = {
    items,
    addItem(item) { added.push(item); const old = cart.items.find(row => row.productId === item.productId && row.size === item.size && row.color === item.color); if (old) old.quantity += item.quantity; else cart.items.push(item) },
    updateQuantity(id, size, color, quantity) { cart.items = cart.items.map(item => item.productId === id && item.size === size && item.color === color ? { ...item, quantity } : item).filter(item => item.quantity > 0) },
    removeItem(id, size, color) { cart.items = cart.items.filter(item => !(item.productId === id && item.size === size && item.color === color)) },
    getTotal() { return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0) },
    syncPrices(prices) { cart.items = cart.items.map(item => { const price = prices.find(row => row.productId === item.productId); return price ? { ...item, price: price.price, originalPrice: price.originalPrice } : item }) },
  }
  const pricing = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/pricing.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: pricing, Date })
  const jsx = (type, props) => ({ type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'next/link': { __esModule: true, default: 'Link' }, 'next/image': { __esModule: true, default: 'Image' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }), '@/components/ui/BrandIcons': { SneakerIcon: 'SneakerIcon' },
    '@/lib/cart': { useCart: selector => selector ? selector(cart) : cart }, '@/lib/utils': { formatPrice: String }, '@/lib/toast': { toast() {} }, '@/lib/pricing': pricing.exports,
    './ProductReviews': { __esModule: true, default: 'ProductReviews' },
  }
  const compiled = { exports: {} }
  const file = kind === 'cart' ? 'src/app/(shop)/cart/page.tsx' : `src/components/shop/${kind === 'card' ? 'ProductCard' : 'ProductDetail'}.tsx`
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, Date, Intl, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, status: 200, json: async () => data } },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] },
  })
  function render() { cursor = 0; tree = compiled.exports.default(kind === 'card' ? { product: { ...data, image: '', category: 'رسمی' } } : { slug: data.slug }); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, cart, requests, added, get tree() { return tree }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}
async function settle(app) { for (let index = 0; index < 3; index++) { await new Promise(setImmediate); app.render() } }

test('Detail only sells actual active size/color combinations, and switching size picks a compatible color', async () => {
  const app = mount(); await settle(app)
  assert.equal(button(app, '40').props.disabled, true)
  assert.equal(button(app, '41').props.disabled, true)
  assert.equal(button(app, 'قرمز').props.disabled, true)
  button(app, '39').props.onClick(); app.render()
  assert.equal(button(app, 'قرمز').props['aria-pressed'], true)
  assert.equal(button(app, 'آبی').props.disabled, true)
  assert.equal(find(app, node => node.props['aria-label'] === 'افزایش تعداد').props.disabled, true)
  button(app, 'افزودن به سبد خرید').props.onClick(); app.render()
  assert.equal(app.added.length, 1)
  assert.equal(app.added[0].size, 39)
  assert.equal(app.added[0].color, 'قرمز')
  assert.equal(app.added[0].variantId, 'red-39')
  assert.equal(button(app, 'این انتخاب در دسترس نیست').props.disabled, true)
  app.unmount()
})

test('Detail quantity limits subtract the exact variant already in the cart without consuming another color/size', async () => {
  const app = mount('detail', product, [line(38, 'آبی', 1)]); await settle(app)
  assert.equal(find(app, node => node.props['aria-label'] === 'افزایش تعداد').props.disabled, true)
  button(app, 'افزودن به سبد خرید').props.onClick(); app.render()
  assert.equal(app.added[0].quantity, 1)
  assert.equal(app.cart.items.find(item => item.size === 38).quantity, 2)
  assert.equal(button(app, '39').props.disabled, false)
  button(app, '39').props.onClick(); app.render()
  assert.equal(button(app, 'افزودن به سبد خرید').props.disabled, false)
  app.unmount()
})

test('Unconfigured inventory cannot be bought even when a legacy aggregate stock count is positive', async () => {
  const data = { ...product, inventoryConfigured: false, stock: 99 }
  for (const kind of ['detail', 'card']) {
    const app = mount(kind, data); await settle(app)
    assert.match(text(app.tree), /ناموجود/)
    assert.ok(find(app, node => node.type === 'button' && node.props.disabled))
    assert.equal(app.added.length, 0)
    app.unmount()
  }
})

test('Cart checks the chosen variant, caps increases, and requires explicit reduction of excess quantities', async () => {
  const app = mount('cart', product, [line(38, 'آبی', 3), line(39, 'قرمز', 1)]); await settle(app)
  assert.equal(nodes(app.tree).filter(node => node.props['aria-label']?.startsWith('افزایش تعداد')).every(node => node.props.disabled), true)
  assert.ok(!find(app, node => node.type === 'Link' && node.props.href === '/checkout'))
  assert.match(text(app.tree), /فقط 2 جفت موجود است/)
  assert.equal(app.cart.items[0].quantity, 3, 'Inventory refresh never silently removes the customer selection')
  button(app, 'تنظیم تعداد به موجودی').props.onClick(); app.render()
  assert.equal(app.cart.items[0].quantity, 2)
  assert.ok(find(app, node => node.type === 'Link' && node.props.href === '/checkout'))
  app.unmount()
})

test('Legacy and unavailable cart variants remain visible for removal and cannot proceed to checkout', async () => {
  for (const [data, item] of [[{ ...product, inventoryConfigured: false }, line(38, 'آبی')], [product, line(40, 'قرمز')], [product, line(41, 'آبی')], [product, line(38, 'قرمز')]]) {
    const app = mount('cart', data, [item]); await settle(app)
    assert.match(text(app.tree), /این رنگ و سایز فعلاً موجود نیست/)
    assert.ok(!find(app, node => node.type === 'Link' && node.props.href === '/checkout'))
    assert.equal(app.cart.items.length, 1)
    app.unmount()
  }
})
