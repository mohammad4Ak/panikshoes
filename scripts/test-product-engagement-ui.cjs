const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const pricingModule = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/pricing.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: pricingModule, Date })

const settle = () => new Promise(setImmediate)
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const buyer = { user: { id: 'buyer-one', name: 'مشتری نمونه' } }
const report = (overrides = {}) => ({
  reviews: [], total: 0, page: 1, pageSize: 10,
  summary: { average: 0, count: 0, distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, count: 0 })) },
  myReview: null, ...overrides,
})
const review = { id: 'review-one', rating: 5, comment: 'کیفیت خیلی خوب', authorName: 'خریدار نمونه', verifiedBuyer: true, createdAt: '2026-10-09T08:00:00.000Z' }
const myReview = { id: 'mine', rating: 4, comment: 'تجربهٔ من', status: 'APPROVED' }
const product = { id: 'shoe-one', name: 'کفش نمونه', slug: 'panik-498', description: '', price: 1900000, images: ['/one.png', '/two.png'], sizes: [38, 39], colors: ['مشکی'], stock: 2, category: { name: 'رسمی' } }

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree?.props) return []
  return [tree, ...nodes(tree.props.children)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}

// Execute actual components and asynchronous handlers, with isolated hooks and
// network doubles. Product reviews are never written to the application DB.
function mount({ kind = 'reviews', props = {}, session = null, queue = [] } = {}) {
  const slots = [], pendingEffects = [], requests = [], saved = [], cart = []
  let cursor = 0, tree, stateWrites = 0, currentSession = session, currentProps = props
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, (next) => { stateWrites++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useId() { return 'review-field-' + cursor++ },
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
  const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/image': { __esModule: true, default: 'Image' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session: currentSession }) },
    '@/components/ui/BrandIcons': { SneakerIcon: 'SneakerIcon' },
    '@/lib/utils': { formatPrice: (value) => String(value) },
    '@/lib/pricing': pricingModule.exports,
    '@/lib/cart': { useCart: (selector) => selector({ addItem: (item) => cart.push(item) }) },
    '@/lib/toast': { toast() {} },
    './ProductReviews': { __esModule: true, default: 'ProductReviews' },
  }
  const files = { reviews: 'ProductReviews.tsx', form: 'ProductReviews.tsx', detail: 'ProductDetail.tsx', card: 'ProductCard.tsx' }
  let source = readFileSync(path.join(__dirname, '../src/components/shop', files[kind]), 'utf8')
  if (kind === 'form') source = source.replace('function ReviewForm(', 'export function ReviewForm(')
  const context = {
    module: { exports: {} }, AbortController, Intl, Date, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      const value = queue.length ? queue.shift() : response(kind === 'detail' ? product : report())
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value(options) : value
    },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] },
  }
  vm.runInNewContext(transformSync(source, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' }).code, context)
  const component = kind === 'form' ? context.module.exports.ReviewForm : context.module.exports.default
  const defaults = kind === 'form' ? { productId: product.id, myReview: null, onSaved: () => saved.push(true) } : kind === 'detail' ? { slug: product.slug } : kind === 'card' ? { product: { ...product, image: product.images[0], category: 'رسمی' } } : { productId: product.id }
  function render() { cursor = 0; tree = component({ ...defaults, ...currentProps }); pendingEffects.splice(0).forEach((effect) => effect()); return tree }
  render()
  return {
    render, requests, saved, cart,
    get tree() { return tree }, get stateWrites() { return stateWrites },
    setSession(value) { currentSession = value; render() },
    setProps(value) { currentProps = value; render() },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()) },
  }
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const form = (app) => find(app, (node) => node.type === 'form')
const radio = (app, rating) => find(app, (node) => node.type === 'input' && node.props.type === 'radio' && node.props.value === rating)
const submit = async (app) => { await form(app).props.onSubmit({ preventDefault() {} }); app.render() }
const choose = (app, rating) => { radio(app, rating).props.onChange(); app.render() }
const write = (app, value) => { find(app, (node) => node.type === 'textarea').props.onChange({ target: { value } }); app.render() }

test('Guest sees approved reviews and the verified buyer badge, with a login prompt', async () => {
  const app = mount({ queue: [response(report({ reviews: [review], total: 1, summary: { average: 5, count: 1, distribution: [{ rating: 5, count: 1 }] } }))] })
  await settle(); app.render()
  assert.match(text(app.tree), /کیفیت خیلی خوب/)
  assert.match(text(app.tree), /خریدار این محصول/)
  assert.ok(find(app, (node) => node.type === 'Link' && node.props.href === '/login'))
  assert.equal(find(app, (node) => node.type === 'ReviewForm'), undefined)
  app.unmount()
})

