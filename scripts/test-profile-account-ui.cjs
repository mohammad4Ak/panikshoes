const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Execute the actual profile component with isolated hooks and responses; no DB writes.
const user = { name: 'نام قبلی', email: 'customer@example.test', role: 'USER' }
const profile = { name: 'نام فعلی', phone: '09123456789' }
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function page(queues = {}) {
  const slots = [], effects = [], requests = []
  let cursor = 0, tree, stateWrites = 0
  const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
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
        effects.push(() => { slots[index].cleanup = callback() })
      }
    },
  }
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    'next/link': { __esModule: true, default: 'Link' },
    '@/lib/session-actions': { signOutWithSessionLock: async () => {} },
    '@/lib/utils': { formatPrice: String },
    './InvoiceDownload': { __esModule: true, default: 'InvoiceDownload' },
    './account.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }
  const fetch = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`
    requests.push({ url, ...options })
    const next = queues[key]?.length ? queues[key].shift() : response(url === '/api/profile' ? profile : [])
    if (next instanceof Error) throw next
    return next
  }
  const source = readFileSync(path.join(__dirname, '..', 'src/components/shop/ProfileClient.tsx'), 'utf8')
  const { code } = transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  const context = {
    module: { exports: {} }, AbortController, fetch, setTimeout: () => 1,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(code, context)
  function render() {
    cursor = 0
    tree = context.module.exports.default({ user })
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  render()
  nodes(tree).find((node) => node.type === 'button' && text(node) === 'حساب کاربری').props.onClick()
  render()
  return {
    render, requests, get tree() { return tree }, get stateWrites() { return stateWrites },
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
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}
const field = (app, id) => nodes(app.tree).find((node) => node.props.id === `account-${id}`)
const form = (app) => nodes(app.tree).find((node) => node.type === 'form' && nodes(node).some((child) => child.props.id === 'account-name'))
const submit = (app) => form(app).props.onSubmit({ preventDefault() {} })
const save = (app) => nodes(form(app)).find((node) => node.type === 'button' && node.props.type === 'submit')
const writes = (app) => app.requests.filter((request) => request.method === 'PATCH')

test('Delayed profile load cannot save an empty placeholder phone and fills canonical name and phone together', async () => {
  const load = deferred()
  const app = page({ 'GET /api/profile': [load.promise] })
  assert.equal(field(app, 'name').props.disabled, true)
  assert.equal(field(app, 'phone').props.disabled, true)
  assert.equal(save(app).props.disabled, true)
  assert.match(text(app.tree), /در حال بارگذاری اطلاعات حساب/)
  await submit(app)
  assert.equal(writes(app).length, 0)
  load.resolve(response(profile)); await settle(); app.render()
  assert.equal(field(app, 'name').props.value, profile.name)
  assert.equal(field(app, 'phone').props.value, profile.phone)
  assert.equal(field(app, 'phone').props.disabled, false)
  field(app, 'name').props.onChange({ target: { value: 'نام جدید' } }); app.render()
  await submit(app)
  assert.deepEqual(JSON.parse(writes(app)[0].body), { name: 'نام جدید', phone: profile.phone })
  app.unmount()
})

for (const [label, failure] of [
  ['network failure', new TypeError('Failed to fetch')],
  ['server error', response({ error: 'Unavailable' }, 503)],
  ['malformed account', response({ name: 'Partial response' })],
]) {
  test(`A ${label} blocks accidental phone clearing and offers a retry`, async () => {
    const app = page({ 'GET /api/profile': [failure, response(profile)] })
    await settle(); app.render()
    assert.match(text(app.tree), /اطلاعات حساب بارگذاری نشد/)
    assert.ok(nodes(app.tree).some((node) => node.props.role === 'alert'))
    assert.equal(save(app).props.disabled, true)
    assert.equal(field(app, 'name').props.disabled, true)
    await submit(app)
    assert.equal(writes(app).length, 0)
    nodes(app.tree).find((node) => node.type === 'button' && text(node) === 'تلاش دوباره').props.onClick()
    app.render(); assert.equal(save(app).props.disabled, true)
    await settle(); app.render()
    assert.equal(field(app, 'phone').props.value, profile.phone)
    assert.equal(save(app).props.disabled, false)
    assert.ok(!text(app.tree).includes('اطلاعات حساب بارگذاری نشد'))
    app.unmount()
  })
}

test('Only an intentional phone edit can clear a loaded phone; null phones also load as editable empty fields', async () => {
  for (const phone of [profile.phone, null]) {
    const app = page({ 'GET /api/profile': [response({ ...profile, phone })] })
    await settle(); app.render()
    assert.equal(field(app, 'phone').props.value, phone ?? '')
    assert.equal(save(app).props.disabled, false)
    field(app, 'phone').props.onChange({ target: { value: '' } }); app.render()
    await submit(app)
    assert.equal(JSON.parse(writes(app)[0].body).phone, '')
    app.unmount()
  }
})

test('An in-flight account save blocks duplicate submits and edits; failed saves preserve the draft for retry', async () => {
  const patch = deferred()
  const app = page({ 'PATCH /api/profile': [patch.promise, response(profile)] })
  await settle(); app.render()
  field(app, 'phone').props.onChange({ target: { value: '09999999999' } }); app.render()
  const first = submit(app)
  await submit(app)
  app.render()
  assert.equal(writes(app).length, 1)
  assert.equal(save(app).props.disabled, true)
  assert.equal(field(app, 'name').props.disabled, true)
  assert.equal(field(app, 'phone').props.disabled, true)
  patch.resolve(response({ error: 'ذخیره انجام نشد' }, 503)); await first; app.render()
  assert.match(text(app.tree), /ذخیره انجام نشد/)
  assert.equal(field(app, 'phone').props.value, '09999999999')
  assert.equal(save(app).props.disabled, false)
  await submit(app); app.render()
  assert.equal(writes(app).length, 2)
  assert.equal(JSON.parse(writes(app)[1].body).phone, '09999999999')
  assert.match(text(app.tree), /اطلاعات حساب ذخیره شد/)
  app.unmount()
})

test('Leaving the profile aborts its account read and ignores a late response', async () => {
  const load = deferred()
  const app = page({ 'GET /api/profile': [load.promise] })
  await settle()
  const before = app.stateWrites
  app.unmount()
  assert.equal(app.requests.find((request) => request.url === '/api/profile').signal.aborted, true)
  load.resolve(response(profile)); await settle()
  assert.equal(app.stateWrites, before)
})
