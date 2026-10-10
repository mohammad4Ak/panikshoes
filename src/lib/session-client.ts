import type { Session } from 'next-auth'

let requestQueue: Promise<unknown> = Promise.resolve()

export function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(() => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('shoeland-session', operation)
    }
    return operation()
  })
  requestQueue = result.catch(() => {})
  return result
}

// Session reads also set an AuthJS cookie. Serialize them with renewals so an
// older read cannot overwrite a freshly renewed cookie, including across tabs.
export function requestSession(activity = false): Promise<Session | null> {
  const request = async () => {
    let options: RequestInit = { cache: 'no-store' }
    if (activity) {
      const csrfResponse = await fetch('/api/auth/csrf', { cache: 'no-store' })
      if (!csrfResponse.ok) throw new Error('Session check failed')
      const { csrfToken } = await csrfResponse.json()
      if (typeof csrfToken !== 'string' || !csrfToken) throw new Error('Session check failed')
      options = {
        ...options,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken, data: { activity: true } }),
      }
    }
    const response = await fetch('/api/auth/session', options)
    if (!response.ok) throw new Error('Session check failed')
    const session = await response.json()
    if (!session?.user) return null
    if (typeof session.expires !== 'string' || !Number.isFinite(Date.parse(session.expires))) {
      throw new Error('Session check failed')
    }
    // Use the server's remaining idle time; a wrong system clock must neither
    // log users out early nor cause repeated reads of a valid server session.
    if (typeof session.serverTime === 'number' && Number.isFinite(session.serverTime)) {
      session.expires = new Date(Date.now() + Date.parse(session.expires) - session.serverTime).toISOString()
    }
    return session as Session
  }
  return withSessionLock(request)
}
