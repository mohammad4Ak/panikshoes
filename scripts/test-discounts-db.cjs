// Explicit local integration check. It creates only randomized temporary rows,
// uses no products, stock, receipts or verified payments, and removes its rows.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const connection = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid')
if (connection.hostname !== '192.168.1.104' || connection.pathname !== '/shoes_shop') {
  throw new Error('Live discount test requires the explicitly authorized local shoes_shop database at 192.168.1.104')
}
const context = { module: { exports: {} }, Date, Intl }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/coupons.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022',
}).code, context)
const { quoteCoupon, reserveCoupon, releaseCouponReservation, reacquireCouponReservation } = context.module.exports
const prisma = new PrismaClient()
const paymentContext = { module: { exports: {} }, Date, require(name) {
  const dependencies = {
    '@/lib/prisma': { prisma }, '@/lib/payment-contract': { PAYMENT_WINDOW_MS: 600000 },
    '@/lib/request-origin': {}, '@/lib/coupons': context.module.exports,
  }
  assert.ok(name in dependencies, `Unexpected payment dependency: ${name}`)
  return dependencies[name]
} }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/payments.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022',
}).code, paymentContext)
const { expireUnpaidOrders } = paymentContext.module.exports
const token = randomBytes(6).toString('hex').toUpperCase()
const prefix = `TEST_DISCOUNT_${token}`
const userIds = [1, 2].map(index => `${prefix}_USER_${index}`)
const couponIds = ['GLOBAL', 'USER', 'ROLLBACK'].map(label => `${prefix}_${label}`)
const orderIds = ['A', 'B', 'C', 'D', 'E'].map(label => `${prefix}_ORDER_${label}`)
const now = new Date()
const transact = callback => prisma.$transaction(callback, { maxWait: 5000, timeout: 10000, isolationLevel: 'ReadCommitted' })

async function count(couponId) {
  const [coupon, active] = await Promise.all([
    prisma.coupon.findUniqueOrThrow({ where: { id: couponId }, select: { usedCount: true } }),
    prisma.couponRedemption.count({ where: { couponId, releasedAt: null } }),
  ])
  assert.equal(coupon.usedCount, active, 'Counter must match live reservations')
  return active
}