test('Signed-in user receives only their own review form and moderation state', async () => {
  const app = mount({ session: buyer, queue: [response(report({ myReview: { ...myReview, status: 'PENDING' } }))] })
  await settle(); app.render()
  const editor = find(app, (node) => node.type === 'ReviewForm')
  assert.equal(editor.props.myReview.id, 'mine')
  assert.equal(editor.props.myReview.status, 'PENDING')
  assert.equal(find(app, (node) => node.type === 'Link' && node.props.href === '/login'), undefined)
  app.unmount()
})

test('Changing session hides private review state immediately and aborts obsolete reads', async () => {
  let finish
  const app = mount({ session: buyer, queue: [response(report({ myReview })), () => new Promise((resolve) => { finish = resolve }), response(report())] })
  await settle(); app.render()
  app.setSession({ user: { id: 'buyer-two' } })
  assert.equal(find(app, (node) => node.type === 'ReviewForm'), undefined)
  app.setSession(null)
  assert.equal(app.requests.at(-2).signal.aborted, true)
  await settle(); app.render()
  const writes = app.stateWrites
  finish(response(report({ myReview })))
  await settle(); app.render()
  assert.equal(app.stateWrites, writes)
  assert.equal(find(app, (node) => node.type === 'ReviewForm'), undefined)
  app.unmount()
})

for (const failure of [new TypeError('offline'), response({ error: 'unavailable' }, 503), response({ reviews: [] })]) {
  test('Review load failure can be retried without hiding the initial product rating', async () => {
    const app = mount({ props: { initialAverage: 4.5, initialCount: 8 }, queue: [failure, response(report({ reviews: [review], total: 1 }))] })
    await settle(); app.render()
    assert.ok(find(app, (node) => node.props.role === 'alert'))
    assert.match(text(app.tree), /8 امتیاز تأییدشده/)
    find(app, (node) => node.type === 'button' && text(node) === 'تلاش دوباره').props.onClick()
    app.render(); await settle(); app.render()
    assert.match(text(app.tree), /کیفیت خیلی خوب/)
    assert.equal(find(app, (node) => node.props.role === 'alert'), undefined)
    app.unmount()
  })
}

test('Review pagination requests the next server page and keeps the current draft editor', async () => {
  const app = mount({ session: buyer, queue: [response(report({ reviews: [review], total: 11, myReview })), response(report({ reviews: [{ ...review, id: 'second', comment: 'صفحه دوم' }], total: 11, page: 2, myReview }))] })
  await settle(); app.render()
  const key = find(app, (node) => node.type === 'ReviewForm').props.myReview.id
  find(app, (node) => node.props['aria-label'] === 'صفحهٔ بعد نظرات').props.onClick()
  app.render(); await settle(); app.render()
  assert.match(app.requests.at(-1).url, /page=2$/)
  assert.match(text(app.tree), /صفحه دوم/)
  assert.equal(find(app, (node) => node.type === 'ReviewForm').props.myReview.id, key)
  app.unmount()
})

test('Rating selection is accessible and an unrated form never posts', async () => {
  const app = mount({ kind: 'form' })
  assert.equal(nodes(app.tree).filter((node) => node.type === 'input' && node.props.type === 'radio').length, 5)
  assert.match(radio(app, 5).props['aria-label'], /5 از ۵/)
  await submit(app)
  assert.equal(app.requests.length, 0)
  assert.match(text(app.tree), /اول امتیازت/)
  app.unmount()
})

test('A rating can be posted without a comment and becomes pending moderation', async () => {
  const app = mount({ kind: 'form', queue: [response({}, 201)] })
  choose(app, 5)
  await submit(app)
  assert.deepEqual(JSON.parse(app.requests[0].body), { rating: 5, comment: '' })
  assert.equal(app.requests[0].method, 'POST')
  assert.match(text(app.tree), /در انتظار تأیید مدیر/)
  assert.equal(app.saved.length, 1)
  app.unmount()
})

