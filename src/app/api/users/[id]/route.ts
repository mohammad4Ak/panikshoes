import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, booleanField, emailField, optionalText, passwordField, readJsonObject, textField } from '@/lib/api-input'
import { customerPhoneField, customerPostalCodeField } from '@/lib/customer-contact-input'
import { serializableTransaction } from '@/lib/serializable-transaction'

const userSelect = {
  id: true, name: true, email: true, phone: true, postalCode: true, role: true,
  loginPhone: true, emailVerifiedAt: true, phoneVerifiedAt: true,
  isActive: true, createdAt: true, updatedAt: true,
  _count: { select: { orders: true, addresses: true } },
} as const
const addressSelect = { id: true, title: true, address: true, phone: true, postalCode: true, isDefault: true, createdAt: true } as const

class AddressesChangedError extends ApiInputError {
  constructor() { super('نشانی‌های کاربر تغییر کرده‌اند؛ نشانی‌های تازه را دریافت و دوباره بررسی کنید', 409) }
}

function addressSnapshot(value: unknown): string {
  if (!Array.isArray(value) || value.length > 2000) throw new ApiInputError('اطلاعات اولیهٔ نشانی‌ها معتبر نیست؛ دوباره دریافت کنید')
  const rows = value.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiInputError('اطلاعات اولیهٔ نشانی‌ها معتبر نیست')
    const row = input as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id || typeof row.address !== 'string' || typeof row.phone !== 'string' ||
        typeof row.isDefault !== 'boolean' || (row.title != null && typeof row.title !== 'string') ||
        (row.postalCode != null && typeof row.postalCode !== 'string')) throw new ApiInputError('اطلاعات اولیهٔ نشانی‌ها معتبر نیست')
    return { id: row.id, title: row.title ?? null, address: row.address, phone: row.phone, postalCode: row.postalCode ?? null, isDefault: row.isDefault }
  }).sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify(rows)
}

