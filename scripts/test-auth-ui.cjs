const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const userSession = { user: { id: 'buyer', email: 'buyer@example.test', role: 'USER' } }
const success = { ok: true, error: null }
const event = { preventDefault() {} }
const contact = { exports: {} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/customer-contact.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022',
}).code, { module: contact })

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
function mount(kind, {
  search = '', signInResults = [success], sessions = [userSession],
  methods = { emailEnabled: true, smsEnabled: false },
  codeResponses = [],
  registration = Response.json({ id: 'buyer' }, { status: 201 }),
  reducedMotion = true,
} = {}) {
  const slots = [], effects = [], pushes = [], signIns = [], registrations = []
  let cursor = 0, tree, reads = 0, refreshes = 0, finishFeedback
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
    useEffect(effect, deps) {
      const index = cursor++
      if (slots[index]?.deps.every((dep, i) => Object.is(dep, deps[i]))) return
      slots[index]?.cleanup?.()
      slots[index] = { deps }
      effects.push(() => { slots[index].cleanup = effect() })
    },
  }
  async function take(queue) {
    const value = queue.shift()
    if (value instanceof Error) throw value
    return typeof value === 'function' ? value() : value
  }
  const jsx = (type, props, key) => ({ type, props, key })
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
    '@/lib/customer-contact': contact.exports,
  }
  const context = {
    module: { exports: {} },
    window: {
      location: { search }, matchMedia: () => ({ matches: reducedMotion }),
      setTimeout(callback, delay) { if (delay < 1000) finishFeedback = callback; return 1 }, clearTimeout() {},
    }, URLSearchParams, AbortController,
    fetch: async (url, options) => {
      if (!options.method) return Response.json(methods)
      registrations.push({ url, body: JSON.parse(options.body) })
      if (url.endsWith('/code')) return codeResponses.shift() ?? Response.json({
        challengeId: 'challenge-id',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        resendAt: new Date(Date.now() + 60_000).toISOString(),
      })
      if (registration instanceof Error) throw registration
      return registration.clone()
    },
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  const source = readFileSync(path.join(__dirname, `../src/app/(shop)/${kind}/page.tsx`), 'utf8')
  vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, context)
  function render() { cursor = 0; tree = context.module.exports.default(); effects.splice(0).forEach((effect) => effect()); return tree }
  const field = (id) => nodes(tree).find((node) => node.props.id === id)
  function fill(id, value) { field(id).props.onChange({ target: { value } }); render() }
  async function submit() { await nodes(tree).find((node) => node.type === 'form').props.onSubmit(event); render() }
  async function ready() { await new Promise(setImmediate); render() }
  render()
  if (kind === 'login') {
    fill('login-identifier', 'buyer@example.test')
    fill('login-password', 'example-password')
  }
  return {
    render, field, fill, ready, submit, pushes, signIns, registrations,
    finishFeedback: () => finishFeedback(),
    codeSlots: () => nodes(tree).find((node) => node.props.className === 'codeSlots'),
    get reads() { return reads }, get refreshes() { return refreshes },
    form: () => nodes(tree).find((node) => node.type === 'form'),
    alert: () => nodes(tree).find((node) => node.props.role === 'alert'),
    button: () => nodes(tree).find((node) => node.type === 'button' && node.props.type === 'submit'),
    links: () => nodes(tree).filter((node) => node.type === 'Link'),
  }
}

async function enterRegistrationCode(app, destination = 'buyer@example.test') {
  await app.ready()
  app.fill('register-destination', destination)
  await app.submit()
  assert.equal(app.signIns.length, 0, 'Sending the code cannot sign the user in')
  app.fill('register-code', '۰۰۱۲۳۴')
  app.fill('register-name', 'خریدار نمونه')
  if (!app.field('register-phone').props.value) app.fill('register-phone', '+۹۸ ۹۱۲-۳۴۵-۶۷۸۹')
  app.fill('register-postal-code', '۰۱۲۳۴-۵۶۷۸۹')
  app.fill('register-password', 'example-password')
  app.fill('register-confirm', 'example-password')
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
  await enterRegistrationCode(app)
  await app.submit()
  assert.deepEqual(app.registrations, [
    { url: '/api/auth/register/code', body: { channel: 'email', destination: 'buyer@example.test' } },
    { url: '/api/auth/register', body: { challengeId: 'challenge-id', code: '001234', name: 'خریدار نمونه', phone: '09123456789', postalCode: '0123456789', password: 'example-password' } },
  ])
  assert.equal(app.reads, 1)
  assert.deepEqual(app.pushes, ['/profile'])
  assert.equal(app.alert(), undefined)
})

