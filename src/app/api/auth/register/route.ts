import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { ApiInputError, apiError, emailField, passwordField, readJsonObject, textField } from '@/lib/api-input'

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request)
    const name = textField(body.name, 'نام', 200)
    const email = emailField(body.email)
    const password = passwordField(body.password)
    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
    if (existing) throw new ApiInputError('این ایمیل قبلاً ثبت شده است', 409)
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { name, email, password: hashed, role: 'USER' },
      select: { id: true, name: true, email: true },
    })
    return NextResponse.json(user, { status: 201 })
  } catch (error) {
    return apiError(error, 'خطا در ثبت حساب کاربری')
  }
}
