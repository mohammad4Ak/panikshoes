import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isSameOriginRequest } from '@/lib/request-origin'
import {
  AnalyticsValidationError, isHumanVisit, parseVisit, readVisitorCookie,
  recordPageView, reportedVisitIp, signVisitor, VISITOR_COOKIE, VISITOR_COOKIE_SECONDS,
} from '@/lib/analytics'

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

class VisitBodyTooLarge extends Error {}

async function boundedVisitBody(request: Request): Promise<unknown> {
  const limit = 4_096
  const length = Number(request.headers.get('content-length'))
  if (length > limit) throw new VisitBodyTooLarge()
  if (!request.body) throw new AnalyticsValidationError()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new VisitBodyTooLarge() }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new AnalyticsValidationError() }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ accepted: false, ignored: true }, { status: 403, headers })
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return NextResponse.json({ accepted: false, ignored: true }, { status: 415, headers })
  if (request.headers.get('purpose') === 'prefetch' || request.headers.get('sec-purpose')?.includes('prefetch') || !isHumanVisit(request.headers.get('user-agent'))) {
    return NextResponse.json({ accepted: false, ignored: true }, { headers })
  }
  try {
    const visit = parseVisit(await boundedVisitBody(request))
    const visitorId = readVisitorCookie(request.headers.get('cookie'))
    if (!visitorId) {
      // Do not log before the browser proves it retained a server-issued cookie.
      // The tracker retries once with this same event ID after this response.
      const response = NextResponse.json({ accepted: false, ignored: true }, { status: 202, headers })
      response.cookies.set(VISITOR_COOKIE, signVisitor(randomUUID()), {
        httpOnly: true, sameSite: 'lax', secure: new URL(request.url).protocol === 'https:',
        path: '/', maxAge: VISITOR_COOKIE_SECONDS,
      })
      return response
    }
    const accepted = await recordPageView(prisma, visit, visitorId, reportedVisitIp(request.headers), request.headers.get('user-agent')!, new Date())
    return NextResponse.json({ accepted, ignored: !accepted }, { headers })
  } catch (error) {
    return NextResponse.json({ accepted: false, ignored: true }, { status: error instanceof VisitBodyTooLarge ? 413 : error instanceof AnalyticsValidationError ? 400 : 503, headers })
  }
}
