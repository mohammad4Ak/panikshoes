// The existing suites isolate shipping/discount/stock behavior. Real account
// authorization and purchase locking are covered by test-checkout-profile.cjs.
class CheckoutProfileError extends Error {
  constructor(message, status, code) { super(message); Object.assign(this, { status, code }) }
}
module.exports = {
  CheckoutProfileError,
  requireCheckoutProfile: async () => ({ phone: '09123456789', postalCode: '1234567890', isActive: true }),
  readCheckoutProfile: async () => ({ phone: '09123456789', postalCode: '1234567890', isActive: true }),
}