test('Editing an approved review preserves the draft, trims submitted text, and explains remoderation', async () => {
  const app = mount({ kind: 'form', props: { myReview }, queue: [response({})] })
  assert.equal(radio(app, 4).props.checked, true)
  assert.match(text(app.tree), /تا تأیید دوباره از نمایش عمومی خارج/)
  write(app, '  نظر اصلاح شده  ')
  await submit(app)
  assert.deepEqual(JSON.parse(app.requests[0].body), { rating: 4, comment: 'نظر اصلاح شده' })
  assert.match(text(app.tree), /در انتظار تأیید مدیر/)
  app.unmount()
})

test('Rejected moderation reason is visible as plain text without publishing the review', () => {
  const app = mount({ kind: 'form', props: { myReview: { ...myReview, status: 'REJECTED', moderationNote: '<b>لطفاً اصلاح کن</b>' } } })
  assert.ok(text(app.tree).includes('توضیح مدیر: <b>لطفاً اصلاح کن</b>'))
  assert.equal(nodes(app.tree).some((node) => node.props.dangerouslySetInnerHTML), false)
  app.unmount()
})

for (const status of [401, 429, 500]) {
  test('Failed review submission retains rating and text and displays the server reason: ' + status, async () => {
    const app = mount({ kind: 'form', queue: [response({ error: 'ثبت نظر ممکن نشد' }, status)] })
    choose(app, 3); write(app, 'متن نگه داشته شود')
    await submit(app)
    assert.match(text(app.tree), /ثبت نظر ممکن نشد/)
    assert.equal(radio(app, 3).props.checked, true)
    assert.equal(find(app, (node) => node.type === 'textarea').props.value, 'متن نگه داشته شود')
    assert.equal(app.saved.length, 0)
    app.unmount()
  })
}

test('Double submission sends one request and late responses after unmount write no state', async () => {
  let finish
  const app = mount({ kind: 'form', queue: [() => new Promise((resolve) => { finish = resolve })] })
  choose(app, 5)
  const pending = form(app).props.onSubmit({ preventDefault() {} })
  await form(app).props.onSubmit({ preventDefault() {} })
  assert.equal(app.requests.length, 1)
  app.unmount()
  assert.equal(app.requests[0].signal.aborted, true)
  const writes = app.stateWrites
  finish(response({}))
  await pending
  assert.equal(app.stateWrites, writes)
  assert.equal(app.saved.length, 0)
})

test('Product detail displays ordered specifications and approved ratings without changing cart selection', async () => {
  const app = mount({ kind: 'detail', queue: [response({ ...product, ratingAverage: 4.5, ratingCount: 2, specifications: [{ name: 'جنس رویه', value: 'ورنی مات' }, { name: 'ارتفاع پاشنه', value: '۱۰ سانتی‌متر' }] })] })
  await settle(); app.render()
  const rows = nodes(app.tree).filter((node) => node.type === 'tr')
  assert.deepEqual(rows.map(text), ['جنس رویهورنی مات', 'ارتفاع پاشنه۱۰ سانتی‌متر'])
  assert.ok(find(app, (node) => node.props.href === '#product-reviews'))
  find(app, (node) => node.type === 'button' && text(node) === 'افزودن به سبد خرید').props.onClick()
  assert.equal(app.cart[0].size, 38)
  assert.equal(app.cart[0].quantity, 1)
  assert.equal(find(app, (node) => node.type === 'ProductReviews').props.initialCount, 2)
  app.unmount()
})

test('Product detail omits an empty specifications table and rejects stale product responses', async () => {
  let finish
  const app = mount({ kind: 'detail', queue: [() => new Promise((resolve) => { finish = resolve }), response({ ...product, id: 'new-shoe', slug: 'new-shoe', name: 'مدل جدید' })] })
  app.setProps({ slug: 'new-shoe' })
  await settle(); app.render()
  assert.equal(app.requests[0].signal.aborted, true)
  assert.match(text(app.tree), /مدل جدید/)
  assert.equal(find(app, (node) => node.type === 'table'), undefined)
  finish(response(product)); await settle(); app.render()
  assert.match(text(app.tree), /مدل جدید/)
  assert.equal(find(app, (node) => node.type === 'ProductReviews').props.productId, 'new-shoe')
  app.unmount()
})

