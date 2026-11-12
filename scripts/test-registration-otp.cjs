const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const password = 'correct-horse-battery'
const email = 'test@example.com'
const phone = '09123456789'
const postalCode = '0123456789'
const defaults = {
  id: 1, version: 1, emailEnabled: true, smsEnabled: true, expiryMinutes: 5,
  maxAttempts: 3, resendSeconds: 15, destinationHourlyLimit: 5, ipHourlyLimit: 30,
  emailSender: 'auth', smsTemplate: 'login',
}

function matchesInsensitiveLike(value, pattern) {
  const expression = pattern.replace(/\\(.)|./gs, (token, escaped) => {
    if (!escaped && token === '%') return '.*'
    if (!escaped && token === '_') return '.'
    return (escaped ?? token).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
  })
  return typeof value === 'string' && new RegExp('^' + expression + '$', 'is').test(value)
}

function setup({ settings = {}, failDelivery = false, seededUsers = [], conflict = false } = {}) {
  const clock = { now: 1_800_000_000_000 }
  const deliveries = []
  let hashCalls = 0
  let userLookups = 0
  let challenges = new Map()
  let limits = new Map()
  let users = [...seededUsers]
  let transactions = Promise.resolve()

  const prisma = {
    $queryRaw: async (sql, key, now, cutoff, _countCutoff, cap) => {
      const statement = sql.join('?')
      if (statement.includes('pg_advisory_xact_lock')) return [{ locked: 1 }]
      assert.match(statement, /INSERT INTO "RegistrationRateLimit"/)
      const previous = limits.get(key)
      const row = previous && previous.windowStartedAt > cutoff
        ? { ...previous, count: Math.min(previous.count + 1, cap) }
        : { count: 1, windowStartedAt: now }
      limits.set(key, row)
      return [row]
    },
    $transaction: callback => {
      const run = transactions.then(async () => {
        const snapshot = structuredClone({ challenges, limits, users })
        try {
          return await callback(prisma)
        } catch (error) {
          ;({ challenges, limits, users } = snapshot)
          throw error
        }
      })
      transactions = run.catch(() => undefined)
      return run
    },
    registrationSettings: { findUnique: async () => ({ ...defaults, ...settings }) },
    registrationRateLimit: {
      deleteMany: async ({ where }) => {
        for (const [key, row] of limits) if (row.windowStartedAt < where.windowStartedAt.lt) limits.delete(key)
      },
    },
    registrationChallenge: {
      deleteMany: async ({ where }) => {
        for (const [key, row] of challenges) if (row.expiresAt < where.expiresAt.lt) challenges.delete(key)
      },
      findUnique: async ({ where }) => {
        const key = where.channel_destination
        const row = key ? challenges.get(`${key.channel}:${key.destination}`)
          : [...challenges.values()].find(entry => entry.id === where.id)
        return row && { ...row }
      },
      upsert: async ({ create, update }) => {
        const key = `${create.channel}:${create.destination}`
        const row = challenges.has(key) ? { ...challenges.get(key), ...update } : { ...create }
        challenges.set(key, row)
      },
      updateMany: async ({ where, data }) => {
        const row = [...challenges.values()].find(entry => entry.id === where.id)
        if (!row || row.consumedAt || (where.codeDigest && row.codeDigest !== where.codeDigest) ||
            (where.expiresAt && row.expiresAt <= where.expiresAt.gt) || (where.attempts && row.attempts >= where.attempts.lt)) return { count: 0 }
        if (data.attempts) row.attempts += data.attempts.increment
        if (data.consumedAt) row.consumedAt = data.consumedAt
        return { count: 1 }
      },
    },
    user: {
      findFirst: async ({ where }) => {
        userLookups++
        if (!where.email) return users.find(user => user.loginPhone === where.loginPhone)
        const { equals, mode } = where.email
        return mode === 'insensitive'
          ? users.find(user => matchesInsensitiveLike(user.email, equals))
          : users.find(user => user.email === equals)
      },
      createManyAndReturn: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true)
        if (conflict) return []
        const row = { email: null, loginPhone: null, ...data, id: `user-${users.length + 1}` }
        users.push(row)
        return [{ id: row.id, email: row.email, loginPhone: row.loginPhone, name: row.name }]
      },
    },
  }

  const dependencies = {
    'next/server': { NextResponse: Response },
    'node:crypto': require('node:crypto'),
    'node:net': require('node:net'),
    './prisma': { prisma },
    'node:dns/promises': { lookup: async () => { throw new Error('Unexpected SMS DNS request') } },
    'node:https': { request: () => { throw new Error('Unexpected SMS HTTP request') } },
    'ipaddr.js': require('ipaddr.js'),
    'bcryptjs': { hash: async (value, cost) => { hashCalls++; assert.equal(cost, 10); return `hash:${value}` } },
    './registration-delivery': { sendRegistrationCode: async (_settings, message) => {
      deliveries.push(message)
      if (failDelivery) throw new Error('private provider failure')
    } },
  }
  const sandbox = {
    Response, Headers, Buffer, URL,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.now])) }
      static now() { return clock.now }
    },
    process: { env: { AUTH_SECRET: 'x'.repeat(40), REGISTRATION_EMAIL_API_KEY: 'test-email', REGISTRATION_KAVENEGAR_API_KEY: 'test-sms', VERCEL: '1' } },
  }
  const cache = new Map()
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename)
    const source = readFileSync(filename, 'utf8')
    const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
    const testModule = { exports: {} }
    const requireDependency = (name) => {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('@/')) return load(path.join(root, `src/${name.slice(2)}.ts`))
      if (name.startsWith('./')) return load(path.join(path.dirname(filename), `${name}.ts`))
      throw new Error(`Unexpected dependency ${name}`)
    }
    vm.runInNewContext(code, { ...sandbox, module: testModule, require: requireDependency }, { filename })
    cache.set(filename, testModule.exports)
    return testModule.exports
  }

  const route = load(path.join(root, 'src/app/api/auth/register/route.ts'))
  const codeRoute = load(path.join(root, 'src/app/api/auth/register/code/route.ts'))
  const request = (body, headers) => new Request('http://localhost/api/auth/register', {
    method: 'POST', body: JSON.stringify(body), headers: { 'x-vercel-forwarded-for': '203.0.113.1', ...headers },
  })
  return {
    clock, deliveries, codeRoute, route, request,
    users: () => users, challenges: () => [...challenges.values()], limits: () => [...limits.keys()],
    hashCalls: () => hashCalls, userLookups: () => userLookups,
    send: (destination = email, channel = 'email', headers) => codeRoute.POST(request({ destination, channel }, headers)),
    verify: (challengeId, code, fields = {}, headers) => route.POST(request({ challengeId, code, name: ' Name ', password, phone, postalCode, ...fields }, headers)),
  }
}

