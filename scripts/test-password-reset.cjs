const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const email = 'buyer@example.test'
const mobile = '09123456789'
const password = 'a-new-password'
const account = extra => ({ id: 'buyer', email, loginPhone: null, phoneVerifiedAt: null, emailVerifiedAt: null, isActive: true, password: 'hash:old-password', authVersion: 3, ...extra })

function matches(row, where) {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key]
    if (condition === null || typeof condition !== 'object') return value === condition
    if ('equals' in condition) {
      const literal = condition.equals.replace(/\\(.)/g, '$1')
      return typeof value === 'string' && value.toLowerCase() === literal.toLowerCase()
    }
    if ('not' in condition && value === condition.not) return false
    if ('gt' in condition && !(value > condition.gt)) return false
    if ('lt' in condition && !(value < condition.lt)) return false
    return true
  })
}
const selectRow = (row, select) => row && (select ? Object.fromEntries(Object.keys(select).map(key => [key, row[key]])) : { ...row })

function setup({ users: initialUsers = [account()], settings: overrides = {}, delivery: deliveryOverrides = {}, failDelivery = false, deliveryHook, hashHook, env = {} } = {}) {
  const clock = { now: 1_800_000_000_000 }
  const resetSettings = { version: 1, enabled: true, emailEnabled: true, smsEnabled: false, expiryMinutes: 5, maxAttempts: 5, resendSeconds: 60, destinationHourlyLimit: 5, ipHourlyLimit: 30, ...overrides }
  const transportSettings = { version: 1, emailSender: 'auth', emailEnabled: false, smsEnabled: false, smsTemplate: 'reset-otp', smsProvider: 'kavenegar', ...deliveryOverrides }
  let users = structuredClone(initialUsers), challenges = new Map(), limits = new Map(), transactions = Promise.resolve(), hashCalls = 0, sequence = 123
  const jobs = [], deliveries = [], queries = [], passwordWrites = []
  const apply = (row, data) => { for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value }
  const challengeRows = () => [...challenges.values()]
  const db = {
    async $queryRaw(sql, ...values) {
      const statement = sql.join('?'); queries.push(statement)
      if (statement.includes('pg_advisory_xact_lock')) return [{ locked: 1 }]
      assert.match(statement, /INSERT INTO "PasswordResetRateLimit"/)
      const [key, now, cutoff, , cap] = values
      const previous = limits.get(key)
      const row = previous && previous.windowStartedAt > cutoff ? { ...previous, count: Math.min(previous.count + 1, cap) } : { count: 1, windowStartedAt: now }
      limits.set(key, row); return [row]
    },
    $transaction(callback) {
      const run = transactions.then(async () => {
        const saved = structuredClone({ users, challenges, limits })
        try { return await callback(db) }
        catch (error) { ({ users, challenges, limits } = saved); throw error }
      })
      transactions = run.catch(() => undefined)
      return run
    },
    passwordResetSettings: { findUnique: async ({ select }) => selectRow(resetSettings, select) },
    registrationSettings: { findUnique: async () => ({ ...transportSettings }) },
    passwordResetRateLimit: { deleteMany: async ({ where }) => { for (const [key, row] of limits) if (row.windowStartedAt < where.windowStartedAt.lt) limits.delete(key) } },
    passwordResetChallenge: {
      deleteMany: async ({ where }) => { for (const [key, row] of challenges) if (row.expiresAt < where.expiresAt.lt) challenges.delete(key) },
      findUnique: async ({ where, select }) => {
        const row = where.channel_destination ? challenges.get(`${where.channel_destination.channel}:${where.channel_destination.destination}`) : challengeRows().find(item => item.id === where.id)
        return selectRow(row, select) ?? null
      },
      upsert: async ({ create, update }) => {
        const key = `${create.channel}:${create.destination}`
        challenges.set(key, challenges.has(key) ? { ...challenges.get(key), ...update } : { ...create })
      },
      updateMany: async ({ where, data }) => {
        let count = 0
        for (const row of challengeRows()) if (matches(row, where)) { apply(row, data); count++ }
        return { count }
      },
    },
    user: {
      findFirst: async ({ where, select }) => selectRow(users.find(row => matches(row, where)), select) ?? null,
      updateMany: async ({ where, data }) => {
        let count = 0
        for (const row of users) if (matches(row, where)) { apply(row, data); passwordWrites.push(structuredClone(data)); count++ }
        return { count }
      },
    },
  }
  const cache = new Map()
  const dependencies = {
    'next/server': { NextResponse: Response, after: callback => jobs.push(callback) },
    'node:crypto': { ...require('node:crypto'), randomInt: () => sequence++ }, 'node:net': require('node:net'),
    'bcryptjs': { compare: async (value, hash) => hash === `hash:${value}`, hash: async (value, cost) => { assert.equal(cost, 10); hashCalls++; if (hashHook) await hashHook(); return `hash:${value}` } },
    './prisma': { prisma: db },
    './registration-delivery': { sendPasswordResetCode: async (settings, message) => { deliveries.push({ settings, ...message }); if (deliveryHook) await deliveryHook(message); if (failDelivery) throw new Error('private provider credential/recipient failure') } },
    './registration-sms': { validateCustomSmsConfiguration: () => {} },
  }
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])) } static now() { return clock.now } }
  const globals = { Request, Response, Headers, Buffer, URL, Date: ClockDate, process: { env: { AUTH_SECRET: 'test-secret-'.repeat(4), REGISTRATION_EMAIL_API_KEY: 'test-provider-key', REGISTRATION_KAVENEGAR_API_KEY: 'test-sms-key', VERCEL: '1', ...env } } }
  function load(file) {
    const filename = path.resolve(root, file)
    if (cache.has(filename)) return cache.get(filename)
    const compiled = { exports: {} }
    const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
    vm.runInNewContext(code, { ...globals, module: compiled, require(name) {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('@/')) return load('src/' + name.slice(2) + '.ts')
      if (name.startsWith('./')) return load(path.join(path.dirname(filename), name + '.ts'))
      throw new Error('Unexpected dependency ' + name)
    } })
    cache.set(filename, compiled.exports); return compiled.exports
  }
  const route = load('src/app/api/auth/password-reset/route.ts')
  const codeRoute = load('src/app/api/auth/password-reset/code/route.ts')
  const request = (body, headers = {}, raw) => new Request('http://localhost/api/auth/password-reset', { method: 'POST', body: raw ?? JSON.stringify(body), headers: { 'x-vercel-forwarded-for': '203.0.113.1', ...headers } })
  const post = (body, headers, raw) => route.POST(request(body, headers, raw))
  return {
    clock, db, route, codeRoute, jobs, deliveries, queries, passwordWrites, resetSettings, transportSettings,
    users: () => users, challenges: challengeRows, limits: () => [...limits.entries()], hashCalls: () => hashCalls,
    send: (destination = email, channel = 'email', headers) => codeRoute.POST(request({ channel, destination }, headers)),
    reset: (challengeId, code, fields = {}, headers) => post({ challengeId, code, newPassword: password, confirmPassword: password, ...fields }, headers),
    post, async flush() { for (const job of jobs.splice(0)) await job() }, advance(ms) { clock.now += ms },
  }
}
const issue = async (h, destination = email, channel = 'email') => { const res = await h.send(destination, channel); assert.equal(res.status, 200); return res.json() }
async function invalid(response) { assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_PASSWORD_RESET_CODE') }

test('Capabilities are private, independently configured, and contain no secrets or account data', async () => {
  const h = setup()
  const res = await h.route.GET()
  assert.deepEqual(await res.json(), { enabled: true, emailEnabled: true, smsEnabled: false, expiryMinutes: 5, resendSeconds: 60 })
  assert.match(res.headers.get('Cache-Control'), /no-store/); assert.equal(res.headers.get('Vary'), 'Cookie')
  assert.equal(Date.parse(res.headers.get('Date')), h.clock.now)
  const disabled = setup({ settings: { enabled: false } })
  assert.equal((await disabled.send()).status, 503); assert.equal(disabled.jobs.length, 0)
  const noProvider = setup({ env: { REGISTRATION_EMAIL_API_KEY: '' } })
  assert.equal((await noProvider.send()).status, 503)
})

test('Active, absent and blocked accounts receive the same generic issuance shape without waiting for a provider', async () => {
  const states = [setup(), setup({ users: [] }), setup({ users: [account({ isActive: false })] }), setup({ failDelivery: true })]
  for (const h of states) {
    const result = await issue(h)
    assert.deepEqual(Object.keys(result).sort(), ['challengeId', 'expiresAt', 'message', 'resendAt'])
    assert.match(result.challengeId, /^[0-9a-f-]{36}$/)
    assert.equal(result.message, 'اگر حساب فعالی با این مشخصات وجود داشته باشد، کد بازیابی برای آن ارسال می‌شود.')
    assert.equal(Date.parse(result.expiresAt) - h.clock.now, 300000)
    assert.equal(Date.parse(result.resendAt) - h.clock.now, 60000)
    assert.equal(h.deliveries.length, 0); assert.equal(h.jobs.length, 1)
    assert.doesNotMatch(JSON.stringify(result), /buyer|000123|Digest|authVersion/)
    await h.flush()
  }
  assert.deepEqual(states.map(h => h.deliveries.length), [1, 0, 0, 1])
  assert.ok(states[3].challenges()[0].consumedAt)
  assert.ok(states[0].challenges()[0].deliveredAt)
})

test('A normalized legacy email account resets only after accepted delivery, preserves role, and revokes every previous session', async () => {
  const h = setup({ users: [account({ role: 'ADMIN' })] })
  const issued = await issue(h, ' BUYER@EXAMPLE.TEST ')
  assert.match(h.challenges()[0].codeDigest, /^[a-f0-9]{64}$/)
  assert.notEqual(h.challenges()[0].codeDigest, '000123')
  const registrationDigest = require('node:crypto').createHmac('sha256', 'test-secret-'.repeat(4)).update(JSON.stringify(['registration-otp:v1', 'code', issued.challengeId, 'email', email, '000123'])).digest('hex')
  assert.notEqual(h.challenges()[0].codeDigest, registrationDigest, 'Registration codes and reset codes use different cryptographic contexts')
  await invalid(await h.reset(issued.challengeId, '000123'))
  assert.equal(h.challenges()[0].attempts, 1)
  await h.flush()
  assert.equal(h.deliveries[0].destination, email); assert.equal(h.deliveries[0].code, '000123')
  const res = await h.reset(issued.challengeId, '۰۰۰۱۲۳')
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { success: true })
  assert.equal(res.headers.get('Set-Cookie'), null)
  assert.equal(h.users()[0].password, `hash:${password}`); assert.equal(h.users()[0].authVersion, 4); assert.equal(h.users()[0].role, 'ADMIN')
  assert.ok(h.challenges()[0].consumedAt); assert.equal(h.hashCalls(), 1)
  await invalid(await h.reset(issued.challengeId, '000123'))
  assert.equal(h.passwordWrites.length, 1)
})

