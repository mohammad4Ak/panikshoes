const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const admin = { user: { id: 'admin', role: 'ADMIN' } }
const customer = { user: { id: 'buyer', role: 'USER' } }
const context = id => ({ params: Promise.resolve({ id: id ?? 'buyer' }) })
const request = body => new Request('http://localhost/api', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const plain = value => JSON.parse(JSON.stringify(value))

function load(file, { session = admin, prisma = {}, bcrypt = {} } = {}) {
  const cache = new Map()
  let authConfig
  const dependencies = {
    'next/server': { NextResponse: Response },
    '@/lib/prisma': { prisma }, './prisma': { prisma },
    '@/lib/auth': { auth: async () => session },
    'bcryptjs': { hash: async value => `hash:${value}`, compare: async () => true, ...bcrypt },
    'next-auth': config => { authConfig = config; return {} },
    'next-auth/providers/credentials': config => config,
  }
  function read(filename) {
    const absolute = path.resolve(root, filename)
    if (cache.has(absolute)) return cache.get(absolute)
    const testModule = { exports: {} }
    const source = transformSync(readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
    vm.runInNewContext(source, { module: testModule, Response, Buffer, Date, require: name => {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('@/lib/')) return read(`src/lib/${name.slice(6)}.ts`)
      if (name.startsWith('./')) return read(path.join(path.dirname(filename), `${name}.ts`))
      throw new Error(`Unexpected dependency ${name}`)
    } }, { filename: absolute })
    cache.set(absolute, testModule.exports)
    return testModule.exports
  }
  return { handlers: read(file), authConfig: () => authConfig }
}

function database() {
  const state = {
    users: [
      { id: 'admin', name: 'مدیر', email: 'admin@example.test', phone: null, postalCode: null, password: 'admin-hash', role: 'ADMIN', isActive: true, authVersion: 0 },
      { id: 'buyer', name: 'خریدار', email: 'buyer@example.test', phone: '09123456789', postalCode: '1234567890', password: 'old-hash', role: 'USER', isActive: true, authVersion: 0 },
    ],
    addresses: [{ id: 'home', userId: 'buyer', title: 'خانه', address: 'نشانی اصلی', phone: '09123456789', postalCode: '1234567890', isDefault: true }],
    orders: [{ id: 'historical-order', userId: 'buyer', verified: true, total: 500, phone: '09123456789', postalCode: '1234567890', address: 'نشانی اصلی', status: 'PROCESSING', receipts: [{ id: 'receipt', data: 'secret image', status: 'APPROVED' }], items: [] }],
  }
  const writes = []
  const queries = []
  const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object') {
      if ('not' in expected) return row[key] !== expected.not
      if ('notIn' in expected) return !expected.notIn.includes(row[key])
      if ('equals' in expected) return expected.mode === 'insensitive' ? row[key]?.toLowerCase() === expected.equals.toLowerCase() : row[key] === expected.equals
    }
    return row[key] === expected
  })
  function select(row, fields) {
    if (!row) return null
    if (!fields) return { ...row }
    return Object.fromEntries(Object.entries(fields).map(([key, selection]) => {
      if (key === '_count') return [key, { orders: state.orders.filter(order => order.userId === row.id).length, addresses: state.addresses.filter(address => address.userId === row.id).length }]
      if (key === 'addresses') return [key, state.addresses.filter(address => address.userId === row.id).map(address => select(address, selection.select))]
      const value = row[key]
      if (selection === true) return [key, value ?? null]
      if (Array.isArray(value)) return [key, value.map(item => select(item, selection.select))]
      return [key, select(value, selection.select)]
    }))
  }
  const db = {
    user: {
      findUnique: async query => { queries.push(['user.findUnique', plain(query)]); return select(state.users.find(row => matches(row, query.where)), query.select) },
      findFirst: async query => select(state.users.find(row => matches(row, query.where)), query.select),
      findMany: async query => state.users.filter(row => matches(row, query.where)).map(row => select(row, query.select)),
      count: async query => state.users.filter(row => matches(row, query.where)).length,
      update: async query => {
        const row = state.users.find(row => matches(row, query.where))
        assert.ok(row)
        writes.push(['user.update', plain(query)])
        for (const [key, value] of Object.entries(query.data)) row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value
        return select(row, query.select)
      },
      updateMany: async query => {
        const rows = state.users.filter(row => matches(row, query.where))
        for (const row of rows) await db.user.update({ ...query, where: { id: row.id } })
        return { count: rows.length }
      },
      create: async query => { const row = { id: `created-${state.users.length}`, authVersion: 0, ...query.data }; state.users.push(row); return select(row, query.select) },
    },
    address: {
      findMany: async query => state.addresses.filter(row => matches(row, query.where)).map(row => select(row, query.select)),
      deleteMany: async query => { state.addresses = state.addresses.filter(row => !matches(row, query.where)) },
      updateMany: async query => { for (const row of state.addresses) if (matches(row, query.where)) Object.assign(row, query.data) },
      update: async query => { const row = state.addresses.find(row => matches(row, query.where)); assert.ok(row); Object.assign(row, query.data); return row },
      create: async query => { const row = { id: `new-${state.addresses.length}`, ...query.data }; state.addresses.push(row); return row },
    },
    order: {
      findMany: async query => { queries.push(['order.findMany', plain(query)]); return state.orders.filter(row => matches(row, query.where)).slice(0, query.take).map(row => select(row, query.select)) },
      aggregate: async query => ({ _sum: { total: state.orders.filter(row => matches(row, query.where)).reduce((total, row) => total + row.total, 0) } }),
    },
    $transaction: async (operation, options) => {
      queries.push(['transaction', options])
      const initial = plain(state)
      try { return await operation(db) } catch (error) { Object.assign(state, initial); throw error }
    },
  }
  return { prisma: db, state, writes, queries, buyer: () => state.users.find(row => row.id === 'buyer') }
}

