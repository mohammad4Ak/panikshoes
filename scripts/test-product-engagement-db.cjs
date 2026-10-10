// Opt-in integration test. Every fixture/write is enclosed in one rolled-back transaction.
// Run: node --env-file=.env scripts/test-product-engagement-db.cjs
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')
const root = path.join(__dirname, '..')
const prisma = new PrismaClient()
function handlers(file, database, session) {
 const cache = new Map()
 function read(name) {
  const f = path.resolve(root, name); if (cache.has(f)) return cache.get(f)
  const testModule = { exports: {} }; cache.set(f, testModule.exports)
  const code = transformSync(readFileSync(f, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  vm.runInNewContext(code, { module: testModule, Response, Request, Headers, URL, Buffer, Date, process: { env: {} }, require(name) {
   if (name === 'next/server') return { NextResponse: Response }
   if (name === '@/lib/prisma') return { prisma: database }
   if (name === '@/lib/auth') return { auth: async () => session }
   if (name.startsWith('@/lib/')) return read('src/lib/' + name.slice(6) + '.ts')
   if (name.startsWith('./')) return read(path.relative(root, path.join(path.dirname(f), name + '.ts')))
   throw new Error('Unexpected dependency ' + name)
  } }, { filename: f }); cache.set(f, testModule.exports); return testModule.exports
 }
 return read(file)
}
const context = id => ({ params: Promise.resolve({ id }) })
const request = body => new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
;(async () => {
 const marker = randomUUID(), rollback = new Error('ROLLBACK_EXPECTED')
 let productId, userId
 try {
  await prisma.$transaction(async tx => {
   const category = await tx.category.findFirst({ select: { id: true } }); assert.ok(category)
   const user = await tx.user.create({ data: { email: marker + '@integration.invalid', name: 'خریدار آزمایشی', password: 'not-an-authentication-hash' } }); userId = user.id
   const product = await tx.product.create({ data: { name: 'Temporary integration fixture', slug: 'fixture-' + marker, description: '', price: 1000, images: [], categoryId: category.id, sizes: [38], colors: ['کرم'], stock: 0, specifications: [{ name: 'جنس رویه', value: 'ورنی' }] } }); productId = product.id
   const publicFile = 'src/app/api/products/[id]/reviews/route.ts'
   const customer = handlers(publicFile, tx, { user: { id: user.id, role: 'USER' } })
   const anonymous = handlers(publicFile, tx, null)
   const admin = handlers('src/app/api/admin/reviews/[id]/route.ts', tx, { user: { id: user.id, role: 'ADMIN' } })
   assert.equal((await customer.POST(request({ rating: 4, comment: 'Test review' }), context(product.id))).status, 200)
   let own = await (await customer.GET(new Request('http://localhost/api'), context(product.id))).json()
   assert.equal(own.myReview.status, 'PENDING'); assert.equal(own.summary.count, 0)
   const reviewId = own.myReview.id
   assert.equal((await admin.PUT(request({ action: 'approve', expectedRevision: 1 }), context(reviewId))).status, 200)
   let listed = await (await anonymous.GET(new Request('http://localhost/api'), context(product.id))).json()
   assert.equal(listed.summary.average, 4); assert.equal(listed.summary.count, 1); assert.equal(listed.myReview, null)
   assert.equal(listed.reviews[0].verifiedBuyer, false)
   const order = await tx.order.create({ data: { userId: user.id, total: 1000, verified: true, status: 'PROCESSING', address: 'integration fixture', phone: '0', items: { create: { productId: product.id, productName: product.name, quantity: 1, size: 38, color: 'کرم', price: 1000 } } } })
   listed = await (await anonymous.GET(new Request('http://localhost/api'), context(product.id))).json(); assert.equal(listed.reviews[0].verifiedBuyer, true)
   await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } })
   listed = await (await anonymous.GET(new Request('http://localhost/api'), context(product.id))).json(); assert.equal(listed.reviews[0].verifiedBuyer, false)
   assert.equal((await customer.POST(request({ rating: 2, comment: 'Edited after approval' }), context(product.id))).status, 200)
   assert.equal((await admin.PUT(request({ action: 'approve', expectedRevision: 2 }), context(reviewId))).status, 409)
   listed = await (await anonymous.GET(new Request('http://localhost/api'), context(product.id))).json(); assert.equal(listed.summary.count, 0)
   assert.equal((await admin.PUT(request({ action: 'reject', expectedRevision: 3, note: 'Private moderation note' }), context(reviewId))).status, 200)
   own = await (await customer.GET(new Request('http://localhost/api'), context(product.id))).json(); assert.equal(own.myReview.status, 'REJECTED'); assert.equal(own.myReview.moderationNote, 'Private moderation note')
   await Promise.all(Array.from({ length: 5 }, (_, i) => customer.POST(request({ rating: i + 1, comment: 'One entry' }), context(product.id))))
   assert.equal(await tx.productReview.count({ where: { productId: product.id, userId: user.id } }), 1)
   const canonical = await tx.productReview.findUnique({ where: { id: reviewId } }); assert.equal(canonical.revision, 9); assert.equal(canonical.status, 'PENDING')
   assert.equal((await admin.PUT(request({ action: 'approve', expectedRevision: 9 }), context(reviewId))).status, 200)
   const metrics = await handlers('src/lib/product-reviews.ts', tx, null).withProductRatings([product])
   assert.equal(metrics[0].ratingCount, 1); assert.equal(metrics[0].ratingAverage, canonical.rating)
   throw rollback
  }, { timeout: 20000 })
  throw new Error('Fixture transaction unexpectedly committed')
 } catch (error) { if (error !== rollback) throw error }
 assert.equal(await prisma.product.count({ where: { id: productId } }), 0)
 assert.equal(await prisma.user.count({ where: { id: userId } }), 0)
 assert.equal(await prisma.productReview.count({ where: { productId } }), 0)
 console.log('Real PostgreSQL review/moderation/ratings/buyer-badge checks passed; all fixtures rolled back.')
})().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => prisma.$disconnect())