test('Concurrent correct submissions consume the code once; concurrent wrong guesses cannot exceed the attempt budget', async () => {
  const h = setup({ settings: { maxAttempts: 3 } })
  const first = await issue(h); await h.flush()
  const responses = await Promise.all([h.reset(first.challengeId, '000123'), h.reset(first.challengeId, '000123')])
  assert.deepEqual(responses.map(res => res.status).sort(), [200, 400]); assert.equal(h.passwordWrites.length, 1)
  const wrong = setup({ settings: { maxAttempts: 3 } })
  const second = await issue(wrong); await wrong.flush()
  const guesses = await Promise.all(Array.from({ length: 3 }, () => wrong.reset(second.challengeId, '999999')))
  assert.ok(guesses.every(res => res.status === 400)); assert.equal(wrong.challenges()[0].attempts, 3)
  const exhausted = await wrong.reset(second.challengeId, '000123')
  await invalid(exhausted); assert.equal(wrong.passwordWrites.length, 0)
})

test('Cooldown rejections commit destination quotas, hide account existence, and retain the old challenge', async () => {
  const h = setup({ settings: { destinationHourlyLimit: 3 } })
  const issued = await issue(h)
  for (let i = 0; i < 2; i++) { const res = await h.send(); assert.equal(res.status, 429); assert.ok(res.headers.get('Retry-After')) }
  h.advance(60000)
  const limited = await h.send()
  assert.equal(limited.status, 429); assert.equal(h.challenges()[0].id, issued.challengeId)
  assert.ok(h.limits().some(([, row]) => row.count === 4))
  h.advance(3600000)
  assert.equal((await h.send()).status, 200)
})

