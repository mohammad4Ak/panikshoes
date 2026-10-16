const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const event = { preventDefault() {} }
const serverTime = '2026-10-02T12:00:00.000Z'
const deadline = '2026-10-02T12:10:00.000Z'
const nextTurn = () => new Promise(setImmediate)
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const proof = new File([new Uint8Array([1, 2, 3])], 'receipt.png', { type: 'image/png' })

function payment(overrides = {}, receipts = []) {
  return {
    order: {
      id: 'order-1', total: 4200000, status: 'PENDING', verified: false,
      paymentMethod: 'bank_transfer', paymentStatus: 'AWAITING_RECEIPT', paymentExpiresAt: deadline,
      paymentCardNumber: '6037991234567890', paymentCardholderName: 'فروشگاه کفش لند', paymentBankName: 'بانک ملی',
      invoice: null, ...overrides,
    }, receipts, serverTime,
  }
}

function receipt(overrides = {}) {
  return { id: 'receipt-1', createdAt: serverTime, status: 'PENDING', reviewNote: null, reviewedAt: null, payerCardLast4: null, transferReference: null, isLate: false, ...overrides }
}

const cancelledPayment = () => payment({ status: 'CANCELLED', paymentStatus: 'UNPAID', paymentExpiresAt: null })
const cancellation = () => ({ order: cancelledPayment().order, serverTime })

function confirmCancellation(app) {
  app.button('انصراف از خرید').props.onClick()
  app.render()
  app.button('تأیید انصراف').props.onClick()
  app.render()
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}

function compile(relativePath, loader = 'tsx') {
  return transformSync(readFileSync(path.join(root, relativePath), 'utf8'), { loader, format: 'cjs', target: 'es2022', jsx: 'automatic' }).code
}

const componentCode = compile('src/components/shop/BankTransferPayment.tsx')
const contractContext = { module: { exports: {} } }
vm.runInNewContext(compile('src/lib/payment-contract.ts', 'ts'), contractContext)
const totalsContext = { module: { exports: {} } }
vm.runInNewContext(compile('src/lib/order-totals.ts', 'ts'), totalsContext)

test('Bank-transfer payment shows separated discounts while preserving the exact payable amount', async () => {
  const app = mount({ queue: [response(payment({ subtotal: 1000, productDiscount: 100, couponDiscount: 101, couponCode: 'PANIK101', shippingCost: 50, total: 849 }))] })
  await app.start()
  assert.match(text(app.tree), /جمع اولیهٔ کالاها/)
  assert.match(text(app.tree), /تخفیف محصولات/)
  assert.match(text(app.tree), /PANIK101/)
  assert.match(text(app.tree), /−\s*100/)
  assert.match(text(app.tree), /−\s*101/)
  assert.match(text(app.tree), /849/)
  assert.match(text(app.tree), /8490/)
  app.unmount()
})