async function assertInvalidRegistrationCode(response) {
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'کد تأیید نامعتبر است یا اعتبار آن به پایان رسیده است.',
    code: 'INVALID_REGISTRATION_CODE',
  })
}

test('Public capability response excludes secrets and rejects disabled methods, malformed destinations and cross-origin bodies', async () => {
  const subject = setup({ settings: { smsEnabled: false } })
  const response = await subject.route.GET()
  assert.deepEqual(await response.json(), { emailEnabled: true, smsEnabled: false })
  assert.match(response.headers.get('Cache-Control'), /no-store/)
  assert.equal((await subject.send('09121234567', 'sms')).status, 503)
  assert.equal((await subject.send('02112345678', 'sms')).status, 400)
  assert.equal((await subject.send('Name<test@example.com>')).status, 400)
  assert.equal((await subject.send('test@example.com,localhost')).status, 400)
  assert.equal((await subject.send(email, 'email', { origin: 'http://foreign.example' })).status, 403)
  assert.equal((await subject.codeRoute.POST(subject.request({ extra: 'a'.repeat(9_000) }))).status, 413)
  assert.equal(subject.deliveries.length, 0)
})

test('Email OTP is normalized, hashed, single-use and creates only a verified customer account', async () => {
  const subject = setup()
  const response = await subject.send(' TEST@Example.com ')
  assert.equal(response.status, 200)
  assert.equal(Date.parse(response.headers.get('Date')), subject.clock.now)
  const issued = await response.json()
  assert.deepEqual(Object.keys(issued).sort(), ['challengeId', 'expiresAt', 'resendAt'])
  assert.equal(Date.parse(issued.expiresAt) - subject.clock.now, 300_000)
  assert.equal(Date.parse(issued.resendAt) - subject.clock.now, 15_000)
  const delivered = subject.deliveries[0]
  assert.equal(delivered.destination, email)
  assert.match(delivered.code, /^\d{6}$/)
  assert.equal(subject.userLookups(), 1)
  assert.match(subject.challenges()[0].codeDigest, /^[0-9a-f]{64}$/)
  assert.notEqual(subject.challenges()[0].codeDigest, delivered.code)
  assert.ok(subject.limits().every(key => /^[0-9a-f]{64}$/.test(key)))

  const persianCode = [...delivered.code].map(digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]).join('')
  const verified = await subject.verify(issued.challengeId, persianCode, {
    role: 'ADMIN', email: 'attacker@example.com', phone: '+۹۸ (۹۱۲) ۳۴۵-۶۷۸۹', postalCode: '۰۱۲۳۴-۵۶۷۸۹',
  })
  assert.equal(verified.status, 201)
  assert.deepEqual(await verified.json(), { id: 'user-1', name: 'Name', email, loginPhone: null })
  assert.equal(subject.users()[0].role, 'USER')
  assert.equal(subject.users()[0].password, `hash:${password}`)
  assert.equal(subject.users()[0].phone, phone)
  assert.equal(subject.users()[0].postalCode, postalCode)
  assert.equal(+subject.users()[0].emailVerifiedAt, subject.clock.now)
  await assertInvalidRegistrationCode(await subject.verify(issued.challengeId, delivered.code))
})

