const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const response = (body, status = 200) => Response.json(body, { status })
const snapshot = (overrides = {}) => ({ settings: { version: 4, maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ipMaxAttempts: 30, ...overrides } })
const endpoint = '/api/admin/login-security-settings'

function mount(queues = {}) {
  const slots = [], effects = [], timers = new Map(), requests = []
  let cursor = 0, tree, timerId = 0, writes = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { writes++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next }] },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i] },
    useCallback(callback, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { callback, deps }; return slots[i].callback },
    useEffect(callback, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = callback() }) } },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: ({ onValueChange, ...props }) => jsx('input', { ...props, onChange: event => onValueChange(event.target.value) }) },
  }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/login-security/page.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, Error, TypeError,
    setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    async fetch(url, options = {}) {
      requests.push({ url, ...options })
      const queue = queues[options.method || 'GET']
      const result = queue?.length ? queue.shift() : options.method === 'PATCH' ? response(snapshot({ ...JSON.parse(options.body), version: JSON.parse(options.body).version + 1 })) : response(snapshot())
      if (result instanceof Error) throw result
      return typeof result === 'function' ? result(options) : result
    },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] },
  })
  const render = () => { cursor = 0; tree = compiled.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  const app = { requests, render, get tree() { return tree }, get stateWrites() { return writes }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
  render()
  for (const [id, timer] of timers) if (timer.delay === 0) { timers.delete(id); timer.callback() }
  return app
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const field = (app, key) => find(app, node => node.props.id === `login-security-${key}`)
const button = (app, name) => find(app, node => node.type === 'button' && text(node).trim() === name)
const submitButton = app => find(app, node => node.type === 'button' && node.props.type === 'submit')
const fill = (app, key, value) => { field(app, key).props.onChange({ target: { value } }); app.render() }
const submit = async app => { await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); app.render() }
async function ready(queues = {}) { const app = mount(queues); await settle(); app.render(); return app }

test('Settings load from the server and submit numeric limits with the stored version', async () => {
  const app = await ready()
  assert.match(text(app.tree), /۵ تلاش ناموفق در بازهٔ ۱۵ دقیقه/)
  assert.match(text(app.tree), /عقب نمی‌اندازد/)
  assert.match(text(app.tree), /شمارندهٔ مشترک/)
  assert.match(text(app.tree), /Vercel/)
  assert.equal(nodes(app.tree).filter(node => node.type === 'input').length, 4)
  assert.equal(find(app, node => node.props.type === 'checkbox' || node.props.type === 'password'), undefined)
  fill(app, 'maxAttempts', '7')
  assert.match(text(app.tree), /۵ تلاش ناموفق/)
  await submit(app)
  assert.deepEqual(JSON.parse(app.requests[1].body), { version: 4, maxAttempts: 7, windowMinutes: 15, lockMinutes: 15, ipMaxAttempts: 30 })
  assert.ok(app.requests.every(request => request.url === endpoint && request.cache === 'no-store' && request.credentials === 'same-origin'))
  assert.match(text(app.tree), /۷ تلاش ناموفق/)
  assert.match(text(app.tree), /ذخیره شد/)
  app.unmount()
})

test('Missing or invalid snapshots show an explicit retry instead of editable invented defaults', async () => {
  for (const data of [{ settings: {} }, snapshot({ maxAttempts: 2 }), snapshot({ maxAttempts: 20, ipMaxAttempts: 10 }), snapshot({ version: -1 })]) {
    const app = await ready({ GET: [response(data), response(snapshot())] })
    assert.equal(find(app, node => node.type === 'form'), undefined)
    assert.ok(find(app, node => node.props.role === 'alert'))
    button(app, 'تلاش دوباره').props.onClick(); await settle(); app.render()
    assert.equal(field(app, 'maxAttempts').props.value, '5')
    app.unmount()
  }
})

test('Invalid limits and a network cap below the account cap never send a settings update', async () => {
  for (const [key, value] of [['maxAttempts', '0'], ['maxAttempts', '-1'], ['maxAttempts', '21'], ['maxAttempts', '1.5'], ['windowMinutes', ''], ['windowMinutes', '61'], ['lockMinutes', '0'], ['lockMinutes', '61'], ['ipMaxAttempts', '9'], ['ipMaxAttempts', '201']]) {
    const app = await ready()
    fill(app, key, value); await submit(app)
    assert.equal(app.requests.length, 1, `${key}=${value}`)
    assert.ok(find(app, node => node.props.role === 'alert'))
    app.unmount()
  }
  const app = await ready()
  fill(app, 'maxAttempts', '20'); fill(app, 'ipMaxAttempts', '10'); await submit(app)
  assert.equal(app.requests.length, 1)
  app.unmount()
})

test('Conflicts preserve the draft and block retries until an explicit canonical refresh', async () => {
  const app = await ready({ GET: [response(snapshot()), response(snapshot({ version: 6, maxAttempts: 10 }))], PATCH: [response({ error: 'تنظیمات تغییر کرده است.' }, 409)] })
  fill(app, 'maxAttempts', '7'); await submit(app)
  assert.equal(field(app, 'maxAttempts').props.value, '7')
  assert.equal(submitButton(app).props.disabled, true)
  await submit(app); assert.equal(app.requests.filter(request => request.method === 'PATCH').length, 1)
  button(app, 'دریافت آخرین تنظیمات').props.onClick(); await settle(); app.render()
  assert.equal(field(app, 'maxAttempts').props.value, '10')
  assert.equal(submitButton(app).props.disabled, false)
  await submit(app)
  assert.equal(JSON.parse(app.requests.at(-1).body).version, 6)
  app.unmount()
})

test('Uncertain saves require a fresh read while rejected validation leaves the draft correctable', async () => {
  for (const receipt of [response({ settings: {} }), response({ error: 'نامشخص' }, 500), new TypeError('Network failure')]) {
    const app = await ready({ PATCH: [receipt] })
    fill(app, 'lockMinutes', '20'); await submit(app)
    assert.equal(field(app, 'lockMinutes').props.value, '20')
    assert.equal(submitButton(app).props.disabled, true)
    await submit(app); assert.equal(app.requests.length, 2)
    app.unmount()
  }
  const app = await ready({ PATCH: [response({ error: 'مقدار نامعتبر است.' }, 400)] })
  fill(app, 'lockMinutes', '20'); await submit(app)
  assert.equal(submitButton(app).props.disabled, false)
  assert.equal(field(app, 'lockMinutes').props.value, '20')
  app.unmount()
})

test('Duplicate submissions issue one update and unmount aborts without accepting a late receipt', async () => {
  const pending = deferred()
  const app = await ready({ PATCH: [() => pending.promise] })
  const handler = find(app, node => node.type === 'form').props.onSubmit
  const first = handler({ preventDefault() {} }), second = handler({ preventDefault() {} })
  assert.equal(app.requests.filter(request => request.method === 'PATCH').length, 1)
  app.render()
  assert.equal(submitButton(app).props.disabled, true)
  assert.ok(nodes(app.tree).filter(node => node.type === 'input').every(node => node.props.disabled))
  app.unmount()
  const writes = app.stateWrites
  assert.equal(app.requests.at(-1).signal.aborted, true)
  pending.resolve(response(snapshot({ version: 5 })))
  await Promise.all([first, second])
  assert.equal(app.stateWrites, writes)
})
