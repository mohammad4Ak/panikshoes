import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, integerField, readJsonObject } from '@/lib/api-input'
import { withProductRatings } from '@/lib/product-reviews'
import { productInput, productPricingSnapshot, validateProductSale } from '@/lib/catalog-input'
import { productPricing } from '@/lib/pricing'
import { configureInventory, InventoryError, parseInventoryRows } from '@/lib/inventory'
import { productInventory } from '@/lib/inventory-contract'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  const { id } = await params
  let decodedId = id
  try { decodedId = decodeURIComponent(id) } catch { /* Keep the original route parameter. */ }
  const product =
    (await prisma.product.findUnique({ where: { id: decodedId }, include: { category: true, variants: true } })) ??
    (await prisma.product.findFirst({ where: { slug: decodedId }, include: { category: true, variants: true } })) ??
    (await prisma.product.findFirst({ where: { slug: id }, include: { category: true, variants: true } }))
  if (!product) return NextResponse.json({ error: 'محصول یافت نشد' }, { status: 404 })
  return NextResponse.json({ ...productInventory((await withProductRatings([product]))[0], session?.user?.role === 'ADMIN'), ...productPricing(product) }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
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
    if (data.stock !== undefined) throw new ApiInputError('موجودی را برای هر رنگ و سایز در جدول موجودی وارد کنید')
    const existing = await prisma.product.findUnique({ where: { id } })
    if (!existing) throw new ApiInputError('محصول یافت نشد', 404)
    const guardPricing = ['price', 'salePrice', 'saleStartsAt', 'saleEndsAt'].some(key => key in data)
    const expectedPricing = guardPricing ? productPricingSnapshot(body.expectedPricing) : null
    const pricingConflict = () => NextResponse.json({ error: 'قیمت یا تخفیف محصول تغییر کرده است. فرم محصول را دوباره باز کنید.', code: 'PRODUCT_PRICE_CHANGED' }, { status: 409 })
    if (expectedPricing && (expectedPricing.price !== existing.price || expectedPricing.salePrice !== (existing.salePrice ?? null) ||
        expectedPricing.saleStartsAt?.getTime() !== existing.saleStartsAt?.getTime() || expectedPricing.saleEndsAt?.getTime() !== existing.saleEndsAt?.getTime())) return pricingConflict()
    validateProductSale(data, existing)
    const dimensions = { sizes: data.sizes ?? existing.sizes, colors: data.colors ?? existing.colors }
    const dimensionsChanged = JSON.stringify(dimensions.sizes) !== JSON.stringify(existing.sizes) || JSON.stringify(dimensions.colors) !== JSON.stringify(existing.colors)
    if (dimensionsChanged && body.variants === undefined) throw new ApiInputError('با تغییر رنگ یا سایز، جدول موجودی ترکیب‌ها را هم ثبت کنید')
    const rows = body.variants === undefined ? null : parseInventoryRows(body.variants, dimensions.sizes, dimensions.colors)
    const expectedVersion = rows ? integerField(body.expectedInventoryVersion, 'نسخهٔ قبلی موجودی') : null
    delete data.sizes
    delete data.colors
    if (data.categoryId !== undefined) {
      const category = await prisma.category.findUnique({ where: { id: data.categoryId } })
      if (!category) throw new ApiInputError('دسته بندی نامعتبر است')
    }
    // Keep the stock check in the write itself, including size-only edits whose
    // validation depends on the current inventory. A read-then-write is not enough.
    try {
      const product = await prisma.$transaction(async tx => {
        if (rows && expectedVersion !== null) await configureInventory(tx, id, rows, expectedVersion, dimensions)
        return tx.product.update({
          where: { id, ...expectedPricing }, data, include: { category: true, variants: true },
        })
      })
      return NextResponse.json(productInventory(product, true))
    } catch (error) {
      if (guardPricing && error && typeof error === 'object' && 'code' in error && error.code === 'P2025') return pricingConflict()
      throw error
    }
  } catch (error) {
    if (error instanceof InventoryError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    return apiError(error, 'خطا در ویرایش محصول')
  }
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
