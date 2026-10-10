const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Run the real moderation page and native select with isolated hooks/fetch. Never contact a database.
const review = (overrides = {}) => ({
  id: 'review-1', rating: 4, comment: 'کیفیت رویه و اندازه مناسب بود.', status: 'PENDING', moderationNote: null, revision: 3,
  createdAt: '2026-10-08T09:00:00.000Z', updatedAt: '2026-10-08T09:00:00.000Z',
  product: { name: 'کفش پانیک مدل ۶۲۰', slug: 'panik-620' }, user: { name: 'مشتری نمونه' }, ...overrides,
})
const report = (reviews = [review()], overrides = {}) => ({ reviews, total: reviews.length, pending: reviews.filter(item => item.status === 'PENDING').length, page: 1, pageSize: 20, totalPages: 1, ...overrides })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)

function mount({ queues = {}, initial = report() } = {}) {
  const slots = [], effects = [], requests = [], timers = new Map()
  let cursor = 0, tree, stateWrites = 0, nextTimer = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, next => { stateWrites++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.()
        slots[index] = { dependencies }
        effects.push(() => { slots[index].cleanup = callback() })
      }
    },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/lib/utils': { formatPrice: value => String(value) },
  }
  const load = file => {
    const compiledModule = { exports: {} }
    const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
    const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
    const fetch = async (url, options = {}) => {
      requests.push({ url, ...options })
      const pathname = new URL(url, 'http://localhost').pathname
      const key = (options.method || 'GET') + ' ' + url
      const queue = queues[key] || queues[url] || queues[(options.method || 'GET') + ' ' + pathname] || queues[pathname]
      const value = queue?.length ? queue.shift() : response(options.method === 'PUT' ? { review: review() } : initial)
      if (value instanceof Error) throw value
      if (typeof value === 'function') return value(options)
      return value
    }
    vm.runInNewContext(code, {
      module: compiledModule, fetch, AbortController, Error, TypeError, URLSearchParams,
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
      clearTimeout(id) { timers.delete(id) },
      require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] },
    })
    return compiledModule.exports
  }
  dependencies['@/components/ui/EnhancedSelect'] = load('src/components/ui/EnhancedSelect.tsx')
  const component = load('src/app/admin/reviews/page.tsx').default
  const render = () => { cursor = 0; tree = component(); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return {
    render, requests,
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) },
    get tree() { return tree }, get stateWrites() { return stateWrites },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return tree === null || tree === undefined || typeof tree === 'boolean' ? '' : String(tree) }
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node) === label)
const statusSelect = app => find(app, node => node.type === 'select' && node.props['aria-label'] === 'وضعیت نظر')
const searchInput = app => find(app, node => node.type === 'input' && node.props['aria-label'] === 'جستجوی نظرات')
const noteInput = (app, name = 'مشتری نمونه') => find(app, node => node.type === 'input' && node.props['aria-label'] === 'یادداشت بررسی برای ' + name)
const articles = app => nodes(app.tree).filter(node => node.type === 'article')
const writes = app => app.requests.filter(request => request.method === 'PUT')
const reads = app => app.requests.filter(request => !request.method || request.method === 'GET')
async function flush(app) { await settle(); app.render() }
async function ready(options) { const app = mount(options); await flush(app); app.flushTimers(); app.render(); await flush(app); return app }

function params(request) { return new URL(request.url, 'http://localhost').searchParams }

test('Moderation opens on pending reviews with an uncached request and optional existing note', async () => {
  const app = await ready({ initial: report([review({ moderationNote: 'اصلاح نگارشی' })], { pending: 7 }) })
  assert.equal(reads(app).length, 1)
  assert.equal(params(reads(app)[0]).get('status'), 'PENDING')
  assert.equal(params(reads(app)[0]).get('q'), '')
  assert.equal(params(reads(app)[0]).get('page'), '1')
  assert.equal(reads(app)[0].cache, 'no-store')
  assert.equal(statusSelect(app).props.value, 'PENDING')
  assert.equal(noteInput(app).props.value, 'اصلاح نگارشی')
  assert.match(text(app.tree), /7 منتظر بررسی/)
  assert.equal(articles(app).length, 1)
  app.unmount()
})