test('Registration requires valid order contact fields before submitting the code', async () => {
  const app = mount('register')
  await enterRegistrationCode(app)
  assert.equal(app.field('register-phone').props.required, true)
  assert.equal(app.field('register-postal-code').props.required, true)

  app.fill('register-phone', '')
  await app.submit()
  assert.match(text(app.alert()), /شمارهٔ تماس/)
  app.fill('register-phone', '09123456789')
  app.fill('register-postal-code', '۱۱۱۱۱۱۱۱۱۱')
  await app.submit()
  assert.match(text(app.alert()), /کدپستی/)
  assert.equal(app.registrations.length, 1, 'Invalid contact fields must not attempt to verify the code')
  assert.equal(app.signIns.length, 0)
})

test('Six visual slots accept a complete pasted code and confirm it before navigation', async () => {
  const app = mount('register', { reducedMotion: false })
  await enterRegistrationCode(app)
  const input = app.field('register-code')
  assert.equal(input.props.autoComplete, 'one-time-code')
  assert.equal(app.codeSlots().props.children.length, 6)
  let prevented = false
  input.props.onPaste({ clipboardData: { getData: () => '۰۰۱ ۲۳۴' }, preventDefault() { prevented = true } })
  app.render()
  assert.equal(prevented, true)
  assert.equal(text(app.codeSlots()), '001234')
  const pending = app.submit()
  await app.ready()
  assert.equal(app.codeSlots().props['data-feedback'], 'accepted')
  assert.deepEqual(app.pushes, [])
  app.finishFeedback()
  await pending
  assert.deepEqual(app.pushes, ['/profile'])
})

test('Mobile registration and subsequent login work with a verified mobile and no email', async () => {
  const phoneSession = { user: { id: 'buyer', email: '', role: 'USER', loginPhone: '09123456789' } }
  const app = mount('register', { methods: { emailEnabled: false, smsEnabled: true }, sessions: [phoneSession] })
  await enterRegistrationCode(app, '+۹۸۹۱۲۳۴۵۶۷۸۹')
  assert.equal(app.field('register-phone').props.value, '09123456789')
  app.fill('register-phone', '۰۲۱ ۱۲۳۴۵۶۷۸')
  await app.submit()
  assert.deepEqual(app.registrations[0].body, { channel: 'sms', destination: '09123456789' })
  assert.equal(app.registrations[1].body.phone, '02112345678')
  assert.equal(app.signIns[0].options.loginPhone, '09123456789')
  assert.equal(app.signIns[0].options.email, undefined)
  assert.deepEqual(app.pushes, ['/profile'])

  const login = mount('login', { sessions: [phoneSession, userSession] })
  login.fill('login-identifier', '+۹۸۹۱۲۳۴۵۶۷۸۹')
  await login.submit()
  assert.equal(login.signIns[0].options.loginPhone, '09123456789')
  assert.deepEqual(login.pushes, ['/profile'])
  await login.submit()
  assert.match(text(login.alert()), /ورود کامل نشد/)
  assert.deepEqual(login.pushes, ['/profile'])
})

test('Signup exposes no form when both registration methods are disabled', async () => {
  const app = mount('register', { methods: { emailEnabled: false, smsEnabled: false } })
  await app.ready()
  assert.equal(app.form(), undefined)
  assert.deepEqual(app.registrations, [])
})

