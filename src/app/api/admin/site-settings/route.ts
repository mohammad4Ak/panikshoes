import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { isSameOriginRequest } from '@/lib/request-origin'
import { parseSiteSettings, readSiteSettings, SiteSettingsError } from '@/lib/site-settings'

const headers = { 'Cache-Control': 'private, no-store' }

async function adminAccess() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'ابتدا وارد حساب شوید.' }, { status: 401, headers })
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'دسترسی غیرمجاز' }, { status: 403, headers })
  return null
}

export async function GET() {
  const denied = await adminAccess()
  if (denied) return denied
  try { return NextResponse.json(await readSiteSettings(), { headers }) }
  catch { return NextResponse.json({ error: 'دریافت تنظیمات سایت انجام نشد.' }, { status: 500, headers }) }
}

export async function PATCH(request: Request) {
  const denied = await adminAccess()
  if (denied) return denied
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'درخواست غیرمجاز' }, { status: 403, headers })
  try {
    let body: unknown
    try { body = await request.json() } catch { throw new SiteSettingsError('اطلاعات تنظیمات باید JSON معتبر باشد.') }
    const { values, version } = parseSiteSettings(body)
    const settings = await prisma.$transaction(async (tx) => {
      if (values.homeHeroProductIds.length) {
        const products = await tx.product.findMany({ where: { id: { in: values.homeHeroProductIds } }, select: { id: true, images: true } })
        if (products.length !== values.homeHeroProductIds.length || products.some((product) => !product.images[0]?.trim())) {
          throw new SiteSettingsError('یکی از محصولات انتخاب‌شده حذف شده یا تصویر اصلی ندارد؛ انتخاب محصولات صفحهٔ اول را بررسی کنید.')
        }
      }
      const updated = await tx.siteSettings.updateMany({ where: { id: 1, version }, data: { ...values, version: { increment: 1 } } })
      if (updated.count !== 1) throw new SiteSettingsError('تنظیمات هم‌زمان تغییر کرده است؛ صفحه را تازه کنید و دوباره تلاش کنید.', 409)
      return readSiteSettings(tx)
    })
    revalidatePath('/', 'layout')
    return NextResponse.json(settings, { headers })
  } catch (error) {
    if (error instanceof SiteSettingsError) return NextResponse.json({ error: error.message }, { status: error.status, headers })
    return NextResponse.json({ error: 'ذخیره تنظیمات سایت انجام نشد.' }, { status: 500, headers })
  }
}
