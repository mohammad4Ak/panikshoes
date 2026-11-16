const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}, globals = {}) {
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
    { module: compiled, URL, Buffer, Request, Response, Headers, Date, ...globals, require(name) { return Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) } })
  return compiled.exports
}

const input = load('src/lib/api-input.ts')
const origin = load('src/lib/request-origin.ts')
const sms = load('src/lib/registration-sms.ts')
const secret = 'password-reset-settings-fixture-secret-32-characters'
const emailKey = 'private-reset-email-fixture-key'
const smsKey = 'private-reset-sms-fixture-key'
const defaults = { version: 0, enabled: true, emailEnabled: true, smsEnabled: false, expiryMinutes: 5, maxAttempts: 5, resendSeconds: 60, destinationHourlyLimit: 5, ipHourlyLimit: 30 }

function harness({ env = { AUTH_SECRET: secret, REGISTRATION_EMAIL_API_KEY: emailKey }, initial, deliveryValues = {} } = {}) {
  let row = initial ? structuredClone(initial) : null
  let session = { user: { id: 'admin', role: 'ADMIN' } }
  let reads = 0, mutations = 0, failRead = false, queue = Promise.resolve()
  const events = []
  const project = (value, select) => !value ? null : select ? Object.fromEntries(Object.keys(select).map(key => [key, value[key]])) : { ...value }
  const delegate = (get, set) => ({
    async findUnique({ select } = {}) { reads++; if (failRead) throw new Error('private backend failure including credentials'); return project(get(), select) },
    async createMany() { events.push('create'); mutations++; if (!get()) { set({ id: 1, ...defaults }); return { count: 1 } } return { count: 0 } },
    async updateMany({ where, data }) {
      events.push('update'); mutations++
      if (!get() || get().version !== where.version) return { count: 0 }
      set({ ...get(), ...data, version: where.version + data.version.increment })
      return { count: 1 }
    },
  })
  const prisma = {
    passwordResetSettings: delegate(() => row, value => { row = value }),
    registrationSettings: { async findUnique() { reads++; if (failRead) throw new Error('private backend failure'); return deliveryValues.row ?? null } },
    $transaction(callback) {
      const execution = queue.then(async () => {
        let draft = structuredClone(row)
        const tx = { passwordResetSettings: delegate(() => draft, value => { draft = value }), async $queryRaw(query) { events.push('lock'); assert.match(query.join(''), /pg_advisory_xact_lock.*password-reset-settings:v1/) } }
        const value = await callback(tx)
        row = draft
        return value
      })
      queue = execution.catch(() => undefined)
      return execution
    },
  }
  const delivery = load('src/lib/registration-settings.ts', { './api-input': input, './prisma': { prisma }, './registration-sms': sms }, { process: { env } })
  const settings = load('src/lib/password-reset-settings.ts', { './api-input': input, './prisma': { prisma }, './registration-settings': delivery })
  const route = load('src/app/api/admin/password-reset-settings/route.ts', {
    'next/server': { NextResponse: Response }, '@/lib/api-input': input, '@/lib/auth': { auth: async () => session },
    '@/lib/request-origin': origin, '@/lib/registration-settings': delivery, '@/lib/password-reset-settings': settings,
  })
  return { ...settings, ...route, delivery, env, events, get row() { return row }, get reads() { return reads }, get mutations() { return mutations }, actor(value) { session = value }, fail() { failRead = true } }
}

