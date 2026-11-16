// Real PostgreSQL locking and persistence checks in a disposable schema only.
// No real account, password, email/SMS transport or public sequence is changed.
const assert = require('node:assert/strict')
const { createHmac, randomBytes } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (target.protocol !== 'postgresql:' || target.hostname !== '192.168.1.105' || target.pathname !== '/shoes_shop'
  || (target.searchParams.get('schema') || 'public') !== 'public') throw new Error('Login security integration requires the designated local development database')
const schema = 'test_login_security_' + randomBytes(8).toString('hex')
const checkScope = () => assert.match(schema, /^test_login_security_[a-f0-9]{16}$/)
const identifier = value => { assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/); return '"' + value + '"' }
checkScope()
const scope = identifier(schema)
const testUrl = new URL(target), sourceUrl = new URL(target)
testUrl.searchParams.set('schema', schema); testUrl.searchParams.set('connection_limit', '12'); testUrl.searchParams.set('connect_timeout', '10')
sourceUrl.searchParams.set('connection_limit', '1'); sourceUrl.searchParams.set('connect_timeout', '10')
const source = new PrismaClient({ datasourceUrl: sourceUrl.toString() })
const db = new PrismaClient({ datasourceUrl: testUrl.toString() })
const secret = 'isolated-login-security-test-secret-at-least-32'
const env = { NODE_ENV: 'test', AUTH_SECRET: secret, VERCEL: '1' }
const password = 'Fixture-only-valid-password'
const basePolicy = { version: 0, maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ipMaxAttempts: 30 }
let created = false, comparisons = 0

