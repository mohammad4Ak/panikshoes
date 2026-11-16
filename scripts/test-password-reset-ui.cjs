const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const response = (body, status = 200, headers = {}) => Response.json(body, { status, headers })
const availability = { enabled: true, emailEnabled: true, smsEnabled: false, expiryMinutes: 5, resendSeconds: 60 }
const baseTime = Date.parse('2026-11-15T10:00:00.000Z')
const challengeId = '11111111-1111-4111-8111-111111111111'
const issued = (now = baseTime, id = challengeId) => response({ challengeId: id, expiresAt: new Date(now + 300000).toISOString(), resendAt: new Date(now + 60000).toISOString(), message: 'generic' }, 200, { Date: new Date(now).toUTCString() })
const snapshot = (overrides = {}) => ({ settings: { version: 4, enabled: true, emailEnabled: true, smsEnabled: false, expiryMinutes: 5, maxAttempts: 5, resendSeconds: 60, destinationHourlyLimit: 5, ipHourlyLimit: 30, ...overrides }, readiness: { emailConfigured: true, smsConfigured: false, otpConfigured: true } })

function mount(kind = 'public', queues = {}, initialTime = baseTime) {
  const slots = [], effects = [], timers = new Map(), requests = []
  let cursor = 0, tree, timerId = 0, now = initialTime, writes = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { writes++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next }] },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i] },
    useCallback(callback, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { callback, deps }; return slots[i].callback },
    useEffect(callback, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = callback() }) } },
  }
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
  const contact = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/customer-contact.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module: contact })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/shop/AuthShell': { __esModule: true, default: 'AuthShell' },
    '@/lib/customer-contact': contact.exports,
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: ({ onValueChange, ...props }) => jsx('input', { ...props, onChange: event => onValueChange(event.target.value) }) },
  }
  const setTimer = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, delay }); return id }
  const clearTimer = id => timers.delete(id)
  const compiled = { exports: {} }
  const file = kind === 'public' ? 'src/app/(shop)/forgot-password/page.tsx' : 'src/app/admin/password-reset/page.tsx'
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, Date: TestDate, AbortController, Error, TypeError, TextEncoder, setTimeout: setTimer, clearTimeout: clearTimer,
    window: { setTimeout: setTimer, clearTimeout: clearTimer },
    async fetch(url, options = {}) {
      requests.push({ url, ...options })
      const key = `${options.method ?? 'GET'} ${url}`
      const queued = queues[key]?.length ? queues[key].shift() : options.method === 'PATCH' ? response(snapshot({ version: 5 })) : !options.method || options.method === 'GET' ? response(kind === 'public' ? availability : snapshot()) : url.endsWith('/code') ? issued(now) : response({ success: true })
      if (queued instanceof Error) throw queued
      return typeof queued === 'function' ? queued(options) : queued
    },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] },
  })
  const render = () => { cursor = 0; tree = compiled.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  const app = { requests, render, get tree() { return tree }, get stateWrites() { return writes }, advance(ms) { now += ms; app.flushTimers(1000) }, flushTimers(max = 0) { const pending = [...timers].filter(([, timer]) => timer.delay <= max); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, timer]) => timer.callback()); render() }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
  render(); app.flushTimers(); return app
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const field = (app, id) => find(app, node => node.props.id === id)
const button = (app, name) => find(app, node => node.type === 'button' && (node.props['aria-label'] === name || text(node).trim() === name))
const submit = async app => { await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render(); await settle(); app.render() }
const fill = (app, id, value) => { field(app, id).props.onChange({ target: { value } }); app.render() }
async function ready(kind = 'public', queues = {}, now) { const app = mount(kind, queues, now); await settle(); app.render(); return app }
async function requestCode(app) { fill(app, 'recovery-destination', 'PERSON@example.test'); await submit(app) }
function fillReset(app, code = '۱۲۳۴۵۶') { fill(app, 'recovery-code', code); fill(app, 'recovery-password', 'new-password'); fill(app, 'recovery-confirm', 'new-password') }

test('Recovery unavailable or malformed availability cannot request a code; failed loading has an explicit retry', async () => {
  const disabled = await ready('public', { 'GET /api/auth/password-reset': [response({ ...availability, enabled: false, emailEnabled: false })] })
  assert.equal(find(disabled, node => node.type === 'form'), undefined)
  assert.match(text(disabled.tree), /در حال حاضر در دسترس نیست/)
  assert.ok(find(disabled, node => node.type === 'Link' && node.props.href === '/login'))
  disabled.unmount()
  const broken = await ready('public', { 'GET /api/auth/password-reset': [response({ enabled: true }), response(availability)] })
  assert.match(text(broken.tree), /بارگذاری نشدند/)
  button(broken, 'تلاش دوباره').props.onClick(); broken.render(); await settle(); broken.render()
  assert.ok(field(broken, 'recovery-destination')); assert.equal(broken.requests.length, 2)
  broken.unmount()
})

