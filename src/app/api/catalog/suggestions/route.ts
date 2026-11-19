import { NextResponse } from 'next/server'
import { CATALOG_SEARCH_MAX_LENGTH, catalogSearchCondition } from '@/lib/catalog-search'
import { prisma } from '@/lib/prisma'
import { productPricing, type PricingProduct } from '@/lib/pricing'

type SuggestionRow = PricingProduct & {
  id: string
  name: string
  slug: string
  image: string | null
  categoryName: string
}

const headers = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q') ?? ''
  if (query.length > CATALOG_SEARCH_MAX_LENGTH || query.includes('\0')) {
    return NextResponse.json({ error: 'عبارت جست‌وجو نامعتبر است.' }, { status: 400, headers })
  }
  if (query.trim().length < 2) return NextResponse.json([], { headers })

  try {
    const products = await prisma.$queryRaw<SuggestionRow[]>`
      SELECT p."id", p."name", p."slug", p."price", p."salePrice", p."saleStartsAt", p."saleEndsAt",
             NULLIF(btrim(p."images"[1]), '') AS "image", c."name" AS "categoryName"
      FROM "Product" p
      JOIN "Category" c ON c."id" = p."categoryId"
      WHERE ${catalogSearchCondition(query)}
      ORDER BY p."createdAt" DESC, p."id" ASC
      LIMIT 6
    `
    const now = new Date()
    return NextResponse.json(products.map(product => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      image: product.image,
      categoryName: product.categoryName,
      effectivePrice: productPricing(product, now).effectivePrice,
    })), { headers })
  } catch {
    return NextResponse.json({ error: 'جست‌وجوی محصولات انجام نشد.' }, { status: 500, headers })
  }
}