for (const [label, failed] of [
  ['unauthenticated', response({ error: 'ابتدا وارد حساب خود شوید' }, 401)],
  ['non-admin', response({ error: 'دسترسی غیرمجاز' }, 403)],
  ['server failure', response({ error: 'نظرات دریافت نشد' }, 503)],
  ['network failure', new TypeError('Failed to fetch')],
  ['invalid payload', response({ unexpected: true })],
]) {
  test('Moderation exposes ' + label + ' without pretending the review queue is empty, and retries', async () => {
    const app = await ready({ queues: { '/api/admin/reviews': [failed, response(report())] } })
    assert.ok(find(app, node => node.props.role === 'alert'))
    assert.ok(!text(app.tree).includes('نظری با این فیلتر نداریم.'))
    assert.equal(articles(app).length, 0)
    button(app, 'تلاش دوباره').props.onClick(); app.render(); await flush(app)
    assert.equal(articles(app).length, 1)
    assert.equal(find(app, node => node.props.role === 'alert'), undefined)
    app.unmount()
  })
}

for (const [action, label, note] of [['approve', 'تأیید', ''], ['reject', 'رد نظر', 'لطفاً تجربهٔ استفاده از همین محصول را بنویسید.']]) {
  test('Moderation sends ' + action + ' with the current revision and optional note, then refreshes the current filter', async () => {
    const app = await ready({ queues: {
      '/api/admin/reviews': [response(report()), response(report([], { pending: 0 }))],
      'PUT /api/admin/reviews/review-1': [response({ id: 'review-1', revision: 4 })],
    } })
    if (note) { noteInput(app).props.onChange({ target: { value: note } }); app.render() }
    button(app, label).props.onClick(); await flush(app); await flush(app)
    assert.deepEqual(JSON.parse(writes(app)[0].body), { action, expectedRevision: 3, note })
    assert.equal(writes(app)[0].headers['Content-Type'], 'application/json')
    assert.equal(params(reads(app).at(-1)).get('status'), 'PENDING')
    assert.equal(articles(app).length, 0)
    assert.ok(find(app, node => node.props.role === 'status' && text(node).includes(action === 'approve' ? 'نظر تأیید شد' : 'کنار گذاشته شد')))
    app.unmount()
  })
}

test('An existing moderation note is preserved unless explicitly replaced or cleared', async () => {
  const app = await ready({ initial: report([review({ moderationNote: 'یادداشت قبلی' })]) })
  noteInput(app).props.onChange({ target: { value: '' } }); app.render()
  button(app, 'رد نظر').props.onClick(); await flush(app)
  assert.equal(JSON.parse(writes(app)[0].body).note, '')
  app.unmount()
})

test('The synchronous mutation lock blocks double clicks and all other review actions until completion', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const app = await ready({ queues: { 'PUT /api/admin/reviews/review-1': [() => pending] }, initial: report([review(), review({ id: 'review-2', product: { name: 'مدل دوم', slug: 'second' }, user: { name: 'مشتری دوم' } })]) })
  const approve = button(app, 'تأیید')
  approve.props.onClick(); approve.props.onClick(); button(app, 'رد نظر').props.onClick(); app.render()
  assert.equal(writes(app).length, 1)
  assert.ok(nodes(app.tree).filter(node => node.type === 'button' && ['تأیید', 'رد نظر', 'تازه‌سازی'].includes(text(node))).every(node => node.props.disabled))
  assert.ok(nodes(app.tree).filter(node => node.type === 'input' && node.props['aria-label']?.startsWith('یادداشت بررسی')).every(node => node.props.disabled))
  complete(response({ revision: 4 })); await flush(app); await flush(app)
  assert.equal(button(app, 'تأیید').props.disabled, false)
  app.unmount()
})

