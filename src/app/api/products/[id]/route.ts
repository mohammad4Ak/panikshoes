import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, integerField, readJsonObject } from '@/lib/api-input'
import { withProductRatings } from '@/lib/product-reviews'
import { productInput, productPricingSnapshot, validateProductSale, validateStockedSizes } from '@/lib/catalog-input'
import { productPricing } from '@/lib/pricing'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let decodedId = id
  try { decodedId = decodeURIComponent(id) } catch { /* Keep the original route parameter. */ }
  const product =
    (await prisma.product.findUnique({ where: { id: decodedId }, include: { category: true } })) ??
    (await prisma.product.findFirst({ where: { slug: decodedId }, include: { category: true } })) ??
    (await prisma.product.findFirst({ where: { slug: id }, include: { category: true } }))
  if (!product) return NextResponse.json({ error: 'محصول یافت نشد' }, { status: 404 })
  return NextResponse.json({ ...(await withProductRatings([product]))[0], ...productPricing(product) })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const { id } = await params
    const body = await readJsonObject(request)
    const data = productInput(body)
    // Absolute inventory edits must be based on the count the administrator saw.
    // Otherwise a checkout between opening and saving the form can be undone.
    const expectedStock = data.stock === undefined ? undefined : integerField(body.expectedStock, 'موجودی قبلی')
    const existing = await prisma.product.findUnique({ where: { id } })
    if (!existing) throw new ApiInputError('محصول یافت نشد', 404)
    const guardPricing = ['price', 'salePrice', 'saleStartsAt', 'saleEndsAt'].some(key => key in data)
    const expectedPricing = guardPricing ? productPricingSnapshot(body.expectedPricing) : null
    const pricingConflict = () => NextResponse.json({ error: 'قیمت یا تخفیف محصول تغییر کرده است. فرم محصول را دوباره باز کنید.', code: 'PRODUCT_PRICE_CHANGED' }, { status: 409 })
    if (expectedPricing && (expectedPricing.price !== existing.price || expectedPricing.salePrice !== (existing.salePrice ?? null) ||
        expectedPricing.saleStartsAt?.getTime() !== existing.saleStartsAt?.getTime() || expectedPricing.saleEndsAt?.getTime() !== existing.saleEndsAt?.getTime())) return pricingConflict()
    validateProductSale(data, existing)
    const stockConflict = () => NextResponse.json({
      error: 'موجودی محصول تغییر کرده است. موجودی تازه را بارگذاری و عدد مورد نظر را دوباره بررسی کنید.',
      code: 'PRODUCT_STOCK_CHANGED',
    }, { status: 409 })
    if (expectedStock !== undefined && expectedStock !== existing.stock) return stockConflict()
    validateStockedSizes(data.stock ?? existing.stock, data.sizes ?? existing.sizes)
    if (data.categoryId !== undefined) {
      const category = await prisma.category.findUnique({ where: { id: data.categoryId } })
      if (!category) throw new ApiInputError('دسته بندی نامعتبر است')
    }
    // Keep the stock check in the write itself, including size-only edits whose
    // validation depends on the current inventory. A read-then-write is not enough.
    const guardStock = data.stock !== undefined || data.sizes !== undefined
    try {
      const product = await prisma.product.update({
        where: { id, ...(guardStock && { stock: existing.stock }), ...expectedPricing }, data, include: { category: true },
      })
      return NextResponse.json(product)
    } catch (error) {
      if ((guardStock || guardPricing) && error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        const latest = await prisma.product.findUnique({ where: { id } })
        if (guardStock && latest?.stock !== existing.stock) return stockConflict()
        return guardPricing ? pricingConflict() : stockConflict()
      }
      throw error
    }
  } catch (error) { return apiError(error, 'خطا در ویرایش محصول') }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const { id } = await params
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id }, include: { _count: { select: { orderItems: true } } } })
      if (!product) throw new ApiInputError('محصول یافت نشد', 404)
      if (product._count.orderItems > 0) throw new ApiInputError('این محصول سابقه سفارش دارد و برای حفظ سوابق فروش قابل حذف نیست', 409)
      await tx.product.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (error) { return apiError(error, 'خطا در حذف محصول') }
}
