const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Exercise the actual admin components with hooks and HTTP responses, without a DB.
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const orderReport = (orders, overrides = {}) => ({
  orders, pagination: { page: 1, pageSize: 20, total: orders.length, pages: 1 },
  dashboard: { date: '2026-10-08', timeZone: 'Asia/Tehran', todayOrders: orders.length, todayPaidOrders: 0, todayPaidTotal: 0, awaitingReview: 0, readyToShip: 0 },
  generatedAt: '2026-10-08T08:00:00.000Z', ...overrides,
})
const settle = () => new Promise(setImmediate)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const receipt = { id: 'receipt-1', createdAt: '2026-10-01T10:00:00Z', status: 'PENDING', payerCardLast4: '1234', transferReference: '12345', reviewNote: null, reviewedAt: null, isLate: false }
const order = {
  id: 'order-1', total: 120000, status: 'PENDING', paymentMethod: 'bank_transfer', paymentStatus: 'AWAITING_REVIEW', verified: false,
  paymentExpiresAt: null, paymentCardNumber: '6037997512345670', paymentCardholderName: 'فروشگاه', paymentBankName: 'ملی',
  createdAt: '2026-10-01T09:00:00Z', phone: '09123456789', recipientName: 'خریدار', address: 'تهران', shippingMethodName: 'پست', shippingCost: 0,
  user: { name: 'خریدار', email: 'customer@example.test' }, receipts: [receipt], _count: { receipts: 1 }, invoice: null,
  items: [{ id: 'item-1', quantity: 1, size: 42, color: 'مشکی', price: 120000, productName: 'کفش', product: { name: 'کفش' } }],
}
const bank = { id: 'bank_transfer', name: 'کارت‌به‌کارت', description: null, isActive: true, cardNumber: '6037997512345670', cardholderName: 'فروشگاه', bankName: 'ملی', sortOrder: 0, available: true }
const zarinpal = { id: 'zarinpal', name: 'زرین‌پال', description: null, isActive: false, cardNumber: null, cardholderName: null, bankName: null, sortOrder: 1, available: false, unavailableReason: 'اتصال تکمیل نشده است.' }

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}
const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
const source = (name) => transformSync(readFileSync(path.join(__dirname, '..', name), 'utf8'), { loader: name.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code

function componentApp(file, queues = {}, href = 'https://shop.example.test/admin/payments') {
  let current
  const requests = [], timers = new Map()
  let nextTimer = 0
  const react = {
    Fragment: 'Fragment',
    useState(initial) {
      const state = current, index = state.cursor++
      if (!(index in state.slots)) state.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [state.slots[index].value, (next) => { state.writes++; state.slots[index].value = typeof next === 'function' ? next(state.slots[index].value) : next }]
    },
    useRef(initial) {
      const index = current.cursor++
      if (!(index in current.slots)) current.slots[index] = { current: initial }
      return current.slots[index]
    },
    useMemo(callback) { current.cursor++; return callback() },
    useCallback(callback, dependencies) {
      const index = current.cursor++
      if (!current.slots[index] || !same(current.slots[index].dependencies, dependencies)) current.slots[index] = { callback, dependencies }
      return current.slots[index].callback
    },
    useEffect(callback, dependencies) {
      const state = current, index = state.cursor++
      if (!state.slots[index] || !same(state.slots[index].dependencies, dependencies)) {
        state.slots[index]?.cleanup?.()
        state.slots[index] = { dependencies }
        state.effects.push(() => { state.slots[index].cleanup = callback() })
      }
    },
  }
  const jsx = (type, props) => ({ type, props })
  const contract = { exports: {} }
  vm.runInNewContext(source('src/lib/payment-contract.ts'), { module: contract })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    'next/link': { __esModule: true, default: 'Link' },
    '@/lib/utils': { formatPrice: String },
    '@/lib/payment-contract': contract.exports,
    '@/components/shop/InvoiceDownload': { __esModule: true, default: 'InvoiceDownload' },
  }
  const context = {
    module: { exports: {} }, AbortController, URL, URLSearchParams, window: { location: { href } }, confirm: () => true,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      const key = `${options.method || 'GET'} ${url}`
      const pathname = new URL(url, 'https://shop.example.test').pathname
      const queue = queues[key] || queues[`${options.method || 'GET'} ${pathname}`]
      assert.ok(queue?.length, `Unexpected request ${key}`)
      const next = queue.shift()
      if (next instanceof Error) throw next
      return next
    },
    require(name) {
      if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
      assert.ok(name in dependencies, `Unexpected dependency ${name}`)
      return dependencies[name]
    },
  }
  vm.runInNewContext(source(file), context)
  const mount = (Component = context.module.exports.default, props = {}) => {
    const state = { slots: [], effects: [], cursor: 0, writes: 0, tree: null }
    const render = () => {
      current = state; state.cursor = 0; state.tree = Component(props)
      for (const node of nodes(state.tree)) if (node.type === 'dialog' && !node.props.ref.current) node.props.ref.current = { showModal() {}, close() {} }
      state.effects.splice(0).forEach((effect) => effect())
      return state.tree
    }
    render()
    return { render, get tree() { return state.tree }, get stateWrites() { return state.writes }, unmount() { for (const slot of state.slots) slot?.cleanup?.() } }
  }
  return { mount, requests }
}
const child = (app, name) => nodes(app.tree).find((node) => typeof node.type === 'function' && node.type.name === name)
const input = (app, id) => nodes(app.tree).find((node) => node.props.id === id)
const submit = (app) => nodes(app.tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
const submitButton = (app) => nodes(app.tree).find((node) => node.type === 'button' && node.props.type === 'submit')
const writes = (runtime) => runtime.requests.filter((request) => request.method && request.method !== 'GET')

async function reviewHarness(action, options = {}) {
  const runtime = componentApp('src/app/admin/payments/page.tsx', { 'GET /api/admin/payments': [response([options.order || order]), ...(options.reads || [])], ...options.queues })
  const page = runtime.mount(); await settle(); page.render()
  nodes(page.tree).find((node) => node.type === 'button' && node.props['aria-expanded'] === false).props.onClick(); page.render()
  nodes(page.tree).find((node) => node.type === 'button' && text(node) === (action === 'approve' ? 'بررسی و تأیید واریز' : 'رد رسید با توضیح')).props.onClick(); page.render()
  const node = child(page, 'ReviewDialog')
  return { runtime, page, dialog: runtime.mount(node.type, node.props) }
}

test('Approval requires actual-deposit confirmation, blocks duplicates/cancel, and keeps a late-stock error retryable', async () => {
  const pending = deferred()
  const late = { ...order, status: 'CANCELLED', receipts: [{ ...receipt, isLate: true }] }
  const paid = { ...late, status: 'PROCESSING', paymentStatus: 'PAID', verified: true, receipts: [{ ...receipt, status: 'APPROVED' }] }
  const { runtime, page, dialog } = await reviewHarness('approve', { order: late, reads: [response([late]), response([paid])], queues: {
    'POST /api/admin/payments/order-1/review': [pending.promise, response({ order: paid })],
  } })
  assert.match(text(dialog.tree), /موجود بودن تمام کالاها/)
  await submit(dialog); dialog.render(); assert.equal(writes(runtime).length, 0)
  assert.match(text(dialog.tree), /دریافت مبلغ در حساب بانکی/)
  nodes(dialog.tree).find((node) => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); dialog.render()
  const first = submit(dialog); await submit(dialog); dialog.render()
  assert.equal(writes(runtime).length, 1)
  assert.equal(submitButton(dialog).props.disabled, true)
  assert.ok(nodes(dialog.tree).filter((node) => node.type === 'button').every((node) => node.props.disabled))
  let prevented = false
  nodes(dialog.tree).find((node) => node.type === 'dialog').props.onCancel({ preventDefault() { prevented = true } })
  page.render(); assert.equal(prevented, true); assert.ok(child(page, 'ReviewDialog'))
  pending.resolve(response({ error: 'موجودی کافی نیست' }, 409)); await first; await settle(); dialog.render()
  assert.match(text(dialog.tree), /موجودی کافی نیست/)
  assert.equal(submitButton(dialog).props.disabled, false)
  assert.equal(nodes(dialog.tree).find((node) => node.props.type === 'checkbox').props.checked, true)
  await submit(dialog); page.render()
  assert.equal(writes(runtime).length, 2)
  assert.ok(!child(page, 'ReviewDialog'))
  dialog.unmount(); page.unmount()
})

test('Rejection requires a reason and failed review preserves its note for retry', async () => {
  const { runtime, page, dialog } = await reviewHarness('reject', { queues: {
    'POST /api/admin/payments/order-1/review': [response({ error: 'ثبت نشد' }, 503)],
  } })
  await submit(dialog); dialog.render(); assert.equal(writes(runtime).length, 0)
  input(dialog, 'payment-review-note').props.onChange({ target: { value: '  مبلغ مطابق نیست  ' } }); dialog.render()
  await submit(dialog); dialog.render()
  assert.equal(JSON.parse(writes(runtime)[0].body).note, 'مبلغ مطابق نیست')
  assert.equal(input(dialog, 'payment-review-note').props.value, '  مبلغ مطابق نیست  ')
  assert.match(text(dialog.tree), /ثبت نشد/)
  assert.equal(submitButton(dialog).props.disabled, false)
  assert.ok(!text(page.tree).includes('رسید رد شد'))
  dialog.unmount(); page.unmount()
})

test('Successful review updates payment state even when the subsequent refresh fails', async () => {
  const paid = { ...order, status: 'PROCESSING', paymentStatus: 'PAID', verified: true, receipts: [{ ...receipt, status: 'APPROVED' }] }
  const { runtime, page, dialog } = await reviewHarness('approve', { reads: [response({ error: 'بارگذاری دوباره انجام نشد' }, 503)], queues: {
    'POST /api/admin/payments/order-1/review': [response({ order: paid })],
  } })
  nodes(dialog.tree).find((node) => node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); dialog.render()
  await submit(dialog); await settle(); page.render()
  assert.match(text(page.tree), /واریز تأیید شد/)
  assert.match(text(page.tree), /بارگذاری دوباره انجام نشد/)
  assert.match(text(page.tree), /رسیدی منتظر بررسی نیست/)
  assert.equal(writes(runtime).length, 1)
  nodes(page.tree).find((node) => node.type === 'button' && text(node) === 'تأییدشده').props.onClick(); page.render()
  assert.ok(nodes(page.tree).some((node) => node.type === 'article'))
  dialog.unmount(); page.unmount()
})

test('Bank settings use the API card and position rules, block duplicate saves, and retain failed drafts', async () => {
  const pending = deferred()
  const runtime = componentApp('src/app/admin/payment-methods/page.tsx', {
    'GET /api/admin/payment-methods': [response([bank, zarinpal])],
    'PATCH /api/admin/payment-methods/bank_transfer': [pending.promise, response({ ...bank, name: 'عنوان جدید', sortOrder: 999 })],
  })
  const page = runtime.mount(); await settle(); page.render()
  const node = child(page, 'MethodForm'), form = runtime.mount(node.type, node.props)
  input(form, 'bank_transfer-sort').props.onChange({ target: { value: '1000' } }); form.render(); await submit(form); form.render()
  assert.equal(writes(runtime).length, 0); assert.match(text(form.tree), /۹۹۹/)
  input(form, 'bank_transfer-sort').props.onChange({ target: { value: '۹۹۹' } })
  input(form, 'bank_transfer-number').props.onChange({ target: { value: '1111111111111111' } }); form.render(); await submit(form); form.render()
  assert.equal(writes(runtime).length, 0); assert.match(text(form.tree), /شماره کارت ۱۶ رقمی معتبر/)
  input(form, 'bank_transfer-number').props.onChange({ target: { value: '۶۰۳۷۹۹۷۵۱۲۳۴۵۶۷۰' } })
  input(form, 'bank_transfer-name').props.onChange({ target: { value: 'عنوان جدید' } }); form.render()
  const first = submit(form); await submit(form); form.render()
  assert.equal(writes(runtime).length, 1)
  assert.equal(input(form, 'bank_transfer-name').props.disabled, true)
  assert.equal(submitButton(form).props.disabled, true)
  assert.equal(JSON.parse(writes(runtime)[0].body).cardNumber, bank.cardNumber)
  assert.equal(JSON.parse(writes(runtime)[0].body).sortOrder, 999)
  pending.resolve(response({ error: 'ذخیره انجام نشد' }, 503)); await first; form.render()
  assert.equal(input(form, 'bank_transfer-name').props.value, 'عنوان جدید')
  assert.equal(submitButton(form).props.disabled, false)
  await submit(form); form.render(); assert.match(text(form.tree), /تنظیمات این روش پرداخت ذخیره شد/)
  form.unmount(); page.unmount()
})

test('Unavailable Zarinpal cannot be enabled, and missing payment settings offer reload', async () => {
  const runtime = componentApp('src/app/admin/payment-methods/page.tsx', {
    'GET /api/admin/payment-methods': [response([]), response([zarinpal])],
    'PATCH /api/admin/payment-methods/zarinpal': [response(zarinpal)],
  })
  const page = runtime.mount(); await settle(); page.render()
  assert.match(text(page.tree), /تنظیمات روش‌های پرداخت هنوز در دسترس نیست/)
  nodes(page.tree).find((node) => node.type === 'button' && text(node).includes('تلاش دوباره')).props.onClick(); page.render(); await settle(); page.render()
  const node = child(page, 'MethodForm'), form = runtime.mount(node.type, node.props)
  assert.equal(input(form, 'zarinpal-active').props.disabled, true)
  assert.equal(input(form, 'zarinpal-active').props.checked, false)
  await submit(form)
  assert.equal(JSON.parse(writes(runtime)[0].body).isActive, false)
  form.unmount(); page.unmount()
})

test('Receipt-bearing orders remain protected after cancellation and simultaneous actions cannot duplicate writes', async () => {
  const pending = deferred()
  const rejected = { ...order, paymentStatus: 'REJECTED', receipts: [] }
  const updated = { ...rejected, status: 'CANCELLED', paymentStatus: 'EXPIRED' }; delete updated._count
  const runtime = componentApp('src/app/admin/orders/page.tsx', {
    'GET /api/admin/orders': [response(orderReport([rejected])), response(orderReport([{ ...updated, _count: rejected._count }]))], 'PATCH /api/orders/order-1': [pending.promise],
  })
  const page = runtime.mount(); await settle(); page.render()
  const select = nodes(page.tree).find((node) => node.type === 'select' && node.props['aria-label'] === `وضعیت سفارش ${order.id.slice(-6)}`)
  assert.deepEqual(nodes(select).filter((node) => node.type === 'option').map((node) => node.props.value), ['PENDING', 'CANCELLED'])
  const first = select.props.onChange({ target: { value: 'CANCELLED' } })
  await select.props.onChange({ target: { value: 'CANCELLED' } }); page.render()
  assert.equal(writes(runtime).length, 1)
  assert.equal(nodes(page.tree).find((node) => node.type === 'select' && node.props['aria-label'] === `وضعیت سفارش ${order.id.slice(-6)}`).props.disabled, true)
  pending.resolve(response(updated)); await first; page.render()
  const remove = nodes(page.tree).find((node) => node.type === 'button' && node.props['aria-label'] === 'حذف سفارش rder-1')
  assert.equal(remove.props.disabled, true)
  await remove.props.onClick(); assert.equal(writes(runtime).length, 1)
  page.unmount()
})

test('Unpaid bank transfers cannot enter fulfillment and pending receipt review cannot be cancelled', async () => {
  for (const paymentStatus of ['AWAITING_RECEIPT', 'REJECTED', 'AWAITING_REVIEW']) {
    const runtime = componentApp('src/app/admin/orders/page.tsx', { 'GET /api/admin/orders': [response(orderReport([{ ...order, paymentStatus }]))] })
    const page = runtime.mount(); await settle(); page.render()
    const select = nodes(page.tree).find((node) => node.type === 'select' && node.props['aria-label'] === `وضعیت سفارش ${order.id.slice(-6)}`)
    const choices = nodes(select).filter((node) => node.type === 'option').map((node) => node.props.value)
    assert.deepEqual(choices, paymentStatus === 'AWAITING_REVIEW' ? ['PENDING'] : ['PENDING', 'CANCELLED'])
    await select.props.onChange({ target: { value: 'PROCESSING' } }); assert.equal(writes(runtime).length, 0)
    page.unmount()
  }
})

test('Leaving orders aborts a pending status write and ignores its late response', async () => {
  const pending = deferred()
  const runtime = componentApp('src/app/admin/orders/page.tsx', {
    'GET /api/admin/orders': [response(orderReport([{ ...order, paymentStatus: 'AWAITING_RECEIPT', _count: { receipts: 0 }, receipts: [] }]))],
    'PATCH /api/orders/order-1': [pending.promise],
  })
  const page = runtime.mount(); await settle(); page.render()
  const saving = nodes(page.tree).find((node) => node.type === 'select' && node.props['aria-label'] === `وضعیت سفارش ${order.id.slice(-6)}`).props.onChange({ target: { value: 'CANCELLED' } })
  page.unmount(); const before = page.stateWrites
  assert.equal(writes(runtime)[0].signal.aborted, true)
  pending.resolve(response({ ...order, status: 'CANCELLED' })); await saving
  assert.equal(page.stateWrites, before)
})