test('Request uses a normalized identity and generic notice, with six aligned slots and no account-existence promise', async () => {
  const app = await ready(); await requestCode(app)
  assert.deepEqual(JSON.parse(app.requests[1].body), { channel: 'email', destination: 'person@example.test' })
  assert.equal(app.requests[1].cache, 'no-store')
  assert.match(text(app.tree), /اگر حساب فعالی با این مشخصات وجود داشته باشد/)
  assert.doesNotMatch(text(app.tree), /کد تأیید ارسال شد/)
  assert.equal(nodes(app.tree).filter(node => node.props.className === 'codeSlot').length, 6)
  assert.equal(field(app, 'recovery-code').props.autoComplete, 'one-time-code')
  assert.equal(field(app, 'recovery-password').props.autoComplete, 'new-password')
  app.unmount()
})

test('Successful reset submits Persian code as ASCII, clears both passwords and requires explicit login', async () => {
  const app = await ready(); await requestCode(app); fillReset(app)
  await submit(app)
  const posted = JSON.parse(app.requests.at(-1).body)
  assert.deepEqual(posted, { challengeId, code: '123456', newPassword: 'new-password', confirmPassword: 'new-password' })
  assert.match(text(app.tree), /رمز عبورت تغییر کرد/)
  assert.equal(find(app, node => node.props['data-feedback'] === 'accepted').props['aria-hidden'], 'true')
  assert.equal(field(app, 'recovery-password'), undefined)
  assert.ok(find(app, node => node.type === 'Link' && node.props.href === '/login' && text(node).includes('ورود با رمز جدید')))
  assert.ok(app.requests.every(request => !request.url.includes('/callback/') && !request.url.includes('/session')))
  app.unmount()
})

test('Incomplete or mismatched new passwords never verify the OTP or post a reset', async () => {
  const app = await ready(); await requestCode(app)
  fillReset(app, '123'); await submit(app); assert.equal(app.requests.length, 2)
  fillReset(app); fill(app, 'recovery-confirm', 'different'); await submit(app); assert.equal(app.requests.length, 2)
  fill(app, 'recovery-password', 'رمز'.repeat(20)); fill(app, 'recovery-confirm', 'رمز'.repeat(20)); await submit(app); assert.equal(app.requests.length, 2)
  app.unmount()
})

test('Wrong codes show red feedback without clearing a correctable password draft; the next success turns green', async () => {
  const app = await ready('public', { 'POST /api/auth/password-reset': [response({ error: 'کد نامعتبر است.', code: 'INVALID_PASSWORD_RESET_CODE' }, 400), response({ success: true })] })
  await requestCode(app); fillReset(app); await submit(app)
  assert.ok(find(app, node => node.props['data-feedback'] === 'rejected'))
  assert.equal(field(app, 'recovery-code').props['aria-invalid'], true)
  assert.equal(field(app, 'recovery-password').props.value, 'new-password')
  assert.equal(nodes(app.tree).filter(node => node.props.role === 'alert').length, 1)
  fill(app, 'recovery-code', '654321'); await submit(app)
  assert.ok(find(app, node => node.props['data-feedback'] === 'accepted'))
  app.unmount()
})

test('Server time drives resend and expiry even with an incorrect device clock, and old submit handlers remain blocked', async () => {
  const app = await ready('public', { 'POST /api/auth/password-reset/code': [issued(baseTime)] }, baseTime + 86400000)
  await requestCode(app)
  assert.ok(text(app.tree).includes('۵:۰۰')); assert.ok(text(app.tree).includes('۱:۰۰'))
  const resend = find(app, node => node.type === 'button' && text(node).includes('ارسال دوباره'))
  assert.equal(resend.props.disabled, true)
  resend.props.onClick(); await settle(); app.render(); assert.equal(app.requests.length, 2)
  app.advance(301000); fillReset(app)
  assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  await submit(app); assert.equal(app.requests.length, 2)
  app.unmount()
})

test('A rate-limited request keeps a cooldown and does not invent a challenge', async () => {
  const app = await ready('public', { 'POST /api/auth/password-reset/code': [response({ error: 'کمی صبر کنید.', retryAt: new Date(baseTime + 120000).toISOString() }, 429, { Date: new Date(baseTime).toUTCString() })] })
  await requestCode(app)
  assert.equal(field(app, 'recovery-code'), undefined)
  assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  await submit(app); assert.equal(app.requests.length, 2)
  app.advance(121000); assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, false)
  app.unmount()
})

test('Resending clears typed secrets, and editing identity aborts the resend and ignores its late response', async () => {
  const pending = deferred()
  const app = await ready('public', { 'POST /api/auth/password-reset/code': [issued(baseTime), () => pending.promise] })
  await requestCode(app); fillReset(app); app.advance(61000)
  find(app, node => node.type === 'button' && text(node).includes('ارسال دوباره')).props.onClick(); app.render()
  assert.equal(field(app, 'recovery-password').props.value, '')
  button(app, 'ویرایش ایمیل').props.onClick(); app.render()
  assert.equal(app.requests.at(-1).signal.aborted, true)
  pending.resolve(issued(baseTime + 61000, '22222222-2222-4222-8222-222222222222')); await settle(); app.render()
  assert.equal(field(app, 'recovery-code'), undefined)
  assert.ok(field(app, 'recovery-destination'))
  app.unmount()
})

