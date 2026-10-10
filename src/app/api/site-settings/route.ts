import { NextResponse } from 'next/server'
import { publicSiteSettings, readSiteSettings } from '@/lib/site-settings'

export async function GET() {
  try {
    return NextResponse.json(publicSiteSettings(await readSiteSettings()), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'دریافت تنظیمات سایت انجام نشد.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
