const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path'), vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

function load(file, dependencies = {}) {
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
    { module: compiled, URL, Buffer, Request, Response, Headers, Date, process, require(name) { return Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) } })
  return compiled.exports
}

const input = load('src/lib/api-input.ts', { 'next/server': { NextResponse: Response } })
const origin = load('src/lib/request-origin.ts')
const defaults = { version: 0, maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ipMaxAttempts: 30 }

function harness({ initial } = {}) {
  let row = initial ? structuredClone(initial) : null
  let session = { user: { id: 'admin', role: 'ADMIN' } }
  let reads = 0, mutations = 0, failRead = false, queue = Promise.resolve()
  const project = (value, select) => !value ? null : select ? Object.fromEntries(Object.keys(select).map(key => [key, value[key]])) : { ...value }
  const delegate = (get, set) => ({
    async findUnique({ select } = {}) { reads++; if (failRead) throw new Error('private backend failure including credentials'); return project(get(), select) },
    async createMany() { mutations++; if (!get()) { set({ id: 1, ...defaults }); return { count: 1 } } return { count: 0 } },
    async updateMany({ where, data }) {
      mutations++
      if (!get() || get().version !== where.version) return { count: 0 }
      set({ ...get(), ...data, version: where.version + data.version.increment })
      return { count: 1 }
    },
  })
  const prisma = {
    loginSecuritySettings: delegate(() => row, value => { row = value }),
    $transaction(callback) {
      const execution = queue.then(async () => {
        let draft = structuredClone(row)
        const tx = { loginSecuritySettings: delegate(() => draft, value => { draft = value }), async $queryRaw() { return [{ locked: 1 }] } }
        const value = await callback(tx)
        row = draft
        return value
      })
      queue = execution.catch(() => undefined)
      return execution
    },
  }
  const settings = load('src/lib/login-security-settings.ts', { './api-input': input, './prisma': { prisma } })
  const route = load('src/app/api/admin/login-security-settings/route.ts', {
    'next/server': { NextResponse: Response }, '@/lib/api-input': input, '@/lib/auth': { auth: async () => session },
    '@/lib/request-origin': origin, '@/lib/login-security-settings': settings,
  })
  return { ...settings, ...route, get row() { return row }, get reads() { return reads }, get mutations() { return mutations }, actor(value) { session = value }, fail() { failRead = true } }
}

const patch = (body, headers = {}) => new Request('https://store.example/api/admin/login-security-settings', { method: 'PATCH', headers: { Origin: 'https://store.example', 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const json = value => JSON.parse(JSON.stringify(value))

test('Login protection defaults to five failures within fifteen minutes and a fifteen minute lock', async () => {
  const app = harness()
  assert.deepEqual(json(await app.readLoginSecuritySettings()), defaults)
  assert.equal(app.mutations, 0)
})

test('Only administrators can read or update policy; foreign-origin writes never read settings', async () => {
  const app = harness()
  for (const [actor, status] of [[null, 401], [{ user: { role: 'ADMIN' } }, 401], [{ user: { id: 'customer', role: 'USER' } }, 403]]) {
    app.actor(actor)
    for (const result of [await app.GET(), await app.PATCH(patch(defaults))]) {
      assert.equal(result.status, status)
      assert.equal(result.headers.get('Cache-Control'), 'private, no-store')
    }
  }
  app.actor({ user: { id: 'admin', role: 'ADMIN' } })
  for (const headers of [{ Origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { host: 'bad/host' }]) {
    assert.equal((await app.PATCH(patch(defaults, headers))).status, 403)
  }
  assert.equal(app.reads, 0)
  assert.equal(app.mutations, 0)
})

test('Private snapshots contain only numeric policy settings, never customer identifiers or credentials', async () => {
  const app = harness({ initial: { id: 1, ...defaults, internalKey: 'private-key', customerEmail: 'private@example.test' } })
  const result = await app.GET()
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(result.headers.get('Vary'), 'Cookie')
  const data = await result.json()
  assert.deepEqual(Object.keys(data), ['settings'])
  assert.deepEqual(data.settings, defaults)
})

test('Numeric policy limits, shared-network floor and unknown disable controls are enforced', async () => {
  const app = harness()
  for (const [key, value] of [
    ['maxAttempts', 0], ['maxAttempts', -1], ['maxAttempts', 2], ['maxAttempts', 21], ['maxAttempts', null],
    ['windowMinutes', 0], ['windowMinutes', 61], ['lockMinutes', -1], ['lockMinutes', 61],
    ['ipMaxAttempts', 9], ['ipMaxAttempts', 201], ['ipMaxAttempts', 1.5], ['ipMaxAttempts', true],
    ['enabled', false], ['disableProtection', true], ['customerEmail', 'person@example.test'],
    ['version', undefined], ['version', -1], ['version', 2_147_483_648],
  ]) {
    const result = await app.PATCH(patch({ ...defaults, [key]: value }))
    assert.equal(result.status, 400, `${key}=${value}`)
  }
  assert.equal((await app.PATCH(patch({ ...defaults, maxAttempts: 20, ipMaxAttempts: 10 }))).status, 400)
  assert.equal(app.mutations, 0)
  assert.equal((await app.PATCH(patch({ ...defaults, maxAttempts: 3, windowMinutes: 1, lockMinutes: 1, ipMaxAttempts: 10 }))).status, 200)
  const maximum = await app.PATCH(patch({ version: 1, maxAttempts: 20, windowMinutes: 60, lockMinutes: 60, ipMaxAttempts: 200 }))
  assert.equal(maximum.status, 200)
  assert.equal((await maximum.json()).settings.ipMaxAttempts, 200)
})

test('Concurrent changes compare stored versions atomically and preserve unspecified policy values', async () => {
  const app = harness()
  const results = await Promise.all([app.PATCH(patch({ version: 0, maxAttempts: 3 })), app.PATCH(patch({ version: 0, lockMinutes: 20 }))])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  assert.equal(app.row.version, 1)
  assert.equal(app.row.maxAttempts, 3)
  assert.equal(app.row.lockMinutes, 15)
  const result = await app.PATCH(patch({ version: 1, windowMinutes: 20 }))
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).settings, { ...defaults, version: 2, maxAttempts: 3, windowMinutes: 20 })
  const previousMutations = app.mutations
  assert.equal((await app.PATCH(patch({ version: 1, lockMinutes: 20 }))).status, 409)
  assert.equal(app.mutations, previousMutations)
})

test('Malformed and oversized JSON bodies are rejected before settings storage is accessed', async () => {
  const app = harness()
  for (const [body, headers, status] of [
    ['{', {}, 400], ['[]', {}, 400], ['null', {}, 400], ['false', {}, 400],
    ['x'.repeat(8193), {}, 413], ['{}', { 'content-length': '8193' }, 413],
    [JSON.stringify({ extra: 'ا'.repeat(4100) }), {}, 413],
  ]) {
    assert.equal((await app.PATCH(patch(body, headers))).status, status)
    assert.equal(app.reads, 0)
    assert.equal(app.mutations, 0)
  }
})

test('Storage failures are private and exhausted versions cannot wrap around', async () => {
  const app = harness()
  app.fail()
  for (const result of [await app.GET(), await app.PATCH(patch(defaults))]) {
    assert.equal(result.status, 500)
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store')
    assert.doesNotMatch(await result.text(), /private|credentials|backend/)
  }
  const exhausted = harness({ initial: { ...defaults, version: 2_147_483_647 } })
  assert.equal((await exhausted.PATCH(patch({ version: 2_147_483_647, maxAttempts: 3 }))).status, 409)
  assert.equal(exhausted.mutations, 0)
})
