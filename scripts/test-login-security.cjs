const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function fixture({ vercel = true, policy = {} } = {}) {
  let now = 1_800_000_000_000, compares = 0, lookups = 0, failDatabase = false
  const env = { AUTH_SECRET: 'login-security-unit-secret-at-least-32-characters', VERCEL: vercel ? '1' : '' }
  const rows = new Map(), cache = new Map()
  const users = [
    { id: 'buyer', name: 'خریدار', email: 'buyer@example.test', loginPhone: '09123456789', phoneVerifiedAt: new Date(now), isActive: true, password: 'hash:correct', role: 'USER', authVersion: 4 },
    { id: 'blocked', email: 'blocked@example.test', isActive: false, password: 'hash:correct' },
    { id: 'unverified', email: 'unverified@example.test', loginPhone: '09120000000', phoneVerifiedAt: null, isActive: true, password: 'hash:correct' },
  ]
  const settings = { version: 0, maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ipMaxAttempts: 30, ...policy }
  const db = {
    loginSecuritySettings: { findUnique: async () => settings },
    loginAttemptWindow: {
      findUnique: async ({ where }) => rows.get(where.key) ?? null,
      upsert: async ({ where, create, update }) => {
        const row = rows.has(where.key) ? { ...rows.get(where.key), ...update } : { ...create }
        rows.set(where.key, row); return row
      },
      deleteMany: async ({ where }) => {
        let count = 0
        for (const [key, row] of rows) if (where.key ? key === where.key
          : row.updatedAt < where.updatedAt.lt && (!row.blockedUntil || row.blockedUntil <= where.OR[1].blockedUntil.lte)) {
          rows.delete(key); count++
        }
        return { count }
      },
    },
    user: {
      findUnique: async ({ where }) => { lookups++; return users.find(user => user.loginPhone === where.loginPhone) ?? null },
      findFirst: async ({ where }) => { lookups++; return users.find(user => user.email === where.email.equals.replace(/\\([\\%_])/g, '$1')) ?? null },
    },
    $queryRaw: async () => [],
    $transaction: async callback => { if (failDatabase) throw new Error('database unavailable'); return callback(db) },
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const compiled = { exports: {} }; cache.set(file, compiled)
    vm.runInNewContext(transformSync(readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
      module: compiled, Date: Clock, Buffer, process: { env },
      require(name) {
        if (name === './prisma') return { prisma: db }
        if (name === 'next/server') return { NextResponse: Response }
        if (name === 'bcryptjs') return { compare: async (password, hash) => { compares++; return hash === 'hash:' + password } }
        if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(file), name + '.ts'))
        return require(name)
      },
    }, { filename: file })
    return compiled.exports
  }
  const core = load('src/lib/login-security.ts')
  const attempt = (credentials = {}, ip = '192.0.2.10', extraHeaders = {}) => core.authorizePasswordLogin(
    { email: 'buyer@example.test', password: 'wrong', ...credentials },
    new Request('http://localhost/api/auth/callback/credentials', { headers: { 'x-vercel-forwarded-for': ip, ...extraHeaders } }),
  )
  return { core, attempt, rows, settings, users, env, db, get compares() { return compares }, get lookups() { return lookups },
    advance: ms => { now += ms }, now: () => now, fail: () => { failDatabase = true } }
}

test('Fifth failed password commits both counters and temporarily rejects even a correct password', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) assert.equal(await f.attempt(), null)
  await assert.rejects(f.attempt(), error => error instanceof f.core.LoginRateLimitError && error.retryAfterSeconds === 900)
  const locked = [...f.rows.values()].find(row => row.blockedUntil)
  assert.equal(locked.failures, 5)
  const deadline = locked.blockedUntil.getTime()
  f.advance(30_000)
  await assert.rejects(f.attempt({ password: 'correct' }), error => error.retryAfterSeconds === 870)
  assert.equal(locked.blockedUntil.getTime(), deadline)
  assert.equal(f.compares, 5)
  assert.equal(locked.failures, 5)
})

test('Email case and Persian/international phone aliases share the account quota across networks', async () => {
  const f = fixture()
  await f.attempt({ email: ' BUYER@EXAMPLE.TEST ' }, '192.0.2.1')
  await f.attempt({ email: '', loginPhone: '+۹۸ ۹۱۲-۳۴۵-۶۷۸۹' }, '192.0.2.2')
  await f.attempt({}, '192.0.2.3')
  await f.attempt({ email: '', loginPhone: '٠٩١٢٣٤٥٦٧٨٩' }, '192.0.2.4')
  await assert.rejects(f.attempt({}, '192.0.2.5'), f.core.LoginRateLimitError)
  await assert.rejects(f.attempt({ email: '', loginPhone: '09123456789', password: 'correct' }, '192.0.2.6'), f.core.LoginRateLimitError)
  assert.equal(f.compares, 5)
})

test('Successful login clears account failures and preserves identity/authVersion and network failures', async () => {
  const f = fixture()
  await f.attempt(); await f.attempt()
  const user = await f.attempt({ password: 'correct' })
  assert.equal(user.id, 'buyer'); assert.equal(user.authVersion, 4)
  assert.equal(Object.hasOwn(user, 'password'), false)
  assert.equal(f.rows.size, 1)
  assert.equal([...f.rows.values()][0].failures, 2)
  for (let i = 0; i < 4; i++) assert.equal(await f.attempt(), null)
  await assert.rejects(f.attempt(), f.core.LoginRateLimitError)
})

