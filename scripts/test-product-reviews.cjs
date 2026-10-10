const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const root = path.join(__dirname, '..')
const admin = { user: { id: 'admin', role: 'ADMIN' } }
const buyer = { user: { id: 'buyer', role: 'USER' } }
const ctx = id => ({ params: Promise.resolve({ id }) })
const request = (body, url = 'http://localhost/api', headers = {}) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const plain = value => JSON.parse(JSON.stringify(value))

function load(file, { session = buyer, prisma = {} } = {}) {
 const cache = new Map()
 const dependencies = { 'next/server': { NextResponse: Response }, '@/lib/prisma': { prisma }, '@/lib/auth': { auth: async () => session }, '@/lib/payments': { expireUnpaidOrders: async () => 0 } }
 function read(filename) {
  const absolute = path.resolve(root, filename)
  if (cache.has(absolute)) return cache.get(absolute)
  const testModule = { exports: {} }; cache.set(absolute, testModule.exports)
  const code = transformSync(readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  vm.runInNewContext(code, { module: testModule, Response, Request, Headers, URL, Buffer, Date, process: { env: {} }, require(name) {
   if (name in dependencies) return dependencies[name]
   if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
   if (name.startsWith('./')) return read(path.relative(root, path.join(path.dirname(absolute), name + '.ts')))
   throw new Error('Unexpected module ' + name)
  } }, { filename: absolute }); cache.set(absolute, testModule.exports); return testModule.exports
 }
 return read(file)
}
const reviews = 'src/app/api/products/[id]/reviews/route.ts'
const moderation = 'src/app/api/admin/reviews/[id]/route.ts'
const inbox = 'src/app/api/admin/reviews/route.ts'
const db = extra => ({ product: { findUnique: async ({ where }) => where.id === 'p1' || where.slug === 'shoe' ? { id: 'p1' } : null }, ...extra })

for (const rating of [0, 6, -1, 1.5, null, {}, true, 'five']) test('Review rejects invalid rating ' + JSON.stringify(rating), async () => {
 let writes = 0
 const route = load(reviews, { prisma: db({ productReview: { upsert: async () => { writes++; } } }) })
 assert.equal((await route.POST(request({ rating }), ctx('p1'))).status, 400); assert.equal(writes, 0)
})
for (const comment of [3, null, {}, 'x'.repeat(2001), '\u0000'.replace('\\u0000', '\u0000')]) {
 test('Review rejects invalid comment ' + JSON.stringify(comment).slice(0, 30), async () => {
  const input = load('src/lib/product-reviews.ts').reviewInput
  assert.throws(() => input({ rating: 5, comment }))
 })
}
test('Rating-only review normalizes optional text and permits every logged-in user', async () => {
 let command
 const route = load(reviews, { prisma: db({ productReview: { upsert: async query => { command = query; return { id: 'r1', rating: 4, comment: '', status: 'PENDING', revision: 1 } } } }) })
 const result = await route.POST(request({ rating: 4, status: 'APPROVED', userId: 'other', verifiedBuyer: true }), ctx('p1'))
 assert.equal(result.status, 200)
 assert.deepEqual(plain(command.where), { productId_userId: { productId: 'p1', userId: 'buyer' } })
 assert.deepEqual(plain(command.create), { productId: 'p1', userId: 'buyer', rating: 4, comment: '' })
 assert.equal(command.update.status, 'PENDING'); assert.equal(command.update.revision.increment, 1)
 assert.equal(command.update.reviewerId, null); assert.equal(command.update.reviewedAt, null); assert.equal(command.update.moderationNote, null)
})
test('Re-edit uses one compound user/product upsert and always removes prior approval', async () => {
 let command
 const route = load(reviews, { prisma: db({ productReview: { upsert: async q => { command = q; return { id: 'same-review', status: 'PENDING' } } } }) })
 await route.POST(request({ rating: 2, comment: '  changed  ' }), ctx('shoe'))
 assert.equal(command.update.comment, 'changed'); assert.equal(command.update.rating, 2)
 assert.equal(command.update.status, 'PENDING'); assert.equal(command.where.productId_userId.productId, 'p1')
})
for (const session of [null, {}, { user: {} }]) test('Guest cannot post a review ' + JSON.stringify(session), async () => {
 assert.equal((await load(reviews, { session }).POST(request({ rating: 5 }), ctx('p1'))).status, 401)
})
for (const file of [reviews, moderation]) test('Cross-origin write is rejected before database work: ' + file, async () => {
 const route = load(file, { session: admin })
 const handler = route.POST || route.PUT
 assert.equal((await handler(request({ rating: 5, action: 'approve', expectedRevision: 1 }, 'http://localhost/api', { origin: 'https://evil.example' }), ctx('p1'))).status, 403)
})
test('Missing product and malformed body do not create a review', async () => {
 const route = load(reviews, { prisma: db() })
 assert.equal((await route.POST(request({ rating: 5 }), ctx('missing'))).status, 404)
 assert.equal((await route.POST(new Request('http://localhost/api', { method: 'POST', body: '{' }), ctx('p1'))).status, 400)
})
test('Public reviews only expose approved safe fields; buyer badge depends on paid fulfillment', async () => {
 let listQuery, groupedQuery, ownQuery
 const route = load(reviews, { prisma: db({ productReview: {
  findMany: async q => { listQuery = q; return [{ id: 'r1', rating: 5, comment: '<b>real text</b>', createdAt: new Date(), user: { name: 'سارا احمدی', email: 'private@example.test', orders: [{ id: 'paid' }] } }] },
  groupBy: async q => { groupedQuery = q; return [{ rating: 5, _count: { _all: 1 } }] },
  findUnique: async q => { ownQuery = q; return { id: 'mine', status: 'REJECTED', moderationNote: 'own reason' } },
 } }) })
 const response = await route.GET(new Request('http://localhost/api?page=1'), ctx('shoe')), body = await response.json()
 assert.equal(response.headers.get('cache-control'), 'private, no-store')
 assert.equal(listQuery.where.status, 'APPROVED'); assert.equal(groupedQuery.where.status, 'APPROVED')
 assert.equal(listQuery.select.user.select.orders.where.verified, true)
 assert.deepEqual(plain(listQuery.select.user.select.orders.where.status.in), ['PROCESSING', 'SHIPPED', 'DELIVERED'])
 assert.equal(listQuery.select.user.select.orders.where.items.some.productId, 'p1')
 assert.equal(body.reviews[0].authorName, 'سارا'); assert.equal(body.reviews[0].verifiedBuyer, true)
 assert.equal(body.reviews[0].user, undefined); assert.equal(body.reviews[0].moderationNote, undefined)
 assert.equal(JSON.stringify(body).includes('private@example'), false)
 assert.equal(ownQuery.where.productId_userId.userId, 'buyer'); assert.equal(body.myReview.moderationNote, 'own reason')
 assert.equal(body.summary.average, 5); assert.equal(body.summary.count, 1)
})
test('Anonymous GET never reads any private own review and validates pagination', async () => {
 let skip
 const route = load(reviews, { session: null, prisma: db({ productReview: {
  findMany: async q => { skip = q.skip; return [] }, groupBy: async () => [], findUnique: async () => { throw new Error('Private read') },
 } }) })
 const body = await (await route.GET(new Request('http://localhost/api?page=2'), ctx('p1'))).json()
 assert.equal(skip, 10); assert.equal(body.myReview, null); assert.equal(body.summary.count, 0)
 for (const page of ['0', '-1', 'x', '1.5', '1000000']) assert.equal((await route.GET(new Request('http://localhost/api?page=' + page), ctx('p1'))).status, 400)
})
test('Product metrics query only approved reviews and preserves zero/unrated products', async () => {
 let query
 const { withProductRatings } = load('src/lib/product-reviews.ts', { prisma: { productReview: { groupBy: async q => { query = q; return [{ productId: 'p1', _avg: { rating: 4.25 }, _count: { _all: 4 } }] } } } })
 const products = await withProductRatings([{ id: 'p1', viewCount: 8 }, { id: 'p2', viewCount: 1 }])
 assert.equal(query.where.status, 'APPROVED'); assert.deepEqual(plain(query.where.productId.in), ['p1', 'p2'])
 assert.deepEqual(plain(products), [{ id: 'p1', viewCount: 8, ratingAverage: 4.25, ratingCount: 4 }, { id: 'p2', viewCount: 1, ratingAverage: 0, ratingCount: 0 }])
 assert.deepEqual(plain(await withProductRatings([])), [])
})
for (const session of [null, buyer, { user: { role: 'ADMIN' } }]) test('Only identified admin may read inbox or moderate ' + JSON.stringify(session), async () => {
 const expected = session?.user?.id ? 403 : 401
 assert.equal((await load(inbox, { session }).GET(new Request('http://localhost/api'))).status, expected)
 assert.equal((await load(moderation, { session }).PUT(request({ action: 'approve', expectedRevision: 1 }), ctx('r1'))).status, expected)
})
test('Moderation uses atomic revision predicate; changes status without altering rating/comment/author', async () => {
 let query
 const route = load(moderation, { session: admin, prisma: { productReview: { updateMany: async q => { query = q; return { count: 1 } } } } })
 assert.equal((await route.PUT(request({ action: 'approve', expectedRevision: 7, rating: 1, userId: 'fake' }), ctx('r1'))).status, 200)
 assert.deepEqual(plain(query.where), { id: 'r1', revision: 7 }); assert.equal(query.data.status, 'APPROVED')
 assert.equal(query.data.revision.increment, 1); assert.equal(query.data.reviewerId, 'admin')
 assert.equal(query.data.rating, undefined); assert.equal(query.data.comment, undefined); assert.equal(query.data.userId, undefined)
})
test('Stale admin cannot approve a newer customer edit and receives conflict', async () => {
 const route = load(moderation, { session: admin, prisma: { productReview: { updateMany: async () => ({ count: 0 }), findUnique: async () => ({ id: 'r1' }) } } })
 const response = await route.PUT(request({ action: 'approve', expectedRevision: 1 }), ctx('r1'))
 assert.equal(response.status, 409); assert.equal((await response.json()).code, 'REVIEW_CHANGED')
})
test('Deleted review returns404 rather than a stale-edit conflict', async () => {
 const route = load(moderation, { session: admin, prisma: { productReview: { updateMany: async () => ({ count: 0 }), findUnique: async () => null } } })
 assert.equal((await route.PUT(request({ action: 'reject', expectedRevision: 1 }), ctx('missing'))).status, 404)
})
for (const body of [{ action: 'delete', expectedRevision: 1 }, { action: 'approve' }, { action: 'reject', expectedRevision: 0 }, { action: 'approve', expectedRevision: 1, note: 'x'.repeat(501) }]) test('Invalid moderation input never writes ' + JSON.stringify(body).slice(0, 80), async () => {
 assert.equal((await load(moderation, { session: admin }).PUT(request(body), ctx('r1'))).status, 400)
})
test('Admin inbox scopes search/status, paginates and keeps pending total independent', async () => {
 const queries = []
 const route = load(inbox, { session: admin, prisma: { productReview: { findMany: async q => { queries.push(q); return [] }, count: async q => { queries.push(q); return 4 } } } })
 const response = await route.GET(new Request('http://localhost/api?status=APPROVED&q=shoe&page=2')), body = await response.json()
 assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(queries[0].skip, 20); assert.equal(queries[0].take, 20)
 assert.equal(queries[0].where.status, 'APPROVED'); assert.equal(queries[0].where.OR[2].product.name.contains, 'shoe')
 assert.deepEqual(plain(queries[2].where), { status: 'PENDING' }); assert.equal(body.pending, 4)
 assert.equal((await route.GET(new Request('http://localhost/api?status=deleted'))).status, 400)
})
test('Specifications retain admin order, normalize text, default only on create and explicitly clear', () => {
 const { specificationsField, productInput } = load('src/lib/catalog-input.ts')
 const specs = [{ name: '  جنس رویه ', value: ' ورنی  ' }, { name: 'ارتفاع پاشنه', value: '۱۰ سانتی‌متر' }]
 assert.deepEqual(plain(specificationsField(specs)), [{ name: 'جنس رویه', value: 'ورنی' }, { name: 'ارتفاع پاشنه', value: '۱۰ سانتی‌متر' }])
 assert.equal(productInput({ name: 'changed' }).specifications, undefined)
 assert.deepEqual(plain(productInput({ specifications: [] }).specifications), [])
 const create = productInput({ name: 'new', price: 1, categoryId: 'cat' }, true)
 assert.deepEqual(plain(create.specifications), [])
})
for (const specifications of [null, {}, [{ name: '', value: 'x' }], [{ name: 'x', value: '' }], [{ name: 'x', value: 'x'.repeat(501) }], Array(31).fill({ name: 'x', value: 'y' }), [{ name: 'Material', value: 'x' }, { name: 'ｍaterial', value: 'y' }]]) test('Invalid specification arrays cannot reach database ' + JSON.stringify(specifications).slice(0, 60), () => {
 const { productInput } = load('src/lib/catalog-input.ts'); assert.throws(() => productInput({ specifications }))
})
