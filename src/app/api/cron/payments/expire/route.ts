import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { expireUnpaidOrders } from '@/lib/payments'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret ?? ''}`
  if (!secret || secret.length < 32 || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
    return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 401 })
  }
  const expired = await expireUnpaidOrders()
  return NextResponse.json({ expired }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export const POST = GET
