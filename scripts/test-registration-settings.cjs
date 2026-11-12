const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('esbuild')

function load(path, dependencies = {}, globals = {}) {
  const source = readFileSync(join(__dirname, '..', path), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  const compiled = { exports: {} }
  runInNewContext(code, { module: compiled, URL, Buffer, require: name => dependencies[name] ?? require(name), ...globals })
  return compiled.exports
}

const input = load('src/lib/api-input.ts')
const origins = load('src/lib/request-origin.ts')
const smsConfiguration = load('src/lib/registration-sms.ts')
const otpSecret = 'registration-secret-fixture-at-least-32'
const emailKey = 'mail-credential-fixture'
const smsKey = 'sms-credential-fixture'

function harness(env = {}) {
  let session = { user: { id: 'admin', role: 'ADMIN' } }
  let row
  let reads = 0
  const registrationSettings = {
    async findUnique() { reads++; return row },
    async createMany() { row ??= { id: 1, version: 0 } },
    async updateMany({ where, data }) {
      if (where.version !== row?.version) return { count: 0 }
      row = { ...row, ...data, version: where.version + data.version.increment, updatedAt: new Date() }
      return { count: 1 }
    },
  }
  const prisma = { registrationSettings, $transaction: callback => callback({ registrationSettings }) }
  const settings = load('src/lib/registration-settings.ts', {
    './api-input': input, './prisma': { prisma }, './registration-sms': smsConfiguration,
  }, { process: { env } })
  const route = load('src/app/api/admin/registration-settings/route.ts', {
    '@/lib/api-input': input,
    '@/lib/auth': { auth: async () => session },
    '@/lib/request-origin': origins,
    '@/lib/registration-settings': settings,
  })
  return { ...settings, ...route, setSession: value => { session = value }, get reads() { return reads }, get row() { return row } }
}

function patch(body, origin = 'https://store.example') {
  return new Request('https://store.example/api/admin/registration-settings', {
    method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

test('New stores have both OTP channels off and enabling one requires its credentials', async () => {
  const env = {}
  const app = harness(env)
  const defaults = await app.readRegistrationSettings()
  assert.equal(defaults.emailEnabled, false)
  assert.equal(defaults.smsEnabled, false)
  assert.throws(() => app.parseRegistrationSettings({ ...defaults, emailEnabled: true }), { status: 400 })
  env.AUTH_SECRET = otpSecret
  assert.throws(() => app.parseRegistrationSettings({ ...defaults, emailEnabled: true }), { status: 400 })
  env.REGISTRATION_EMAIL_API_KEY = emailKey
  const settings = app.parseRegistrationSettings({ ...defaults, emailEnabled: true })
  assert.equal(app.getRegistrationAvailability(settings).emailEnabled, true)
  assert.equal(app.getRegistrationAvailability(settings).smsEnabled, false)
  assert.throws(() => app.parseRegistrationSettings({ ...defaults, smsEnabled: true, smsTemplate: 'signup-code' }), { status: 400 })
  env.REGISTRATION_KAVENEGAR_API_KEY = smsKey
  const sms = app.parseRegistrationSettings({ ...defaults, smsEnabled: true, smsTemplate: 'signup-code' })
  assert.equal(app.getRegistrationAvailability(sms).smsEnabled, true)
  delete env.REGISTRATION_KAVENEGAR_API_KEY
  assert.equal(app.getRegistrationAvailability(sms).smsEnabled, false)
})

test('Policy limits are bounded, provider configuration uses a fixed sender and template IDs', async () => {
  const app = harness()
  const defaults = await app.readRegistrationSettings()
  for (const [key, value] of [
    ['expiryMinutes', 11], ['maxAttempts', 0], ['resendSeconds', 14], ['destinationHourlyLimit', 21],
    ['ipHourlyLimit', 101], ['ipHourlyLimit', 1.5], ['emailSender', 'victim@example.com'],
    ['smsTemplate', '../unsafe'], ['emailEnabled', 'false'],
  ]) {
    assert.throws(() => app.parseRegistrationSettings({ ...defaults, [key]: value }), { status: 400 }, key)
  }
  const settings = app.parseRegistrationSettings({ ...defaults, expiryMinutes: '10', emailSender: 'noreply', smsTemplate: 'signup_otp' })
  assert.equal(settings.expiryMinutes, 10)
  assert.equal(settings.emailSender, 'noreply')
})

test('Only same-origin admins can update settings, and credentials stay outside the response', async () => {
  const app = harness({ REGISTRATION_OTP_SECRET: otpSecret, REGISTRATION_EMAIL_API_KEY: emailKey, REGISTRATION_KAVENEGAR_API_KEY: smsKey })
  app.setSession(null)
  assert.equal((await app.GET()).status, 401)
  assert.equal((await app.PATCH(patch({}))).status, 401)
  app.setSession({ user: { id: 'customer', role: 'USER' } })
  assert.equal((await app.GET()).status, 403)
  assert.equal((await app.PATCH(patch({}))).status, 403)
  app.setSession({ user: { id: 'admin', role: 'ADMIN' } })
  assert.equal((await app.PATCH(patch({}, 'https://foreign.example'))).status, 403)
  assert.equal(app.reads, 0)

  const response = await app.GET()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  const raw = await response.text()
  for (const secret of [otpSecret, emailKey, smsKey]) assert.ok(!raw.includes(secret))
  const { settings, readiness } = JSON.parse(raw)
  assert.equal(readiness.emailConfigured, true)
  assert.equal(readiness.smsConfigured, false)
  const saved = await app.PATCH(patch({ ...settings, emailEnabled: true }))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).settings.version, 1)
  assert.equal((await app.PATCH(patch({ ...settings, smsTemplate: 'signup' }))).status, 409)
  const final = await (await app.GET()).json()
  assert.equal(final.settings.emailEnabled, true)
  assert.equal(final.settings.smsTemplate, '')
})

test('Custom SMS credentials and header values are encrypted, masked and preserved on unrelated edits', async () => {
  const app = harness({ AUTH_SECRET: otpSecret })
  const defaults = await app.readRegistrationSettings()
  const literalHeader = 'private-provider-header-value'
  const settings = app.parseRegistrationSettings({
    ...defaults,
    smsProvider: 'custom', smsApiUrl: 'https://sms.example.com/v1/send',
    smsApiKey: smsKey, smsEnabled: true, smsSuccessPath: 'status',
    smsHeaders: [{ name: 'Authorization', value: 'Bearer {{apiKey}}' }, { name: 'X-Private-Token', value: literalHeader }],
  })
  const saved = await app.saveRegistrationSettings(settings)
  assert.equal(app.getRegistrationAvailability(saved).smsEnabled, true)
  assert.equal(app.resolveRegistrationSmsApiKey(saved), smsKey)
  assert.equal(app.readRegistrationSmsHeaders(saved)[1].value, literalHeader)
  const stored = JSON.stringify(app.row)
  assert.ok(!stored.includes(smsKey))
  assert.ok(!stored.includes(literalHeader))
  assert.ok(!('smsHeaders' in app.row))
  const snapshot = app.registrationAdminSnapshot(saved)
  const raw = JSON.stringify(snapshot)
  for (const value of [smsKey, literalHeader, saved.smsApiKeyEncrypted, saved.smsHeadersEncrypted]) assert.ok(!raw.includes(value))
  assert.equal(snapshot.settings.smsHeaders[0].value, '')
  assert.equal(snapshot.settings.smsHeaders[0].configured, true)
  assert.equal(snapshot.readiness.smsStoredKeyConfigured, true)
  assert.equal(snapshot.readiness.smsEnvironmentKeyConfigured, false)

  const edited = app.parseRegistrationSettings({ ...snapshot.settings, maxAttempts: 4, smsApiKey: '' }, saved)
  assert.equal(edited.smsApiKeyEncrypted, saved.smsApiKeyEncrypted)
  assert.equal(edited.smsHeadersEncrypted, saved.smsHeadersEncrypted)
  assert.equal(app.resolveRegistrationSmsApiKey(edited), smsKey)
  const renamedCase = app.parseRegistrationSettings({
    ...snapshot.settings, smsHeaders: snapshot.settings.smsHeaders.map(header => ({ ...header, name: header.name.toLowerCase() })),
  }, saved)
  assert.equal(app.readRegistrationSmsHeaders(renamedCase)[1].value, literalHeader)
  const cleared = app.parseRegistrationSettings({ ...snapshot.settings, smsEnabled: false, clearSmsApiKey: true, smsHeaders: [] }, saved)
  assert.equal(cleared.smsApiKeyEncrypted, null)
  assert.equal(cleared.smsHeadersEncrypted, null)
  assert.equal(app.resolveRegistrationSmsApiKey(cleared), '')
  assert.equal(app.getRegistrationAvailability(cleared).smsEnabled, false)
})

test('Key rotation fails closed and preserves unavailable ciphertext until explicitly replaced or cleared', async () => {
  const env = { AUTH_SECRET: otpSecret, REGISTRATION_KAVENEGAR_API_KEY: smsKey }
  const app = harness(env)
  const defaults = await app.readRegistrationSettings()
  const settings = app.parseRegistrationSettings({
    ...defaults, smsApiKey: 'override-secret-fixture', smsTemplate: 'signup',
    smsHeaders: [{ name: 'Authorization', value: 'Bearer private-token' }],
  })
  env.AUTH_SECRET = 'rotated-server-key-with-at-least-32-characters'
  assert.equal(app.resolveRegistrationSmsApiKey(settings), '')
  const snapshot = app.registrationAdminSnapshot(settings)
  assert.equal(snapshot.readiness.smsSecretsReadable, false)
  assert.equal(snapshot.readiness.smsConfigured, false)
  const preserved = app.parseRegistrationSettings({ ...snapshot.settings, maxAttempts: 3 }, settings)
  assert.equal(preserved.smsHeadersEncrypted, settings.smsHeadersEncrypted)
  assert.equal(preserved.smsApiKeyEncrypted, settings.smsApiKeyEncrypted)
  const cleared = app.parseRegistrationSettings({ ...snapshot.settings, clearSmsApiKey: true, clearSmsHeaders: true }, settings)
  assert.equal(app.resolveRegistrationSmsApiKey(cleared), smsKey)
  assert.equal(cleared.smsHeadersEncrypted, null)
  assert.equal(app.registrationAdminSnapshot(cleared).readiness.smsEnvironmentKeyConfigured, true)
})

test('Custom configuration rejects unsafe headers, literal configured keys, and invalid credentials intents', async () => {
  const app = harness({ AUTH_SECRET: otpSecret })
  const defaults = await app.readRegistrationSettings()
  const valid = { ...defaults, smsProvider: 'custom', smsApiUrl: 'https://sms.example.com/send', smsSuccessPath: 'status', smsApiKey: smsKey }
  for (const headers of [
    [{ name: 'Host', value: 'internal.example' }],
    [{ name: '__proto__', value: 'unsafe' }],
    [{ name: 'Authorization', value: 'a' }, { name: 'authorization', value: 'b' }],
    [{ name: 'X-New', value: '' }],
    [{ name: 'X-Key', value: 'first\r\nHost: internal' }],
  ]) assert.throws(() => app.parseRegistrationSettings({ ...valid, smsHeaders: headers }), { status: 400 })
  for (const changes of [
    { smsApiUrl: `https://sms.example.com/${smsKey}` },
    { smsBodyTemplate: JSON.stringify({ phone: '{{phone}}', code: '{{code}}', key: smsKey }) },
    { clearSmsApiKey: true },
    { smsProvider: 'unsupported' },
    { smsMethod: 'DELETE' },
    { smsBodyFormat: 'xml' },
  ]) assert.throws(() => app.parseRegistrationSettings({ ...valid, ...changes }), { status: 400 })
  const explicitContentType = app.parseRegistrationSettings({
    ...valid, smsHeaders: [{ name: 'Content-Type', value: 'application/json;charset=utf-8' }],
  })
  assert.equal(app.readRegistrationSmsHeaders(explicitContentType)[0].value, 'application/json;charset=utf-8')
})
