import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, booleanField, emailField, passwordField, readJsonObject, textField } from '@/lib/api-input'
import { customerPhoneField, customerPostalCodeField } from '@/lib/customer-contact-input'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, loginPhone: true, phone: true, postalCode: true, role: true, isActive: true, createdAt: true, updatedAt: true, _count: { select: { orders: true, addresses: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(users.map(user => ({ ...user, isSelf: user.id === session.user.id })), { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  try {
    const body = await readJsonObject(request)
    const name = textField(body.name, 'نام', 200)
    const email = emailField(body.email)
    const password = passwordField(body.password)
    const phone = body.phone === undefined ? null : customerPhoneField(body.phone, true)
    const postalCode = body.postalCode === undefined ? null : customerPostalCodeField(body.postalCode, true)
    const isActive = body.isActive === undefined ? true : booleanField(body.isActive, 'فعال‌بودن حساب')
    if (body.role !== undefined && body.role !== 'USER' && body.role !== 'ADMIN') throw new ApiInputError('نقش نامعتبر است')
    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
    if (existing) throw new ApiInputError('این ایمیل قبلاً ثبت شده است', 409)
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { name, email, password: hashed, phone, postalCode, isActive, role: body.role === 'ADMIN' ? 'ADMIN' : 'USER' },
      select: { id: true, name: true, email: true, phone: true, postalCode: true, role: true, isActive: true, createdAt: true, updatedAt: true, _count: { select: { orders: true, addresses: true } } },
    })
    return NextResponse.json(user, { status: 201 })
  } catch (error) {
    return apiError(error, 'خطا در ایجاد کاربر')
  }
}
