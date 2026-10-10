import './globals.css'
import './theme.css'
import type { Metadata } from 'next'
import { Vazirmatn } from 'next/font/google'
import Toaster from '@/components/ui/Toaster'
import SessionActivityProvider from '@/components/auth/SessionActivityProvider'
import { SiteSettingsProvider } from '@/components/layout/SiteSettingsProvider'
import { getSiteSettings, publicSiteSettings } from '@/lib/site-settings'

const vazir = Vazirmatn({
  subsets: ['arabic'],
  variable: '--font-vazir',
})

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings()
  return {
    title: { default: settings.seoTitle, template: `%s | ${settings.storeName}` },
    description: settings.seoDescription,
    applicationName: settings.storeName,
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const settings = publicSiteSettings(await getSiteSettings())
  return (
    <html lang="fa" dir="rtl" className={vazir.variable} data-scroll-behavior="smooth" data-color-theme={settings.colorTheme}>
      <body className="font-body">
        <SiteSettingsProvider settings={settings}>
          <SessionActivityProvider>
            {children}
            <Toaster />
          </SessionActivityProvider>
        </SiteSettingsProvider>
      </body>
    </html>
  )
}