test('SMS OTP keeps verified phone identity separate from delivery contact and rejects concurrent replay', async () => {
  const subject = setup()
  const { challengeId } = await (await subject.send('+۹۸ (۹۱۲) ۱۲۳-۴۵۶۷', 'sms')).json()
  const delivered = subject.deliveries[0]
  assert.equal(delivered.destination, '09121234567')
  const fields = { loginPhone: phone, phoneVerifiedAt: '2020-01-01' }
  const responses = await Promise.all([subject.verify(challengeId, delivered.code, fields), subject.verify(challengeId, delivered.code, fields)])
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 400])
  await assertInvalidRegistrationCode(responses.find(response => !response.ok))
  assert.equal(subject.hashCalls(), 1)
  assert.equal(subject.users().length, 1)
  assert.equal(subject.users()[0].loginPhone, delivered.destination)
  assert.equal(subject.users()[0].phone, phone)
  assert.equal(subject.users()[0].postalCode, postalCode)
  assert.equal(subject.users()[0].email, null)
  assert.equal(+subject.users()[0].phoneVerifiedAt, subject.clock.now)
})

test('Missing or invalid registration contact leaves the OTP available for corrected information', async () => {
  for (const [channel, destination] of [['email', email], ['sms', '09121234567']]) {
    const subject = setup()
    const { challengeId } = await (await subject.send(destination, channel)).json()
    const { code } = subject.deliveries[0]
    for (const fields of [{ phone: undefined }, { phone: '12345' }, { postalCode: undefined }, { postalCode: '0000000000' }]) {
      const response = await subject.verify(challengeId, code, fields)
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, undefined)
    }
    assert.equal(subject.challenges()[0].consumedAt, null)
    assert.equal(subject.challenges()[0].attempts, 0)
    assert.equal(subject.hashCalls(), 0)
    assert.equal(subject.users().length, 0)
    assert.equal((await subject.verify(challengeId, code)).status, 201)
  }
})

test('OTP verification bounds incorrect attempts before hashing and rejects an expired challenge', async () => {
  const subject = setup()
  const { challengeId } = await (await subject.send()).json()
  const correct = subject.deliveries[0].code
  const wrong = correct === '000000' ? '000001' : '000000'
  await assertInvalidRegistrationCode(await subject.verify(challengeId, '12345'))
  const badPassword = await subject.verify(challengeId, correct, { password: 'short' })
  assert.equal(badPassword.status, 400)
  assert.equal((await badPassword.json()).code, undefined)
  const result = await Promise.all(Array.from({ length: 5 }, () => subject.verify(challengeId, wrong)))
  await Promise.all(result.map(assertInvalidRegistrationCode))
  assert.equal(subject.challenges()[0].attempts, 3)
  await assertInvalidRegistrationCode(await subject.verify(challengeId, correct))
  assert.equal(subject.hashCalls(), 0)

  subject.clock.now += 16_000
  const second = await (await subject.send()).json()
  subject.clock.now = Date.parse(second.expiresAt)
  await assertInvalidRegistrationCode(await subject.verify(second.challengeId, subject.deliveries[1].code))
  assert.equal(subject.users().length, 0)
})

test('Concurrent sends obey cooldown, resend rotates the challenge and the destination limit spans IPs', async () => {
  const subject = setup({ settings: { destinationHourlyLimit: 2 } })
  const responses = await Promise.all([subject.send(), subject.send()])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429])
  const first = await responses.find(response => response.ok).json()
  const cooldown = responses.find(response => response.status === 429)
  assert.equal(cooldown.headers.get('retry-after'), '15')
  assert.equal((await cooldown.json()).retryAt, first.resendAt)
  assert.equal(subject.deliveries.length, 1)
  subject.clock.now += 16_000
  const second = await (await subject.send()).json()
  assert.notEqual(second.challengeId, first.challengeId)
  await assertInvalidRegistrationCode(await subject.verify(first.challengeId, subject.deliveries[0].code))
  subject.clock.now += 16_000
  const limited = await subject.send(email, 'email', { 'x-vercel-forwarded-for': '203.0.113.2' })
  assert.equal(limited.status, 429)
  assert.equal(subject.deliveries.length, 2)
  subject.clock.now += 3_600_000
  assert.equal((await subject.send()).status, 200)
})

