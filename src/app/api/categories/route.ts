import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { apiError, optionalText, readJsonObject, textField } from '@/lib/api-input'
import { imageField } from '@/lib/catalog-input'

export async function GET() {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { products: true } } }, orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json(categories)
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const body = await readJsonObject(request)
    const name = textField(body.name, 'نام دسته بندی', 200)
    const slug = body.slug === undefined ? null : optionalText(body.slug, 'شناسه دسته بندی', 300)
    const image = body.image === undefined ? null : optionalText(body.image, 'تصویر', 2048)
    const category = await prisma.category.create({
      data: { name, slug: slug || `cat-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`, image: image ? imageField(image) : null },
      include: { _count: { select: { products: true } } },
    })
    return NextResponse.json(category, { status: 201 })
  } catch (error) { return apiError(error, 'خطا در ایجاد دسته بندی') }
}