test('An existing identity stays at the destination step and can go to login', async () => {
  const app = mount('register', { codeResponses: [Response.json({ error: 'برای این ایمیل یا شمارهٔ موبایل حساب وجود دارد. وارد حساب شوید.' }, { status: 409 })] })
  await app.ready()
  app.fill('register-destination', 'buyer@example.test')
  await app.submit()
  assert.equal(app.field('register-code'), undefined)
  assert.equal(app.field('register-destination').props.value, 'buyer@example.test')
  assert.match(text(app.alert()), /حساب وجود دارد/)
  assert.ok(app.links().some((link) => link.props.href === '/login'))
  assert.equal(app.registrations.length, 1)
})

test('Resending clears the old code form if an account was created in the meantime', async () => {
  const app = mount('register', { codeResponses: [
    Response.json({
      challengeId: 'challenge-id',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      resendAt: new Date(Date.now() - 1_000).toISOString(),
    }),
    Response.json({ error: 'برای این ایمیل یا شمارهٔ موبایل حساب وجود دارد. وارد حساب شوید.' }, { status: 409 }),
  ] })
  await enterRegistrationCode(app)
  const resend = nodes(app.form()).find((node) => node.type === 'button' && text(node) === 'ارسال دوبارهٔ کد')
  resend.props.onClick()
  await app.ready()
  assert.equal(app.field('register-code'), undefined)
  assert.ok(app.field('register-destination'))
  assert.match(text(app.alert()), /حساب وجود دارد/)
  assert.equal(app.registrations.length, 2)
})

for (const [label, options] of [
  ['rejected sign-in', { signInResults: [{ ok: true, error: 'CredentialsSignin' }] }],
  ['missing sign-in result', { signInResults: [undefined] }],
  ['missing session', { sessions: [null] }],
  ['different session', { sessions: [{ user: { ...userSession.user, id: 'another-account' } }] }],
  ['session connection failure', { sessions: [new Error('offline')] }],
]) {
  test(`A created account with ${label} shows a login recovery without repeating registration`, async () => {
    const app = mount('register', options)
    await enterRegistrationCode(app)
    const submit = app.form().props.onSubmit
    await submit(event)
    app.render()
    assert.deepEqual(app.pushes, [])
    assert.match(text(app.alert()), /حسابت ساخته شد/)
    assert.equal(app.form(), undefined, 'A created account must not be submitted to registration again')
    assert.ok(app.links().some((link) => link.props.href === '/login' && text(link).includes('ورود به حساب')))
    assert.equal(app.registrations.length, 2)
  })
}

test('A rejected registration keeps the form available and never attempts sign-in', async () => {
  const app = mount('register', { registration: Response.json({ code: 'INVALID_REGISTRATION_CODE', error: 'کد تأیید درست نیست.' }, { status: 400 }) })
  await enterRegistrationCode(app)
  await app.submit()
  assert.ok(app.form())
  assert.equal(app.signIns.length, 0)
  assert.equal(app.button().props.disabled, false)
  assert.match(text(app.alert()), /کد تأیید درست نیست/)
  assert.equal(app.codeSlots().props['data-feedback'], 'rejected')
  assert.equal(app.field('register-code').props['aria-invalid'], true)
  const firstAttempt = app.codeSlots().key
  await app.submit()
  assert.notEqual(app.codeSlots().key, firstAttempt)
  app.fill('register-code', '12345')
  assert.equal(app.codeSlots().props['data-feedback'], undefined)
  assert.equal(app.field('register-code').props['aria-invalid'], false)
})

for (const registration of [Response.json({ error: 'نام نامعتبر است' }, { status: 400 }), new Error('offline')]) {
  test(`Registration leaves the code neutral after ${registration instanceof Error ? 'network' : 'unrelated validation'} failure`, async () => {
    const app = mount('register', { registration })
    await enterRegistrationCode(app)
    await app.submit()
    assert.ok(app.alert())
    assert.equal(app.codeSlots().props['data-feedback'], undefined)
    assert.equal(app.field('register-code').props['aria-invalid'], false)
  })
}

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
