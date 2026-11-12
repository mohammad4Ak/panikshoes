const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { transformSync } = require('esbuild')

const source = readFileSync(path.join(__dirname, '../src/lib/registration-delivery.ts'), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
const settings = { emailSender: 'auth', smsTemplate: 'signup-otp', smsProvider: 'kavenegar' }
const smsMessage = { channel: 'sms', destination: '09123456789', code: '001234', expiresInMinutes: 5 }
const custom = {
  ...settings, smsProvider: 'custom', smsApiUrl: 'https://sms.provider.com/v1/send', smsMethod: 'POST',
  smsBodyFormat: 'json', smsBodyTemplate: '{"phone":"{{phone}}","code":"{{code}}","template":"{{template}}"}',
  smsHeaders: [{ name: 'Authorization', value: 'Bearer {{apiKey}}' }], smsSuccessPath: '', smsSuccessValue: '',
}

function delivery({ response, emailConfigured = true, smsConfigured = true, addresses, dnsError, status = 202,
  chunks = [], customKey = 'custom-key', timeout = false, dnsTimeout = false, rebind = false } = {}) {
  const testModule = { exports: {} }
  const calls = []
  const requests = []
  const dnsCalls = []
  const dependencies = {
    './registration-settings': {
      getRegistrationDeliveryReadiness: () => ({ emailConfigured, smsConfigured }),
      resolveRegistrationSmsApiKey: config => config.smsProvider === 'custom' ? customKey : 'test-sms-key',
      readRegistrationSmsHeaders: config => config.smsHeaders,
    },
    'ipaddr.js': require('ipaddr.js'),
    'node:net': require('node:net'),
    'node:dns/promises': { lookup: async (hostname, options) => {
      dnsCalls.push({ hostname, options })
      if (dnsError) throw new Error('private DNS details')
      if (dnsTimeout) return new Promise(() => {})
      if (rebind && dnsCalls.length > 1) return [{ address: '127.0.0.1', family: 4 }]
      return addresses ?? [{ address: '93.184.216.34', family: 4 }]
    } },
    'node:https': { request: (url, options, callback) => {
      const outgoing = new EventEmitter()
      const incoming = new PassThrough()
      incoming.statusCode = status
      const record = { url, options }
      requests.push(record)
      outgoing.destroy = () => incoming.destroy()
      outgoing.end = body => {
        record.body = body
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        options.lookup(hostname, {}, (error, address, family) => {
          assert.equal(error, null)
          record.address = { address, family }
        })
        options.lookup(hostname, { all: true }, (error, results) => {
          assert.equal(error, null)
          record.allAddresses = results
        })
        options.signal.addEventListener('abort', () => {
          incoming.destroy()
          outgoing.emit('error', new Error('private network timeout'))
        }, { once: true })
        queueMicrotask(() => {
          callback(incoming)
          for (const chunk of chunks) incoming.write(Buffer.from(chunk))
          if (!timeout) incoming.end()
        })
      }
      return outgoing
    } },
  }
  const sandbox = {
    AbortSignal: timeout ? { timeout: () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 5)
      return controller.signal
    } } : AbortSignal,
    URLSearchParams, URL, Buffer, setTimeout: dnsTimeout ? handler => setTimeout(handler, 0) : setTimeout,
    clearTimeout,
    process: { env: { REGISTRATION_EMAIL_API_KEY: 'test-email-key', REGISTRATION_KAVENEGAR_API_KEY: 'test-sms-key' } },
    async fetch(url, request) {
      calls.push({ url, request })
      if (response instanceof Error) throw response
      return response
    },
  }
  const requireDependency = name => {
    if (name in dependencies) return dependencies[name]
    assert.equal(name, './registration-sms')
    const smsModule = { exports: {} }
    const smsSource = readFileSync(path.join(__dirname, '../src/lib/registration-sms.ts'), 'utf8')
    const { code: smsCode } = transformSync(smsSource, { loader: 'ts', format: 'cjs', target: 'es2022' })
    vm.runInNewContext(smsCode, { ...sandbox, module: smsModule, require: requireDependency })
    dependencies[name] = smsModule.exports
    return smsModule.exports
  }
  vm.runInNewContext(code, { ...sandbox, module: testModule, require: requireDependency })
  return { calls, requests, dnsCalls, send: testModule.exports.sendRegistrationCode }
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