test('Product cards show a rating only when approved ratings exist, preserving stock behavior', () => {
  const app = mount({ kind: 'card', props: { product: { ...product, image: '/one.png', category: 'رسمی', ratingAverage: 4.5, ratingCount: 2, stock: 0 } } })
  assert.ok(find(app, (node) => node.props['aria-label']?.startsWith('امتیاز')))
  assert.ok(find(app, (node) => node.type === 'button' && node.props.disabled))
  app.setProps({ product: { ...product, image: '/one.png', category: 'رسمی', ratingAverage: 0, ratingCount: 0 } })
  assert.equal(find(app, (node) => node.props['aria-label']?.startsWith('امتیاز')), undefined)
  app.unmount()
})

test('Product cards display an original price and discount badge only while a sale is active', () => {
  const app = mount({ kind: 'card', props: { product: { ...product, image: '/one.png', category: 'رسمی', salePrice: 1520000 } } })
  assert.equal(text(find(app, node => node.type === 'del')), '1900000 تومان')
  assert.match(text(app.tree), /1520000/)
  assert.match(text(app.tree), /20٪ تخفیف/)
  app.setProps({ product: { ...product, image: '/one.png', category: 'رسمی', salePrice: 1520000, saleEndsAt: '2000-01-01T00:00:00Z' } })
  assert.equal(find(app, node => node.type === 'del'), undefined)
  assert.ok(!text(app.tree).includes('1520000'))
  app.unmount()
})

test('Product detail adds the effective sale price to cart while retaining the original price and selected variant', async () => {
  const app = mount({ kind: 'detail', queue: [response({ ...product, salePrice: 1500000 })] })
  await settle(); app.render()
  assert.equal(text(find(app, node => node.type === 'del')), '1900000 تومان')
  find(app, node => node.type === 'button' && text(node) === 'افزودن به سبد خرید').props.onClick()
  assert.equal(app.cart[0].price, 1500000)
  assert.equal(app.cart[0].originalPrice, 1900000)
  assert.equal(app.cart[0].size, 38)
  assert.equal(app.cart[0].color, 'مشکی')
  app.unmount()
})


test('Review login link returns to this product and its review section', async () => {
  const app = mount({ props: { slug: product.slug } })
  await settle(); app.render()
  const link = find(app, (node) => node.type === 'Link' && node.props.href.startsWith('/login?'))
  assert.equal(new URL(link.props.href, 'http://localhost').searchParams.get('callbackUrl'), '/products/panik-498#product-reviews')
  app.unmount()
})


test('Canonical review summary is reported back to the detail header after remoderation', async () => {
  const summaries = []
  const app = mount({ props: { onSummaryChange: (summary) => summaries.push(summary) }, queue: [response(report({ summary: { average: 4.5, count: 2, distribution: [] } }))] })
  await settle(); app.render()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].average, 4.5)
  assert.equal(summaries[0].count, 2)
  app.unmount()
})


test('A last page emptied by moderation returns to the remaining approved review page', async () => {
  const app = mount({ queue: [response(report({ reviews: [review], total: 11 })), response(report({ reviews: [], total: 10, page: 2 })), response(report({ reviews: [review], total: 10 }))] })
  await settle(); app.render()
  find(app, (node) => node.props['aria-label'] === 'صفحهٔ بعد نظرات').props.onClick()
  app.render(); await settle(); app.render(); await settle(); app.render()
  assert.match(app.requests.at(-2).url, /page=2$/)
  assert.match(app.requests.at(-1).url, /page=1$/)
  assert.match(text(app.tree), /کیفیت خیلی خوب/)
  assert.ok(!text(app.tree).includes('اولین تجربه را تو بنویس'))
  app.unmount()
})

test('Changing to a different account clamps an unavailable review page without exposing old own-review data', async () => {
  const app = mount({ session: buyer, queue: [response(report({ reviews: [review], total: 11, myReview })), response(report({ reviews: [review], total: 11, page: 2, myReview })), response(report({ reviews: [], total: 1, page: 2 })), response(report({ reviews: [review], total: 1 }))] })
  await settle(); app.render()
  find(app, (node) => node.props['aria-label'] === 'صفحهٔ بعد نظرات').props.onClick()
  app.render(); await settle(); app.render()
  app.setSession({ user: { id: 'buyer-two' } })
  assert.equal(find(app, (node) => node.type === 'ReviewForm'), undefined)
  await settle(); app.render(); await settle(); app.render()
  assert.match(app.requests.at(-1).url, /page=1$/)
  assert.match(text(app.tree), /کیفیت خیلی خوب/)
  assert.equal(find(app, (node) => node.type === 'ReviewForm').props.myReview, null)
  app.unmount()
})
