import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, booleanField, optionalText, readJsonObject, textField } from '@/lib/api-input'
import { addressTransaction, ensureDefaultAddress } from '@/lib/address-transaction'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const { id } = await params
    const body = await readJsonObject(request)
    const title = body.title === undefined ? undefined : optionalText(body.title, 'عنوان', 200)
    const address = body.address === undefined ? undefined : textField(body.address, 'آدرس', 3000)
    const phone = body.phone === undefined ? undefined : textField(body.phone, 'شماره تماس', 50)
    const isDefault = body.isDefault === undefined ? undefined : booleanField(body.isDefault, 'آدرس پیش‌فرض')
    const updated = await addressTransaction(async (tx) => {
      const existing = await tx.address.findFirst({ where: { id, userId: session.user.id } })
      if (!existing) throw new ApiInputError('آدرس یافت نشد', 404)
      if (isDefault === true) await tx.address.updateMany({ where: { userId: session.user.id }, data: { isDefault: false } })
      await tx.address.update({
        where: { id, userId: session.user.id },
        data: { ...(title !== undefined && { title }), ...(address !== undefined && { address }),
          ...(phone !== undefined && { phone }), ...(isDefault !== undefined && { isDefault }) },
      })
      await ensureDefaultAddress(tx, session.user.id, isDefault === false ? id : undefined)
      return tx.address.findFirst({ where: { id, userId: session.user.id } })
    })
    return NextResponse.json(updated)
  } catch (error) { return apiError(error, 'خطا در ویرایش آدرس') }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const { id } = await params
    await addressTransaction(async (tx) => {
      const existing = await tx.address.findFirst({ where: { id, userId: session.user.id } })
      if (!existing) throw new ApiInputError('آدرس یافت نشد', 404)
      await tx.address.delete({ where: { id, userId: session.user.id } })
      await ensureDefaultAddress(tx, session.user.id)
    })
    return NextResponse.json({ success: true })
  } catch (error) { return apiError(error, 'خطا در حذف آدرس') }
}
