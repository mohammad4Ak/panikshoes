'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

let queue = Promise.resolve()

function newEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // randomUUID needs HTTPS; getRandomValues also works on local HTTP/LAN.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

// Requests are serialized so the first response installs the HttpOnly visitor
// cookie before later route changes send another event. No auth/session writes.
function enqueueVisit(pathname: string) {
  const eventId = newEventId()
  let referrer: string | null = null
  try { if (document.referrer) referrer = new URL(document.referrer).origin } catch {}
  const body = JSON.stringify({ eventId, pathname, referrer })
  queue = queue.catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('/api/analytics/page-view', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body, credentials: 'same-origin', cache: 'no-store', keepalive: true,
        })
        if (response.status !== 202) break
      } catch { break }
    }
  })
}

export default function VisitTracker() {
  const pathname = usePathname()
  useEffect(() => {
    if (!pathname || !/^\/(?:products(?:\/[^/]+)?|about|contact|cart)?\/?$/.test(pathname)) return
    let recorded = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => {
      if (document.visibilityState !== 'visible' || recorded || timer !== undefined) return
      // Cancelling the first development StrictMode effect avoids sending twice.
      timer = setTimeout(() => {
        timer = undefined
        if (!recorded && document.visibilityState === 'visible') {
          recorded = true
          enqueueVisit(pathname)
        }
      }, 300)
    }
    visible()
    document.addEventListener('visibilitychange', visible)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [pathname])
  return null
}
