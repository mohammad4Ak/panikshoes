import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { apiError, optionalText, readJsonObject, textField } from '@/lib/api-input'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  const user = await prisma.user.findUnique({
    where: { id: session.user.id }, select: { id: true, name: true, email: true, phone: true },
  })
  if (!user) return NextResponse.json({ error: 'کاربر یافت نشد' }, { status: 404 })
  return NextResponse.json(user)
}

export async function PATCH(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    const name = body.name === undefined ? undefined : textField(body.name, 'نام', 200)
    const phone = body.phone === undefined ? undefined : optionalText(body.phone, 'شماره تماس', 50)
    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: { ...(name !== undefined && { name }), ...(phone !== undefined && { phone }) },
      select: { id: true, name: true, email: true, phone: true },
    })
    return NextResponse.json(user)
  } catch (error) { return apiError(error, 'خطا در ویرایش حساب') }
}
