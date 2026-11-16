import { NextResponse } from 'next/server'
import { ApiInputError } from '@/lib/api-input'
import { auth } from '@/lib/auth'
import { isSameOriginRequest } from '@/lib/request-origin'
import { readRegistrationSettings } from '@/lib/registration-settings'
import { parsePasswordResetSettings, passwordResetAdminSnapshot, readPasswordResetSettings, savePasswordResetSettings } from '@/lib/password-reset-settings'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

async function adminAccess() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز است.' }, { status: 403, headers })
  return null
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const maximum = 8 * 1024
  if (Number(request.headers.get('content-length')) > maximum) throw new ApiInputError('حجم درخواست بیش از حد مجاز است.', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximum) { await reader.cancel(); throw new ApiInputError('حجم درخواست بیش از حد مجاز است.', 413) }
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiInputError('تنظیمات بازیابی رمز نامعتبر است.')
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiInputError) throw error
    throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')
  } finally { reader.releaseLock() }
}

export async function GET() {
  try {
    const denied = await adminAccess()
    if (denied) return denied
    const [settings, delivery] = await Promise.all([readPasswordResetSettings(), readRegistrationSettings()])
    return NextResponse.json(passwordResetAdminSnapshot(settings, delivery), { headers })
  } catch {
    return NextResponse.json({ error: 'دریافت تنظیمات بازیابی رمز انجام نشد.' }, { status: 500, headers })
  }
}

export async function PATCH(request: Request) {
  try {
    const denied = await adminAccess()
    if (denied) return denied
    if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
    const body = await readBody(request)
    const [current, delivery] = await Promise.all([readPasswordResetSettings(), readRegistrationSettings()])
    const settings = parsePasswordResetSettings(body, current, delivery)
    return NextResponse.json(passwordResetAdminSnapshot(await savePasswordResetSettings(settings), delivery), { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof ApiInputError ? error.message : 'ذخیرهٔ تنظیمات بازیابی رمز انجام نشد.' }, { status: error instanceof ApiInputError ? error.status : 500, headers })
  }
}
