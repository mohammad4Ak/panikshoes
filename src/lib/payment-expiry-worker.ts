import { expireUnpaidOrders } from './payments'

const workerGlobal = globalThis as typeof globalThis & { paymentExpiryTimer?: ReturnType<typeof setInterval> }

// A persistent Node server releases stock even if the shopper closes the tab.
// Serverless hosts use the authenticated cron route; request-time sweeps remain a fallback.
export function startPaymentExpiryWorker() {
  if (workerGlobal.paymentExpiryTimer) return
  let running = false
  const sweep = async () => {
    if (running) return
    running = true
    try { await expireUnpaidOrders() }
    catch { console.error('Payment reservation expiry failed; the next sweep will retry.') }
    finally { running = false }
  }
  workerGlobal.paymentExpiryTimer = setInterval(() => { void sweep() }, 30_000)
  workerGlobal.paymentExpiryTimer.unref()
}
