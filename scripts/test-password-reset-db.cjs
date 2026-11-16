// PostgreSQL integration in one disposable schema. Real mail/SMS are never
// contacted; only a mocked transport and an explicitly flushed Next after queue
// receive fixture codes. No public business row, credential or sequence changes.
const assert = require('node:assert/strict')
const { randomBytes, createHmac } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.protocol !== 'postgresql:' || target.hostname !== '192.168.1.105' || target.pathname !== '/shoes_shop'
  || (target.searchParams.get('schema') || 'public') !== 'public') throw new Error('Password recovery integration requires the designated local development database')
const schema = 'test_password_reset_' + randomBytes(8).toString('hex')
const checkScope = () => assert.match(schema, /^test_password_reset_[a-f0-9]{16}$/)
const identifier = value => { assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/); return '"' + value + '"' }
checkScope()
const scope = identifier(schema)
const testUrl = new URL(target), sourceUrl = new URL(target)
testUrl.searchParams.set('schema', schema); testUrl.searchParams.set('connection_limit', '6'); testUrl.searchParams.set('connect_timeout', '10')
sourceUrl.searchParams.set('connection_limit', '1'); sourceUrl.searchParams.set('connect_timeout', '10')
const source = new PrismaClient({ datasourceUrl: sourceUrl.toString() })
const db = new PrismaClient({ datasourceUrl: testUrl.toString() })
const tables = ['User', 'RegistrationSettings', 'PasswordResetSettings', 'PasswordResetChallenge', 'PasswordResetRateLimit']
const secret = 'isolated-password-reset-otp-test-secret-at-least-32'
const env = { NODE_ENV: 'test', AUTH_SECRET: secret, REGISTRATION_EMAIL_API_KEY: 'isolated-test-email-key-never-sent', REGISTRATION_KAVENEGAR_API_KEY: 'isolated-test-sms-key-never-sent' }
const basePolicy = { enabled: true, emailEnabled: true, smsEnabled: false, expiryMinutes: 5, maxAttempts: 5, resendSeconds: 15, destinationHourlyLimit: 20, ipHourlyLimit: 100, version: 0 }
const oldPassword = 'Existing-fixture-password'
const newPassword = 'Replacement-fixture-password'
const cache = new Map(), afterQueue = [], deliveries = []
let created = false, deliveryGate = null, deliveryFailure = false, enteringCoreLock = null, activeTransactions = 0, oldHash
let session = { user: { id: 'reset-admin', role: 'ADMIN' } }

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const client = new Proxy(db, { get(targetClient, key) {
  if (key === '$transaction') return async (...args) => { activeTransactions++; try { return await targetClient.$transaction(...args) } finally { activeTransactions-- } }
  const value = targetClient[key]
  return typeof value === 'function' ? value.bind(targetClient) : value
} })
const transport = { async sendPasswordResetCode(_settings, message) {
  assert.equal(activeTransactions, 0, 'Provider delivery must not hold a database transaction or settings lock')
  deliveries.push({ ...message })
  if (deliveryGate) await deliveryGate.promise
  if (deliveryFailure) throw new Error('private provider failure must not escape')
} }

function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports
  const compiled = { exports: {} }
  cache.set(relative, compiled)
  vm.runInNewContext(transformSync(readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
    module: compiled, Buffer, Date, Error, URL, URLSearchParams, Request, Response, Headers, Uint8Array, console, process: { env },
    require(name) {
      if (name === 'next/server') return { NextResponse: Response, after: callback => afterQueue.push(callback) }
      if (name === '@/lib/prisma' || name === './prisma') return { prisma: client }
      if (name === '@/lib/auth') return { auth: async () => session }
      if (name === './registration-delivery' || name === '@/lib/registration-delivery') return transport
      if (name === './password-reset-settings' && relative === 'src/lib/password-reset.ts') {
        const actual = load('src/lib/password-reset-settings.ts')
        return { ...actual, async lockPasswordResetSettings(tx) { enteringCoreLock?.resolve(); return actual.lockPasswordResetSettings(tx) } }
      }
      if (name.startsWith('@/lib/')) return load('src/lib/' + name.slice(6) + '.ts')
      if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
      if (name.startsWith('node:') || name === 'bcryptjs' || name === 'ipaddr.js') return require(name)
      throw new Error('Unexpected dependency: ' + name)
    },
  }, { filename: relative })
  return compiled.exports
}

