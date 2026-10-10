'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { initialSiteSettings, isSiteSettings, type SiteSettings } from '@/lib/site-settings-contract'

const SiteSettingsContext = createContext<SiteSettings>(initialSiteSettings)

export function SiteSettingsProvider({ settings, children }: { settings: SiteSettings; children: React.ReactNode }) {
  const pathname = usePathname()
  const [refreshed, setRefreshed] = useState(settings)
  // Persistent layouts don't render again on every client navigation. Refresh the
  // public projection on navigation/focus; a failed read keeps the rendered data.
  useEffect(() => {
    let disposed = false
    let request: AbortController | null = null
    let timeout: number | undefined
    const refresh = async () => {
      if (disposed || request || document.visibilityState === 'hidden') return
      const controller = new AbortController()
      request = controller
      timeout = window.setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch('/api/site-settings', { cache: 'no-store', credentials: 'omit', signal: controller.signal })
        if (!response.ok) return
        const next: unknown = await response.json()
        if (!disposed && !controller.signal.aborted && isSiteSettings(next)) {
          setRefreshed((current) => next.version >= current.version && next.version >= settings.version ? next : current)
        }
      } catch { /* The server-rendered settings remain usable offline. */ }
      finally {
        window.clearTimeout(timeout)
        if (request === controller) request = null
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      request?.abort()
      window.clearTimeout(timeout)
      window.removeEventListener('focus', refresh)
    }
  }, [pathname, settings.version])
  const current = settings.version > refreshed.version ? settings : refreshed
  useEffect(() => {
    // The initial palette is already rendered by the server. Keep persistent
    // layouts in sync after an admin save, navigation, or a focus refresh.
    document.documentElement.dataset.colorTheme = current.colorTheme
  }, [current.colorTheme])
  return <SiteSettingsContext.Provider value={current}>{children}</SiteSettingsContext.Provider>
}

export function useSiteSettings() {
  return useContext(SiteSettingsContext)
}
