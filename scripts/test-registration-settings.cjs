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
  const settings = load('src/lib/registration-settings.ts', { './api-input': input, './prisma': { prisma } }, { process: { env } })
  const route = load('src/app/api/admin/registration-settings/route.ts', {
    '@/lib/api-input': input,
    '@/lib/auth': { auth: async () => session },
    '@/lib/request-origin': origins,
    '@/lib/registration-settings': settings,
  })
  return { ...settings, ...route, setSession: value => { session = value }, get reads() { return reads } }
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
