import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { apiError } from '@/lib/api-input'
import { readStockMovements } from '@/lib/warehouse'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  try { return NextResponse.json(await readStockMovements(prisma, new URL(request.url).searchParams), { headers }) }
  catch (error) { return apiError(error, 'دریافت تاریخچهٔ انبار انجام نشد.') }
}
