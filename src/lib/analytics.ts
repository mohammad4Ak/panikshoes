import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Prisma } from '@prisma/client'
import { parseSalesRange, SALES_TIME_ZONE } from '@/lib/sales-report'

export const VISITOR_COOKIE = 'shop_visitor'
export const VISIT_WINDOW_MS = 30 * 60 * 1000
export const VISITOR_COOKIE_SECONDS = 365 * 24 * 60 * 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BOT = /bot\b|spider|crawler|headlesschrome|lighthouse|google-inspectiontool|facebookexternalhit|slackbot|discordbot|curl\b|wget\b|python-requests|httpclient|postmanruntime|uptimerobot/i
const globalSecrets = globalThis as unknown as { analyticsDevelopmentSecret?: string }

export class AnalyticsValidationError extends Error {}

function signingSecret(): string {
  const configured = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') throw new Error('Analytics signing secret unavailable')
  return globalSecrets.analyticsDevelopmentSecret ??= randomBytes(32).toString('hex')
}

function signature(id: string): string {
  return createHmac('sha256', signingSecret()).update('shop-visitor:' + id).digest('base64url')
}

export function signVisitor(id: string): string {
  if (!UUID.test(id)) throw new AnalyticsValidationError('شناسهٔ بازدید معتبر نیست.')
  return id + '.' + signature(id)
}

export function readVisitorCookie(cookieHeader: string | null): string | null {
  const cookies = (cookieHeader ?? '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(VISITOR_COOKIE + '='))
  if (cookies.length !== 1) return null
  const value = cookies[0].slice(VISITOR_COOKIE.length + 1)
  const [id, supplied, extra] = value.split('.')
  if (!UUID.test(id ?? '') || !supplied || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return null
  const expected = signature(id)
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? id : null
}

export function analyticsPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 600 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null
  const clean = value.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/'
  if (['/', '/products', '/about', '/contact', '/cart'].includes(clean)) return clean
  const match = /^\/products\/([^/]+)$/.exec(clean)
  if (!match) return null
  try {
    const slug = decodeURIComponent(match[1])
    if (!slug || slug.length > 160 || slug === '.' || slug === '..' || /[/\\\u0000-\u001f\u007f]/.test(slug)) return null
    return '/products/' + encodeURIComponent(slug)
  } catch { return null }
}

export function isHumanVisit(userAgent: string | null): boolean {
  return !!userAgent?.trim() && userAgent.length <= 1_024 && !BOT.test(userAgent)
}

export function reportedVisitIp(headers: Headers): string | null {
  // Next supplies the socket peer when this header is absent. With a reverse
  // proxy the first address is meaningful only if that proxy overwrites client
  // forwarding headers. Treat it as reported evidence, never visitor identity.
  const input = (headers.get('x-forwarded-for')?.split(',')[0] ?? headers.get('x-real-ip') ?? '').trim()
  if (!isIP(input)) return null
  return input.startsWith('::ffff:') && isIP(input.slice(7)) === 4 ? input.slice(7) : input
}

export function analyticsReferrer(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch { return null }
}

export interface VisitInput { eventId: string; pathname: string; referrer: string | null }

export function parseVisit(value: unknown): VisitInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AnalyticsValidationError('اطلاعات بازدید معتبر نیست.')
  const input = value as Record<string, unknown>
  const pathname = analyticsPath(input.pathname)
  if (typeof input.eventId !== 'string' || !UUID.test(input.eventId) || !pathname) throw new AnalyticsValidationError('اطلاعات بازدید معتبر نیست.')
  return { eventId: input.eventId.toLowerCase(), pathname, referrer: analyticsReferrer(input.referrer) }
}

export async function recordPageView(database: {
  $transaction: <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options: { isolationLevel: 'ReadCommitted' }) => Promise<T>
}, visit: VisitInput, visitorId: string, ipAddress: string | null, userAgent: string, now = new Date()): Promise<boolean> {
  try {
    return await database.$transaction(async (tx) => {
      // Rolling-window deduplication remains atomic across requests and server
      // processes. ReadCommitted ensures the waiter sees the preceding commit.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${visitorId + ':' + visit.pathname}, 0))`
      if (await tx.pageView.findUnique({ where: { id: visit.eventId }, select: { id: true } })) return false
      if (await tx.pageView.findFirst({
        where: { visitorId, pathname: visit.pathname, createdAt: { gt: new Date(now.getTime() - VISIT_WINDOW_MS) } },
        select: { id: true },
      })) return false
      let productId: string | null = null
      if (visit.pathname.startsWith('/products/')) {
        const product = await tx.product.findUnique({ where: { slug: decodeURIComponent(visit.pathname.slice('/products/'.length)) }, select: { id: true } })
        if (!product) return false
        productId = product.id
      }
      await tx.pageView.create({ data: {
        id: visit.eventId, visitorId, pathname: visit.pathname, ipAddress,
        userAgent: userAgent.slice(0, 512), referrer: visit.referrer, productId, createdAt: now,
      } })
      if (productId) await tx.product.update({ where: { id: productId }, data: { viewCount: { increment: 1 } } })
      return true
    }, { isolationLevel: 'ReadCommitted' })
  } catch (error) {
    // Reused event IDs across different paths also roll the transaction back.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return false
    throw error
  }
}