test('IP rate limit protects unrelated destinations and provider failure keeps cooldown without disclosing details', async () => {
  const subject = setup({ settings: { ipHourlyLimit: 2 }, failDelivery: true })
  const failed = await subject.send()
  assert.equal(failed.status, 502)
  const { error, retryAt } = await failed.json()
  assert.doesNotMatch(error, /provider|@|private/)
  assert.equal(Date.parse(retryAt) - subject.clock.now, 15_000)
  assert.ok(subject.challenges()[0].consumedAt)
  const cooldown = await subject.send()
  assert.equal(cooldown.status, 429)
  assert.equal((await cooldown.json()).retryAt, retryAt)
  const limited = await subject.send('other@example.com', 'email', { 'x-forwarded-for': '203.0.113.99' })
  assert.equal(limited.status, 429)
  assert.equal(subject.deliveries.length, 1)
})

test('Existing email and verified login mobile stop issuance before creating a challenge or sending a code', async () => {
  const subject = setup({
    seededUsers: [
      { id: 'email-account', email: 'Test@Example.com' },
      { id: 'mobile-account', email: null, loginPhone: '09121234567', phone: '09120000000' },
    ],
  })
  for (const [destination, channel] of [[' TEST@example.com ', 'email'], ['+۹۸ (۹۱۲) ۱۲۳-۴۵۶۷', 'sms']]) {
    const response = await subject.send(destination, channel)
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'برای این ایمیل یا شمارهٔ موبایل حساب وجود دارد. وارد حساب شوید.' })
  }
  assert.equal(subject.deliveries.length, 0)
  assert.equal(subject.challenges().length, 0)
  assert.equal(subject.hashCalls(), 0)
})

test('Email identifiers containing LIKE wildcard characters match only the exact address', async () => {
  const subject = setup({ seededUsers: [{ id: 'similar', email: 'axb-extra@example.com' }] })
  const address = 'a_b%@example.com'
  const response = await subject.send(address)
  assert.equal(response.status, 200)
  const { challengeId } = await response.json()
  assert.equal((await subject.verify(challengeId, subject.deliveries[0].code)).status, 201)
  assert.equal(subject.users()[1].email, address)
  assert.equal((await subject.send(' A_B%@Example.com ')).status, 409)
  assert.equal(subject.deliveries.length, 1)
})

test('A checkout contact number does not reserve the mobile login identifier', async () => {
  const subject = setup({
    seededUsers: [{ id: 'email-account', email, loginPhone: null, phone: '09121234567' }],
  })
  const response = await subject.send('09121234567', 'sms')
  assert.equal(response.status, 200)
  const { challengeId } = await response.json()
  assert.equal((await subject.verify(challengeId, subject.deliveries[0].code)).status, 201)
  assert.equal(subject.users()[0].loginPhone, null)
  assert.equal(subject.users()[1].loginPhone, '09121234567')
})

test('Duplicate issuance still consumes network and destination budgets before exposing account existence', async () => {
  const subject = setup({
    seededUsers: [{ id: 'existing', email }],
    settings: { ipHourlyLimit: 1, destinationHourlyLimit: 1 },
  })
  assert.equal((await subject.send()).status, 409)
  assert.equal((await subject.send('different@example.com')).status, 429)
  assert.equal((await subject.send(email, 'email', { 'x-vercel-forwarded-for': '203.0.113.2' })).status, 429)
  assert.equal(subject.userLookups(), 1)
  assert.equal(subject.deliveries.length, 0)
  assert.equal(subject.challenges().length, 0)
})

test('An account created after issuance or a concurrent insert consumes the verified challenge without creating a duplicate', async () => {
  for (const conflict of [false, true]) {
    const subject = setup({ conflict })
    const send = await subject.send()
    assert.equal(send.status, 200)
    if (!conflict) subject.users().push({ id: 'existing', email: 'Test@Example.com' })
    const { challengeId } = await send.json()
    const correct = subject.deliveries[0].code
    const wrong = correct === '000000' ? '000001' : '000000'
    const lookups = subject.userLookups()
    await assertInvalidRegistrationCode(await subject.verify(challengeId, wrong))
    assert.equal(subject.userLookups(), lookups)
    const duplicate = await subject.verify(challengeId, correct)
    assert.equal(duplicate.status, 409)
    assert.equal((await duplicate.json()).code, undefined)
    await assertInvalidRegistrationCode(await subject.verify(challengeId, correct))
    assert.equal(subject.users().length, conflict ? 0 : 1)
    assert.ok(subject.challenges()[0].consumedAt)
  }
})