const contacts = load('src/lib/customer-contact.ts').handlers
for (const value of ['09123456789', '۰۹۱۲۳۴۵۶۷۸۹', '٠٩١٢٣٤٥٦٧٨٩', '+98 912-345-6789', '0098(912)3456789']) {
  test(`Iranian phone normalizes without losing its leading zero: ${value}`, () => {
    assert.equal(contacts.normalizePhone(value), '09123456789')
    assert.equal(contacts.isValidCustomerPhone(value), true)
  })
}
test('Landlines are supported and malformed or numeric identifiers never pass validation', () => {
  assert.equal(contacts.isValidCustomerPhone('۰۲۱۱۲۳۴۵۶۷۸'), true)
  for (const value of ['9123456789', '+98912345678', '00123456789', '0912345678x', 9123456789, {}, null]) assert.equal(contacts.isValidCustomerPhone(value), false)
  for (const value of ['۱۲۳۴۵-۶۷۸۹۰', '١٢٣٤٥٦٧٨٩٠', '1234567890']) assert.equal(contacts.normalizePostalCode(value), '1234567890')
  for (const value of ['0000000000', '1111111111', '123456789', '12345678900', 1234567890, {}, null]) assert.equal(contacts.isValidPostalCode(value), false)
  assert.equal(contacts.customerContactComplete('+989123456789', '۱۲۳۴۵۶۷۸۹۰'), true)
  assert.equal(contacts.customerContactComplete('09123456789', ''), false)
})

for (const session of [null, {}, { user: {} }, customer]) {
  test(`Customer support detail and writes reject unauthorized sessions: ${JSON.stringify(session)}`, async () => {
    const { handlers } = load('src/app/api/users/[id]/route.ts', { session })
    assert.equal((await handlers.GET(request({}), context())).status, 401)
    assert.equal((await handlers.PATCH(request({ name: 'هک' }), context())).status, 401)
  })
}