function makeLoader() {
  const cache = new Map()
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports
    const compiled = { exports: {} }
    cache.set(relative, compiled)
    vm.runInNewContext(transformSync(readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), {
      loader: 'ts', format: 'cjs', target: 'es2022',
    }).code, {
      module: compiled, Buffer, Date, Error, URL, Request, Response, Headers, process: { env },
      require(name) {
        if (name === 'next/server') return { NextResponse: Response }
        if (name === './prisma') return { prisma: db }
        if (name === 'bcryptjs') return { ...bcrypt, compare: async (...args) => { comparisons++; return bcrypt.compare(...args) } }
        if (name.startsWith('./')) return load(path.posix.join(path.posix.dirname(relative), name + '.ts'))
        if (name.startsWith('node:') || name === 'ipaddr.js') return require(name)
        throw new Error('Unexpected dependency: ' + name)
      },
    }, { filename: relative })
    return compiled.exports
  }
  return load
}
const load = makeLoader()
const core = load('src/lib/login-security.ts')
const settings = load('src/lib/login-security-settings.ts')
const key = (kind, value) => createHmac('sha256', secret).update(JSON.stringify(['login-security:v1', kind, value])).digest('hex')
const accountKey = key('account', 'login-buyer')
const account = () => db.loginAttemptWindow.findUnique({ where: { key: accountKey } })
const network = ip => db.loginAttemptWindow.findUnique({ where: { key: key('network', ip) } })
const request = ip => new Request('https://login-test.invalid/api/auth/callback/credentials', { method: 'POST', headers: { 'x-vercel-forwarded-for': ip } })
const emailCredentials = (value = password) => ({ email: 'buyer@login-test.invalid', password: value })
async function attempt(credentials, ip = '203.0.113.1', instance = core) {
  try { return { user: await instance.authorizePasswordLogin(credentials, request(ip)), retry: null } }
  catch (error) {
    if (!(error instanceof instance.LoginRateLimitError)) throw error
    assert.ok(error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 3600)
    return { user: null, retry: error.retryAfterSeconds }
  }
}
async function reset(policy = {}) {
  await db.loginAttemptWindow.deleteMany()
  await db.loginSecuritySettings.update({ where: { id: 1 }, data: { ...basePolicy, ...policy } })
  comparisons = 0
}
async function setup() {
  checkScope()
  await source.$executeRawUnsafe('CREATE SCHEMA ' + scope)
  created = true
  for (const table of ['User', 'LoginSecuritySettings', 'LoginAttemptWindow']) {
    await source.$executeRawUnsafe('CREATE TABLE ' + scope + '.' + identifier(table) + ' (LIKE "public".' + identifier(table) + ' INCLUDING ALL)')
  }
  const labels = await source.$queryRaw`SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'Role' ORDER BY e.enumsortorder`
  assert.ok(labels.length)
  await source.$executeRawUnsafe('CREATE TYPE ' + scope + '."Role" AS ENUM (' + labels.map(row => "'" + row.label.replace(/'/g, "''") + "'").join(',') + ')')
  await source.$executeRawUnsafe('ALTER TABLE ' + scope + '."User" ALTER COLUMN "role" DROP DEFAULT')
  await source.$executeRawUnsafe('ALTER TABLE ' + scope + '."User" ALTER COLUMN "role" TYPE ' + scope + '."Role" USING "role"::text::' + scope + '."Role"')
  await source.$executeRawUnsafe('ALTER TABLE ' + scope + '."User" ALTER COLUMN "role" SET DEFAULT \'USER\'::' + scope + '."Role"')
  assert.deepEqual(await db.$queryRaw`SELECT current_schema() AS name`, [{ name: schema }])
  await db.loginSecuritySettings.create({ data: { id: 1, ...basePolicy } })
  const hash = await bcrypt.hash(password, 4)
  await db.user.createMany({ data: [
    { id: 'login-buyer', name: 'خریدار آزمایشی', email: 'buyer@login-test.invalid', password: hash, loginPhone: '09123456789', phoneVerifiedAt: new Date(), authVersion: 7 },
    { id: 'login-disabled', name: 'حساب غیرفعال آزمایشی', email: 'disabled@login-test.invalid', password: hash, isActive: false },
  ] })
}

async function main() {
  try {
    await setup()
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => attempt(index % 2
      ? { loginPhone: '+۹۸ ۹۱۲-۳۴۵-۶۷۸۹', password: 'wrong-password' }
      : { email: '  BUYER@LOGIN-TEST.INVALID  ', password: 'wrong-password' }, `203.0.113.${index + 1}`)))
    assert.equal(results.filter(result => !result.retry && result.user === null).length, 4)
    assert.equal(results.filter(result => result.retry).length, 8)
    assert.equal(comparisons, 5, 'Cross-network and cross-alias concurrency must allow at most five password comparisons')
    const locked = await account()
    assert.equal(locked.failures, 5)
    assert.ok(locked.blockedUntil > new Date())
    assert.equal(await db.loginAttemptWindow.count(), 6, 'Only the five admitted networks and one account should have counters')
    console.log('PASS twelve concurrent attempts across independent networks and email/mobile aliases commit exactly five failures and one fixed account lock')

    const beforeComparisons = comparisons
    for (const value of [password, 'wrong-again', password]) assert.ok((await attempt(emailCredentials(value), '203.0.113.40')).retry)
    const freshCore = makeLoader()('src/lib/login-security.ts')
    assert.ok((await attempt(emailCredentials(), '203.0.113.41', freshCore)).retry, 'A new process/module must not reset persistent counters')
    const stillLocked = await account()
    assert.equal(stillLocked.blockedUntil.getTime(), locked.blockedUntil.getTime())
    assert.equal(stillLocked.updatedAt.getTime(), locked.updatedAt.getTime())
    assert.equal(stillLocked.failures, 5)
    assert.equal(comparisons, beforeComparisons, 'Blocked attempts must not run bcrypt')
    await db.loginSecuritySettings.update({ where: { id: 1 }, data: { lockMinutes: 1 } })
    assert.ok((await attempt(emailCredentials(), '203.0.113.42')).retry > 60, 'Changing policy cannot shorten an existing lock')
    assert.equal((await account()).blockedUntil.getTime(), locked.blockedUntil.getTime())
    console.log('PASS blocked retries, a new server instance and policy edits do not extend or erase an existing lock')

    await db.loginAttemptWindow.update({ where: { key: accountKey }, data: { blockedUntil: new Date(Date.now() - 1000) } })
    const signedIn = await attempt(emailCredentials(), '203.0.113.43')
    assert.equal(signedIn.user.id, 'login-buyer')
    assert.equal(signedIn.user.authVersion, 7)
    assert.equal(signedIn.retry, null)
    assert.equal(await account(), null)
    console.log('PASS an expired lock permits a valid password, preserves authVersion, and clears only the account counter')

    await reset()
    await attempt(emailCredentials('wrong'))
    await db.loginAttemptWindow.update({ where: { key: accountKey }, data: { failures: 4, windowStartedAt: new Date(Date.now() - 16 * 60_000) } })
    assert.equal((await attempt(emailCredentials('wrong'))).retry, null)
    assert.equal((await account()).failures, 1)
    await db.loginAttemptWindow.update({ where: { key: accountKey }, data: { failures: 5, blockedUntil: new Date(Date.now() - 1000) } })
    assert.equal((await attempt(emailCredentials('wrong'))).retry, null)
    assert.equal((await account()).failures, 1, 'Expired lock resets allowance even while its counting window is recent')
    console.log('PASS counting-window expiry and lock expiry both restore a fresh allowance')

    await reset({ ipMaxAttempts: 10 })
    const sharedIp = '198.51.100.10'
    for (let index = 0; index < 9; index++) {
      const result = await attempt({ email: `missing-${index}@login-test.invalid`, password: 'wrong-password' }, sharedIp)
      assert.equal(result.retry, null); assert.equal(result.user, null)
    }
    assert.equal((await network(sharedIp)).failures, 9)
    assert.equal((await attempt(emailCredentials(), sharedIp)).user.id, 'login-buyer')
    assert.equal((await network(sharedIp)).failures, 9, 'Successful credentials must not launder the network failure count')
    assert.ok((await attempt({ email: 'missing-final@login-test.invalid', password: 'wrong-password' }, sharedIp)).retry)
    const networkLock = await network(sharedIp)
    assert.equal(networkLock.failures, 10)
    assert.ok((await attempt(emailCredentials(), sharedIp)).retry)
    assert.equal((await network(sharedIp)).blockedUntil.getTime(), networkLock.blockedUntil.getTime())
    assert.equal((await attempt(emailCredentials(), '198.51.100.11')).user.id, 'login-buyer', 'Network lock must not lock every customer globally on trusted-IP hosting')
    for (const row of await db.loginAttemptWindow.findMany()) {
      assert.match(row.key, /^[a-f0-9]{64}$/)
      assert.deepEqual(Object.keys(row).sort(), ['blockedUntil', 'failures', 'key', 'updatedAt', 'windowStartedAt'])
    }
    console.log('PASS unknown-account network quota survives successful login, blocks all guesses from that network, and persists only opaque keys')

    await reset()
    const disabled = await attempt({ email: 'disabled@login-test.invalid', password }, '198.51.100.30')
    assert.equal(disabled.user, null); assert.equal(disabled.retry, null)
    assert.equal((await db.loginAttemptWindow.findUniqueOrThrow({ where: { key: key('account', 'login-disabled') } })).failures, 1)
    assert.equal(comparisons, 1)
    const first = await settings.readLoginSecuritySettings()
    const saves = await Promise.allSettled([
      settings.saveLoginSecuritySettings({ ...first, maxAttempts: 6 }),
      settings.saveLoginSecuritySettings({ ...first, maxAttempts: 7 }),
    ])
    assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1)
    const stale = saves.find(result => result.status === 'rejected')
    assert.equal(stale.reason.status, 409)
    assert.equal((await settings.readLoginSecuritySettings()).version, 1)
    await assert.rejects(db.loginSecuritySettings.update({ where: { id: 1 }, data: { maxAttempts: 0 } }), /LoginSecuritySettings_bounds/)
    await assert.rejects(db.loginSecuritySettings.update({ where: { id: 1 }, data: { maxAttempts: 20, ipMaxAttempts: 10 } }), /LoginSecuritySettings_bounds/)
    console.log('PASS inactive accounts stay generic, concurrent settings edits reject a stale version, and database policy bounds hold')

    await reset()
    await db.$executeRawUnsafe('CREATE FUNCTION ' + scope + '.reject_account_counter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."key" = \'' + accountKey + '\' THEN RAISE EXCEPTION \'forced isolated counter rejection\'; END IF; RETURN NEW; END $$')
    await db.$executeRawUnsafe('CREATE TRIGGER fixture_counter_failure BEFORE INSERT OR UPDATE ON ' + scope + '."LoginAttemptWindow" FOR EACH ROW EXECUTE FUNCTION ' + scope + '.reject_account_counter()')
    await assert.rejects(attempt(emailCredentials('wrong-password')), /forced isolated counter rejection/)
    assert.equal(await db.loginAttemptWindow.count(), 0, 'A database error must not partially commit or authorize the request')
    await db.$executeRawUnsafe('DROP TRIGGER fixture_counter_failure ON ' + scope + '."LoginAttemptWindow"')
    assert.equal((await attempt(emailCredentials('wrong-password'))).retry, null)
    assert.equal((await account()).failures, 1)
    console.log('PASS database failures fail closed and roll back both counters atomically')
  } finally {
    await db.$disconnect()
    if (created) {
      checkScope()
      await source.$executeRawUnsafe('DROP SCHEMA ' + scope + ' CASCADE')
      const remaining = await source.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`
      assert.deepEqual(remaining, [])
      console.log('PASS exact isolated login-security schema removed; public users, passwords and sequences were untouched')
    }
    await source.$disconnect()
  }
}

main().catch(error => { console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/\S+/gi, '[database URL]')); process.exitCode = 1 })
