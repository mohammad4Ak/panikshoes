import type { Session } from 'next-auth'
import { SESSION_ACTIVITY_SYNC_MS, SESSION_IDLE_TIMEOUT_MS } from './session-policy'

type ActivityOptions = {
  read: () => Promise<Session | null>
  renew: () => Promise<Session | null>
  onSession: (session: Session | null) => void
  onExpired: () => void
  now: () => number
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel: (timer: ReturnType<typeof setTimeout>) => void
}

export function createSessionActivity(options: ActivityOptions) {
  let session: Session | null = null
  let stopped = false
  let pendingActivity = false
  let lastSync = 0
  let retryAfter = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let activityTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<Session | null> | undefined

  function scheduleExpiry(delay: number) {
    if (expiryTimer !== undefined) options.cancel(expiryTimer)
    expiryTimer = options.schedule(() => { void refresh().catch(() => {}) }, Math.max(100, delay))
  }

  function scheduleActivity() {
    if (stopped || !session || !pendingActivity || inFlight || activityTimer !== undefined) return
    const untilExpiry = Date.parse(session.expires) - options.now()
    // Flush recent input before the signed server deadline, even near expiry.
    const delay = Math.max(0, retryAfter - options.now(), Math.min(lastSync + SESSION_ACTIVITY_SYNC_MS - options.now(), untilExpiry - 1000))
    activityTimer = options.schedule(() => {
      activityTimer = undefined
      if (stopped || !session || !pendingActivity) return
      if (inFlight) return
      if (options.now() >= Date.parse(session.expires)) {
        pendingActivity = false
        void refresh().catch(() => {})
        return
      }
      pendingActivity = false
      lastSync = options.now()
      void run(true).catch(() => {
        if (!stopped && session) pendingActivity = true
      }).finally(scheduleActivity)
    }, delay)
  }

  function run(activity: boolean): Promise<Session | null> {
    if (stopped) return Promise.resolve(null)
    if (inFlight) return inFlight
    if (options.now() < retryAfter) return Promise.reject(new Error('Session check is waiting to retry'))
    inFlight = (activity ? options.renew() : options.read()).then((next) => {
      if (stopped) return next
      const previous = session
      session = next
      retryAfter = 0
      options.onSession(next)
      if (next) {
        lastSync = Date.parse(next.expires) - SESSION_IDLE_TIMEOUT_MS
        scheduleExpiry(Date.parse(next.expires) - options.now())
      } else {
        pendingActivity = false
        if (expiryTimer !== undefined) options.cancel(expiryTimer)
        if (activityTimer !== undefined) options.cancel(activityTimer)
        expiryTimer = activityTimer = undefined
        if (previous) options.onExpired()
      }
      return next
    }).catch((error) => {
      // A temporary network failure is not evidence that the user logged out.
      // The server still enforces expiry while we retry the read.
      if (!stopped) {
        retryAfter = options.now() + 10_000
        scheduleExpiry(10_000)
      }
      throw error
    }).finally(() => {
      inFlight = undefined
      scheduleActivity()
    })
    return inFlight
  }

  function refresh() { return run(false) }

  function activity() {
    if (stopped || !session) return
    if (options.now() >= Date.parse(session.expires)) {
      // Sleeping tabs must recheck the shared cookie before any renewal. An
      // already expired session can never be revived by a new mouse movement.
      void refresh().then((next) => { if (next) activity() }).catch(() => {})
      return
    }
    pendingActivity = true
    scheduleActivity()
  }

  function dispose() {
    stopped = true
    if (expiryTimer !== undefined) options.cancel(expiryTimer)
    if (activityTimer !== undefined) options.cancel(activityTimer)
  }

  return { refresh, activity, dispose }
}
