import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { AnalyticsValidationError, parseAnalyticsFilters, readAnalyticsReport } from '@/lib/analytics'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

export async function GET(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب خود شوید.' }, { status: 401, headers })
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
    const now = new Date()
    const filters = parseAnalyticsFilters(new URL(request.url).searchParams, now)
    const report = await prisma.$transaction((tx) => readAnalyticsReport(tx, filters, now), { isolationLevel: 'RepeatableRead' })
    return NextResponse.json(report, { headers })
  } catch (error) {
    if (error instanceof AnalyticsValidationError) return NextResponse.json({ error: error.message }, { status: 400, headers })
    return NextResponse.json({ error: 'دریافت آمار بازدید انجام نشد. دوباره تلاش کنید.' }, { status: 500, headers })
  }
}
