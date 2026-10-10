const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const userSession = { user: { id: 'buyer', email: 'buyer@example.test', role: 'USER' } }
const success = { ok: true, error: null }
const event = { preventDefault() {} }

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

// Exercise the real forms and their asynchronous handlers without an AuthJS
// server or database, including failed session reads after successful signup.
function mount(kind, { search = '', signInResults = [success], sessions = [userSession], registration = { ok: true, json: async () => ({ id: 'buyer' }) } } = {}) {
  const slots = [], pushes = [], signIns = [], registrations = []
  let cursor = 0, tree, reads = 0, refreshes = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: initial }
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
  }
  async function take(queue) {
    const value = queue.shift()
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value() : value
  }
  const jsx = (type, props) => ({ type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'next/navigation': { useRouter: () => ({ push: (url) => pushes.push(url), refresh: () => { refreshes++ } }) },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': { ArrowLeft: 'ArrowLeft' },
    '@/components/shop/AuthShell': { __esModule: true, default: 'AuthShell' },
    '@/components/shop/account.module.css': css,
    '@/lib/session-actions': { signInWithSessionLock: async (provider, options) => {
      signIns.push({ provider, options })
      return take(signInResults)
    } },
    '@/lib/session-client': { requestSession: async () => { reads++; return take(sessions) } },
  }
  const context = {
    module: { exports: {} },
    window: { location: { search } }, URLSearchParams,
    fetch: async (url, options) => { registrations.push({ url, body: JSON.parse(options.body) }); return registration },
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  const source = readFileSync(path.join(__dirname, `../src/app/(shop)/${kind}/page.tsx`), 'utf8')
  vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, context)
  function render() { cursor = 0; tree = context.module.exports.default(); return tree }
  function fill(id, value) { nodes(tree).find((node) => node.props.id === id).props.onChange({ target: { value } }); render() }
  render()
  if (kind === 'register') fill('register-name', 'خریدار نمونه')
  fill(`${kind}-email`, 'buyer@example.test')
  fill(`${kind}-password`, 'example-password')
  if (kind === 'register') fill('register-confirm', 'example-password')
  return {
    render, pushes, signIns, registrations,
    get reads() { return reads }, get refreshes() { return refreshes },
    form: () => nodes(tree).find((node) => node.type === 'form'),
    submit: async () => { await nodes(tree).find((node) => node.type === 'form').props.onSubmit(event); render() },
    alert: () => nodes(tree).find((node) => node.props.role === 'alert'),
    button: () => nodes(tree).find((node) => node.type === 'button' && node.props.type === 'submit'),
    links: () => nodes(tree).filter((node) => node.type === 'Link'),
  }
}

for (const [role, destination] of [['USER', '/profile'], ['ADMIN', '/admin']]) {
  test(`Login confirms the session and sends ${role} to the correct account page`, async () => {
    const app = mount('login', { sessions: [{ user: { ...userSession.user, role } }] })
    await app.submit()
    assert.deepEqual(app.pushes, [destination])
    assert.equal(app.refreshes, 1)
    assert.equal(app.alert(), undefined)
  })
}

test('Successful login can resume only a local transfer page, never arbitrary callback URLs', async () => {
  for (const [callback, destination] of [
    ['/payment/transfer/order-123', '/payment/transfer/order-123'],
    ['https://evil.example/payment/transfer/order-123', '/profile'],
    ['//evil.example/payment/transfer/order-123', '/profile'],
    ['/payment/transfer/../admin', '/profile'],
    ['/admin', '/profile'],
  ]) {
    const app = mount('login', { search: `?callbackUrl=${encodeURIComponent(callback)}` })
    await app.submit()
    assert.deepEqual(app.pushes, [destination])
  }
})