const patch = (body, headers = {}) => new Request('https://store.example/api/admin/password-reset-settings', { method: 'PATCH', headers: { Origin: 'https://store.example', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('Recovery defaults enable ready email independently from disabled registration channels and keep SMS off', async () => {
  const app = harness()
  const settings = await app.readPasswordResetSettings()
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), defaults)
  const delivery = await app.delivery.readRegistrationSettings()
  assert.equal(delivery.emailEnabled, false)
  assert.equal(delivery.smsEnabled, false)
  assert.deepEqual(JSON.parse(JSON.stringify(app.getPasswordResetAvailability(settings, delivery))), { enabled: true, emailEnabled: true, smsEnabled: false })
  assert.equal(app.mutations, 0)
})

test('Delivery readiness and recovery policy are independent: enabling SMS needs configured credentials, not registration enablement', async () => {
  const app = harness({ env: { AUTH_SECRET: secret, REGISTRATION_EMAIL_API_KEY: emailKey, REGISTRATION_KAVENEGAR_API_KEY: smsKey }, deliveryValues: { row: { id: 1, version: 2, emailEnabled: false, smsEnabled: false, emailSender: 'auth', smsTemplate: 'recovery', smsProvider: 'kavenegar' } } })
  const delivery = await app.delivery.readRegistrationSettings()
  const saved = app.parsePasswordResetSettings({ ...defaults, smsEnabled: true }, defaults, delivery)
  assert.equal(app.getPasswordResetAvailability(saved, delivery).smsEnabled, true)
  delete app.env.REGISTRATION_KAVENEGAR_API_KEY
  assert.equal(app.getPasswordResetAvailability(saved, delivery).smsEnabled, false)
  assert.throws(() => app.parsePasswordResetSettings({ ...defaults, smsEnabled: true }, defaults, delivery), { status: 400 })
  const disabled = app.parsePasswordResetSettings({ ...defaults, enabled: false, smsEnabled: true }, defaults, delivery)
  assert.deepEqual(JSON.parse(JSON.stringify(app.getPasswordResetAvailability(disabled, delivery))), { enabled: false, emailEnabled: false, smsEnabled: false })
})

test('Missing or rotated provider/OTP secrets fail closed while administrators can still disable recovery', async () => {
  const app = harness({ env: {} })
  const delivery = await app.delivery.readRegistrationSettings()
  assert.equal(app.getPasswordResetAvailability(defaults, delivery).enabled, false)
  assert.throws(() => app.parsePasswordResetSettings(defaults, defaults, delivery), { status: 400 })
  app.env.AUTH_SECRET = secret
  assert.throws(() => app.parsePasswordResetSettings(defaults, defaults, delivery), { status: 400 })
  app.env.REGISTRATION_EMAIL_API_KEY = emailKey
  assert.equal(app.getPasswordResetAvailability(defaults, delivery).emailEnabled, true)
  app.env.AUTH_SECRET = 'short'
  assert.equal(app.getPasswordResetAvailability(defaults, delivery).enabled, false)
  assert.equal(app.parsePasswordResetSettings({ version: 0, enabled: false }, defaults, delivery).enabled, false)
})

test('Policy bounds, explicit nulls, booleans, unknown fields and stale versions cannot change settings', async () => {
  const app = harness()
  const delivery = await app.delivery.readRegistrationSettings()
  for (const [key, value] of [
    ['enabled', 'false'], ['emailEnabled', null], ['smsEnabled', 1], ['expiryMinutes', 0], ['expiryMinutes', 11], ['expiryMinutes', null],
    ['maxAttempts', 11], ['resendSeconds', 14], ['resendSeconds', 301], ['destinationHourlyLimit', 21], ['ipHourlyLimit', 101], ['ipHourlyLimit', 1.5],
    ['emailSender', 'victim@example.test'], ['smsApiKey', 'secret'], ['version', undefined], ['version', -1],
  ]) assert.throws(() => app.parsePasswordResetSettings({ ...defaults, [key]: value }, defaults, delivery), { status: 400 }, key)
  assert.throws(() => app.parsePasswordResetSettings({ ...defaults, version: 9 }, defaults, delivery), { status: 409 })
  const minimum = app.parsePasswordResetSettings({ ...defaults, expiryMinutes: '1', maxAttempts: 1, resendSeconds: 15, destinationHourlyLimit: 1, ipHourlyLimit: 1 }, defaults, delivery)
  assert.equal(minimum.expiryMinutes, 1)
  const maximum = app.parsePasswordResetSettings({ ...defaults, expiryMinutes: 10, maxAttempts: 10, resendSeconds: 300, destinationHourlyLimit: 20, ipHourlyLimit: 100 }, defaults, delivery)
  assert.equal(maximum.ipHourlyLimit, 100)
  assert.equal(app.mutations, 0)
})

test('Anonymous, customer and foreign-origin access is refused before any settings read or write', async () => {
  const app = harness()
  for (const [actor, status] of [[null, 401], [{ user: { id: 'customer', role: 'USER' } }, 403]]) {
    app.actor(actor)
    assert.equal((await app.GET()).status, status)
    assert.equal((await app.PATCH(patch(defaults))).status, status)
  }
  app.actor({ user: { id: 'admin', role: 'ADMIN' } })
  assert.equal((await app.PATCH(patch(defaults, { Origin: 'https://foreign.example' }))).status, 403)
  assert.equal(app.reads, 0)
  assert.equal(app.mutations, 0)
})

test('Private snapshots contain only recovery settings and readiness, with no delivery configuration or credentials', async () => {
  const app = harness()
  const response = await app.GET()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(response.headers.get('Vary'), 'Cookie')
  const body = await response.text()
  for (const credential of [secret, emailKey, smsKey, 'smsHeaders', 'smsApiKeyEncrypted', 'smsApiUrl', 'emailSender']) assert.ok(!body.includes(credential))
  const data = JSON.parse(body)
  assert.deepEqual(Object.keys(data).sort(), ['readiness', 'settings'])
  assert.deepEqual(data.readiness, { emailConfigured: true, smsConfigured: false, otpConfigured: true })
})

test('Settings writes acquire the shared recovery lock before mutation and compare versions atomically', async () => {
  const app = harness()
  const results = await Promise.all([app.PATCH(patch({ version: 0, maxAttempts: 3 })), app.PATCH(patch({ version: 0, expiryMinutes: 8 }))])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  assert.equal(app.row.version, 1)
  assert.equal(app.row.maxAttempts, 3)
  assert.equal(app.row.expiryMinutes, 5)
  assert.equal(app.events[0], 'lock')
  assert.equal(app.events.filter(event => event === 'lock').length, 2)
  const response = await app.PATCH(patch({ version: 1, enabled: false }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).settings.version, 2)
  assert.equal(app.row.enabled, false)
})

test('Partial updates preserve channels and limits, while malformed/oversized bodies cannot touch storage', async () => {
  const app = harness()
  for (const [raw, headers, status] of [['{', {}, 400], ['[]', {}, 400], ['x'.repeat(8193), {}, 413], ['{}', { 'content-length': '8193' }, 413]]) {
    assert.equal((await app.PATCH(patch(raw, headers))).status, status)
    assert.equal(app.reads, 0)
    assert.equal(app.mutations, 0)
  }
  const result = await app.PATCH(patch({ version: 0, expiryMinutes: 8 }))
  assert.equal(result.status, 200)
  const { settings } = await result.json()
  assert.equal(settings.expiryMinutes, 8)
  assert.equal(settings.emailEnabled, true)
  assert.equal(settings.smsEnabled, false)
  assert.equal(settings.ipHourlyLimit, defaults.ipHourlyLimit)
})

test('Database failures never disclose raw diagnostics and exhausted versions cannot wrap around', async () => {
  const app = harness()
  app.fail()
  for (const response of [await app.GET(), await app.PATCH(patch({ version: 0, enabled: false }))]) {
    assert.equal(response.status, 500)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.doesNotMatch(await response.text(), /private|credentials|backend/)
  }
  const limit = harness({ initial: { ...defaults, version: 2_147_483_647 } })
  assert.equal((await limit.PATCH(patch({ version: 2_147_483_647, enabled: false }))).status, 409)
  assert.equal(limit.mutations, 0)
})