test('Expired counting windows reset; expired locks reset even inside a longer window', async () => {
  const f = fixture({ policy: { windowMinutes: 60, lockMinutes: 1 } })
  for (let i = 0; i < 4; i++) await f.attempt()
  f.advance(60 * 60_000)
  assert.equal(await f.attempt(), null)
  for (let i = 0; i < 3; i++) await f.attempt()
  await assert.rejects(f.attempt(), error => error.retryAfterSeconds === 60)
  f.advance(60_000)
  assert.equal(await f.attempt(), null)
  assert.equal([...f.rows.values()].find(row => row.failures === 1).blockedUntil, null)
  assert.ok(await f.attempt({ password: 'correct' }))
})

test('Changing policy cannot shorten a currently active lock', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) await f.attempt()
  await assert.rejects(f.attempt(), f.core.LoginRateLimitError)
  Object.assign(f.settings, { lockMinutes: 1, windowMinutes: 1, maxAttempts: 20 })
  f.advance(2 * 60_000)
  await assert.rejects(f.attempt(), error => error.retryAfterSeconds === 780)
})

test('Unknown, inactive and unverified-phone accounts do dummy comparisons and generic failures', async () => {
  const f = fixture()
  for (const credentials of [
    { email: 'missing@example.test', password: 'correct' },
    { email: 'blocked@example.test', password: 'correct' },
    { email: '', loginPhone: '09120000000', password: 'correct' },
  ]) assert.equal(await f.attempt(credentials), null)
  assert.equal(f.compares, 3)
  assert.equal([...f.rows.keys()].every(key => /^[a-f0-9]{64}$/.test(key)), true)
  assert.doesNotMatch(JSON.stringify([...f.rows.values()]), /example|0912|192\.0|correct|wrong/)
})

test('Network quota spans unknown accounts and successful logins do not clear it', async () => {
  const f = fixture({ policy: { ipMaxAttempts: 10 } })
  for (let i = 0; i < 9; i++) assert.equal(await f.attempt({ email: `unknown${i}@example.test` }), null)
  assert.ok(await f.attempt({ password: 'correct' }))
  await assert.rejects(f.attempt({ email: 'last@example.test' }), f.core.LoginRateLimitError)
  const lookups = f.lookups
  await assert.rejects(f.attempt({ email: 'different@example.test', password: 'correct' }), f.core.LoginRateLimitError)
  assert.equal(f.lookups, lookups, 'Network block is checked before account lookup')
  assert.ok(await f.attempt({ password: 'correct' }, '192.0.2.11'))
})

test('Non-Vercel hosts ignore forged forwarding headers and share a fallback quota', async () => {
  const f = fixture({ vercel: false, policy: { ipMaxAttempts: 10 } })
  for (let i = 0; i < 9; i++) await f.attempt({ email: `unknown${i}@example.test` }, `192.0.2.${i}`, { 'x-forwarded-for': `203.0.113.${i}` })
  await assert.rejects(f.attempt({ email: 'last@example.test' }, '203.0.113.99'), f.core.LoginRateLimitError)
})

test('Equivalent IPv6 and IPv4-mapped address spellings share network buckets', async () => {
  const f = fixture()
  await f.attempt({ email: 'one@example.test' }, '2001:db8::1')
  await f.attempt({ email: 'two@example.test' }, '2001:0db8:0:0:0:0:0:1')
  await f.attempt({ email: 'three@example.test' }, '::ffff:192.0.2.10')
  await f.attempt({ email: 'four@example.test' }, '192.0.2.10')
  assert.equal([...f.rows.values()].filter(row => row.failures === 2).length, 2)
})

test('Malformed trusted-IP headers use the shared fallback rather than caller-controlled keys', async () => {
  const f = fixture()
  await f.attempt({ email: 'one@example.test' }, '192.0.2.1, 192.0.2.2')
  await f.attempt({ email: 'two@example.test' }, 'arbitrary-text')
  assert.equal([...f.rows.values()].filter(row => row.failures === 2).length, 1)
})

test('Malformed/oversized credentials never enter a password comparison', async () => {
  const f = fixture()
  for (const credentials of [{ password: '' }, { password: 'x'.repeat(73) }, { password: 'آ'.repeat(37) },
    { email: [] }, { email: 'x'.repeat(255) }, { email: 'no-at-sign' }, { loginPhone: '09123456789' },
    { email: '', loginPhone: 'not-a-phone' }, { email: '', loginPhone: '9'.repeat(65) }]) {
    assert.equal(await f.attempt(credentials), null)
  }
  assert.equal(f.compares, 0); assert.equal(f.rows.size, 0)
})

test('Missing secret and database failure fail closed', async () => {
  const f = fixture()
  f.env.AUTH_SECRET = ''
  await assert.rejects(f.attempt({ password: 'correct' }), /secret/)
  f.env.AUTH_SECRET = 'another-test-secret-at-least-thirty-two'
  f.fail()
  await assert.rejects(f.attempt({ password: 'correct' }), /database unavailable/)
  assert.equal(f.compares, 0)
})

test('Old inactive rows are cleaned while active blocks remain', async () => {
  const f = fixture()
  const old = new Date(f.now() - 25 * 60 * 60_000)
  f.rows.set('old', { key: 'old', updatedAt: old, windowStartedAt: old, failures: 1, blockedUntil: null })
  f.rows.set('locked', { key: 'locked', updatedAt: old, windowStartedAt: old, failures: 5, blockedUntil: new Date(f.now() + 60_000) })
  await f.attempt()
  assert.equal(f.rows.has('old'), false)
  assert.equal(f.rows.has('locked'), true)
})