test('Profile stores canonical contact fields, allows intentional clearing, and ignores security fields', async () => {
  const db = database()
  const { handlers } = load('src/app/api/profile/route.ts', { session: customer, prisma: db.prisma })
  assert.equal((await handlers.PATCH(request({ phone: '+98 9123456789', postalCode: '۱۲۳۴۵۶۷۸۹۰', isActive: false, role: 'ADMIN' }))).status, 200)
  assert.equal(db.buyer().phone, '09123456789')
  assert.equal(db.buyer().postalCode, '1234567890')
  assert.equal(db.buyer().role, 'USER')
  assert.equal(db.buyer().isActive, true)
  const response = await handlers.GET()
  assert.match(response.headers.get('cache-control'), /no-store/)
  const profile = await response.json()
  assert.equal(profile.postalCode, '1234567890')
  assert.ok(!('password' in profile) && !('authVersion' in profile))
  assert.equal((await handlers.PATCH(request({ phone: '', postalCode: null }))).status, 200)
  assert.equal(db.buyer().phone, null)
  assert.equal(db.buyer().postalCode, null)
})

for (const body of [{ phone: '123' }, { phone: 9123456789 }, { postalCode: '1111111111' }, { postalCode: 1234567890 }]) {
  test(`Invalid account identifiers never write: ${JSON.stringify(body)}`, async () => {
    const db = database()
    const { handlers } = load('src/app/api/profile/route.ts', { session: customer, prisma: db.prisma })
    assert.equal((await handlers.PATCH(request(body))).status, 400)
    assert.equal(db.writes.length, 0)
  })
}

test('Support detail excludes passwords, session versions and receipt bytes while retaining bounded order/payment summaries', async () => {
  const db = database()
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  const response = await handlers.GET(request({}), context())
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const result = await response.json()
  assert.equal(result.user.addresses[0].postalCode, '1234567890')
  assert.equal(result.summary.orderCount, 1)
  assert.equal(result.summary.paidTotal, 500)
  assert.equal(result.isSelf, false)
  assert.equal(result.canManageRole, true)
  assert.ok(!('password' in result.user) && !('authVersion' in result.user))
  assert.ok(!('data' in result.orders[0].receipts[0]))
  assert.equal(db.queries.find(([name]) => name === 'order.findMany')[1].take, 100)
  assert.equal(db.queries.find(([name]) => name === 'order.findMany')[1].where.userId, 'buyer')
})

test('Administrator can repair account identity and contacts without rewriting historical shipping snapshots', async () => {
  const db = database()
  db.buyer().emailVerifiedAt = '2026-11-06T10:00:00Z'
  const historical = plain(db.state.orders)
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  const response = await handlers.PATCH(request({ name: ' نام تازه ', email: ' NEW@EXAMPLE.TEST ', phone: '+982112345678', postalCode: '۱۲۳۴۵۶۷۸۹۰' }), context())
  assert.equal(response.status, 200)
  assert.equal(db.buyer().name, 'نام تازه')
  assert.equal(db.buyer().email, 'new@example.test')
  assert.equal(db.buyer().emailVerifiedAt, null)
  assert.equal(db.buyer().phone, '02112345678')
  assert.equal(db.buyer().authVersion, 0)
  assert.deepEqual(db.state.orders, historical)
  assert.equal(db.queries.find(([name]) => name === 'transaction')[1].isolationLevel, 'Serializable')
})

test('Support can edit a mobile account without email but cannot replace its verified mobile with a contact number', async () => {
  const db = database()
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  assert.equal((await handlers.PATCH(request({ email: null }), context())).status, 400)

  const phoneVerifiedAt = '2026-11-06T10:00:00Z'
  Object.assign(db.buyer(), { loginPhone: '09123456789', phoneVerifiedAt })
  const response = await handlers.PATCH(request({ email: null, phone: '02112345678', loginPhone: '09123456780' }), context())
  assert.equal(response.status, 200)
  const updated = await response.json()
  assert.equal(updated.email, null)
  assert.equal(updated.phone, '02112345678')
  assert.equal(updated.loginPhone, '09123456789')
  assert.equal(updated.phoneVerifiedAt, phoneVerifiedAt)
})

