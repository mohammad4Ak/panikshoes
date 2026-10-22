import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, passwordField, readJsonObject } from '@/lib/api-input'

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد شوید' }, { status: 401 })
  try {
    const body = await readJsonObject(request)
    if (typeof body.currentPassword !== 'string' || !body.currentPassword) throw new ApiInputError('رمز فعلی الزامی است')
    const newPassword = passwordField(body.newPassword, 'رمز جدید')
    if (body.currentPassword === newPassword) throw new ApiInputError('رمز جدید نباید با رمز فعلی یکسان باشد')
    const user = await prisma.user.findUnique({ where: { id: session.user.id } })
    if (!user) throw new ApiInputError('کاربر یافت نشد', 404)
    if (!await bcrypt.compare(body.currentPassword, user.password)) throw new ApiInputError('رمز فعلی اشتباه است')
    const hashed = await bcrypt.hash(newPassword, 10)
    // A concurrent support reset must not be overwritten using the old secret.
    const updated = await prisma.user.updateMany({
      where: { id: user.id, password: user.password, isActive: true },
      data: { password: hashed, authVersion: { increment: 1 } },
    })
    if (updated.count !== 1) throw new ApiInputError('اطلاعات حساب تغییر کرده است؛ دوباره وارد شوید', 409)
    return NextResponse.json({ success: true })
  } catch (error) { return apiError(error, 'خطا در تغییر رمز عبور') }
}
