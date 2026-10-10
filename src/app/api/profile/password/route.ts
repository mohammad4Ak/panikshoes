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
    await prisma.user.update({ where: { id: user.id }, data: { password: hashed } })
    return NextResponse.json({ success: true })
  } catch (error) { return apiError(error, 'خطا در تغییر رمز عبور') }
}