test('Email duplicates and a demoted or blocked actor stop every support mutation', async () => {
  for (const scenario of ['duplicate', 'demoted', 'blocked']) {
    const db = database()
    if (scenario === 'demoted') db.state.users[0].role = 'USER'
    if (scenario === 'blocked') db.state.users[0].isActive = false
    const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
    const response = await handlers.PATCH(request({ email: scenario === 'duplicate' ? 'ADMIN@EXAMPLE.TEST' : 'fresh@example.test', newPassword: 'abcdef' }), context())
    assert.equal(response.status, scenario === 'duplicate' ? 409 : 401)
    assert.equal(db.writes.length, 0)
    assert.equal(db.buyer().password, 'old-hash')
  }
})

test('Support password resets, blocking/unblocking and role changes revoke old sessions while metadata edits do not', async () => {
  const db = database()
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  for (const [body, version] of [[{ newPassword: 'new-secret' }, 1], [{ isActive: false }, 2], [{ isActive: false }, 2], [{ isActive: true }, 3], [{ role: 'ADMIN' }, 4], [{ name: 'اصلاح نام' }, 4]]) {
    const response = await handlers.PATCH(request(body), context())
    assert.equal(response.status, 200)
    assert.equal(db.buyer().authVersion, version)
    assert.ok(!('password' in await response.json()))
  }
  assert.equal(db.buyer().password, 'hash:new-secret')
  for (const body of [{ isActive: false }, { role: 'USER' }]) assert.equal((await handlers.PATCH(request(body), context('admin'))).status, 400)
})

test('The last-active-admin guard counts only active managers', async () => {
  const db = database()
  db.buyer().role = 'ADMIN'
  db.prisma.user.count = async query => { assert.deepEqual(plain(query.where), { role: 'ADMIN', isActive: true }); return 1 }
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  for (const body of [{ isActive: false }, { role: 'USER' }]) assert.equal((await handlers.PATCH(request(body), context())).status, 409)
  assert.equal(db.writes.length, 0)
})

test('Address support replaces only owned rows, canonicalizes identifiers, and leaves exactly one default', async () => {
  const db = database()
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  const response = await handlers.PATCH(request({ expectedAddresses: db.state.addresses, addresses: [
    { id: 'home', title: 'خانه', address: 'نشانی اصلاح‌شده', phone: '۰۹۱۲۳۴۵۶۷۸۹', postalCode: '۱۲۳۴۵۶۷۸۹۰', isDefault: false },
    { title: 'کار', address: 'نشانی دوم', phone: '02112345678', postalCode: '', isDefault: true },
  ] }), context())
  assert.equal(response.status, 200)
  assert.equal(db.state.addresses.length, 2)
  assert.equal(db.state.addresses[0].phone, '09123456789')
  assert.equal(db.state.addresses.filter(row => row.isDefault).length, 1)
  assert.equal(db.state.addresses.find(row => row.isDefault).title, 'کار')
  assert.equal(db.state.addresses[1].postalCode, null)
})

test('A stale support form cannot delete or overwrite addresses edited by the customer', async () => {
  const db = database()
  const expectedAddresses = plain(db.state.addresses)
  db.state.addresses[0].address = 'Customer changed it'
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  const response = await handlers.PATCH(request({ name: 'Must roll back', expectedAddresses, addresses: [] }), context())
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'USER_ADDRESSES_CHANGED')
  assert.equal(db.buyer().name, 'خریدار')
  assert.equal(db.state.addresses[0].address, 'Customer changed it')
})

test('Address ownership, duplicate IDs and missing baselines reject unsafe full replacements', async () => {
  for (const kind of ['foreign', 'duplicate', 'missing']) {
    const db = database()
    const address = plain(db.state.addresses[0])
    const addresses = kind === 'foreign' ? [{ ...address, id: 'another-users-address' }] : kind === 'duplicate' ? [address, address] : []
    const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
    const response = await handlers.PATCH(request({ addresses, ...(kind !== 'missing' && { expectedAddresses: db.state.addresses }) }), context())
    assert.equal(response.status, 400)
    assert.equal(db.state.addresses.length, 1)
    assert.equal(db.writes.length, 0)
  }
})