test('Custom JSON SMS substitutes values as data and pins the first public DNS answer against rebinding while retaining TLS hostname verification', async () => {
  const subject = delivery({ rebind: true, chunks: ['{"result":{"accepted":true}}'] })
  const maliciousKey = '"},"admin":true,"code":"{{phone}}'
  const configuration = {
    ...custom, smsSuccessPath: 'result.accepted', smsSuccessValue: 'true',
    smsBodyTemplate: '{"receiver":"{{phone}}","args":["{{code}}","{{apiKey}}"]}',
    smsHeaders: [],
  }
  const injectable = delivery({ customKey: maliciousKey, chunks: ['{"result":{"accepted":true}}'] })
  await injectable.send(configuration, smsMessage)
  assert.deepEqual(JSON.parse(injectable.requests[0].body), { receiver: smsMessage.destination, args: [smsMessage.code, maliciousKey] })
  await subject.send({ ...custom, smsSuccessPath: 'result.accepted', smsSuccessValue: 'true' }, smsMessage)
  const [{ url, options, address, allAddresses }] = subject.requests
  assert.equal(url.hostname, 'sms.provider.com')
  assert.equal(options.agent, false)
  assert.equal(options.family, 4)
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.headers.authorization, 'Bearer custom-key')
  assert.equal(options.headers['content-type'], 'application/json')
  assert.deepEqual(address, { address: '93.184.216.34', family: 4 })
  assert.equal(JSON.stringify(allAddresses), '[{"address":"93.184.216.34","family":4}]')
  assert.equal(subject.dnsCalls.length, 1)
  assert.equal(subject.dnsCalls[0].options.all, true)
  assert.equal(subject.calls.length, 0)
})

test('Custom GET URL placeholders are individually encoded and form bodies preserve exact scalar data', async () => {
  const subject = delivery({ customKey: 'key/with?x=1&y={{code}}' })
  await subject.send({ ...custom, smsMethod: 'GET', smsApiUrl: 'https://sms.provider.com/{{apiKey}}?phone={{phone}}&code={{code}}' }, smsMessage)
  const get = subject.requests[0]
  assert.equal(get.url.pathname, '/key%2Fwith%3Fx%3D1%26y%3D%7B%7Bcode%7D%7D')
  assert.equal(get.url.searchParams.get('phone'), smsMessage.destination)
  assert.equal(get.url.searchParams.get('code'), smsMessage.code)
  assert.equal(get.url.searchParams.has('y'), false)
  assert.equal(get.body, undefined)

  const form = delivery()
  await form.send({ ...custom, smsBodyFormat: 'form' }, smsMessage)
  assert.deepEqual(Object.fromEntries(new URLSearchParams(form.requests[0].body)), {
    phone: smsMessage.destination, code: smsMessage.code, template: settings.smsTemplate,
  })
  assert.equal(form.requests[0].options.headers['content-type'], 'application/x-www-form-urlencoded')
  const explicitType = delivery()
  await explicitType.send({ ...custom, smsHeaders: [{ name: 'Content-Type', value: 'application/json;charset=utf-8' }] }, smsMessage)
  assert.equal(explicitType.requests[0].options.headers['content-type'], 'application/json;charset=utf-8')
})

test('Private, special and URL-normalized IP literals and DNS answers are denied before HTTPS dispatch', async () => {
  for (const host of ['127.0.0.1', '2130706433', '0x7f000001', '169.254.169.254', '10.0.0.1', '[::1]',
    '[::ffff:127.0.0.1]', '[2002:7f00:1::]', '[64:ff9b::7f00:1]', '[fc00::1]', '[2001:db8::1]']) {
    const subject = delivery()
    await assert.rejects(subject.send({ ...custom, smsApiUrl: `https://${host}/send` }, smsMessage), { message: 'Registration delivery failed' })
    assert.equal(subject.requests.length, 0)
  }
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }],
    [{ address: '::ffff:10.0.0.1', family: 6 }]]) {
    const subject = delivery({ addresses })
    await assert.rejects(subject.send(custom, smsMessage), { message: 'Registration delivery failed' })
    assert.equal(subject.requests.length, 0)
  }
  const ipv6 = delivery({ addresses: [{ address: '2606:4700:4700::1111', family: 6 }] })
  await ipv6.send(custom, smsMessage)
  assert.equal(ipv6.requests[0].options.family, 6)
  assert.equal(ipv6.requests[0].address.address, '2606:4700:4700::1111')
})