function addressRows(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.length > limit) throw new ApiInputError('حداکثر ۲۰ نشانی قابل ثبت است؛ تعداد نشانی‌های قدیمی بیشتر از این سقف هم قابل افزایش نیست')
  const rows = value.map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiInputError('اطلاعات نشانی نامعتبر است')
    const row = input as Record<string, unknown>
    return {
      id: row.id === undefined ? undefined : textField(row.id, 'شناسهٔ نشانی', 200),
      title: row.title === undefined ? null : optionalText(row.title, 'عنوان نشانی', 200),
      address: textField(row.address, 'نشانی', 3000),
      phone: customerPhoneField(row.phone)!,
      postalCode: row.postalCode === undefined ? null : customerPostalCodeField(row.postalCode, true),
      isDefault: row.isDefault === undefined ? false : booleanField(row.isDefault, 'نشانی پیش‌فرض'),
    }
  })
  const ids = rows.flatMap(row => row.id ? [row.id] : [])
  if (new Set(ids).size !== ids.length) throw new ApiInputError('شناسهٔ نشانی تکراری است')
  if (rows.filter(row => row.isDefault).length > 1) throw new ApiInputError('فقط یک نشانی می‌تواند پیش‌فرض باشد')
  if (rows.length && !rows.some(row => row.isDefault)) rows[0].isDefault = true
  return rows
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  try {
    const { id } = await params
    const user = await prisma.user.findUnique({ where: { id }, select: {
      ...userSelect, addresses: { select: addressSelect, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
    } })
    if (!user) throw new ApiInputError('کاربر یافت نشد', 404)
    const [orders, payments] = await Promise.all([
      prisma.order.findMany({
        where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 100,
        select: {
          id: true, status: true, total: true, createdAt: true, paymentMethod: true, paymentStatus: true, verified: true,
          address: true, phone: true, postalCode: true, recipientName: true, shippingMethodName: true,
          trackingCode: true, trackingRecordedAt: true,
          invoice: { select: { id: true, issuedAt: true } },
          items: { select: { id: true, productName: true, quantity: true, size: true, color: true, price: true, product: { select: { id: true, name: true, code: true } } } },
          receipts: { orderBy: { createdAt: 'desc' }, take: 20, select: {
            id: true, status: true, createdAt: true, reviewNote: true, reviewedAt: true,
            payerCardLast4: true, transferReference: true, isLate: true,
          } },
        },
      }),
      prisma.order.aggregate({ where: { userId: id, verified: true }, _sum: { total: true } }),
    ])
    const isSelf = id === session.user.id
    return NextResponse.json({ user, orders, summary: { orderCount: user._count.orders, paidTotal: payments._sum.total ?? 0 }, isSelf, canManageRole: !isSelf }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error) { return apiError(error, 'خطا در دریافت جزئیات کاربر') }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  try {
    const { id } = await params
    const body = await readJsonObject(request)
    if (body.role !== undefined && body.role !== 'USER' && body.role !== 'ADMIN') throw new ApiInputError('نقش نامعتبر است')
    const role = body.role as 'USER' | 'ADMIN' | undefined
    const isActive = body.isActive === undefined ? undefined : booleanField(body.isActive, 'فعال‌بودن حساب')
    if (session.user.id === id && role !== undefined && role !== 'ADMIN') throw new ApiInputError('نمیتوانید نقش خودتان را تغییر دهید')
    if (session.user.id === id && isActive === false) throw new ApiInputError('نمی‌توانید حساب خودتان را مسدود کنید')
    const name = body.name === undefined ? undefined : textField(body.name, 'نام', 200)
    const email = body.email === undefined ? undefined : body.email === null || body.email === '' ? null : emailField(body.email)
    const phone = body.phone === undefined ? undefined : customerPhoneField(body.phone, true)
    const postalCode = body.postalCode === undefined ? undefined : customerPostalCodeField(body.postalCode, true)
    const expectedAddresses = body.addresses === undefined ? undefined : addressSnapshot(body.expectedAddresses)
    // Existing accounts may predate the limit. Administrators must still be able
    // to repair/reduce those address sets without increasing their old excess.
    const addressLimit = Array.isArray(body.expectedAddresses) ? Math.max(20, body.expectedAddresses.length) : 20
    const addresses = body.addresses === undefined ? undefined : addressRows(body.addresses, addressLimit)
    const hashed = body.newPassword === undefined || body.newPassword === '' ? undefined : await bcrypt.hash(passwordField(body.newPassword, 'رمز جدید'), 10)
    const user = await serializableTransaction(async tx => {
      // Recheck the actor inside the write transaction: another admin may have
      // blocked/demoted this session while the request was hashing a password.
      const actor = await tx.user.findUnique({ where: { id: session.user.id }, select: { role: true, isActive: true } })
      if (actor?.role !== 'ADMIN' || actor.isActive === false) throw new ApiInputError('دسترسی غیرمجاز', 401)
      const target = await tx.user.findUnique({ where: { id }, select: { role: true, isActive: true, email: true, loginPhone: true } })
      if (!target) throw new ApiInputError('کاربر یافت نشد', 404)
      if (email === null && !target.loginPhone) throw new ApiInputError('حساب بدون موبایل ورود باید ایمیل داشته باشد')
      const nextRole = role ?? target.role
      const nextActive = isActive ?? target.isActive
      if (target.role === 'ADMIN' && target.isActive !== false && (nextRole !== 'ADMIN' || nextActive === false) &&
          await tx.user.count({ where: { role: 'ADMIN', isActive: true } }) <= 1) {
        throw new ApiInputError('حداقل یک مدیر فعال باید در فروشگاه باقی بماند', 409)
      }
      if (email && await tx.user.findFirst({ where: { id: { not: id }, email: { equals: email, mode: 'insensitive' } }, select: { id: true } })) {
        throw new ApiInputError('این ایمیل قبلاً ثبت شده است', 409)
      }
      if (addresses !== undefined) {
        const existing = await tx.address.findMany({ where: { userId: id }, select: addressSelect })
        if (addressSnapshot(existing) !== expectedAddresses) throw new AddressesChangedError()
        const ownedIds = new Set(existing.map(row => row.id))
        if (addresses.some(row => row.id && !ownedIds.has(row.id))) throw new ApiInputError('نشانی متعلق به این کاربر نیست', 400)
        const kept = addresses.flatMap(row => row.id ? [row.id] : [])
        await tx.address.deleteMany({ where: { userId: id, ...(kept.length ? { id: { notIn: kept } } : {}) } })
        // Reset first to preserve the database's one-default-address constraint.
        await tx.address.updateMany({ where: { userId: id }, data: { isDefault: false } })
        for (const { id: addressId, ...data } of addresses) {
          if (addressId) await tx.address.update({ where: { id: addressId, userId: id }, data })
          else await tx.address.create({ data: { ...data, userId: id } })
        }
      }
      const revokeSessions = hashed !== undefined || (role !== undefined && role !== target.role) || (isActive !== undefined && isActive !== target.isActive)
      return tx.user.update({
        where: { id }, data: {
          ...(name !== undefined && { name }), ...(email !== undefined && { email }),
          ...(email !== undefined && email !== (target.email?.toLowerCase() ?? null) && { emailVerifiedAt: null }),
          ...(phone !== undefined && { phone }), ...(postalCode !== undefined && { postalCode }),
          ...(role !== undefined && { role }), ...(isActive !== undefined && { isActive }),
          ...(hashed !== undefined && { password: hashed }), ...(revokeSessions && { authVersion: { increment: 1 } }),
        }, select: userSelect,
      })
    })
    return NextResponse.json({ ...user, isSelf: user.id === session.user.id })
  } catch (error) {
    if (error instanceof AddressesChangedError) return NextResponse.json({ error: error.message, code: 'USER_ADDRESSES_CHANGED' }, { status: 409 })
    return apiError(error, 'خطا در ویرایش کاربر')
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  try {
    const { id } = await params
    if (session.user.id === id) throw new ApiInputError('نمیتوانید حساب خودتان را حذف کنید')
    await prisma.$transaction(async tx => {
      const user = await tx.user.findUnique({ where: { id }, include: { _count: { select: { orders: true } } } })
      if (!user) throw new ApiInputError('کاربر یافت نشد', 404)
      if (user.role === 'ADMIN') throw new ApiInputError('کاربران مدیر قابل حذف نیستند', 409)
      if (user._count.orders > 0) throw new ApiInputError('این کاربر سابقه سفارش دارد و برای حفظ سوابق فروش قابل حذف نیست؛ حساب را مسدود کنید', 409)
      await tx.user.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (error) { return apiError(error, 'خطا در حذف کاربر') }
}