for (const result of [undefined, { ok: false }, { ok: true, error: 'CredentialsSignin' }]) {
  test(`Login failure ${JSON.stringify(result)} cannot navigate or become stuck loading`, async () => {
    const app = mount('login', { signInResults: [result] })
    await app.submit()
    assert.deepEqual(app.pushes, [])
    assert.equal(app.reads, 0)
    assert.ok(app.alert())
    assert.equal(app.button().props.disabled, false)
  })
}

for (const session of [null, { user: { email: 'buyer@example.test' } }, { user: { ...userSession.user, email: 'other@example.test' } }]) {
  test(`Login with a missing or different session stays on the form: ${JSON.stringify(session)}`, async () => {
    const app = mount('login', { sessions: [session] })
    await app.submit()
    assert.deepEqual(app.pushes, [])
    assert.match(text(app.alert()), /ورود کامل نشد/)
    assert.equal(app.button().props.disabled, false)
  })
}

test('A failed login session check can be retried successfully', async () => {
  const app = mount('login', { signInResults: [success, success], sessions: [new Error('network down'), userSession] })
  await app.submit()
  assert.ok(app.alert())
  assert.equal(app.button().props.disabled, false)
  await app.submit()
  assert.equal(app.alert(), undefined)
  assert.deepEqual(app.pushes, ['/profile'])
})

test('Rapid login submissions share one pending credential request', async () => {
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const app = mount('login', { signInResults: [() => pending] })
  const handler = app.form().props.onSubmit
  const first = handler(event)
  await handler(event)
  assert.equal(app.signIns.length, 1)
  finish(success)
  await first
  assert.deepEqual(app.pushes, ['/profile'])
})

test('Successful registration confirms automatic login before opening the profile', async () => {
  const app = mount('register')
  await app.submit()
  assert.equal(app.registrations.length, 1)
  assert.equal(app.reads, 1)
  assert.deepEqual(app.pushes, ['/profile'])
  assert.equal(app.alert(), undefined)
})

for (const [label, options] of [
  ['rejected sign-in', { signInResults: [{ ok: true, error: 'CredentialsSignin' }] }],
  ['missing sign-in result', { signInResults: [undefined] }],
  ['missing session', { sessions: [null] }],
  ['different session', { sessions: [{ user: { ...userSession.user, email: 'other@example.test' } }] }],
  ['session connection failure', { sessions: [new Error('offline')] }],
]) {
  test(`A created account with ${label} shows a login recovery without repeating registration`, async () => {
    const app = mount('register', options)
    const submit = app.form().props.onSubmit
    await submit(event)
    app.render()
    assert.deepEqual(app.pushes, [])
    assert.match(text(app.alert()), /حسابت ساخته شد/)
    assert.equal(app.form(), undefined, 'A created account must not be submitted to registration again')
    assert.ok(app.links().some((link) => link.props.href === '/login' && text(link).includes('ورود به حساب')))
    assert.equal(app.registrations.length, 1)
  })
}

test('A rejected registration keeps the form available and never attempts sign-in', async () => {
  const app = mount('register', { registration: { ok: false, json: async () => ({ error: 'ایمیل قبلاً ثبت شده' }) } })
  await app.submit()
  assert.ok(app.form())
  assert.equal(app.signIns.length, 0)
  assert.equal(app.button().props.disabled, false)
  assert.match(text(app.alert()), /ایمیل قبلاً ثبت شده/)
})


test('Review login returns to the selected product reviews instead of the account dashboard', async () => {
 const target = '/products/panik-622#product-reviews'
 const app = mount('login', { search: '?callbackUrl=' + encodeURIComponent(target) })
 await app.submit()
 assert.deepEqual(app.pushes, [target])
})
for (const target of ['https://evil.example/products/shoe', '//evil.example/products/shoe', '/products/shoe?redirect=https://evil.example', '/products/shoe#arbitrary']) test('Unapproved review login callback keeps the normal account destination: ' + target, async () => {
 const app = mount('login', { search: '?callbackUrl=' + encodeURIComponent(target) })
 await app.submit()
 assert.deepEqual(app.pushes, ['/profile'])
})
