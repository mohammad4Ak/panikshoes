import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, booleanField, optionalText, readJsonObject, textField } from '@/lib/api-input'
import { addressTransaction } from '@/lib/address-transaction'
import { customerPhoneField, customerPostalCodeField } from '@/lib/customer-contact-input'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  const addresses = await prisma.address.findMany({
    where: { userId: session.user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })
  return NextResponse.json(addresses, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    const address = textField(body.address, 'آدرس', 3000)
    const phone = customerPhoneField(body.phone)!
    const postalCode = body.postalCode === undefined ? null : customerPostalCodeField(body.postalCode, true)
    const title = body.title === undefined ? null : optionalText(body.title, 'عنوان', 200)
    const requestedDefault = body.isDefault === undefined ? false : booleanField(body.isDefault, 'آدرس پیش‌فرض')
    const created = await addressTransaction(async (tx) => {
      const existing = await tx.address.findMany({ where: { userId: session.user.id }, select: { id: true, isDefault: true } })
      if (existing.length >= 20) throw new ApiInputError('حداکثر ۲۰ نشانی می‌توانید ذخیره کنید؛ یکی از نشانی‌های قبلی را ویرایش یا حذف کنید', 409)
      const makeDefault = requestedDefault || !existing.some(row => row.isDefault)
      if (makeDefault) await tx.address.updateMany({ where: { userId: session.user.id }, data: { isDefault: false } })
      return tx.address.create({ data: { userId: session.user.id, title, address, phone, postalCode, isDefault: makeDefault } })
    })
    return NextResponse.json(created, { status: 201 })
  } catch (error) { return apiError(error, 'خطا در ثبت آدرس') }
}
