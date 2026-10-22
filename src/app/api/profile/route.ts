import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { apiError, readJsonObject, textField } from '@/lib/api-input'
import { customerPhoneField, customerPostalCodeField } from '@/lib/customer-contact-input'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  const user = await prisma.user.findUnique({
    where: { id: session.user.id }, select: { id: true, name: true, email: true, phone: true, postalCode: true },
  })
  if (!user) return NextResponse.json({ error: 'کاربر یافت نشد' }, { status: 404 })
  return NextResponse.json(user, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function PATCH(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    const name = body.name === undefined ? undefined : textField(body.name, 'نام', 200)
    const phone = body.phone === undefined ? undefined : customerPhoneField(body.phone, true)
    const postalCode = body.postalCode === undefined ? undefined : customerPostalCodeField(body.postalCode, true)
    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: { ...(name !== undefined && { name }), ...(phone !== undefined && { phone }), ...(postalCode !== undefined && { postalCode }) },
      select: { id: true, name: true, email: true, phone: true, postalCode: true },
    })
    return NextResponse.json(user)
  } catch (error) { return apiError(error, 'خطا در ویرایش حساب') }
}