test('Resend rotates identity, invalidates queued old deliveries, and replaces old codes', async () => {
  const h = setup()
  const first = await issue(h); h.advance(60000)
  const second = await issue(h)
  assert.notEqual(first.challengeId, second.challengeId)
  await h.flush(); assert.equal(h.deliveries.length, 1); assert.equal(h.deliveries[0].code, '000124')
  await invalid(await h.reset(first.challengeId, '000123'))
  await invalid(await h.reset(second.challengeId, '000123'))
  assert.equal((await h.reset(second.challengeId, '000124')).status, 200)
})

test('A failed old in-flight delivery cannot consume or mark a newer resent challenge', async () => {
  let rejectFirst
  const gate = new Promise((_resolve, reject) => { rejectFirst = reject })
  const h = setup({ deliveryHook: async message => { if (message.code === '000123') await gate } })
  await issue(h)
  const firstDelivery = h.jobs.shift()()
  await new Promise(setImmediate)
  assert.equal(h.deliveries.length, 1)
  h.advance(60000)
  const resent = await issue(h); await h.flush()
  rejectFirst(new Error('private obsolete delivery failure')); await firstDelivery
  assert.equal(h.challenges()[0].id, resent.challengeId)
  assert.equal(h.challenges()[0].consumedAt, null)
  assert.ok(h.challenges()[0].deliveredAt)
  assert.equal((await h.reset(resent.challengeId, '000124')).status, 200)
})