test('Duplicate clicks send one reset, and a lost success receipt clears secrets and advises checking the new password', async () => {
  const pending = deferred()
  const app = await ready('public', { 'POST /api/auth/password-reset': [() => pending.promise] })
  await requestCode(app); fillReset(app)
  const handler = find(app, node => node.type === 'form').props.onSubmit
  const first = handler({ preventDefault() {} }); const duplicate = handler({ preventDefault() {} })
  assert.equal(app.requests.filter(request => request.url === '/api/auth/password-reset' && request.method === 'POST').length, 1)
  pending.resolve(response({ incomplete: true })); await Promise.all([first, duplicate]); app.render()
  assert.equal(field(app, 'recovery-password').props.value, '')
  assert.equal(field(app, 'recovery-code').props.value, '')
  assert.match(text(app.tree), /ممکن است رمز تغییر کرده باشد/)
  await submit(app); assert.equal(app.requests.filter(request => request.method === 'POST').length, 2)
  app.unmount()
})

test('Leaving recovery aborts the request and its late response cannot write component state', async () => {
  const pending = deferred()
  const app = await ready('public', { 'POST /api/auth/password-reset/code': [() => pending.promise] })
  fill(app, 'recovery-destination', 'person@example.test')
  const work = find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  app.unmount(); const writes = app.stateWrites
  assert.equal(app.requests.at(-1).signal.aborted, true)
  pending.resolve(issued()); await work
  assert.equal(app.stateWrites, writes)
})

test('Admin changes global and individual methods with numeric limits and the stored version, without provider secrets', async () => {
  const app = await ready('admin')
  assert.match(text(app.tree), /فعال در سایت/)
  find(app, node => node.props['aria-label'] === 'بازیابی رمز توسط کاربر').props.onChange({ target: { checked: false } }); app.render()
  fill(app, 'recovery-setting-expiryMinutes', '6'); await submit(app)
  const posted = JSON.parse(app.requests.find(request => request.method === 'PATCH').body)
  assert.equal(posted.version, 4); assert.equal(posted.enabled, false); assert.equal(posted.expiryMinutes, 6)
  assert.equal(posted.smsEnabled, false)
  assert.deepEqual(Object.keys(posted).sort(), ['version', 'enabled', 'emailEnabled', 'smsEnabled', 'expiryMinutes', 'maxAttempts', 'resendSeconds', 'destinationHourlyLimit', 'ipHourlyLimit'].sort())
  assert.match(text(app.tree), /ذخیره شد/)
  assert.ok(find(app, node => node.type === 'Link' && node.props.href === '/admin/registration'))
  app.unmount()
})

test('Admin conflicts preserve drafts and block repeated writes until an explicit canonical refresh', async () => {
  const app = await ready('admin', { 'PATCH /api/admin/password-reset-settings': [response({ error: 'تنظیمات تغییر کرده است.' }, 409)] })
  fill(app, 'recovery-setting-expiryMinutes', '7'); await submit(app)
  assert.equal(field(app, 'recovery-setting-expiryMinutes').props.value, '7')
  assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  await submit(app); assert.equal(app.requests.filter(request => request.method === 'PATCH').length, 1)
  button(app, 'دریافت آخرین تنظیمات').props.onClick(); await settle(); app.render()
  assert.equal(field(app, 'recovery-setting-expiryMinutes').props.value, '5')
  assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, false)
  app.unmount()
})

test('Admin malformed receipts and uncertain server failures require a fresh settings read before retry', async () => {
  for (const receipt of [response({ settings: {} }), response({ error: 'نتیجه نامشخص است.' }, 500), new TypeError('Network failure')]) {
    const app = await ready('admin', { 'PATCH /api/admin/password-reset-settings': [receipt] })
    await submit(app); assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
    await submit(app); assert.equal(app.requests.filter(request => request.method === 'PATCH').length, 1)
    app.unmount()
  }
})

test('Admin invalid limits never post and a policy validation failure leaves the draft editable', async () => {
  const app = await ready('admin', { 'PATCH /api/admin/password-reset-settings': [response({ error: 'سرویس آماده نیست.' }, 400)] })
  fill(app, 'recovery-setting-expiryMinutes', '11'); await submit(app); assert.equal(app.requests.length, 1)
  fill(app, 'recovery-setting-expiryMinutes', '4'); await submit(app)
  assert.equal(field(app, 'recovery-setting-expiryMinutes').props.value, '4')
  assert.equal(find(app, node => node.type === 'button' && node.props.type === 'submit').props.disabled, false)
  app.unmount()
})