const codeRoute = load('src/app/api/auth/password-reset/code/route.ts')
const resetRoute = load('src/app/api/auth/password-reset/route.ts')
const settingsRoute = load('src/app/api/admin/password-reset-settings/route.ts')
const resetSettings = load('src/lib/password-reset-settings.ts')
const request = (route, body, headers = {}) => route.POST(new Request('http://localhost:3000/api/auth/password-reset', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }))
async function send(destination = 'buyer@recovery-test.invalid', channel = 'email', headers) {
  const response = await request(codeRoute, { channel, destination }, headers)
  return { status: response.status, headers: response.headers, data: await response.json() }
}
async function finish(id, code, password = newPassword, headers) {
  const response = await request(resetRoute, { challengeId: id, code, newPassword: password, confirmPassword: password }, headers)
  return { status: response.status, headers: response.headers, data: await response.json() }
}
async function flushAfter() { while (afterQueue.length) await afterQueue.shift()() }
async function issue(destination, channel) {
  const result = await send(destination, channel)
  assert.equal(result.status, 200)
  await flushAfter()
  return { ...result.data, code: deliveries.at(-1)?.code }
}
const user = () => db.user.findUniqueOrThrow({ where: { id: 'reset-buyer' } })
const challenge = id => db.passwordResetChallenge.findUniqueOrThrow({ where: { id } })
const rateKey = (...parts) => createHmac('sha256', secret).update(JSON.stringify(['password-reset:v1', ...parts])).digest('hex')
async function resetFixtures(policy = {}) {
  assert.equal(afterQueue.length, 0, 'A fixture must never discard an outstanding delivery')
  deliveries.length = 0; deliveryGate = null; deliveryFailure = false; enteringCoreLock = null
  await db.passwordResetChallenge.deleteMany()
  await db.passwordResetRateLimit.deleteMany()
  await db.passwordResetSettings.update({ where: { id: 1 }, data: { ...basePolicy, ...policy } })
  await db.registrationSettings.update({ where: { id: 1 }, data: { version: 0, emailEnabled: false, smsEnabled: false, emailSender: 'auth', smsProvider: 'kavenegar', smsTemplate: 'fixture_recovery' } })
  await db.user.update({ where: { id: 'reset-buyer' }, data: { email: 'buyer@recovery-test.invalid', loginPhone: '09123456789', phone: '09123456789', phoneVerifiedAt: new Date(), isActive: true, authVersion: 0, password: oldHash } })
}

