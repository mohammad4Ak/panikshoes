import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError } from '@/lib/api-input'
import { isSameOriginRequest } from '@/lib/request-origin'
import { MAX_SHIPMENT_FILE_BYTES, parseShipmentWorkbook } from '@/lib/shipment-import'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  try {
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('مرسوله‌ها')
    sheet.views = [{ rightToLeft: true }]
    sheet.columns = [{ header: 'تلفن گیرنده', key: 'phone', width: 22 }, { header: 'کدپستی گیرنده', key: 'postalCode', width: 22 }, { header: 'کد رهگیری', key: 'tracking', width: 38 }, { header: 'شماره سفارش (اختیاری)', key: 'order', width: 32 }]
    for (const column of sheet.columns) column.numFmt = '@'
    sheet.getRow(1).font = { bold: true }
    const buffer = await workbook.xlsx.writeBuffer()
    return new Response(new Uint8Array(buffer), { headers: { ...headers, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="shipment-template.xlsx"' } })
  } catch (error) { return apiError(error, 'ساخت فایل نمونه انجام نشد.') }
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست از مبدأ نامعتبر است.' }, { status: 403, headers })
  try {
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.startsWith('multipart/form-data;') || !request.body) throw new ApiInputError('فایل اکسل را انتخاب کنید.')
    const limit = MAX_SHIPMENT_FILE_BYTES + 64 * 1024
    const declaredSize = Number(request.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > limit) throw new ApiInputError('حجم فایل باید حداکثر ۴ مگابایت باشد.', 413)
    const reader = request.body.getReader(), chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) { await reader.cancel(); throw new ApiInputError('حجم فایل باید حداکثر ۴ مگابایت باشد.', 413) }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    let form: FormData
    try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData() }
    catch { throw new ApiInputError('فایل بارگذاری‌شده خوانده نشد.') }
    const files = form.getAll('file')
    if (files.length !== 1 || !(files[0] instanceof File) || !/\.xlsx$/i.test(files[0].name) || !files[0].size || files[0].size > MAX_SHIPMENT_FILE_BYTES) throw new ApiInputError('یک فایل xlsx با حداکثر حجم ۴ مگابایت انتخاب کنید.')
    const sheets = await parseShipmentWorkbook(Buffer.from(await files[0].arrayBuffer()))
    return NextResponse.json({ sheets }, { headers })
  } catch (error) { return apiError(error, 'خواندن فایل اکسل انجام نشد.') }
}
