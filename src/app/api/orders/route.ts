import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import type { Product } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { calculateShippingCost, MAX_SHIPPING_AMOUNT, ShippingValidationError } from '@/lib/shipping'
import { expireUnpaidOrders, methodAvailability } from '@/lib/payments'
import { PAYMENT_WINDOW_MS } from '@/lib/payment-contract'
import { isSameOriginRequest } from '@/lib/request-origin'
import { allocateDiscount, productPricing } from '@/lib/pricing'
import { CouponError, normalizeCouponCode, quoteCoupon, reserveCoupon } from '@/lib/coupons'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید' }, { status: 401 })
  }

  await expireUnpaidOrders()
  const orders = await prisma.order.findMany({
    where: session.user.role === 'ADMIN' ? {} : { userId: session.user.id },
    include: {
      user: { select: { name: true, email: true } },
      items: { include: { product: { select: { name: true } } } },
      invoice: { select: { id: true, issuedAt: true } },
      _count: { select: { receipts: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(orders, { headers: { 'Cache-Control': 'private, no-store' } })
}

class OrderError extends Error {
  constructor(message: string, readonly details: {
    status?: number
    outOfStock?: string[]
    outOfStockDetails?: { productId: string; name: string; availableQuantity: number }[]
    code?: string
    shippingCost?: number
    productPrices?: { productId: string; price: number; originalPrice: number }[]
    couponDiscount?: number
    invalidVariants?: { productId: string; size: number; color: string }[]
    existingOrderId?: string
  } = {}) { super(message) }
}

interface RequestedItem {
  productId: string
  quantity: number
  size: number
  color: string
}

function validMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SHIPPING_AMOUNT
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'برای ثبت سفارش ابتدا وارد شوید' }, { status: 401 })
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر ارسال شده است' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'اطلاعات درخواست معتبر نیست' }, { status: 400 })
  }

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    return NextResponse.json({ error: 'سبد خرید خالی یا نامعتبر است' }, { status: 400 })
  }
  if (typeof body.address !== 'string' || !body.address.trim() || body.address.trim().length > 3000 ||
      typeof body.phone !== 'string' || !body.phone.trim() || body.phone.length > 50) {
    return NextResponse.json({ error: 'آدرس و شماره تماس معتبر الزامی است' }, { status: 400 })
  }
  if (body.recipientName !== undefined &&
      (typeof body.recipientName !== 'string' || !body.recipientName.trim() || body.recipientName.trim().length > 120)) {
    return NextResponse.json({ error: 'نام گیرنده معتبر نیست (حداکثر ۱۲۰ نویسه)' }, { status: 400 })
  }
  if (body.checkoutKey !== undefined &&
      (typeof body.checkoutKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.checkoutKey))) {
    return NextResponse.json({ error: 'شناسهٔ ثبت سفارش معتبر نیست' }, { status: 400 })
  }
  if (typeof body.shippingMethodId !== 'string' || !body.shippingMethodId.trim() || body.shippingMethodId.length > 128) {
    return NextResponse.json({ error: 'یک روش ارسال انتخاب کنید', code: 'SHIPPING_METHOD_UNAVAILABLE' }, { status: 409 })
  }
  if (body.paymentMethodId !== 'bank_transfer') {
    return NextResponse.json({ error: 'یک روش پرداخت فعال انتخاب کنید', code: 'PAYMENT_METHOD_UNAVAILABLE' }, { status: 409 })
  }
  if (!validMoney(body.expectedShippingCost)) {
    return NextResponse.json({ error: 'هزینهٔ ارسال را بازبینی کنید' }, { status: 400 })
  }
  if (body.expectedSubtotal !== undefined && !validMoney(body.expectedSubtotal)) {
    return NextResponse.json({ error: 'مبلغ محصولات را بازبینی کنید' }, { status: 400 })
  }
  let couponCode: string | null
  try { couponCode = normalizeCouponCode(body.couponCode) }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'کد تخفیف معتبر نیست', code: 'COUPON_INVALID' }, { status: 400 }) }
  if ((couponCode || body.expectedCouponDiscount !== undefined) && !validMoney(body.expectedCouponDiscount)) {
    return NextResponse.json({ error: 'مبلغ کد تخفیف را بازبینی کنید', code: 'COUPON_QUOTE_REQUIRED' }, { status: 400 })
  }

  const address = body.address.trim()
  const phone = body.phone.trim()
  const recipientName = typeof body.recipientName === 'string' ? body.recipientName.trim() : session.user.name?.trim() || null
  const shippingMethodId = body.shippingMethodId.trim()
  const paymentMethodId = body.paymentMethodId
  const expectedShippingCost = body.expectedShippingCost
  const expectedSubtotal = body.expectedSubtotal
  const checkoutKey = typeof body.checkoutKey === 'string' ? `${session.user.id}:${body.checkoutKey.toLowerCase()}` : null
  const items: RequestedItem[] = []
  const requestedQuantities = new Map<string, number>()

  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ error: 'محصولات سبد خرید معتبر نیستند' }, { status: 400 })
    }
    const item = raw as Record<string, unknown>
    if (typeof item.productId !== 'string' || !item.productId.trim() || item.productId.length > 128 ||
        typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_SHIPPING_AMOUNT ||
        typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_SHIPPING_AMOUNT ||
        (item.color != null && (typeof item.color !== 'string' || item.color.length > 80))) {
      return NextResponse.json({ error: 'مشخصات یا تعداد محصول معتبر نیست' }, { status: 400 })
    }
    const productId = item.productId.trim()
    const quantity = (requestedQuantities.get(productId) ?? 0) + item.quantity
    if (!Number.isSafeInteger(quantity) || quantity > MAX_SHIPPING_AMOUNT) {
      return NextResponse.json({ error: 'تعداد محصول معتبر نیست' }, { status: 400 })
    }
    requestedQuantities.set(productId, quantity)
    items.push({
      productId, quantity: item.quantity, size: item.size,
      color: typeof item.color === 'string' ? item.color.trim() || '-' : '-',
    })
  }

  const checkoutFingerprint = checkoutKey ? createHash('sha256').update(JSON.stringify({
    // The quote may refresh after a lost response. It is not a new purchase intent.
    recipientName, address, phone, shippingMethodId, paymentMethodId, ...(couponCode ? { couponCode } : {}),
    items: [...items].sort((left, right) => left.productId.localeCompare(right.productId) ||
      left.size - right.size || left.color.localeCompare(right.color) || left.quantity - right.quantity),
  })).digest('hex') : null

  const existingCheckout = async () => {
    if (!checkoutKey) return null
    const existing = await prisma.order.findFirst({
      where: { checkoutKey, userId: session.user.id },
      include: { items: true, invoice: { select: { id: true, issuedAt: true } } },
    })
    if (existing && existing.checkoutFingerprint !== checkoutFingerprint) {
      throw new OrderError('اطلاعات این درخواست با سفارش ثبت‌شده متفاوت است؛ سفارش را دوباره بازبینی کنید', {
        status: 409, code: 'CHECKOUT_KEY_REUSED', existingOrderId: existing.id,
      })
    }
    return existing
  }

  try {
    // A lost response must not create a second order or reserve inventory twice.
    // Return the historical order before reading current stock, prices or carriers.
    const existing = await existingCheckout()
    if (existing) return NextResponse.json(existing)
    await expireUnpaidOrders(new Date(), undefined, { productIds: [...requestedQuantities.keys()], couponCode })
    // Aggregate sizes/colors of the same product when checking stock.
    const failures: string[] = []
    const failureNames: string[] = []
    const failureDetails: { productId: string; name: string; availableQuantity: number }[] = []
    for (const [productId, quantity] of requestedQuantities) {
      const product = await prisma.product.findUnique({ where: { id: productId } })
      if (!product || product.stock < quantity) {
        failures.push(productId)
        failureNames.push(product?.name ?? 'محصول')
        failureDetails.push({ productId, name: product?.name ?? 'محصول', availableQuantity: product?.stock ?? 0 })
      }
    }
    if (failures.length) {
      throw new OrderError('متأسفیم، موجودی «' + failureNames.join('» و «') + '» در حال حاضر تمام شده یا برای تعداد انتخاب‌شده کافی نیست.', {
        status: 409, code: 'STOCK_UNAVAILABLE', outOfStock: failures, outOfStockDetails: failureDetails,
      })
    }

    const order = await prisma.$transaction(async (tx) => {
      const paymentMethod = await tx.paymentMethod.findUnique({ where: { id: paymentMethodId } })
      if (!paymentMethod?.isActive || !methodAvailability(paymentMethod).available) {
        throw new OrderError('این روش پرداخت در دسترس نیست؛ روش‌های پرداخت را دوباره دریافت کنید', {
          status: 409, code: 'PAYMENT_METHOD_UNAVAILABLE',
        })
      }
      const method = await tx.shippingMethod.findUnique({ where: { id: shippingMethodId } })
      if (!method?.isActive) {
        throw new OrderError('این روش ارسال دیگر در دسترس نیست؛ روش دیگری انتخاب کنید', {
          status: 409, code: 'SHIPPING_METHOD_UNAVAILABLE',
        })
      }

      let subtotal = 0
      let grossSubtotal = 0
      let itemCount = 0
      const now = new Date()
      const orderItemsData = []
      const products = new Map<string, Product>()
      for (const item of items) {
        // Ignore client prices and calculate both shipping and totals from database prices.
        let product = products.get(item.productId)
        if (!product) {
          const stored = await tx.product.findUnique({ where: { id: item.productId } })
          if (!stored) throw new OrderError('متأسفیم، یکی از محصولات سبد دیگر در دسترس نیست.', {
            status: 409, code: 'STOCK_UNAVAILABLE', outOfStock: [item.productId],
          })
          product = stored
          products.set(item.productId, stored)
        }
        if (!product.sizes.includes(item.size) ||
            (product.colors.length > 0 ? !product.colors.includes(item.color) : item.color !== '-')) {
          throw new OrderError(`سایز یا رنگ انتخاب‌شده برای «${product.name}» دیگر در دسترس نیست؛ سبد خرید را بازبینی کنید`, {
            status: 409, code: 'INVALID_PRODUCT_VARIANT',
            invalidVariants: [{ productId: item.productId, size: item.size, color: item.color }],
          })
        }
        if (!validMoney(product.price)) throw new OrderError('قیمت یکی از محصولات معتبر نیست')
        const pricing = productPricing(product, now)
        subtotal += pricing.effectivePrice * item.quantity
        grossSubtotal += pricing.originalPrice * item.quantity
        itemCount += item.quantity
        if (!validMoney(subtotal) || !validMoney(grossSubtotal) || !Number.isSafeInteger(itemCount)) {
          throw new OrderError('مبلغ سفارش از سقف مجاز بیشتر است')
        }
        orderItemsData.push({ ...item, productName: product.name, price: pricing.effectivePrice, originalPrice: pricing.originalPrice, couponDiscount: 0 })
      }

      const coupon = await quoteCoupon(tx, couponCode, session.user.id, subtotal, now)
      const shippingCost = calculateShippingCost(method, subtotal - coupon.discount, itemCount)
      const productPrices = [...products].map(([productId, product]) => ({ productId, price: productPricing(product, now).effectivePrice, originalPrice: product.price }))
      if (expectedSubtotal !== undefined && subtotal !== expectedSubtotal) {
        throw new OrderError('قیمت محصولات تغییر کرده است؛ مبلغ جدید را بازبینی و دوباره سفارش را ثبت کنید', {
          status: 409, code: 'ORDER_PRICES_CHANGED', shippingCost, productPrices,
        })
      }
      if (shippingCost !== expectedShippingCost) {
        throw new OrderError('هزینهٔ ارسال تغییر کرده است؛ مبلغ جدید را بازبینی و دوباره سفارش را ثبت کنید', {
          status: 409, code: 'SHIPPING_QUOTE_CHANGED', shippingCost, productPrices,
        })
      }
      if (body.expectedCouponDiscount !== undefined && body.expectedCouponDiscount !== coupon.discount) {
        throw new OrderError('مبلغ کد تخفیف تغییر کرده است؛ تخفیف و مبلغ نهایی را دوباره بررسی کنید', {
          status: 409, code: 'COUPON_QUOTE_CHANGED', couponDiscount: coupon.discount, shippingCost, productPrices,
        })
      }
      const total = subtotal - coupon.discount + shippingCost
      if (!validMoney(total)) throw new OrderError('مبلغ سفارش از سقف مجاز بیشتر است')
      const allocated = allocateDiscount(orderItemsData.map((item) => item.price * item.quantity), coupon.discount)
      orderItemsData.forEach((item, index) => { item.couponDiscount = allocated[index] })

      // Keep atomic stock protection; any failure rolls back the entire order.
      for (const [productId, quantity] of [...requestedQuantities].sort(([left], [right]) => left.localeCompare(right))) {
        const decremented = await tx.product.updateMany({
          where: { id: productId, stock: { gte: quantity } },
          data: { stock: { decrement: quantity } },
        })
        if (decremented.count === 0) {
          const current = await tx.product.findUnique({ where: { id: productId } })
          throw new OrderError('متأسفیم، موجودی یکی از محصولات در حین ثبت سفارش تمام شد یا برای تعداد انتخاب‌شده کافی نیست.', {
            status: 409, code: 'STOCK_UNAVAILABLE', outOfStock: [productId],
            outOfStockDetails: [{ productId, name: products.get(productId)?.name ?? 'محصول', availableQuantity: current?.stock ?? 0 }],
          })
        }
      }

      const created = await tx.order.create({
        data: {
          userId: session.user.id, total, address, phone, recipientName, checkoutKey, checkoutFingerprint,
          subtotal: grossSubtotal, productDiscount: grossSubtotal - subtotal,
          couponId: coupon.couponId, couponCode: coupon.code, couponDiscount: coupon.discount,
          shippingMethodId: method.id, shippingMethodName: method.name, shippingCost,
          paymentMethod: paymentMethod.id, paymentStatus: 'AWAITING_RECEIPT',
          paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
          paymentCardNumber: paymentMethod.cardNumber, paymentCardholderName: paymentMethod.cardholderName,
          paymentBankName: paymentMethod.bankName,
          items: { create: orderItemsData },
        },
        include: { items: true, invoice: { select: { id: true, issuedAt: true } } },
      })
      await reserveCoupon(tx, coupon, session.user.id, created.id, now)
      return created
    })
    return NextResponse.json(order, { status: 201 })
  } catch (error) {
    if (checkoutKey) {
      // A concurrent request may win the key after our first lookup. Recheck even
      // on stock/quote failure: the winning order may have used the last pair.
      try {
        const existing = await existingCheckout()
        if (existing) return NextResponse.json(existing)
      } catch (raceError) {
        if (raceError instanceof OrderError) {
          const { status = 400, ...details } = raceError.details
          return NextResponse.json({ error: raceError.message, ...details }, { status })
        }
      }
    }
    if (error instanceof OrderError) {
      const { status = 400, ...details } = error.details
      return NextResponse.json({ error: error.message, ...details }, { status })
    }
    if (error instanceof ShippingValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof CouponError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    // A method may be deleted after it was read but before the order's FK is written.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2003' &&
        'meta' in error && error.meta && typeof error.meta === 'object' && 'field_name' in error.meta &&
        typeof error.meta.field_name === 'string' && error.meta.field_name.includes('shippingMethodId')) {
      return NextResponse.json({ error: 'این روش ارسال دیگر در دسترس نیست؛ روش دیگری انتخاب کنید', code: 'SHIPPING_METHOD_UNAVAILABLE' }, { status: 409 })
    }
    return NextResponse.json({ error: 'خطا در ثبت سفارش' }, { status: 500 })
  }
}
