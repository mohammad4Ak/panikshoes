'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { Session } from 'next-auth'
import { createSessionActivity } from '@/lib/session-activity'
import { requestSession } from '@/lib/session-client'

const SESSION_SIGNAL = 'shoeland:session-changed'
const SessionContext = createContext<{
  session: Session | null
  refresh: () => Promise<Session | null>
}>({ session: null, refresh: () => requestSession() })

export function useAppSession() { return useContext(SessionContext) }

export default function SessionActivityProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const controller = useRef<ReturnType<typeof createSessionActivity> | null>(null)
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    let userId: string | undefined
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('next-auth') : null
    const broadcast = () => {
      channel?.postMessage({ event: 'session' })
      try { localStorage.setItem(SESSION_SIGNAL, `${Date.now()}-${Math.random()}`) } catch {}
    }
    const monitor = createSessionActivity({
      read: () => requestSession(),
      renew: async () => {
        const next = await requestSession(true)
        broadcast()
        return next
      },
      onSession: (next) => {
        setSession(next)
        if (userId !== next?.user.id) broadcast()
        userId = next?.user.id
      },
      // A null server response has already invalidated the cookie. Refresh
      // protected pages so their existing auth guards take the user to login.
      onExpired: () => router.refresh(),
      now: Date.now,
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: (timer) => window.clearTimeout(timer),
    })
    controller.current = monitor
    const check = () => { void monitor.refresh().catch(() => {}) }
    const onActivity = (event: Event) => {
      if (event.isTrusted && document.visibilityState === 'visible') monitor.activity()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    const onStorage = (event: StorageEvent) => { if (event.key === SESSION_SIGNAL) check() }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove']
    for (const event of events) window.addEventListener(event, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    window.addEventListener('storage', onStorage)
    channel?.addEventListener('message', check)
    check()
    return () => {
      monitor.dispose()
      controller.current = null
      for (const event of events) window.removeEventListener(event, onActivity)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
      window.removeEventListener('storage', onStorage)
      channel?.close()
    }
  }, [router])

  // Login and registration navigate without remounting the root layout.
  useEffect(() => { void controller.current?.refresh().catch(() => {}) }, [pathname])
  const refresh = useCallback(() => controller.current?.refresh() ?? requestSession(), [])

  return <SessionContext.Provider value={{ session, refresh }}>{children}</SessionContext.Provider>
}