test('A rejected write retains the canonical status and exposes the server reason', async () => {
  const app = await ready({ queues: { 'PUT /api/admin/reviews/review-1': [response({ error: 'ثبت بررسی مجاز نیست' }, 403)] } })
  button(app, 'تأیید').props.onClick(); await flush(app)
  assert.match(text(find(app, node => node.props.role === 'alert')), /ثبت بررسی مجاز نیست/)
  assert.equal(articles(app).length, 1)
  assert.match(text(articles(app)[0]), /منتظر بررسی/)
  assert.equal(reads(app).length, 1)
  app.unmount()
})

test('A revision conflict refreshes canonical review content and keeps the conflict explanation visible', async () => {
  const canonical = review({ comment: 'متن اصلاح‌شده توسط مشتری', revision: 4 })
  const app = await ready({ queues: {
    '/api/admin/reviews': [response(report()), response(report([canonical]))],
    'PUT /api/admin/reviews/review-1': [response({ error: 'این نظر تغییر کرده؛ دوباره بررسی کن' }, 409)],
  } })
  button(app, 'تأیید').props.onClick(); await flush(app); await flush(app)
  assert.match(text(articles(app)[0]), /متن اصلاح‌شده توسط مشتری/)
  assert.match(text(find(app, node => node.props.role === 'alert')), /این نظر تغییر کرده/)
  button(app, 'تأیید').props.onClick(); await flush(app)
  assert.equal(JSON.parse(writes(app).at(-1).body).expectedRevision, 4)
  app.unmount()
})

test('Approved and rejected rows disable only their already-current moderation action', async () => {
  const app = await ready({ initial: report([review({ status: 'APPROVED' }), review({ id: 'review-2', status: 'REJECTED' })]) })
  const first = nodes(articles(app)[0]), second = nodes(articles(app)[1])
  assert.equal(first.find(node => node.type === 'button' && text(node) === 'تأیید').props.disabled, true)
  assert.equal(first.find(node => node.type === 'button' && text(node) === 'رد نظر').props.disabled, false)
  assert.equal(second.find(node => node.type === 'button' && text(node) === 'تأیید').props.disabled, false)
  assert.equal(second.find(node => node.type === 'button' && text(node) === 'رد نظر').props.disabled, true)
  app.unmount()
})

test('Review status changes reset later pages and pagination preserves the chosen filter', async () => {
  const app = await ready({ initial: report([review()], { total: 45, totalPages: 3 }) })
  button(app, 'بعدی').props.onClick(); app.render(); await flush(app)
  assert.equal(params(reads(app).at(-1)).get('page'), '2')
  statusSelect(app).props.onChange({ target: { value: 'APPROVED' } }); app.render(); await flush(app)
  assert.equal(params(reads(app).at(-1)).get('status'), 'APPROVED')
  assert.equal(params(reads(app).at(-1)).get('page'), '1')
  button(app, 'بعدی').props.onClick(); app.render(); await flush(app)
  assert.equal(params(reads(app).at(-1)).get('status'), 'APPROVED')
  assert.equal(params(reads(app).at(-1)).get('page'), '2')
  app.unmount()
})

test('Review search debounces trimmed input, resets to page one and preserves the moderation filter', async () => {
  const app = await ready({ initial: report([review()], { total: 45, totalPages: 3 }) })
  statusSelect(app).props.onChange({ target: { value: 'ALL' } }); app.render(); await flush(app)
  button(app, 'بعدی').props.onClick(); app.render(); await flush(app)
  const before = reads(app).length
  searchInput(app).props.onChange({ target: { value: 'کف' } }); app.render()
  searchInput(app).props.onChange({ target: { value: '  کفش پانیک  ' } }); app.render()
  assert.equal(reads(app).length, before)
  app.flushTimers(); app.render(); await flush(app)
  assert.equal(reads(app).length, before + 1)
  assert.equal(params(reads(app).at(-1)).get('q'), 'کفش پانیک')
  assert.equal(params(reads(app).at(-1)).get('page'), '1')
  assert.equal(params(reads(app).at(-1)).get('status'), 'ALL')
  app.unmount()
})

