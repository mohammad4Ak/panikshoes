import { NextResponse } from 'next/server'
import { ApiInputError, readJsonObject } from '@/lib/api-input'
import { auth } from '@/lib/auth'
import { isSameOriginRequest } from '@/lib/request-origin'
import { parseRegistrationSettings, readRegistrationSettings, registrationAdminSnapshot, saveRegistrationSettings } from '@/lib/registration-settings'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

async function adminAccess() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز است.' }, { status: 403, headers })
  return null
}

export async function GET() {
  const denied = await adminAccess()
  if (denied) return denied

  try {
    return NextResponse.json(registrationAdminSnapshot(await readRegistrationSettings()), { headers })
  } catch {
    return NextResponse.json({ error: 'دریافت تنظیمات ثبت‌نام انجام نشد.' }, { status: 500, headers })
  }
}

export async function PATCH(request: Request) {
  const denied = await adminAccess()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })

  try {
    const settings = parseRegistrationSettings(await readJsonObject(request))
    return NextResponse.json(registrationAdminSnapshot(await saveRegistrationSettings(settings)), { headers })
  } catch (error) {
    if (error instanceof ApiInputError) return NextResponse.json({ error: error.message }, { status: error.status, headers })
    return NextResponse.json({ error: 'ذخیره تنظیمات ثبت‌نام انجام نشد.' }, { status: 500, headers })
  }
}