test('Empty address sets can be explicitly saved and metadata-only support does not touch addresses', async () => {
  const db = database()
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  assert.equal((await handlers.PATCH(request({ name: 'نام تازه' }), context())).status, 200)
  assert.equal(db.state.addresses.length, 1)
  assert.equal((await handlers.PATCH(request({ expectedAddresses: db.state.addresses, addresses: [] }), context())).status, 200)
  assert.equal(db.state.addresses.length, 0)
})

function manyAddresses(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `address-${index}`, userId: 'buyer', title: `نشانی ${index}`, address: `نشانی قدیمی ${index}`,
    phone: '09123456789', postalCode: '1234567890', isDefault: index === 0 }))
}

test('Administrators can repair or reduce a legacy address set above twenty without deleting valid rows first', async () => {
  const db = database()
  db.state.addresses = manyAddresses(21)
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  const addresses = plain(db.state.addresses)
  addresses[20].address = 'نشانی اصلاح‌شده'
  assert.equal((await handlers.PATCH(request({ expectedAddresses: db.state.addresses, addresses }), context())).status, 200)
  assert.equal(db.state.addresses.length, 21)
  assert.equal(db.state.addresses[20].address, 'نشانی اصلاح‌شده')
  assert.equal((await handlers.PATCH(request({ expectedAddresses: db.state.addresses, addresses: db.state.addresses.slice(0, 20) }), context())).status, 200)
  assert.equal(db.state.addresses.length, 20)
})

test('Legacy address excess cannot grow and forged large baselines cannot bypass ownership/concurrency validation', async () => {
  const db = database()
  db.state.addresses = manyAddresses(21)
  const { handlers } = load('src/app/api/users/[id]/route.ts', { prisma: db.prisma })
  const response = await handlers.PATCH(request({ expectedAddresses: db.state.addresses, addresses: [...db.state.addresses, { address: 'جدید', phone: '09123456789' }] }), context())
  assert.equal(response.status, 400)
  assert.equal(db.state.addresses.length, 21)
  db.state.addresses = manyAddresses(1)
  const forged = await handlers.PATCH(request({ expectedAddresses: manyAddresses(21), addresses: manyAddresses(21) }), context())
  assert.equal(forged.status, 409)
  assert.equal((await forged.json()).code, 'USER_ADDRESSES_CHANGED')
  assert.equal(db.state.addresses.length, 1)
})

test('Customer address creation caps new and legacy sets at twenty inside the serializable transaction', async () => {
  const db = database()
  const { handlers } = load('src/app/api/addresses/route.ts', { session: customer, prisma: db.prisma })
  const body = { address: 'نشانی تازه', phone: '09123456789', postalCode: '1234567890' }
  for (const count of [20, 21]) {
    db.state.addresses = manyAddresses(count)
    const result = await handlers.POST(request(body))
    assert.equal(result.status, 409)
    assert.match((await result.json()).error, /۲۰/)
    assert.equal(db.state.addresses.length, count)
  }
  db.state.addresses = manyAddresses(19)
  assert.equal((await handlers.POST(request(body))).status, 201)
  assert.equal(db.state.addresses.length, 20)
  assert.equal(db.state.addresses.filter(row => row.isDefault).length, 1)
  assert.equal((await handlers.POST(request(body))).status, 409)
  assert.equal(db.state.addresses.length, 20)
  assert.ok(db.queries.filter(([name]) => name === 'transaction').every(([, options]) => options.isolationLevel === 'Serializable'))
})

