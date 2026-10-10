import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError } from '@/lib/api-input'
import { reviewPage } from '@/lib/product-reviews'
import type { Prisma, ReviewStatus } from '@prisma/client'
const headers = { 'Cache-Control': 'private, no-store' }
export async function GET(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) throw new ApiInputError('ابتدا وارد حساب خود شوید', 401)
    if (session.user.role !== 'ADMIN') throw new ApiInputError('دسترسی غیرمجاز', 403)
    const search = new URL(request.url).searchParams
    const status = search.get('status') ?? 'PENDING'
    if (!['ALL', 'PENDING', 'APPROVED', 'REJECTED'].includes(status)) throw new ApiInputError('فیلتر وضعیت نامعتبر است')
    const query = (search.get('q') ?? '').trim()
    if (query.length > 100) throw new ApiInputError('عبارت جستجو خیلی طولانی است')
    const page = reviewPage(search), pageSize = 20
    const where: Prisma.ProductReviewWhereInput = {
      ...(status !== 'ALL' ? { status: status as ReviewStatus } : {}),
      ...(query ? { OR: [{ comment: { contains: query, mode: 'insensitive' } }, { user: { name: { contains: query, mode: 'insensitive' } } }, { product: { name: { contains: query, mode: 'insensitive' } } }] } : {}),
    }
    const [reviews, total, pending] = await Promise.all([
      prisma.productReview.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
        select: { id: true, rating: true, comment: true, status: true, moderationNote: true, revision: true, createdAt: true, updatedAt: true,
          product: { select: { id: true, name: true, slug: true } }, user: { select: { name: true } } },
      }),
      prisma.productReview.count({ where }), prisma.productReview.count({ where: { status: 'PENDING' } }),
    ])
    return NextResponse.json({ reviews, total, pending, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }, { headers })
  } catch (error) { return apiError(error, 'دریافت نظرات برای بررسی انجام نشد') }
}