test('Invalid URL authority, redirect targets, headers, prototype keys and unsupported templates fail without leaking details', async () => {
  for (const overrides of [
    { smsApiUrl: 'http://sms.provider.com/send' },
    { smsApiUrl: 'https://{{apiKey}}.provider.com/send' },
    { smsApiUrl: 'https://user:password@sms.provider.com/send' },
    { smsApiUrl: 'https://sms.provider.com/send#fragment' },
    { smsApiUrl: 'https://sms.provider.com/send?{{phone}}={{code}}' },
    { smsHeaders: [{ name: 'Host', value: 'localhost' }] },
    { smsHeaders: [{ name: 'Content-Length', value: '0' }] },
    { smsHeaders: [{ name: 'Cookie', value: 'session=secret' }] },
    { smsHeaders: [{ name: '__proto__', value: 'polluted' }] },
    { smsHeaders: [{ name: 'constructor', value: 'polluted' }] },
    { smsHeaders: [{ name: 'x-forwarded-host', value: 'localhost' }] },
    { smsHeaders: [{ name: 'x-key', value: 'a' }, { name: 'X-Key', value: 'b' }] },
    { smsHeaders: [{ name: 'Authorization', value: 'secret\r\nHost: localhost' }] },
    { smsBodyTemplate: '{"__proto__":{"polluted":true},"code":"{{code}}","phone":"{{phone}}"}' },
    { smsBodyTemplate: '{"phone":"{{phone}}","nested":{"constructor":"{{code}}"}}' },
    { smsBodyTemplate: '{"{{phone}}":"{{code}}"}' },
    { smsBodyTemplate: '{"phone":"{{phone}}","code":"{{global.process.env}}"}' },
    { smsBodyTemplate: '{"phone":"{{phone}}","phone":"constant","code":"{{code}}"}' },
    { smsBodyFormat: 'form', smsBodyTemplate: '{"phone":"{{phone}}","code":["{{code}}"]}' },
    { smsSuccessPath: '__proto__.accepted', smsSuccessValue: 'true' },
    { smsSuccessPath: 'status', smsSuccessValue: '{}' },
  ]) {
    const subject = delivery()
    await assert.rejects(subject.send({ ...custom, ...overrides }, smsMessage), { message: 'Registration delivery failed' })
    assert.equal(subject.requests.length, 0)
  }
  const injected = delivery({ customKey: 'secret\r\nHost: localhost' })
  await assert.rejects(injected.send(custom, smsMessage), { message: 'Registration delivery failed' })
  assert.equal(injected.requests.length, 0)
  const expanded = delivery({ customKey: 'x'.repeat(4001) })
  await assert.rejects(expanded.send(custom, smsMessage), { message: 'Registration delivery failed' })
  assert.equal(expanded.requests.length, 0)
})

test('Only HTTP success and the optional strict business success value accept delivery, without following redirects', async () => {
  for (const options of [
    { status: 302 }, { status: 500 },
    { chunks: ['not-json'] }, { chunks: ['{"accepted":"true"}'] }, { chunks: ['{}'] },
  ]) {
    const subject = delivery(options)
    await assert.rejects(subject.send({ ...custom, smsSuccessPath: 'accepted', smsSuccessValue: 'true' }, smsMessage), { message: 'Registration delivery failed' })
    assert.equal(subject.requests.length, 1)
  }
  const accepted = delivery({ status: 200, chunks: ['{"return":{"status":200}}'] })
  await accepted.send({ ...custom, smsSuccessPath: 'return.status', smsSuccessValue: '200' }, smsMessage)
  const empty = delivery({ status: 204 })
  await empty.send({ ...custom, smsSuccessValue: '200' }, smsMessage)
})

test('DNS failures, elapsed request deadline and oversized response are generic bounded delivery failures', async () => {
  for (const options of [{ dnsError: true }, { dnsTimeout: true }, { timeout: true, chunks: ['partial'] }, { chunks: ['x'.repeat(33 * 1024)] }]) {
    const subject = delivery(options)
    await assert.rejects(subject.send(custom, smsMessage), { message: 'Registration delivery failed' })
  }
})
