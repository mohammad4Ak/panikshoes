import { NextResponse } from 'next/server'

export class ApiInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ApiInputError('بدنه درخواست باید JSON معتبر باشد')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiInputError('اطلاعات درخواست نامعتبر است')
  }
  return body as Record<string, unknown>
}

export function textField(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new ApiInputError(`${label} نامعتبر است`)
  }
  return value.trim()
}

export function optionalText(value: unknown, label: string, maxLength = 500): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new ApiInputError(`${label} نامعتبر است`)
  }
  return value.trim() || null
}

export function emailField(value: unknown): string {
  const email = textField(value, 'ایمیل', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiInputError('ایمیل نامعتبر است')
  return email
}

export function passwordField(value: unknown, label = 'رمز عبور'): string {
  // bcrypt only uses the first 72 UTF-8 bytes. Reject longer passwords instead of
  // silently treating two distinct passwords as the same credential.
  if (typeof value !== 'string' || value.length < 6 || Buffer.byteLength(value, 'utf8') > 72) {
    throw new ApiInputError(`${label} باید حداقل ۶ کاراکتر و حداکثر ۷۲ بایت باشد`)
  }
  return value
}

export function integerField(value: unknown, label: string, minimum = 0): number {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^\d+$/.test(value.trim()))) {
    throw new ApiInputError(`${label} باید عدد صحیح باشد`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > 2_147_483_647) {
    throw new ApiInputError(`${label} نامعتبر است`)
  }
  return number
}

export function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ApiInputError(`${label} نامعتبر است`)
  return value
}

export function apiError(error: unknown, fallback: string) {
  if (error instanceof ApiInputError) return NextResponse.json({ error: error.message }, { status: error.status })
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'P2002') return NextResponse.json({ error: 'این مقدار قبلاً ثبت شده است' }, { status: 409 })
  if (code === 'P2025') return NextResponse.json({ error: 'مورد یافت نشد' }, { status: 404 })
  if (code === 'P2003') return NextResponse.json({ error: 'این مورد در سوابق فروش استفاده شده و قابل حذف نیست' }, { status: 409 })
  if (code === 'P2034') return NextResponse.json({ error: 'درخواست هم‌زمان دیگری ثبت شد؛ دوباره تلاش کنید' }, { status: 409 })
  return NextResponse.json({ error: fallback }, { status: 500 })
}