async function setup() {
  checkScope()
  await source.$executeRawUnsafe('CREATE SCHEMA ' + scope)
  created = true
  for (const table of tables) await source.$executeRawUnsafe('CREATE TABLE ' + scope + '.' + identifier(table) + ' (LIKE "public".' + identifier(table) + ' INCLUDING ALL)')
  const labels = await source.$queryRaw`SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'Role' ORDER BY e.enumsortorder`
  assert.ok(labels.length)
  await source.$executeRawUnsafe('CREATE TYPE ' + scope + '."Role" AS ENUM (' + labels.map(row => "'" + row.label.replace(/'/g, "''") + "'").join(',') + ')')
  await source.$executeRawUnsafe('ALTER TABLE ' + scope + '."User" ALTER COLUMN "role" DROP DEFAULT')
  await source.$executeRawUnsafe('ALTER TABLE ' + scope + '."User" ALTER COLUMN "role" TYPE ' + scope + '."Role" USING "role"::text::' + scope + '."Role"')
  await source.$executeRawUnsafe('ALTER TABLE ' + scope + '."User" ALTER COLUMN "role" SET DEFAULT \'USER\'::' + scope + '."Role"')
  assert.deepEqual(await db.$queryRaw`SELECT current_schema() AS name`, [{ name: schema }])
  oldHash = await bcrypt.hash(oldPassword, 4)
  await db.passwordResetSettings.create({ data: { id: 1, ...basePolicy } })
  await db.registrationSettings.create({ data: { id: 1, emailEnabled: false, smsEnabled: false, smsTemplate: 'fixture_recovery' } })
  await db.user.createMany({ data: [
    { id: 'reset-buyer', name: 'خریدار آزمایشی', email: 'buyer@recovery-test.invalid', password: oldHash, loginPhone: '09123456789', phone: '09123456789', phoneVerifiedAt: new Date() },
    { id: 'reset-blocked', name: 'حساب مسدود آزمایشی', email: 'blocked@recovery-test.invalid', password: oldHash, isActive: false },
    { id: 'reset-contact-only', name: 'تلفن تماس آزمایشی', email: 'contact@recovery-test.invalid', password: oldHash, phone: '09121111111' },
    { id: 'reset-unverified', name: 'تلفن تأییدنشدهٔ آزمایشی', email: 'unverified@recovery-test.invalid', password: oldHash, phone: '09122222222', phoneVerifiedAt: null },
  ] })
  await assert.rejects(db.user.update({ where: { id: 'reset-unverified' }, data: { loginPhone: '09122222222' } }), /User_verified_login_phone_check/)
}

async function main() {
  try {
    await setup()
    const sent = await send()
    assert.equal(sent.status, 200)
    assert.equal(afterQueue.length, 1)
    assert.equal(deliveries.length, 0)
    assert.equal((await challenge(sent.data.challengeId)).deliveredAt, null)
    deliveryGate = deferred()
    const delivery = afterQueue.shift()()
    while (!deliveries.length) await new Promise(setImmediate)
    const code = deliveries[0].code
    assert.equal((await finish(sent.data.challengeId, code)).status, 400, 'A guessed correct code cannot reset before provider acceptance')
    deliveryGate.resolve(); await delivery
    assert.ok((await challenge(sent.data.challengeId)).deliveredAt)
    const concurrent = await Promise.all([finish(sent.data.challengeId, code), finish(sent.data.challengeId, code)])
    assert.deepEqual(concurrent.map(row => row.status).sort(), [200, 400])
    assert.equal((await user()).authVersion, 1)
    assert.equal(await bcrypt.compare(newPassword, (await user()).password), true)
    assert.equal(await bcrypt.compare(oldPassword, (await user()).password), false)
    assert.ok((await challenge(sent.data.challengeId)).consumedAt)
    assert.equal((await finish(sent.data.challengeId, code, 'Another-fixture-password')).status, 400)
    console.log('PASS request returns before deferred delivery; provider acceptance is required and two concurrent correct resets produce one password/authVersion update and one-time consumption')

    await resetFixtures({ smsEnabled: true })
    const unknown = await send('missing@recovery-test.invalid')
    const blocked = await send('blocked@recovery-test.invalid')
    const contact = await send('09121111111', 'sms')
    const unverified = await send('09122222222', 'sms')
    for (const result of [unknown, blocked, contact, unverified]) {
      assert.equal(result.status, 200)
      assert.deepEqual(Object.keys(result.data).sort(), Object.keys(sent.data).sort())
      assert.equal(result.data.message, sent.data.message)
      assert.equal((await challenge(result.data.challengeId)).userId, null)
      assert.equal(result.headers.get('Cache-Control'), 'private, no-store')
    }
    await flushAfter()
    assert.equal(deliveries.length, 0)
    assert.equal((await user()).authVersion, 0)
    console.log('PASS missing, inactive, contact-only and unverified-mobile accounts get the same generic response with no delivery or user change')

    await resetFixtures()
    const failed = await send()
    deliveryFailure = true; await flushAfter()
    assert.equal(failed.status, 200)
    assert.ok((await challenge(failed.data.challengeId)).consumedAt)
    assert.equal((await finish(failed.data.challengeId, deliveries[0].code)).status, 400)
    assert.equal((await user()).password, oldHash)
    console.log('PASS provider failures remain private, invalidate their own challenge, and cannot change a password')

    await resetFixtures({ maxAttempts: 3 })
    const limited = await issue()
    const wrong = limited.code === '999999' ? '888888' : '999999'
    const wrongResults = await Promise.all(Array.from({ length: 5 }, () => finish(limited.challengeId, wrong)))
    assert.ok(wrongResults.every(result => result.status === 400))
    assert.equal((await challenge(limited.challengeId)).attempts, 3)
    assert.equal((await finish(limited.challengeId, limited.code)).status, 400)
    const verifyQuota = await db.passwordResetRateLimit.findUniqueOrThrow({ where: { key: rateKey('verify-destination', 'email', 'buyer@recovery-test.invalid') } })
    assert.equal(verifyQuota.count, 6, 'Failed attempts and exhausted-code requests retain their destination quota increments')
    assert.equal((await user()).authVersion, 0)
    console.log('PASS concurrent wrong attempts persist and clamp at the configured limit; destination verification quotas do not roll back on rejected codes')

    await resetFixtures()
    const old = await issue()
    await db.passwordResetChallenge.update({ where: { id: old.challengeId }, data: { resendAt: new Date(Date.now() - 1000) } })
    const fresh = await issue()
    assert.notEqual(fresh.challengeId, old.challengeId)
    assert.equal((await finish(old.challengeId, old.code)).status, 400)
    assert.equal((await finish(fresh.challengeId, fresh.code)).status, 200)
    console.log('PASS resending replaces the challenge identity; the previous identifier/code cannot reset the account')

    for (const [description, change] of [
      ['administrator password reset', () => db.user.update({ where: { id: 'reset-buyer' }, data: { authVersion: { increment: 1 }, password: '$disabled$fixture' } })],
      ['identity change', () => db.user.update({ where: { id: 'reset-buyer' }, data: { email: 'changed@recovery-test.invalid' } })],
      ['account blocking', () => db.user.update({ where: { id: 'reset-buyer' }, data: { isActive: false } })],
      ['configuration disable/re-enable', async () => { await db.passwordResetSettings.update({ where: { id: 1 }, data: { enabled: false, version: { increment: 1 } } }); await db.passwordResetSettings.update({ where: { id: 1 }, data: { enabled: true, version: { increment: 1 } } }) }],
      ['delivery configuration revision', () => db.registrationSettings.update({ where: { id: 1 }, data: { version: { increment: 1 } } })],
    ]) {
      await resetFixtures()
      const pending = await issue()
      await change()
      const before = await user()
      assert.equal((await finish(pending.challengeId, pending.code)).status, 400, description)
      const after = await user()
      assert.equal(after.password, before.password, description)
      assert.equal(after.authVersion, before.authVersion, description)
    }
    console.log('PASS support resets, identity changes, account blocking, recovery toggles and provider revisions invalidate earlier challenges without overwriting current credentials')

    await resetFixtures({ smsEnabled: true })
    const email = await issue()
    const mobile = await issue('+989123456789', 'sms')
    const channels = await Promise.all([finish(email.challengeId, email.code), finish(mobile.challengeId, mobile.code, 'Mobile-fixture-password')])
    assert.deepEqual(channels.map(row => row.status).sort(), [200, 400])
    assert.equal((await user()).authVersion, 1)
    assert.equal(await db.passwordResetChallenge.count({ where: { userId: 'reset-buyer', consumedAt: null } }), 0)
    console.log('PASS verified login-phone recovery works independently from registration, while concurrent email and SMS challenges still permit only one account reset')

    await resetFixtures({ ipHourlyLimit: 1 })
    assert.equal((await send('one@recovery-test.invalid')).status, 200); await flushAfter()
    assert.equal((await send('two@recovery-test.invalid', 'email', { 'x-forwarded-for': '203.0.113.1', 'x-vercel-forwarded-for': '203.0.113.2' })).status, 429)
    assert.equal((await db.passwordResetRateLimit.findUniqueOrThrow({ where: { key: rateKey('send-network', 'unattributed') } })).count, 2)
    await resetFixtures()
    assert.equal((await send('quota@recovery-test.invalid')).status, 200); await flushAfter()
    assert.equal((await send('quota@recovery-test.invalid')).status, 429)
    assert.equal((await db.passwordResetRateLimit.findUniqueOrThrow({ where: { key: rateKey('send-destination', 'email', 'quota@recovery-test.invalid') } })).count, 2)
    await db.passwordResetRateLimit.update({ where: { key: rateKey('send-global') }, data: { count: 300 } })
    assert.equal((await send('global@recovery-test.invalid')).status, 429)
    assert.equal((await db.passwordResetRateLimit.findUniqueOrThrow({ where: { key: rateKey('send-global') } })).count, 301)
    console.log('PASS network/destination/global send quotas persist; untrusted forwarding headers cannot bypass the shared network bucket')

    await resetFixtures()
    const rollback = await issue()
    await db.$executeRawUnsafe('CREATE FUNCTION ' + scope + '.reject_password_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."password" IS DISTINCT FROM OLD."password" THEN RAISE EXCEPTION \'forced fixture rejection\'; END IF; RETURN NEW; END $$')
    await db.$executeRawUnsafe('CREATE TRIGGER fixture_reject_password BEFORE UPDATE ON ' + scope + '."User" FOR EACH ROW EXECUTE FUNCTION ' + scope + '.reject_password_write()')
    assert.equal((await finish(rollback.challengeId, rollback.code)).status, 500)
    assert.equal((await challenge(rollback.challengeId)).consumedAt, null)
    assert.equal((await user()).password, oldHash)
    assert.equal((await user()).authVersion, 0)
    await db.$executeRawUnsafe('DROP TRIGGER fixture_reject_password ON ' + scope + '."User"')
    assert.equal((await finish(rollback.challengeId, rollback.code)).status, 200)
    console.log('PASS a database failure rolls back both challenge consumption and credential changes, allowing the same valid operation to succeed after recovery')

    await resetFixtures()
    const disabled = await issue()
    const lockHeld = deferred(), releaseLock = deferred()
    const disabling = db.$transaction(async tx => {
      await resetSettings.lockPasswordResetSettings(tx)
      lockHeld.resolve()
      await releaseLock.promise
      await tx.passwordResetSettings.update({ where: { id: 1 }, data: { enabled: false, version: { increment: 1 } } })
    }, { maxWait: 5000, timeout: 10000 })
    await lockHeld.promise
    enteringCoreLock = deferred()
    const racingReset = finish(disabled.challengeId, disabled.code)
    await enteringCoreLock.promise
    releaseLock.resolve(); await disabling
    assert.notEqual((await racingReset).status, 200)
    assert.equal((await user()).authVersion, 0)
    assert.equal((await user()).password, oldHash)
    const settingsResponse = await settingsRoute.GET()
    assert.equal((await settingsResponse.json()).settings.enabled, false)
    session = null
    assert.equal((await settingsRoute.GET()).status, 401)
    assert.equal((await request(codeRoute, { channel: 'email', destination: 'buyer@recovery-test.invalid' }, { Origin: 'https://foreign.example' })).status, 403)
    console.log('PASS a concurrent administrative disable is serialized before reset completion; the old code cannot change credentials and foreign-origin/admin access remain guarded')
  } finally {
    deliveryGate?.resolve()
    await Promise.allSettled(afterQueue.splice(0).map(callback => callback()))
    await db.$disconnect()
    if (created) {
      checkScope()
      await source.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
      const remaining = await source.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`
      assert.deepEqual(remaining, [])
      console.log('PASS exact isolated recovery schema removed; public users, credentials and sequences were untouched')
    }
    await source.$disconnect()
  }
}

main().catch(error => { console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/\S+/gi, '[database URL]')); process.exitCode = 1 })