test('Successful recovery consumes every older recovery challenge for that user across channels', async () => {
  const h = setup({ users: [account({ loginPhone: mobile, phoneVerifiedAt: new Date() })], settings: { smsEnabled: true } })
  const emailChallenge = await issue(h)
  const smsChallenge = await issue(h, mobile, 'sms')
  await h.flush()
  assert.equal((await h.reset(emailChallenge.challengeId, '000123')).status, 200)
  assert.ok(h.challenges().every(challenge => challenge.consumedAt))
  await invalid(await h.reset(smsChallenge.challengeId, '000124'))
  assert.equal(h.passwordWrites.length, 1)
})

test('Reset codes expire and settings, provider, account credentials, activity or identity changes invalidate them', async () => {
  for (const change of ['expiry', 'settings', 'provider', 'version', 'blocked', 'email']) {
    const h = setup(); const issued = await issue(h); await h.flush()
    if (change === 'expiry') h.advance(300000)
    if (change === 'settings') h.resetSettings.version++
    if (change === 'provider') h.transportSettings.version++
    if (change === 'version') { h.users()[0].authVersion++; h.users()[0].password = 'hash:support-change' }
    if (change === 'blocked') h.users()[0].isActive = false
    if (change === 'email') h.users()[0].email = 'changed@example.test'
    await invalid(await h.reset(issued.challengeId, '000123'))
    assert.equal(h.passwordWrites.length, 0, change)
  }
})

