import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, readJsonObject } from '@/lib/api-input'
import { isSameOriginRequest } from '@/lib/request-origin'
import { findReviewProduct, reviewInput, reviewPage, summarizeRatings } from '@/lib/product-reviews'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
const contextProduct = async (params: Promise<{ id: string }>) => {
  const { id } = await params
  const product = await findReviewProduct(id)
  if (!product) throw new ApiInputError('محصول یافت نشد', 404)
  return product
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const product = await contextProduct(params)
    const page = reviewPage(new URL(request.url).searchParams)
    const pageSize = 10
    const session = await auth()
    const where = { productId: product.id, status: 'APPROVED' as const }
    const [reviews, groups, myReview] = await Promise.all([
      prisma.productReview.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
        select: { id: true, rating: true, comment: true, createdAt: true, user: { select: { name: true, orders: {
          where: { verified: true, status: { in: ['PROCESSING', 'SHIPPED', 'DELIVERED'] }, items: { some: { productId: product.id } } }, take: 1, select: { id: true },
        } } } },
      }),
      prisma.productReview.groupBy({ by: ['rating'], where, _count: { _all: true } }),
      session?.user?.id ? prisma.productReview.findUnique({ where: { productId_userId: { productId: product.id, userId: session.user.id } },
        select: { id: true, rating: true, comment: true, status: true, moderationNote: true, revision: true } }) : null,
    ])
    const summary = summarizeRatings(groups)
    return NextResponse.json({ reviews: reviews.map(review => ({ id: review.id, rating: review.rating, comment: review.comment,
      createdAt: review.createdAt, authorName: review.user.name.trim().split(/\s+/)[0] || 'کاربر فروشگاه', verifiedBuyer: review.user.orders.length > 0,
    })), total: summary.count, page, pageSize, summary, myReview }, { headers })
  } catch (error) { return apiError(error, 'دریافت نظرات انجام نشد؛ دوباره تلاش کنید') }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isSameOriginRequest(request)) throw new ApiInputError('درخواست نامعتبر است', 403)
    const session = await auth()
    if (!session?.user?.id) throw new ApiInputError('برای ثبت نظر وارد حساب خود شوید', 401)
    const product = await contextProduct(params)
    const data = reviewInput(await readJsonObject(request))
    const review = await prisma.productReview.upsert({
      where: { productId_userId: { productId: product.id, userId: session.user.id } },
      create: { productId: product.id, userId: session.user.id, ...data },
      update: { ...data, status: 'PENDING', moderationNote: null, reviewerId: null, reviewedAt: null, revision: { increment: 1 } },
      select: { id: true, rating: true, comment: true, status: true, revision: true },
    })
    return NextResponse.json({ review, message: 'امتیاز و نظر شما پس از تأیید ادمین نمایش داده می‌شود' }, { status: 200, headers })
  } catch (error) { return apiError(error, 'ثبت نظر انجام نشد؛ دوباره تلاش کنید') }
}
