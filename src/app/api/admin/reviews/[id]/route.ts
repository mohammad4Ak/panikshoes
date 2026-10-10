import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ApiInputError, apiError, integerField, optionalText, readJsonObject } from '@/lib/api-input'
import { isSameOriginRequest } from '@/lib/request-origin'
const headers = { 'Cache-Control': 'private, no-store' }
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isSameOriginRequest(request)) throw new ApiInputError('درخواست نامعتبر است', 403)
    const session = await auth()
    if (!session?.user?.id) throw new ApiInputError('ابتدا وارد حساب خود شوید', 401)
    if (session.user.role !== 'ADMIN') throw new ApiInputError('دسترسی غیرمجاز', 403)
    const { id } = await params, body = await readJsonObject(request)
    if (body.action !== 'approve' && body.action !== 'reject') throw new ApiInputError('عملیات بررسی نامعتبر است')
    const revision = integerField(body.expectedRevision, 'نسخه نظر', 1)
    const note = optionalText(body.note ?? '', 'یادداشت بررسی', 500)
    if (note?.includes('\u0000')) throw new ApiInputError('یادداشت بررسی نامعتبر است')
    const result = await prisma.productReview.updateMany({ where: { id, revision }, data: {
      status: body.action === 'approve' ? 'APPROVED' : 'REJECTED', moderationNote: note,
      reviewerId: session.user.id, reviewedAt: new Date(), revision: { increment: 1 },
    } })
    if (!result.count) {
      const exists = await prisma.productReview.findUnique({ where: { id }, select: { id: true } })
      if (!exists) throw new ApiInputError('نظر یافت نشد', 404)
      return NextResponse.json({ error: 'نظر بعد از باز شدن صفحه تغییر کرده است؛ نسخه تازه را بررسی کنید', code: 'REVIEW_CHANGED' }, { status: 409, headers })
    }
    return NextResponse.json({ success: true }, { headers })
  } catch (error) { return apiError(error, 'ثبت نتیجه بررسی انجام نشد') }
}
