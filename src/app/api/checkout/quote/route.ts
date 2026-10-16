import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { CouponError, normalizeCouponCode, quoteCoupon } from '@/lib/coupons'
import { productPricing } from '@/lib/pricing'
import { calculateShippingCost, MAX_SHIPPING_AMOUNT, ShippingValidationError } from '@/lib/shipping'
import { expireUnpaidOrders } from '@/lib/payments'
import { isSameOriginRequest } from '@/lib/request-origin'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست غیرمجاز است' }, { status: 403, headers })
  try {
    let body: Record<string, unknown>
    try {
      const value: unknown = await request.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      body = value as Record<string, unknown>
    } catch { throw new CouponError('اطلاعات سبد خرید معتبر نیست') }
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100 ||
        typeof body.shippingMethodId !== 'string' || !body.shippingMethodId.trim() || body.shippingMethodId.length > 128) {
      throw new CouponError('سبد خرید یا روش ارسال معتبر نیست')
    }
    const quantities = new Map<string, number>()
    for (const item of body.items) {
      if (!item || typeof item !== 'object' || typeof item.productId !== 'string' || !item.productId.trim() || item.productId.length > 128 ||
          !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_SHIPPING_AMOUNT) throw new CouponError('تعداد محصولات معتبر نیست')
      const id = item.productId.trim()
      const quantity = (quantities.get(id) ?? 0) + item.quantity
      if (!Number.isSafeInteger(quantity) || quantity > MAX_SHIPPING_AMOUNT) throw new CouponError('تعداد محصولات معتبر نیست')
      quantities.set(id, quantity)
    }
    if (body.checkoutKey !== undefined && body.checkoutKey !== null &&
        (typeof body.checkoutKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.checkoutKey))) throw new CouponError('شناسهٔ ثبت سفارش معتبر نیست')
    const session = await auth()
    // A lost response must remain recoverable even when that very order has
    // already reserved the last global/per-user use of its coupon.
    if (body.checkoutKey && session?.user?.id) {
      const existing = await prisma.order.findFirst({
        where: { checkoutKey: `${session.user.id}:${String(body.checkoutKey).toLowerCase()}`, userId: session.user.id }, select: { id: true },
      })
      if (existing) return NextResponse.json({ error: 'این سبد قبلاً ثبت شده است؛ برای ادامه، سفارش ثبت‌شده را باز کن.', code: 'CHECKOUT_ALREADY_CREATED', existingOrderId: existing.id }, { status: 409, headers })
    }
    const code = normalizeCouponCode(body.couponCode)
    if (code && !session?.user?.id) return NextResponse.json({ error: 'برای استفاده از کد تخفیف ابتدا وارد حساب شوید' }, { status: 401, headers })
    await expireUnpaidOrders(new Date(), undefined, { productIds: [...quantities.keys()], couponCode: code })
    const quote = await prisma.$transaction(async (tx) => {
      const now = new Date()
      const method = await tx.shippingMethod.findUnique({ where: { id: body.shippingMethodId as string } })
      if (!method?.isActive) throw new CouponError('روش ارسال دیگر در دسترس نیست', 409, 'SHIPPING_METHOD_UNAVAILABLE')
      const products = await tx.product.findMany({ where: { id: { in: [...quantities.keys()] } } })
      if (products.length !== quantities.size) throw new CouponError('یکی از محصولات سبد دیگر در دسترس نیست', 409, 'STOCK_UNAVAILABLE')
      let grossSubtotal = 0, subtotal = 0, count = 0
      const productPrices = products.map((product) => {
        const pricing = productPricing(product, now)
        const quantity = quantities.get(product.id)!
        grossSubtotal += pricing.originalPrice * quantity
        subtotal += pricing.effectivePrice * quantity
        count += quantity
        return { productId: product.id, price: pricing.effectivePrice, originalPrice: pricing.originalPrice }
      })
      if (![grossSubtotal, subtotal, count].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_SHIPPING_AMOUNT)) throw new CouponError('مبلغ یا تعداد سفارش بیش از سقف مجاز است')
      const coupon = await quoteCoupon(tx, code, session?.user?.id ?? '', subtotal, now)
      const shippingCost = calculateShippingCost(method, subtotal - coupon.discount, count)
      const total = subtotal - coupon.discount + shippingCost
      if (!Number.isSafeInteger(total) || total > MAX_SHIPPING_AMOUNT) throw new CouponError('مبلغ سفارش بیش از سقف مجاز است')
      return { grossSubtotal, subtotal, productDiscount: grossSubtotal - subtotal, couponDiscount: coupon.discount, couponCode: coupon.code, shippingCost, total, productPrices }
    })
    return NextResponse.json(quote, { headers })
  } catch (error) {
    if (error instanceof CouponError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers })
    if (error instanceof ShippingValidationError) return NextResponse.json({ error: error.message }, { status: 400, headers })
    return NextResponse.json({ error: 'محاسبهٔ مبلغ سفارش انجام نشد؛ دوباره تلاش کنید' }, { status: 500, headers })
  }
}
