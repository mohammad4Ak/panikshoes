import { handlers } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { getRequestOrigin } from '@/lib/request-origin'

function developmentRequest(request: NextRequest) {
  // Next constructs its dev request URL from the server hostname. Auth callbacks
  // must use the address actually opened by the browser (localhost or LAN IP).
  if (process.env.NODE_ENV !== 'development') return request
  const url = new URL(request.url)
  const origin = getRequestOrigin(request)
  return new NextRequest(`${origin}${url.pathname}${url.search}`, request)
}

export async function GET(request: NextRequest) {
  let corrected: NextRequest
  try { corrected = developmentRequest(request) }
  catch { return NextResponse.json({ error: 'آدرس درخواست معتبر نیست' }, { status: 400 }) }
  return handlers.GET(corrected)
}

export async function POST(request: NextRequest) {
  let corrected: NextRequest
  try { corrected = developmentRequest(request) }
  catch { return NextResponse.json({ error: 'آدرس درخواست معتبر نیست' }, { status: 400 }) }
  return handlers.POST(corrected)
}