test('Admin-created customers can start incomplete but cannot store malformed contact identifiers', async () => {
  const db = database()
  const { handlers } = load('src/app/api/users/route.ts', { prisma: db.prisma })
  const base = { name: 'نام', email: 'new@example.test', password: 'abcdef', phone: '', postalCode: '' }
  assert.equal((await handlers.POST(request({ ...base, postalCode: '123' }))).status, 400)
  const response = await handlers.POST(request(base))
  assert.equal(response.status, 201)
  const result = await response.json()
  assert.equal(result.phone, null)
  assert.equal(result.postalCode, null)
  assert.equal(result.isActive, true)
  assert.ok(!('password' in result))
  const list = await handlers.GET()
  assert.equal((await list.json()).find(row => row.id === 'admin').isSelf, true)
  assert.match(list.headers.get('cache-control'), /no-store/)
})

test('Blocked accounts cannot sign in and a security-version change invalidates legacy and modern cookies', async () => {
  const db = database()
  const { authConfig } = load('src/lib/auth.ts', { prisma: db.prisma })
  const config = authConfig()
  const original = await config.providers[0].authorize({ email: 'buyer@example.test', password: 'old' })
  assert.equal(original.authVersion, 0)
  const token = await config.callbacks.jwt({ token: {}, user: original })
  assert.equal(token.authVersion, 0)
  db.buyer().isActive = false
  assert.equal(await config.providers[0].authorize({ email: 'buyer@example.test', password: 'old' }), null)
  assert.equal(await config.callbacks.jwt({ token }), null)
  db.buyer().isActive = true
  db.buyer().authVersion = 1
  assert.equal(await config.callbacks.jwt({ token }), null)
  assert.equal(await config.callbacks.jwt({ token: { id: 'buyer', lastActivityAt: Date.now() } }), null)
  assert.equal(await config.callbacks.jwt({ token: {}, user: original }), null, 'An authorize response issued before the reset cannot establish a new session')
  const fresh = await config.providers[0].authorize({ email: 'buyer@example.test', password: 'new' })
  assert.ok(await config.callbacks.jwt({ token: {}, user: fresh }))
})

test('Mobile credentials use the verified login number and establish a session without an email address', async () => {
  const db = database()
  Object.assign(db.buyer(), { email: null, loginPhone: '09123456789', phoneVerifiedAt: '2026-11-06T10:00:00Z', phone: '09123456780' })
  const { authConfig } = load('src/lib/auth.ts', { prisma: db.prisma, bcrypt: { compare: async password => password === 'correct' } })
  const config = authConfig()
  const authorize = config.providers[0].authorize
  assert.equal(await authorize({ loginPhone: '09123456780', password: 'correct' }), null)
  assert.equal(await authorize({ loginPhone: '09123456789', password: 'incorrect' }), null)
  const authorized = await authorize({ loginPhone: '+۹۸ ۹۱۲-۳۴۵-۶۷۸۹', password: 'correct' })
  assert.equal(authorized.id, 'buyer')
  const token = await config.callbacks.jwt({ token: {}, user: authorized })
  const session = await config.callbacks.session({ session: { user: {} }, token })
  assert.equal(session.user.email, '')
  assert.equal(session.user.loginPhone, '09123456789')
  db.buyer().isActive = false
  assert.equal(await authorize({ loginPhone: '09123456789', password: 'correct' }), null)
})

test('Changing your password uses an atomic old-hash check and revokes every session', async () => {
  const db = database()
  const { handlers } = load('src/app/api/profile/password/route.ts', { session: customer, prisma: db.prisma })
  assert.equal((await handlers.POST(request({ currentPassword: 'old', newPassword: 'new-secret' }))).status, 200)
  assert.equal(db.buyer().authVersion, 1)
  const conflict = load('src/app/api/profile/password/route.ts', { session: customer, prisma: db.prisma, bcrypt: { hash: async value => {
    db.buyer().password = 'support-reset-hash'
    return `hash:${value}`
  } } }).handlers
  assert.equal((await conflict.POST(request({ currentPassword: 'old', newPassword: 'other-secret' }))).status, 409)
  assert.equal(db.buyer().password, 'support-reset-hash')
})
