export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build' && !process.env.VERCEL) {
    const { startPaymentExpiryWorker } = await import('./lib/payment-expiry-worker')
    startPaymentExpiryWorker()
  }
}
