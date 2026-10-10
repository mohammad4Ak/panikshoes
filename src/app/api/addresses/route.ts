import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { apiError, booleanField, optionalText, readJsonObject, textField } from '@/lib/api-input'
import { addressTransaction } from '@/lib/address-transaction'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  const addresses = await prisma.address.findMany({
    where: { userId: session.user.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  })
  return NextResponse.json(addresses)
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    const address = textField(body.address, 'آدرس', 3000)
    const phone = textField(body.phone, 'شماره تماس', 50)
    const title = body.title === undefined ? null : optionalText(body.title, 'عنوان', 200)
    const requestedDefault = body.isDefault === undefined ? false : booleanField(body.isDefault, 'آدرس پیش‌فرض')
    const created = await addressTransaction(async (tx) => {
      const current = await tx.address.findFirst({ where: { userId: session.user.id, isDefault: true } })
      const makeDefault = requestedDefault || !current
      if (makeDefault) await tx.address.updateMany({ where: { userId: session.user.id }, data: { isDefault: false } })
      return tx.address.create({ data: { userId: session.user.id, title, address, phone, isDefault: makeDefault } })
    })
    return NextResponse.json(created, { status: 201 })
  } catch (error) { return apiError(error, 'خطا در ثبت آدرس') }
}
