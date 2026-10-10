import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, optionalText, readJsonObject, textField } from '@/lib/api-input'
import { imageField } from '@/lib/catalog-input'

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const { id } = await params
    const body = await readJsonObject(request)
    const name = body.name === undefined ? undefined : textField(body.name, 'نام دسته بندی', 200)
    const slug = body.slug === undefined ? undefined : textField(body.slug, 'شناسه دسته بندی', 300)
    const image = body.image === undefined ? undefined : optionalText(body.image, 'تصویر', 2048)
    const category = await prisma.category.update({
      where: { id },
      data: { ...(name !== undefined && { name }), ...(slug !== undefined && { slug }),
        ...(image !== undefined && { image: image ? imageField(image) : null }) },
      include: { _count: { select: { products: true } } },
    })
    return NextResponse.json(category)
  } catch (error) { return apiError(error, 'خطا در ویرایش دسته بندی') }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const { id } = await params
    await prisma.$transaction(async (tx) => {
      const category = await tx.category.findUnique({ where: { id }, include: { _count: { select: { products: true } } } })
      if (!category) throw new ApiInputError('دسته بندی یافت نشد', 404)
      if (category._count.products > 0) throw new ApiInputError('ابتدا محصولات این دسته بندی را حذف یا منتقل کنید', 409)
      await tx.category.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (error) { return apiError(error, 'خطا در حذف دسته بندی') }
}
