import { NextResponse } from 'next/server'
import { ApiInputError, readJsonObject } from '@/lib/api-input'
import { auth } from '@/lib/auth'
import { isSameOriginRequest } from '@/lib/request-origin'
import { parseLoginSecuritySettings, readLoginSecuritySettings, saveLoginSecuritySettings } from '@/lib/login-security-settings'

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
    return await readJsonObject(new Request(request.url, { method: 'PATCH', body: Buffer.concat(chunks).toString('utf8') }))
  } catch (error) {
    if (error instanceof ApiInputError) throw error
    throw new ApiInputError('بدنهٔ درخواست باید JSON معتبر باشد.')
  } finally { reader.releaseLock() }
}

export async function GET() {
  try {
    const denied = await adminAccess()
    if (denied) return denied
    return NextResponse.json({ settings: await readLoginSecuritySettings() }, { headers })
  } catch {
    return NextResponse.json({ error: 'دریافت تنظیمات امنیت ورود انجام نشد.' }, { status: 500, headers })
  }
}

export async function PATCH(request: Request) {
  try {
    const denied = await adminAccess()
    if (denied) return denied
    if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
    const body = await readBody(request)
    const current = await readLoginSecuritySettings()
    const settings = parseLoginSecuritySettings(body, current)
    return NextResponse.json({ settings: await saveLoginSecuritySettings(settings) }, { headers })
  } catch (error) {
    return NextResponse.json({ error: error instanceof ApiInputError ? error.message : 'ذخیرهٔ تنظیمات امنیت ورود انجام نشد.' }, { status: error instanceof ApiInputError ? error.status : 500, headers })
  }
}