async function main() {
  try {
    await prisma.user.createMany({ data: userIds.map((id, index) => ({ id, email: `${token.toLowerCase()}-${index}@discount-test.invalid`, name: 'آزمایش داخلی تخفیف', password: '$disabled$temporary-test-account', role: 'USER' })) })
    await prisma.coupon.createMany({ data: couponIds.map((id, index) => ({
      id, code: `TD_${token}_${index}`, name: 'آزمایش داخلی تخفیف', type: 'PERCENT', value: 10,
      minSubtotal: 100, maxUses: index === 0 ? 1 : 3, perUserLimit: 1, isActive: true,
      startsAt: new Date(now.getTime() - 60000), endsAt: new Date(now.getTime() + 300000),
    })) })
    await prisma.order.createMany({ data: orderIds.map((id, index) => ({
      id, userId: index === 1 ? userIds[1] : userIds[0], address: 'آزمایش داخلی — بدون ارسال', phone: '00000000000',
      total: 900, subtotal: 1000, productDiscount: 0, couponDiscount: 100, shippingCost: 0,
      status: 'CANCELLED', verified: false, paymentMethod: null, paymentStatus: 'UNPAID',
    })) })

    const global = await prisma.coupon.findUniqueOrThrow({ where: { id: couponIds[0] } })
    const globalQuotes = await Promise.all(userIds.map(userId => quoteCoupon(prisma, global.code, userId, 1000, now)))
    const globalResults = await Promise.allSettled(userIds.map((userId, index) => transact(tx => reserveCoupon(tx, globalQuotes[index], userId, orderIds[index], now))))
    assert.equal(globalResults.filter(result => result.status === 'fulfilled').length, 1, 'Only one concurrent user may claim a globally limited code')
    assert.equal(await count(global.id), 1)
    const globalWinner = globalResults.findIndex(result => result.status === 'fulfilled')
    const winnerOrder = orderIds[globalWinner]
    const winnerUser = userIds[globalWinner]
    console.log('PASS concurrent global maxUses=1 across two distinct users')

    const perUser = await prisma.coupon.findUniqueOrThrow({ where: { id: couponIds[1] } })
    const perUserQuote = await quoteCoupon(prisma, perUser.code, userIds[0], 1000, now)
    const userResults = await Promise.allSettled([orderIds[2], orderIds[3]].map(orderId => transact(tx => reserveCoupon(tx, perUserQuote, userIds[0], orderId, now))))
    assert.equal(userResults.filter(result => result.status === 'fulfilled').length, 1, 'One user cannot claim twice concurrently even when global capacity is 3')
    assert.equal(await count(perUser.id), 1)
    const userFailure = userResults.find(result => result.status === 'rejected')
    assert.equal(userFailure.reason.code, 'COUPON_USER_LIMIT_REACHED')
    console.log('PASS concurrent perUserLimit=1 while maxUses=3; rejected increment rolled back')

    await Promise.all([1, 2].map(() => transact(tx => releaseCouponReservation(tx, winnerOrder, now))))
    assert.equal(await count(global.id), 0)
    await transact(tx => releaseCouponReservation(tx, winnerOrder, now))
    assert.equal(await count(global.id), 0)
    console.log('PASS concurrent and repeated release decrements once')

    const forcedRollback = new Error('intentional fixture transaction rollback')
    await assert.rejects(transact(async tx => {
      await reacquireCouponReservation(tx, winnerOrder, winnerUser, now)
      throw forcedRollback
    }), error => error === forcedRollback)
    assert.equal(await count(global.id), 0)
    assert.ok((await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: winnerOrder } })).releasedAt)

    const reacquisitions = await Promise.allSettled([1, 2].map(() => transact(tx => reacquireCouponReservation(tx, winnerOrder, winnerUser, now))))
    assert.ok(reacquisitions.some(result => result.status === 'fulfilled'))
    await transact(tx => reacquireCouponReservation(tx, winnerOrder, winnerUser, now))
    assert.equal(await count(global.id), 1)
    console.log('PASS reacquire rollback, concurrency and repeated reacquire preserve exact count')

    await prisma.order.update({ where: { id: winnerOrder }, data: {
      couponId: global.id, status: 'PENDING', paymentMethod: 'bank_transfer',
      paymentStatus: 'AWAITING_RECEIPT', paymentExpiresAt: new Date(now.getTime() - 1),
    } })
    assert.equal(await expireUnpaidOrders(now, undefined, { productIds: [`${prefix}_NO_PRODUCT`], couponCode: global.code }), 1)
    assert.equal(await count(global.id), 0)
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: winnerOrder } })).paymentStatus, 'EXPIRED')
    console.log('PASS targeted expiry query releases the exact coupon reservation using real PostgreSQL relations')

    const rollback = await prisma.coupon.findUniqueOrThrow({ where: { id: couponIds[2] } })
    const rollbackQuote = await quoteCoupon(prisma, rollback.code, userIds[0], 1000, now)
    await assert.rejects(transact(async tx => {
      await reserveCoupon(tx, rollbackQuote, userIds[0], orderIds[4], now)
      throw forcedRollback
    }), error => error === forcedRollback)
    assert.equal(await count(rollback.id), 0)
    assert.equal(await prisma.couponRedemption.count({ where: { orderId: orderIds[4] } }), 0)
    console.log('PASS failed order transaction rolls back both claim and redemption')

    await prisma.coupon.update({ where: { id: rollback.id }, data: { endsAt: new Date(now.getTime() - 1) } })
    await assert.rejects(quoteCoupon(prisma, rollback.code, userIds[0], 1000, now), error => error.code === 'COUPON_INVALID')
    assert.equal(await count(rollback.id), 0)
    console.log('PASS expired code cannot be quoted or consume usage')
  } finally {
    // Exact randomized identities only: never delete/reset existing store data.
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
    await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    assert.equal(await prisma.order.count({ where: { id: { in: orderIds } } }), 0)
    assert.equal(await prisma.coupon.count({ where: { id: { in: couponIds } } }), 0)
    assert.equal(await prisma.user.count({ where: { id: { in: userIds } } }), 0)
    console.log('PASS all temporary rows removed; no products, stock or payments touched')
  }
}

main().catch(error => {
  console.error('Local discount DB test failed:', error.code || error.name, error.message)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