test('Disabled reset and changed delivery settings prevent queued messages, without serializing codes into responses', async () => {
  for (const change of ['reset', 'provider', 'blocked']) {
    const h = setup(); await issue(h)
    if (change === 'reset') { h.resetSettings.enabled = false; h.resetSettings.version++ }
    if (change === 'provider') h.transportSettings.version++
    if (change === 'blocked') h.users()[0].isActive = false
    await h.flush(); assert.equal(h.deliveries.length, 0)
  }
})

test('Mobile recovery uses only a verified login identity, never an ordinary contact phone', async () => {
  for (const details of [{ phone: mobile }, { loginPhone: mobile }, { loginPhone: mobile, phoneVerifiedAt: new Date() }]) {
    const h = setup({ users: [account(details)], settings: { smsEnabled: true } })
    const issued = await issue(h, '+98 912 345 6789', 'sms'); await h.flush()
    const verified = !!details.phoneVerifiedAt
    assert.equal(h.deliveries.length, Number(verified))
    const res = await h.reset(issued.challengeId, '000123')
    assert.equal(res.status, verified ? 200 : 400)
  }
})

test('Network quotas ignore spoofed forwarding headers outside trusted hosting and verification is independently bounded', async () => {
  const h = setup({ settings: { ipHourlyLimit: 1 }, env: { VERCEL: '0' } })
  await issue(h)
  assert.equal((await h.send('other@example.test', 'email', { 'x-vercel-forwarded-for': '203.0.113.2', 'x-forwarded-for': '203.0.113.3' })).status, 429)
  const invalidId = '00000000-0000-4000-8000-000000000001'
  const verify = setup({ settings: { ipHourlyLimit: 1, maxAttempts: 1 } })
  await invalid(await verify.reset(invalidId, '123456'))
  assert.equal((await verify.reset(invalidId, '123456')).status, 429)
  assert.equal(verify.hashCalls(), 0)
})

test('Malformed bodies, cross-origin requests and invalid mailbox/mobile forms fail before delivery or challenge creation', async () => {
  const h = setup()
  assert.equal((await h.send(email, 'email', { origin: 'https://elsewhere.test' })).status, 403)
  assert.equal((await h.post({}, { 'sec-fetch-site': 'same-site' })).status, 403)
  for (const value of ['Name <buyer@example.test>', 'a@example.test,b@example.test', 'a@localhost']) assert.equal((await h.send(value)).status, 400)
  assert.equal((await h.send('02112345678', 'sms')).status, 400)
  assert.equal((await h.post({}, {}, '[]')).status, 400)
  assert.equal((await h.post({}, {}, 'x'.repeat(8193))).status, 413)
  assert.equal((await h.post({}, { 'content-length': '9000' })).status, 413)
  assert.equal(h.challenges().length, 0); assert.equal(h.jobs.length, 0)
})

test('Password confirmation, bcrypt byte bounds and old-password reuse do not consume a valid recovery code', async () => {
  const h = setup(); const issued = await issue(h); await h.flush()
  for (const fields of [{ newPassword: 'short', confirmPassword: 'short' }, { newPassword: '😀'.repeat(19), confirmPassword: '😀'.repeat(19) }, { confirmPassword: 'different' }, { newPassword: 'old-password', confirmPassword: 'old-password' }]) {
    const res = await h.reset(issued.challengeId, '000123', fields)
    assert.equal(res.status, 400); assert.equal(h.challenges()[0].consumedAt, null); assert.equal(h.passwordWrites.length, 0)
  }
  assert.equal((await h.reset(issued.challengeId, '000123')).status, 200)
})

test('A code that expires while hashing cannot win the final password-change claim', async () => {
  let h
  h = setup({ settings: { expiryMinutes: 1 }, hashHook: async () => h.advance(1) })
  const issued = await issue(h); await h.flush(); h.advance(59999)
  await invalid(await h.reset(issued.challengeId, '000123'))
  assert.equal(h.passwordWrites.length, 0)
  assert.equal(h.users()[0].password, 'hash:old-password')
  assert.equal(h.challenges()[0].consumedAt, null)
})