// Run real component handlers/effects with monotonic time and abort-aware network
// doubles. Tests observe customer behavior and requests without touching live data.
function mount({ queue = [response(payment())], orderId = 'order-1', uuidFailure = false, uuidAvailable = true } = {}) {
  const slots = [], effects = [], requests = [], replacements = [], revoked = [], listeners = new Map(), timers = new Map()
  let cursor = 0, tree, now = 0, nextTimer = 0, stateWrites = 0, nextUuid = 0, dirty = false, nextUrl = 0
  const sameDeps = (before, after) => before && after && before.length === after.length && before.every((value, index) => Object.is(value, after[index]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      slot.setter ??= (value) => { stateWrites++; dirty = true; slot.value = typeof value === 'function' ? value(slot.value) : value }
      return [slot.value, slot.setter]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!(index in slots) || !sameDeps(slots[index].deps, deps)) slots[index] = { callback, deps }
      return slots[index].callback
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!(index in slots) || !sameDeps(slots[index].deps, deps)) {
        const previous = slots[index]
        const slot = slots[index] = { deps }
        effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() })
      }
    },
  }
  const window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay, interval: false }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay, interval: true }); return id },
    clearInterval(id) { timers.delete(id) },
  }
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { const entries = listeners.get(name) ?? new Set(); entries.add(callback); listeners.set(name, entries) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
  }
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options })
    assert.ok(queue.length, `Unexpected request: ${url}`)
    const result = queue.shift()
    if (result instanceof Error) throw result
    return typeof result === 'function' ? result(options) : result
  }
  const router = { replace(url) { replacements.push(url) } }
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'next/navigation': { useRouter: () => router },
    'next/link': { __esModule: true, default: 'Link' },
    'next/image': { __esModule: true, default: 'Image' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/BrandIcons': { PaymentStatusIcon: 'PaymentStatusIcon' },
    '@/lib/utils': { formatPrice: (value) => String(value) },
    '@/lib/payment-contract': contractContext.module.exports,
    '@/lib/order-totals': totalsContext.module.exports,
    './InvoiceDownload': { __esModule: true, default: 'InvoiceDownload' },
    './bank-transfer.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }
  const context = {
    module: { exports: {} }, AbortController, File, FormData, Date, Error, TypeError, fetch, document, window,
    performance: { now: () => now },
    crypto: {
      randomUUID: uuidAvailable ? () => { if (uuidFailure) throw new Error('UUID unavailable'); return `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, '0')}` } : undefined,
      getRandomValues: (bytes) => bytes.fill(++nextUuid),
    },
    URL: { createObjectURL: () => `blob:receipt-${++nextUrl}`, revokeObjectURL: (url) => revoked.push(url) },
    navigator: { clipboard: { writeText: async () => {} } },
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(componentCode, context)
  function render() {
    cursor = 0
    dirty = false
    tree = context.module.exports.default({ orderId })
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  async function settle() {
    for (let index = 0; index < 5; index++) { await nextTurn(); if (dirty) render() }
  }
  function runTimer(id) {
    const timer = timers.get(id)
    if (!timer) return
    if (timer.interval) timer.at = now + timer.delay
    else timers.delete(id)
    timer.callback()
  }
  async function advance(milliseconds) {
    const end = now + milliseconds
    let due
    while ((due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0])) {
      now = due[1].at
      runTimer(due[0])
      await settle()
    }
    now = end
    if (dirty) render()
  }
  render()
  return {
    render, settle, advance, requests, replacements, timers, revoked, listeners, queue,
    get tree() { return tree }, get stateWrites() { return stateWrites },
    async start() { await advance(0) },
    button(label) { return nodes(tree).find((node) => node.type === 'button' && text(node).includes(label)) },
    form: () => nodes(tree).find((node) => node.type === 'form'),
    timer: () => nodes(tree).find((node) => node.props.role === 'timer'),
    alert: () => nodes(tree).find((node) => node.props.role === 'alert'),
    input: (id) => nodes(tree).find((node) => node.props.id === id),
    choose(file = proof) { nodes(tree).find((node) => node.props.id === 'transfer-receipt').props.onChange({ target: { files: file ? [file] : [] } }); render() },
    fill(id, value) { nodes(tree).find((node) => node.props.id === id).props.onChange({ target: { value } }); render() },
    async submit() { const promise = nodes(tree).find((node) => node.type === 'form').props.onSubmit(event); render(); await promise; await settle() },
    async visible(value) { document.visibilityState = value; listeners.get('visibilitychange')?.forEach((callback) => callback()); await settle() },
    async timeout(delay) { const timer = [...timers].find(([, timer]) => !timer.interval && timer.delay === delay); assert.ok(timer, `Missing ${delay}ms timeout`); runTimer(timer[0]); await settle() },
    unmount() { slots.forEach((slot) => slot.cleanup?.()) },
  }
}

function stalled(options) {
  return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
}

test('The countdown follows server time and monotonic elapsed time even when the computer clock differs', async () => {
  const app = mount()
  await app.start()
  assert.equal(text(app.timer()).replace(/\s/g, ''), '10:00')
  await app.advance(2000)
  assert.equal(text(app.timer()).replace(/\s/g, ''), '09:58')
  assert.match(text(app.tree), /42000000\s+ریال/)
  assert.equal(app.requests[0].cache, 'no-store')
})

test('Hidden pages skip periodic and deadline requests and refresh once when visible again', async () => {
  const nearExpiry = payment({ paymentExpiresAt: '2026-10-02T12:00:02.000Z' })
  const app = mount({ queue: [response(nearExpiry), response(payment({ status: 'CANCELLED', paymentStatus: 'EXPIRED', paymentExpiresAt: null }))] })
  await app.start()
  await app.visible('hidden')
  await app.advance(30_000)
  assert.equal(app.requests.length, 1)
  await app.visible('visible')
  assert.equal(app.requests.length, 2)
  assert.match(text(app.tree), /موجودی آزاد شده است/)
})

test('Reading a slow response body does not extend the server deadline', async () => {
  let finish
  const app = mount({ queue: [{ status: 200, ok: true, json: () => new Promise((resolve) => { finish = resolve }) }] })
  await app.start()
  await app.advance(5000)
  finish(payment())
  await app.settle()
  assert.equal(text(app.timer()).replace(/\s/g, ''), '09:55')
})

test('Unpaid expiration removes payment controls and requires an explicit late-proof action', async () => {
  const expired = payment({ status: 'CANCELLED', paymentStatus: 'EXPIRED', paymentExpiresAt: null })
  const app = mount({ queue: [response(expired), response({ receipt: receipt({ isLate: true }), paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment({ status: 'CANCELLED', paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt({ isLate: true })]))] })
  await app.start()
  assert.equal(app.form(), undefined)
  assert.match(text(app.tree), /رزرو موجودی آزاد شده است/)
  app.button('واریز کردم، مهلت تمام شد').props.onClick()
  app.render()
  app.choose()
  await app.submit()
  assert.equal(app.requests[1].body.get('latePayment'), 'true')
  assert.equal(app.timer(), undefined)
  assert.match(text(app.tree), /موجودی رزرو نیست/)
})

test('A received proof stops the countdown and remains unconfirmed until server verification', async () => {
  const app = mount({ queue: [response(payment()), response({ receipt: receipt(), paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment({ paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt()]))] })
  await app.start()
  app.choose()
  app.fill('payer-last-four', '۱۲۳۴')
  app.fill('transfer-reference', 'پیگیری ١٢٣')
  await app.submit()
  assert.equal(app.requests[1].body.get('payerCardLast4'), '1234')
  assert.equal(app.requests[1].body.get('transferReference'), 'پیگیری 123')
  assert.equal(app.requests[1].body.get('latePayment'), null)
  assert.equal(app.timer(), undefined)
  assert.equal(app.form(), undefined)
  assert.match(text(app.tree), /در انتظار تأیید ادمین/)
  assert.equal(nodes(app.tree).find((node) => node.type === 'InvoiceDownload'), undefined)
})

test('Rejected receipts resume the new server deadline and display the review note', async () => {
  const rejected = receipt({ status: 'REJECTED', reviewNote: 'مبلغ رسید خوانا نیست', reviewedAt: serverTime })
  const app = mount({ queue: [response(payment({ paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null })), response(payment({ paymentStatus: 'REJECTED', paymentExpiresAt: deadline }, [rejected]))] })
  await app.start()
  assert.equal(app.timer(), undefined)
  app.button('بررسی آخرین وضعیت').props.onClick()
  await app.settle()
  assert.equal(text(app.timer()).replace(/\s/g, ''), '10:00')
  assert.ok(app.form())
  assert.match(text(app.tree), /مبلغ رسید خوانا نیست/)
})

test('Verified orders expose invoice controls and cannot submit a receipt', async () => {
  const invoice = { id: 42, issuedAt: serverTime }
  const app = mount({ queue: [response(payment({ verified: true, paymentStatus: 'PAID', paymentExpiresAt: null, invoice }))] })
  await app.start()
  assert.equal(app.form(), undefined)
  assert.equal(app.timer(), undefined)
  const download = nodes(app.tree).find((node) => node.type === 'InvoiceDownload')
  assert.equal(download.props.invoice.id, 42)
  assert.match(text(app.tree), /پرداختت تأیید شد/)
})

test('An upload timeout releases busy controls and keeps the same idempotency key for retry', async () => {
  const app = mount({ queue: [response(payment()), stalled, response(payment()), response({ receipt: receipt(), paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment({ paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt()]))] })
  await app.start()
  app.choose()
  const handler = app.form().props.onSubmit
  const pending = handler(event)
  app.render()
  await handler(event)
  assert.equal(app.requests.length, 2, 'Rapid duplicate submissions must share a request')
  assert.equal(app.form().props['aria-busy'], true)
  await app.timeout(60_000)
  await pending
  assert.equal(app.form().props['aria-busy'], false)
  assert.match(text(app.alert()), /ارسال رسید طول کشید/)
  await app.submit()
  const uploads = app.requests.filter((request) => request.method === 'POST')
  assert.equal(uploads.length, 2)
  assert.equal(uploads[0].body.get('submissionKey'), uploads[1].body.get('submissionKey'))
  assert.ok(uploads[0].signal.aborted)
})

test('Malformed successful upload responses remain safely retryable with the same key', async () => {
  const app = mount({ queue: [response(payment()), response({ receipt: { id: 'broken' }, paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment()), response({ receipt: receipt(), paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment({ paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt()]))] })
  await app.start()
  app.choose()
  await app.submit()
  assert.match(text(app.alert()), /پاسخ ثبت رسید دریافت نشد/)
  assert.ok(app.input('transfer-receipt'))
  await app.submit()
  const uploads = app.requests.filter((request) => request.method === 'POST')
  assert.equal(uploads[0].body.get('submissionKey'), uploads[1].body.get('submissionKey'))
})

test('An idempotent retry for a receipt already reviewed does not reset it to awaiting review', async () => {
  const reviewed = receipt({ status: 'REJECTED', reviewNote: 'نیاز به اصلاح', reviewedAt: serverTime })
  const app = mount({ queue: [response(payment()), response({ receipt: reviewed, paymentStatus: 'REJECTED' }, 201), new Error('Status unavailable')] })
  await app.start()
  app.choose()
  await app.submit()
  assert.match(text(app.tree), /رسیدت نیاز به اصلاح داره/)
  assert.doesNotMatch(text(app.tree), /رسیدت در حال بررسیه/)
  assert.match(text(app.tree), /این رسید قبلاً ثبت و بررسی شده/)
})

test('A failed local upload setup releases the submission lock', async () => {
  const app = mount({ uuidFailure: true, queue: [response(payment()), response(payment()), response(payment())] })
  await app.start()
  app.choose()
  await app.submit()
  assert.equal(app.form().props['aria-busy'], false)
  assert.ok(app.alert())
  await app.submit()
  assert.equal(app.form().props['aria-busy'], false)
  assert.equal(app.requests.filter((request) => request.method === 'POST').length, 0)
})

test('Receipt uploads work during a plain HTTP LAN preview without randomUUID', async () => {
  const app = mount({ uuidAvailable: false, queue: [response(payment()), response({ receipt: receipt(), paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment({ paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt()]))] })
  await app.start()
  app.choose()
  await app.submit()
  assert.match(app.requests[1].body.get('submissionKey'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(app.alert(), undefined)
  assert.equal(app.form(), undefined)
})

test('Invalid receipt files are rejected before any upload', async () => {
  const app = mount()
  await app.start()
  for (const file of [new File([], 'empty.png', { type: 'image/png' }), new File(['text'], 'proof.pdf', { type: 'application/pdf' }), new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })]) {
    app.choose(file)
    assert.match(text(app.alert()), /حداکثر ۵ مگابایت/)
    assert.equal(app.button('ثبت رسید و درخواست').props.disabled, true)
  }
  assert.equal(app.requests.length, 1)
})

test('GET timeout and malformed payment JSON show a retryable load error without crashing', async () => {
  for (const first of [stalled, response(null), response(payment({}, [{ id: 'bad', createdAt: 'invalid' }])), response(payment({ total: 'NaN' })), response(payment({ paymentExpiresAt: null }))]) {
    const app = mount({ queue: [first, response(payment())] })
    await app.start()
    if (first === stalled) await app.timeout(20_000)
    assert.ok(app.alert())
    const retry = app.button('تلاش دوباره')
    assert.equal(retry.props.disabled, false)
    retry.props.onClick()
    await app.settle()
    assert.equal(text(app.timer()).replace(/\s/g, ''), '10:00')
    assert.equal(app.alert(), undefined)
  }
})

test('GET and upload authorization expiry both return through login to the transfer page', async () => {
  const app = mount({ queue: [response({ error: 'Sign in' }, 401)] })
  await app.start()
  assert.deepEqual(app.replacements, ['/login?callbackUrl=%2Fpayment%2Ftransfer%2Forder-1'])
  const upload = mount({ queue: [response(payment()), response({ error: 'Sign in' }, 401)] })
  await upload.start()
  upload.choose()
  await upload.submit()
  assert.deepEqual(upload.replacements, app.replacements)
  assert.equal(upload.requests.length, 2, 'A 401 upload must navigate without another payment fetch')
})

test('Unmount cancels requests, polling, deadline timers, previews and event subscriptions', async () => {
  const app = mount({ queue: [response(payment()), stalled] })
  await app.start()
  app.choose()
  await app.advance(0)
  const pending = app.form().props.onSubmit(event)
  app.render()
  const writes = app.stateWrites
  app.unmount()
  await pending
  await app.settle()
  assert.ok(app.requests[1].signal.aborted)
  assert.equal(app.stateWrites, writes, 'An unmounted upload must not write state')
  assert.equal(app.timers.size, 0)
  assert.equal(app.listeners.get('visibilitychange').size, 0)
  assert.deepEqual(app.revoked, ['blob:receipt-1'])
  assert.equal(app.requests.length, 2)
})

test('Unmounting a payment load prevents stale responses from updating state', async () => {
  let finish
  const app = mount({ queue: [() => new Promise((resolve) => { finish = resolve })] })
  await app.start()
  const writes = app.stateWrites
  app.unmount()
  finish(response(payment()))
  await app.settle()
  assert.equal(app.stateWrites, writes)
  assert.ok(app.requests[0].signal.aborted)
  assert.equal(app.timers.size, 0)
})

test('Cancellation needs an explicit confirmation and keeping the order does not send a request', async () => {
  const app = mount()
  await app.start()
  app.button('انصراف از خرید').props.onClick()
  app.render()
  assert.match(text(app.tree), /فقط اگر هنوز مبلغی واریز نکرده‌ای/)
  assert.equal(app.requests.length, 1)
  app.button('ادامهٔ خرید').props.onClick()
  app.render()
  assert.equal(app.button('تأیید انصراف'), undefined)
  assert.ok(app.form())
  assert.equal(app.requests.length, 1)
})

test('Successful cancellation immediately removes transfer controls and shows released stock', async () => {
  const app = mount({ queue: [response(payment()), response(cancellation()), response(cancelledPayment())] })
  await app.start()
  app.choose()
  confirmCancellation(app)
  await app.settle()
  const cancel = app.requests.find((request) => request.url.endsWith('/cancel'))
  assert.equal(cancel.method, 'POST')
  assert.equal(cancel.credentials, 'same-origin')
  assert.equal(app.form(), undefined)
  assert.equal(app.timer(), undefined)
  assert.equal(app.button('انصراف از خرید'), undefined)
  assert.match(text(app.tree), /سفارشت لغو شد/)
  assert.match(text(app.tree), /رزرو موجودی آزاد شده است/)
  assert.ok(app.button('قبل از انصراف واریز کرده‌ام'))
})

test('Cancellation cannot run concurrently with upload or duplicate cancellation clicks', async () => {
  const app = mount({ queue: [response(payment()), stalled, response(payment())] })
  await app.start()
  app.choose()
  confirmCancellation(app)
  assert.equal(app.button('در حال ثبت انصراف').props.disabled, true)
  assert.equal(app.input('transfer-receipt').props.disabled, true)
  await app.submit()
  assert.equal(app.requests.length, 2)
  app.button('در حال ثبت انصراف').props.onClick()
  await app.settle()
  assert.equal(app.requests.length, 2)
  await app.timeout(20_000)
  assert.equal(app.button('تأیید انصراف').props.disabled, false)
  assert.match(text(app.alert()), /دریافت نتیجهٔ انصراف طول کشید/)
  const upload = mount({ queue: [response(payment()), stalled, response(payment())] })
  await upload.start()
  upload.choose()
  const pending = upload.form().props.onSubmit(event)
  upload.render()
  assert.equal(upload.button('انصراف از خرید').props.disabled, true)
  confirmCancellation(upload)
  assert.equal(upload.requests.length, 2)
  await upload.timeout(60_000)
  await pending
})

test('Cancellation is unavailable for reviewed, verified or expired orders but available after rejection', async () => {
  for (const overrides of [
    { paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null },
    { paymentStatus: 'PAID', verified: true, paymentExpiresAt: null },
    { status: 'CANCELLED', paymentStatus: 'EXPIRED', paymentExpiresAt: null },
    { status: 'CANCELLED', paymentStatus: 'UNPAID', paymentExpiresAt: null },
  ]) {
    const app = mount({ queue: [response(payment(overrides))] })
    await app.start()
    assert.equal(app.button('انصراف از خرید'), undefined)
  }
  const rejected = mount({ queue: [response(payment({ paymentStatus: 'REJECTED' }))] })
  await rejected.start()
  assert.ok(rejected.button('انصراف از خرید'))
})

test('A cancellation and receipt race displays the server conflict and reloads review state', async () => {
  const app = mount({ queue: [response(payment()), response({ error: 'این سفارش رسید در انتظار بررسی دارد.' }, 409), response(payment({ paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt()]))] })
  await app.start()
  confirmCancellation(app)
  await app.settle()
  assert.match(text(app.alert()), /رسید در انتظار بررسی/)
  assert.match(text(app.tree), /رسیدت در حال بررسیه/)
  assert.equal(app.button('انصراف از خرید'), undefined)
  assert.equal(app.form(), undefined)
})

test('Cancellation timeout recovers committed state and never reports success from malformed JSON alone', async () => {
  for (const cancel of [stalled, response(null)]) {
    const app = mount({ queue: [response(payment()), cancel, response(cancelledPayment())] })
    await app.start()
    confirmCancellation(app)
    if (cancel === stalled) await app.timeout(20_000)
    else await app.settle()
    assert.equal(app.alert(), undefined)
    assert.match(text(app.tree), /سفارشت لغو شد/)
    assert.equal(app.form(), undefined)
  }
  const app = mount({ queue: [response(payment()), response(null), response(payment())] })
  await app.start()
  confirmCancellation(app)
  await app.settle()
  assert.match(text(app.alert()), /نتیجهٔ انصراف دریافت نشد/)
  assert.ok(app.form())
  assert.doesNotMatch(text(app.tree), /سفارشت لغو شد/)
})

test('Cancelled orders preserve an explicit path to report a transfer already made', async () => {
  const app = mount({ queue: [response(cancelledPayment()), response({ receipt: receipt({ isLate: true }), paymentStatus: 'AWAITING_REVIEW' }, 201), response(payment({ status: 'CANCELLED', paymentStatus: 'AWAITING_REVIEW', paymentExpiresAt: null }, [receipt({ isLate: true })]))] })
  await app.start()
  app.button('قبل از انصراف واریز کرده‌ام').props.onClick()
  app.render()
  app.choose()
  await app.submit()
  assert.equal(app.requests[1].body.get('latePayment'), 'true')
  assert.match(text(app.tree), /موجودی رزرو نیست/)
})

test('Cancellation authorization expiry returns through login without a further status request', async () => {
  const app = mount({ queue: [response(payment()), response({ error: 'Sign in' }, 401)] })
  await app.start()
  confirmCancellation(app)
  await app.settle()
  assert.deepEqual(app.replacements, ['/login?callbackUrl=%2Fpayment%2Ftransfer%2Forder-1'])
  assert.equal(app.requests.length, 2)
})

test('Unmount aborts in-flight cancellation without further state writes or polling', async () => {
  const app = mount({ queue: [response(payment()), stalled] })
  await app.start()
  confirmCancellation(app)
  const writes = app.stateWrites
  app.unmount()
  await app.settle()
  assert.ok(app.requests[1].signal.aborted)
  assert.equal(app.stateWrites, writes)
  assert.equal(app.timers.size, 0)
  assert.equal(app.requests.length, 2)
})
