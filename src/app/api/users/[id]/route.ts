import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, optionalText, passwordField, readJsonObject, textField } from '@/lib/api-input'
import { serializableTransaction } from '@/lib/serializable-transaction'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const { id } = await params
    const body = await readJsonObject(request)
    if (body.role !== undefined && body.role !== 'USER' && body.role !== 'ADMIN') throw new ApiInputError('نقش نامعتبر است')
    const role = body.role as 'USER' | 'ADMIN' | undefined
    if (body.role !== undefined && session.user.id === id && body.role !== 'ADMIN') {
      throw new ApiInputError('نمیتوانید نقش خودتان را تغییر دهید')
    }
    const name = body.name === undefined ? undefined : textField(body.name, 'نام', 200)
    const phone = body.phone === undefined ? undefined : optionalText(body.phone, 'شماره تماس', 50)
    const hashed = body.newPassword === undefined || body.newPassword === '' ? undefined :
      await bcrypt.hash(passwordField(body.newPassword, 'رمز جدید'), 10)
    const update = {
      where: { id },
      data: {
        ...(role !== undefined && { role }),
        ...(name !== undefined && { name }), ...(phone !== undefined && { phone }),
        ...(hashed !== undefined && { password: hashed }),
      },
      select: { id: true, name: true, email: true, phone: true, role: true, _count: { select: { orders: true } } },
    } as const
    const user = body.role === undefined ? await prisma.user.update(update) : await serializableTransaction(async (tx) => {
      const actor = await tx.user.findUnique({ where: { id: session.user.id }, select: { role: true } })
      if (actor?.role !== 'ADMIN') throw new ApiInputError('دسترسی غیرمجاز', 401)
      const target = await tx.user.findUnique({ where: { id }, select: { role: true } })
      if (!target) throw new ApiInputError('کاربر یافت نشد', 404)
      if (body.role === 'USER' && target.role === 'ADMIN' && await tx.user.count({ where: { role: 'ADMIN' } }) <= 1) {
        throw new ApiInputError('حداقل یک مدیر باید در فروشگاه باقی بماند', 409)
      }
      return tx.user.update(update)
    })
    return NextResponse.json(user)
  } catch (error) {
    return apiError(error, 'خطا در ویرایش کاربر')
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const { id } = await params
    if (session.user.id === id) throw new ApiInputError('نمیتوانید حساب خودتان را حذف کنید')
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: { _count: { select: { orders: true } } } })
      if (!user) throw new ApiInputError('کاربر یافت نشد', 404)
      if (user.role === 'ADMIN') throw new ApiInputError('کاربران مدیر قابل حذف نیستند', 409)
      if (user._count.orders > 0) throw new ApiInputError('این کاربر سابقه سفارش دارد و برای حفظ سوابق فروش قابل حذف نیست', 409)
      await tx.user.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    return apiError(error, 'خطا در حذف کاربر')
  }
}
