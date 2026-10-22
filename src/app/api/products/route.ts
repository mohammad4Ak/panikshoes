import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, readJsonObject } from '@/lib/api-input'
import { productInput } from '@/lib/catalog-input'
import { withProductRatings } from '@/lib/product-reviews'
import { expireUnpaidOrders } from '@/lib/payments'
import { productPricing } from '@/lib/pricing'
import { configureInventory, InventoryError, parseInventoryRows } from '@/lib/inventory'
import { productInventory } from '@/lib/inventory-contract'
import { isProductCodeConflict, normalizeProductCode } from '@/lib/product-code'

export async function GET(request: Request) {
  const session = await auth()
  await expireUnpaidOrders()
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim()
  const categoryId = searchParams.get('categoryId')?.trim()
  const products = await prisma.product.findMany({
    where: {
      ...(q && { OR: [
        { code: { contains: normalizeProductCode(q).replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ] }),
      ...(categoryId && { categoryId }),
    },
    include: { category: true, variants: true }, orderBy: { createdAt: 'desc' },
  })
  const now = new Date()
  return NextResponse.json((await withProductRatings(products)).map(product => ({ ...productInventory(product, session?.user?.role === 'ADMIN'), ...productPricing(product, now) })), { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const body = await readJsonObject(request)
    const data = productInput(body, true)
    if (body.stock !== undefined) throw new ApiInputError('موجودی را برای هر رنگ و سایز در جدول موجودی وارد کنید')
    const dimensions = { sizes: data.sizes ?? [], colors: data.colors ?? [] }
    const rows = parseInventoryRows(body.variants, dimensions.sizes, dimensions.colors)
    const category = await prisma.category.findUnique({ where: { id: data.categoryId } })
    if (!category) throw new ApiInputError('دسته بندی نامعتبر است')
    const product = await prisma.$transaction(async tx => {
      const created = await tx.product.create({
        data: {
          ...data, name: data.name!, slug: data.slug!, description: data.description!,
          price: data.price!, images: data.images!, categoryId: category.id,
        },
        include: { category: true, variants: true },
      })
      await configureInventory(tx, created.id, rows, 0, dimensions, { actorId: session.user.id, actorName: session.user.name || undefined, note: 'ثبت موجودی اولیه هنگام ایجاد محصول' })
      return tx.product.findUniqueOrThrow({ where: { id: created.id }, include: { category: true, variants: true } })
    })
    return NextResponse.json(product, { status: 201 })
  } catch (error) {
    if (isProductCodeConflict(error)) return NextResponse.json({ error: 'این کد محصول قبلاً استفاده شده است؛ کد دیگری وارد کنید', code: 'PRODUCT_CODE_EXISTS' }, { status: 409 })
    if (error instanceof InventoryError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    return apiError(error, 'خطا در ایجاد محصول')
  }
}