test('An emptied final page redirects to the last canonical page after a status change', async () => {
  const app = await ready({ queues: { '/api/admin/reviews': [response(report([review()], { total: 21, totalPages: 2 })), response(report([], { total: 20, page: 2, totalPages: 1 })), response(report([review()], { total: 20, totalPages: 1 }))] } })
  button(app, 'بعدی').props.onClick(); app.render(); await flush(app); await flush(app)
  assert.equal(params(reads(app).at(-1)).get('page'), '1')
  assert.equal(articles(app).length, 1)
  app.unmount()
})

test('Filter changes abort old reads and ignore a stale response that arrives later', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const app = mount({ queues: { '/api/admin/reviews': [() => pending, response(report([review({ status: 'APPROVED', comment: 'نتیجهٔ جدید' })]))] } })
  const initial = reads(app)[0]
  statusSelect(app).props.onChange({ target: { value: 'APPROVED' } }); app.render(); await flush(app)
  assert.equal(initial.signal.aborted, true)
  assert.match(text(articles(app)[0]), /نتیجهٔ جدید/)
  complete(response(report([review({ comment: 'نتیجهٔ قدیمی' })]))); await flush(app)
  assert.match(text(articles(app)[0]), /نتیجهٔ جدید/)
  assert.ok(!text(app.tree).includes('نتیجهٔ قدیمی'))
  app.unmount()
})

test('Unmount aborts reads and ignores late loading responses', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const app = mount({ queues: { '/api/admin/reviews': [() => pending] } })
  app.unmount()
  const stateWrites = app.stateWrites
  assert.equal(reads(app)[0].signal.aborted, true)
  complete(response(report())); await settle()
  assert.equal(app.stateWrites, stateWrites)
})

for (const status of [200, 409]) {
  test('Unmount aborts an active write and ignores its late HTTP ' + status + ' result', async () => {
    let complete
    const pending = new Promise(resolve => { complete = resolve })
    const app = await ready({ queues: { 'PUT /api/admin/reviews/review-1': [() => pending] } })
    button(app, 'تأیید').props.onClick(); app.render(); app.unmount()
    const stateWrites = app.stateWrites
    assert.equal(writes(app)[0].signal.aborted, true)
    complete(response(status === 409 ? { error: 'تعارض نسخه' } : { revision: 4 }, status)); await settle()
    assert.equal(app.stateWrites, stateWrites)
  })
}


test('A successful read clears an earlier error when returning to the same moderation filter', async () => {
  const app = await ready({ queues: { '/api/admin/reviews': [
    response({ error: 'صف بررسی موقتاً در دسترس نیست' }, 503),
    response(report([review({ status: 'APPROVED', comment: 'نتیجهٔ فیلتر تأییدشده' })])),
    response(report([review({ comment: 'صف بررسی بازیابی شد' })])),
  ] } })
  assert.match(text(find(app, node => node.props.role === 'alert')), /صف بررسی موقتاً در دسترس نیست/)
  statusSelect(app).props.onChange({ target: { value: 'APPROVED' } }); app.render(); await flush(app)
  assert.match(text(articles(app)[0]), /نتیجهٔ فیلتر تأییدشده/)
  statusSelect(app).props.onChange({ target: { value: 'PENDING' } }); app.render(); await flush(app)
  assert.equal(params(reads(app).at(-1)).get('status'), 'PENDING')
  assert.match(text(articles(app)[0]), /صف بررسی بازیابی شد/)
  assert.equal(find(app, node => node.props.role === 'alert'), undefined)
  app.unmount()
})
