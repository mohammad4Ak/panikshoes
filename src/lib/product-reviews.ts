import { prisma } from '@/lib/prisma'
import { ApiInputError, integerField } from '@/lib/api-input'

export function reviewInput(body: Record<string, unknown>) {
  const rating = integerField(body.rating, 'امتیاز', 1)
  if (rating > 5) throw new ApiInputError('امتیاز باید بین ۱ تا ۵ باشد')
  const comment = body.comment === undefined ? '' : body.comment
  if (typeof comment !== 'string' || comment.trim().length > 2000 || comment.includes('\u0000')) throw new ApiInputError('متن نظر باید حداکثر ۲۰۰۰ کاراکتر باشد')
  return { rating, comment: comment.trim() }
}

export async function findReviewProduct(idOrSlug: string) {
  return (await prisma.product.findUnique({ where: { id: idOrSlug }, select: { id: true } })) ?? prisma.product.findUnique({ where: { slug: idOrSlug }, select: { id: true } })
}

export function reviewPage(search: URLSearchParams) {
  const page = search.get('page') ?? '1'
  if (!/^[1-9][0-9]{0,5}$/.test(page)) throw new ApiInputError('شماره صفحه نامعتبر است')
  return Number(page)
}

export function summarizeRatings(groups: { rating: number; _count: { _all: number } }[]) {
  const distribution = [5, 4, 3, 2, 1].map(rating => ({ rating, count: groups.find(g => g.rating === rating)?._count._all ?? 0 }))
  const count = distribution.reduce((sum, item) => sum + item.count, 0)
  const total = distribution.reduce((sum, item) => sum + item.rating * item.count, 0)
  return { average: count ? total / count : 0, count, distribution }
}

export async function withProductRatings<T extends { id: string }>(products: T[]) {
  if (!products.length) return [] as (T & { ratingAverage: number; ratingCount: number })[]
  const groups = await prisma.productReview.groupBy({
    by: ['productId'], where: { productId: { in: products.map(p => p.id) }, status: 'APPROVED' },
    _avg: { rating: true }, _count: { _all: true },
  })
  const metrics = new Map(groups.map(g => [g.productId, g]))
  return products.map(product => ({ ...product, ratingAverage: metrics.get(product.id)?._avg.rating ?? 0, ratingCount: metrics.get(product.id)?._count._all ?? 0 }))
}