export function parseAnalyticsFilters(params: URLSearchParams, now = new Date()) {
  for (const key of params.keys()) {
    if (!['range', 'page'].includes(key) || params.getAll(key).length > 1) throw new AnalyticsValidationError('فیلتر گزارش معتبر نیست.')
  }
  const preset = params.get('range') ?? '30d'
  const page = params.get('page') ?? '1'
  if (!['7d', '30d', '90d'].includes(preset)) throw new AnalyticsValidationError('بازهٔ گزارش معتبر نیست.')
  if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) > 1_000_000) throw new AnalyticsValidationError('شمارهٔ صفحه معتبر نیست.')
  const range = parseSalesRange(new URLSearchParams({ range: preset }), now)
  const today = parseSalesRange(new URLSearchParams({ range: '7d' }), now).to
  const todayRange = parseSalesRange(new URLSearchParams({ range: 'custom', from: today, to: today }), now)
  return { range, todayStart: todayRange.start, todayEnd: todayRange.end, page: Number(page), pageSize: 25 }
}

export interface AnalyticsReport {
  range: { preset: string; from: string; to: string; days: number; timeZone: string }
  generatedAt: string
  firstTrackedAt: string | null
  summary: { totalViews: number; totalVisitors: number; todayViews: number; todayVisitors: number; rangeViews: number; rangeVisitors: number }
  trend: { date: string; label: string; views: number; visitors: number }[]
  topProducts: { productId: string; name: string; slug: string; views: number; totalViews: number }[]
  topPaths: { pathname: string; views: number }[]
  recent: { id: string; pathname: string; ipAddress: string | null; referrer: string | null; createdAt: string }[]
  pagination: { page: number; pageSize: number; total: number; pages: number }
}

type Count = number | bigint
const asNumber = (value: Count | null | undefined) => Number(value ?? 0)
const labelFormatter = new Intl.DateTimeFormat('fa-IR', { timeZone: SALES_TIME_ZONE, month: 'short', day: 'numeric' })

export async function readAnalyticsReport(tx: Prisma.TransactionClient, filters: ReturnType<typeof parseAnalyticsFilters>, now: Date): Promise<AnalyticsReport> {
  const { range, todayStart, todayEnd, pageSize } = filters
  const [summaryRows, daily, products, paths, total] = await Promise.all([
    tx.$queryRaw<{ totalViews: Count; totalVisitors: Count; todayViews: Count; todayVisitors: Count; rangeViews: Count; rangeVisitors: Count; firstTrackedAt: Date | null }[]>`
      SELECT COUNT(*) AS "totalViews", COUNT(DISTINCT "visitorId") AS "totalVisitors", MIN("createdAt") AS "firstTrackedAt",
        COUNT(*) FILTER (WHERE "createdAt" >= ${todayStart} AND "createdAt" < ${todayEnd}) AS "todayViews",
        COUNT(DISTINCT "visitorId") FILTER (WHERE "createdAt" >= ${todayStart} AND "createdAt" < ${todayEnd}) AS "todayVisitors",
        COUNT(*) FILTER (WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end}) AS "rangeViews",
        COUNT(DISTINCT "visitorId") FILTER (WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end}) AS "rangeVisitors"
      FROM "PageView"`,
    tx.$queryRaw<{ date: string; views: Count; visitors: Count }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${SALES_TIME_ZONE}, 'YYYY-MM-DD') AS "date",
        COUNT(*) AS "views", COUNT(DISTINCT "visitorId") AS "visitors"
      FROM "PageView" WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
      GROUP BY 1 ORDER BY 1`,
    tx.$queryRaw<{ productId: string; name: string; slug: string; views: Count; totalViews: number }[]>`
      SELECT p."id" AS "productId", p."name", p."slug", COUNT(*) AS "views", p."viewCount" AS "totalViews"
      FROM "PageView" v JOIN "Product" p ON p."id" = v."productId"
      WHERE v."createdAt" >= ${range.start} AND v."createdAt" < ${range.end}
      GROUP BY p."id", p."name", p."slug", p."viewCount"
      ORDER BY "views" DESC, p."id" ASC LIMIT 8`,
    tx.$queryRaw<{ pathname: string; views: Count }[]>`
      SELECT "pathname", COUNT(*) AS "views" FROM "PageView"
      WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
      GROUP BY "pathname" ORDER BY "views" DESC, "pathname" ASC LIMIT 8`,
    tx.pageView.count({ where: { createdAt: { gte: range.start, lt: range.end } } }),
  ])
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(filters.page, pages)
  const recentRows = await tx.pageView.findMany({
    where: { createdAt: { gte: range.start, lt: range.end } },
    select: { id: true, pathname: true, ipAddress: true, referrer: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
  })
  const summary = summaryRows[0]
  const dailyMap = new Map(daily.map((row) => [row.date, row]))
  const trend = Array.from({ length: range.days }, (_, index) => {
    const date = new Date(Date.parse(range.from + 'T12:00:00Z') + index * 86_400_000)
    const key = date.toISOString().slice(0, 10)
    const row = dailyMap.get(key)
    return { date: key, label: labelFormatter.format(date), views: asNumber(row?.views), visitors: asNumber(row?.visitors) }
  })
  return {
    range: { preset: range.preset, from: range.from, to: range.to, days: range.days, timeZone: SALES_TIME_ZONE },
    generatedAt: now.toISOString(), firstTrackedAt: summary?.firstTrackedAt?.toISOString() ?? null,
    summary: {
      totalViews: asNumber(summary?.totalViews), totalVisitors: asNumber(summary?.totalVisitors),
      todayViews: asNumber(summary?.todayViews), todayVisitors: asNumber(summary?.todayVisitors),
      rangeViews: asNumber(summary?.rangeViews), rangeVisitors: asNumber(summary?.rangeVisitors),
    },
    trend, topProducts: products.map((row) => ({ ...row, views: asNumber(row.views) })),
    topPaths: paths.map((row) => ({ ...row, views: asNumber(row.views) })),
    recent: recentRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    pagination: { page, pageSize, total, pages },
  }
}
