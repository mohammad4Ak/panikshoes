import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, readJsonObject } from '@/lib/api-input'
import { productInput } from '@/lib/catalog-input'
import { withProductRatings } from '@/lib/product-reviews'
import { expireUnpaidOrders } from '@/lib/payments'

export async function GET(request: Request) {
  await expireUnpaidOrders()
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim()
  const categoryId = searchParams.get('categoryId')?.trim()
  const products = await prisma.product.findMany({
    where: {
      ...(q && { OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ] }),
      ...(categoryId && { categoryId }),
    },
    include: { category: true }, orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(await withProductRatings(products))
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const data = productInput(await readJsonObject(request), true)
    const category = await prisma.category.findUnique({ where: { id: data.categoryId } })
    if (!category) throw new ApiInputError('دسته بندی نامعتبر است')
    const product = await prisma.product.create({
      data: {
        ...data, name: data.name!, slug: data.slug!, description: data.description!,
        price: data.price!, images: data.images!, categoryId: category.id,
      },
      include: { category: true },
    })
    return NextResponse.json(product, { status: 201 })
  } catch (error) { return apiError(error, 'خطا در ایجاد محصول') }
}
