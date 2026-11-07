const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const source = readFileSync(path.join(__dirname, '../src/lib/registration-delivery.ts'), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
const settings = { emailSender: 'auth', smsTemplate: 'signup-otp' }

function delivery({ response, emailConfigured = true, smsConfigured = true }) {
  const testModule = { exports: {} }
  const calls = []
  vm.runInNewContext(code, {
    module: testModule, AbortSignal, URLSearchParams,
    process: { env: { REGISTRATION_EMAIL_API_KEY: 'test-email-key', REGISTRATION_KAVENEGAR_API_KEY: 'test-sms-key' } },
    require(name) {
      assert.equal(name, './registration-settings')
      return { getRegistrationDeliveryReadiness: () => ({ emailConfigured, smsConfigured }) }
    },
    async fetch(url, request) {
      calls.push({ url, request })
      if (response instanceof Error) throw response
      return response
    },
  })
  return { calls, send: testModule.exports.sendRegistrationCode }
}

test('Panik email API receives only the documented fields and uses the configured sender', async () => {
  const { calls, send } = delivery({ response: new Response(null, { status: 202 }) })
  await send(settings, { channel: 'email', destination: 'buyer@example.test', code: '004325', expiresInMinutes: 5 })
  assert.equal(calls.length, 1)
  const [{ url, request }] = calls
  assert.equal(url, 'https://api.panikshoes.com/v1/emails')
  assert.equal(request.method, 'POST')
  assert.equal(request.redirect, 'error')
  assert.equal(request.headers.Authorization, 'Bearer test-email-key')
  assert.equal(request.headers['Content-Type'], 'application/json')
  const body = JSON.parse(request.body)
  assert.deepEqual(Object.keys(body).sort(), ['from', 'subject', 'text', 'to'])
  assert.equal(body.to, 'buyer@example.test')
  assert.equal(body.from, 'auth')
  assert.match(body.text, /004325/)
})

test('Kavenegar verification uses the approved template and requires provider acceptance', async () => {
  const message = { channel: 'sms', destination: '09123456789', code: '001234', expiresInMinutes: 5 }
  const accepted = delivery({ response: Response.json({ return: { status: 200 } }) })
  await accepted.send(settings, message)
  assert.match(accepted.calls[0].url, /^https:\/\/api\.kavenegar\.com\/v1\/test-sms-key\/verify\/lookup\.json$/)
  assert.deepEqual(Object.fromEntries(accepted.calls[0].request.body), {
    receptor: message.destination, token: message.code, template: settings.smsTemplate, type: 'sms',
  })

  const rejected = delivery({ response: Response.json({ return: { status: 403 } }) })
  await assert.rejects(rejected.send(settings, message), { message: 'Registration delivery failed' })
})

test('An unavailable channel never contacts its provider and provider errors are not exposed', async () => {
  const message = { channel: 'email', destination: 'buyer@example.test', code: '004325', expiresInMinutes: 5 }
  const disabled = delivery({ emailConfigured: false })
  await assert.rejects(disabled.send(settings, message), { message: 'Registration delivery failed' })
  assert.equal(disabled.calls.length, 0)

  const failed = delivery({ response: new Error('private provider request details') })
  await assert.rejects(failed.send(settings, message), { message: 'Registration delivery failed' })
})
