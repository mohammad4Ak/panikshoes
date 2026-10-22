const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const source = file => transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code
const contact = { exports: {} }
vm.runInNewContext(source('src/lib/customer-contact.ts'), { module: contact })
const user = { id: 'customer-622', name: 'مشتری نمونه', email: 'customer@example.test', phone: '09123456789', postalCode: '1234567890', isActive: true, role: 'USER', createdAt: '2026-10-19T12:00:00Z', _count: { orders: 1 } }
const address = { id: 'address-1', title: 'خانه', address: 'تبریز، خیابان نمونه، پلاک ۱۰', phone: user.phone, postalCode: user.postalCode, isDefault: true }
const order = { id: 'order-000001', total: 100000, status: 'SHIPPED', verified: true, paymentStatus: 'PAID', paymentMethod: 'bank_transfer', createdAt: '2026-10-19T12:00:00Z', trackingCode: '000123456789012345678901', items: [{ id: 'line-1', quantity: 1, size: 38, color: 'مشکی', productName: 'کفش پانیک مدل ۶۲۲' }], _count: { receipts: 1 } }
const detail = overrides => ({ user: { ...user, addresses: [address] }, orders: [order], summary: { orderCount: 1, paidTotal: 100000 }, isSelf: false, ...overrides })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

function app({ users = [user], queues = {} } = {}) {
  const slots = [], effects = [], requests = [], confirmations = [], navigations = []
  let cursor = 0, tree, writes = 0
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/layout/SiteSettingsProvider': { useSiteSettings: () => ({ storeName: 'کفش پانیک' }) },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: 'select' },
    '@/lib/customer-contact': contact.exports, '@/lib/utils': { formatPrice: value => String(value) },
    '@/lib/session-actions': { signOutWithSessionLock: async options => navigations.push(options.redirectTo) },
  }
  const context = {
    module: { exports: {} }, AbortController, URL, URLSearchParams, window: { location: { assign: url => navigations.push(url) } },
    confirm: message => { confirmations.push(message); return true },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      const key = `${options.method || 'GET'} ${url}`
      const queue = queues[key]
      let value = queue?.length ? queue.shift() : response(url === '/api/users' ? users : detail())
      if (typeof value === 'function') value = await value(options)
      if (value instanceof Error) throw value
      return value
    },
    require(name) { if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }; assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
  }
  vm.runInNewContext(source('src/app/admin/users/page.tsx'), context)
  const render = () => { cursor = 0; tree = context.module.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, requests, confirmations, navigations, get tree() { return tree }, get writes() { return writes }, unmount() { for (const slot of slots) slot?.cleanup?.() } }
}
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object' || !tree.props) return []; return [tree, ...nodes(tree.props.children)] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return tree == null || typeof tree === 'boolean' ? '' : String(tree) }
const find = (application, predicate) => nodes(application.tree).find(predicate)
const button = (application, label) => find(application, node => node.type === 'button' && text(node) === label)
const input = (application, value) => find(application, node => node.type === 'input' && node.props.value === value)
const patch = application => application.requests.filter(request => request.method === 'PATCH')
const submit = application => find(application, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
async function open(application) {
  await settle(); application.render()
  button(application, 'بررسی و ویرایش').props.onClick(); application.render()
  await settle(); application.render()
}
function change(application, node, value) { node.props.onChange({ target: { value } }); application.render() }

test('Admin user search matches Persian, Arabic and English phone/postal digits and composes filters', async () => {
  const application = app({ users: [user, { ...user, id: 'admin', email: 'admin@example.test', name: 'مدیر فروشگاه', role: 'ADMIN', isActive: false, phone: '02112345678', postalCode: '9876543210' }] })
  await settle(); application.render()
  const search = () => find(application, node => node.props['aria-label'] === 'جستجوی کاربران')
  assert.match(text(application.tree), /اطلاعات خرید کامل/)
  for (const value of ['۰۹۱۲۳۴۵۶۷۸۹', '٠٩١٢٣٤٥٦٧٨٩', '0912 345-6789', '+989123456789', '۱۲۳۴۵۶۷۸۹۰']) {
    change(application, search(), value)
    assert.ok(text(application.tree).includes(user.email))
    assert.ok(!text(application.tree).includes('مدیر فروشگاه'))
  }
  change(application, search(), '')
  change(application, find(application, node => node.props['aria-label'] === 'فیلتر وضعیت کاربران'), 'blocked')
  assert.ok(!text(application.tree).includes(user.email))
  assert.ok(text(application.tree).includes('مدیر فروشگاه'))
  change(application, find(application, node => node.props['aria-label'] === 'فیلتر نقش کاربران'), 'USER')
  assert.match(text(application.tree), /کاربری با این جستجو و فیلتر پیدا نشد/)
  application.unmount()
})

test('Account correction sends only changed fields and preserves unrelated saved addresses', async () => {
  const application = app({ queues: { 'PATCH /api/users/customer-622': [response({ ...user, name: 'نام اصلاح‌شده' })] } })
  await open(application)
  change(application, input(application, user.name), 'نام اصلاح‌شده')
  await submit(application); application.render(); await settle(); application.render()
  const body = JSON.parse(patch(application)[0].body)
  assert.deepEqual(body, { name: 'نام اصلاح‌شده' })
  assert.match(text(application.tree), /تغییرات کاربر ذخیره شد/)
  assert.equal(application.requests.filter(request => !request.method && request.url.endsWith('customer-622')).length, 2)
  application.unmount()
})

test('Resetting a password requires explicit confirmation; failed saves preserve the draft', async () => {
  const application = app({ queues: { 'PATCH /api/users/customer-622': [response({ error: 'حساب مدیر آخر قابل تغییر نیست' }, 409), response(user)] } })
  await open(application)
  change(application, find(application, node => node.type === 'input' && node.props.type === 'password'), 'changed-password')
  assert.equal(button(application, 'ذخیره تغییرات').props.disabled, true)
  await submit(application)
  assert.equal(patch(application).length, 0)
  const confirmation = find(application, node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === false)
  confirmation.props.onChange({ target: { checked: true } }); application.render()
  await submit(application); application.render(); await settle(); application.render()
  assert.equal(JSON.parse(patch(application)[0].body).newPassword, 'changed-password')
  assert.equal(find(application, node => node.type === 'input' && node.props.type === 'password').props.value, 'changed-password')
  assert.match(text(application.tree), /حساب مدیر آخر قابل تغییر نیست/)
  await submit(application); application.render(); await settle(); application.render()
  assert.equal(patch(application).length, 2)
  assert.equal(find(application, node => node.type === 'input' && node.props.type === 'password').props.value, '')
  application.unmount()
})

test('Blocking requires confirmation and self-account role/activation controls are disabled', async () => {
  const application = app()
  await open(application)
  const active = find(application, node => node.type === 'input' && node.props.type === 'checkbox')
  active.props.onChange({ target: { checked: false } }); application.render()
  await submit(application)
  assert.equal(patch(application).length, 0)
  const confirmation = nodes(application.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').at(-1)
  confirmation.props.onChange({ target: { checked: true } }); application.render()
  await submit(application)
  assert.equal(JSON.parse(patch(application)[0].body).isActive, false)
  application.unmount()
  const self = app({ queues: { 'GET /api/users/customer-622': [response(detail({ isSelf: true }))] } })
  await open(self)
  assert.equal(find(self, node => node.type === 'input' && node.props.type === 'checkbox').props.disabled, true)
  assert.equal(find(self, node => node.type === 'select' && node.props.value === 'USER' && node.props.className === 'input-field').props.disabled, true)
  self.unmount()
})

test('Address edits preserve ownership ids and post only an intentional address replacement', async () => {
  const second = { ...address, id: 'address-2', title: 'دفتر', isDefault: false }
  const application = app({ queues: { 'GET /api/users/customer-622': [response(detail({ user: { ...user, addresses: [address, second] } }))] } })
  await open(application)
  button(application, 'نشانی‌ها').props.onClick(); application.render()
  const radios = nodes(application.tree).filter(node => node.type === 'input' && node.props.type === 'radio')
  radios[1].props.onChange(); application.render()
  await submit(application)
  const body = JSON.parse(patch(application)[0].body)
  assert.deepEqual(Object.keys(body), ['addresses', 'expectedAddresses'])
  assert.deepEqual(body.addresses.map(item => [item.id, item.isDefault]), [['address-1', false], ['address-2', true]])
  assert.deepEqual(body.expectedAddresses, [address, second])
  assert.equal(body.addresses[0].postalCode, user.postalCode)
  application.unmount()
})

test('Changing the current admin password redirects to login after its session is revoked', async () => {
  const application = app({ queues: { 'GET /api/users/customer-622': [response(detail({ isSelf: true }))], 'PATCH /api/users/customer-622': [response(user)] } })
  await open(application)
  change(application, find(application, node => node.type === 'input' && node.props.type === 'password'), 'new-password')
  const confirmation = nodes(application.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').at(-1)
  confirmation.props.onChange({ target: { checked: true } }); application.render()
  await submit(application); application.render()
  assert.deepEqual(application.navigations, ['/login'])
  assert.equal(application.requests.filter(request => !request.method && request.url.endsWith('customer-622')).length, 1)
  application.unmount()
})

test('Concurrent address conflicts preserve drafts and refresh only stale addresses', async () => {
  const freshAddress = { ...address, address: 'نشانی تازه از حساب کاربر' }
  const application = app({ queues: {
    'GET /api/users/customer-622': [response(detail()), response(detail({ user: { ...user, phone: '02112345678', addresses: [freshAddress] } }))],
    'PATCH /api/users/customer-622': [response({ error: 'نشانی‌های کاربر تغییر کرده‌اند', code: 'USER_ADDRESSES_CHANGED' }, 409), response(user)],
  } })
  await open(application)
  change(application, input(application, user.name), 'نام اصلاح‌شده')
  button(application, 'نشانی‌ها').props.onClick(); application.render()
  find(application, node => node.type === 'textarea').props.onChange({ target: { value: 'پیش‌نویس نشانی ادمین' } }); application.render()
  await submit(application); application.render()
  assert.equal(find(application, node => node.type === 'textarea').props.value, 'پیش‌نویس نشانی ادمین')
  assert.equal(button(application, 'ذخیره تغییرات').props.disabled, true)
  await button(application, 'بازخوانی نشانی‌ها').props.onClick(); application.render()
  assert.equal(find(application, node => node.type === 'textarea').props.value, freshAddress.address)
  assert.ok(input(application, 'نام اصلاح‌شده'))
  assert.ok(input(application, '02112345678'))
  await submit(application)
  const body = JSON.parse(patch(application)[1].body)
  assert.deepEqual(body, { name: 'نام اصلاح‌شده' })
  application.unmount()
})

test('Removing a default address chooses another default without erasing the account postal code', async () => {
  const application = app({ queues: { 'GET /api/users/customer-622': [response(detail({ user: { ...user, addresses: [address, { ...address, id: 'address-2', isDefault: false }] } }))] } })
  await open(application)
  button(application, 'نشانی‌ها').props.onClick(); application.render()
  find(application, node => node.props['aria-label'] === 'حذف نشانی 1').props.onClick(); application.render()
  await submit(application)
  const body = JSON.parse(patch(application)[0].body)
  assert.equal(body.addresses.length, 1)
  assert.equal(body.addresses[0].id, 'address-2')
  assert.equal(body.addresses[0].isDefault, true)
  assert.ok(!('postalCode' in body))
  application.unmount()
})

test('Support order history shows payment/tracking details and links to the selected order', async () => {
  const application = app()
  await open(application)
  button(application, 'سفارش‌ها و پرداخت‌ها').props.onClick(); application.render()
  const panel = find(application, node => node.props.id === 'support-panel-orders')
  assert.match(text(panel), /کفش پانیک مدل ۶۲۲/)
  assert.match(text(panel), /پرداخت تأییدشده/)
  assert.match(text(panel), /000123456789012345678901/)
  assert.ok(find(application, node => node.type === 'Link' && node.props.href === '/admin/orders?q=order-000001'))
  assert.ok(find(application, node => node.type === 'Link' && node.props.href === '/admin/payments?orderId=order-000001'))
  application.unmount()
})

test('Invalid account information is brought back into view before saving from another tab', async () => {
  const application = app()
  await open(application)
  change(application, input(application, user.email), 'invalid-email')
  button(application, 'نشانی‌ها').props.onClick(); application.render()
  await submit(application); application.render()
  assert.equal(patch(application).length, 0)
  assert.equal(find(application, node => node.props.id === 'support-panel-account').props.hidden, false)
  assert.equal(input(application, 'invalid-email').props.type, 'email')
  assert.match(text(application.tree), /نام و ایمیل معتبر لازم است/)
  application.unmount()
})

test('A malformed successful response does not silently claim the user draft was saved', async () => {
  const application = app({ queues: { 'PATCH /api/users/customer-622': [response(null)] } })
  await open(application)
  change(application, input(application, user.name), 'نام جدید')
  await submit(application); application.render()
  assert.match(text(application.tree), /پاسخ ذخیره معتبر نیست/)
  assert.ok(input(application, 'نام جدید'))
  assert.ok(!text(application.tree).includes('تغییرات کاربر ذخیره شد'))
  application.unmount()
})

test('Support detail loading can retry and closing aborts stale responses', async () => {
  const delayed = deferred()
  const application = app({ queues: { 'GET /api/users/customer-622': [response({ error: 'اطلاعات دریافت نشد' }, 503), () => delayed.promise] } })
  await open(application)
  assert.match(text(application.tree), /اطلاعات دریافت نشد/)
  button(application, 'تلاش دوباره').props.onClick(); application.render()
  find(application, node => node.props['aria-label'] === 'بستن فرم کاربر').props.onClick(); application.render()
  const writes = application.writes
  delayed.resolve(response(detail())); await settle()
  assert.equal(application.writes, writes)
  assert.ok(application.requests.filter(request => request.url.endsWith('customer-622')).every(request => request.signal.aborted))
  application.unmount()
})

test('Pending saves cannot be double-submitted and ignore late responses after unmount', async () => {
  const delayed = deferred()
  const application = app({ queues: { 'PATCH /api/users/customer-622': [() => delayed.promise] } })
  await open(application)
  change(application, input(application, user.name), 'نام جدید')
  const handler = find(application, node => node.type === 'form').props.onSubmit
  const first = handler({ preventDefault() {} }), second = handler({ preventDefault() {} })
  assert.equal(patch(application).length, 1)
  application.unmount()
  const writes = application.writes
  delayed.resolve(response(user)); await Promise.all([first, second])
  assert.equal(application.writes, writes)
  assert.equal(patch(application)[0].signal.aborted, true)
})

test('New account creation retains data after an API error, including postal code', async () => {
  const application = app({ queues: { 'POST /api/users': [response({ error: 'این ایمیل قبلاً ثبت شده است' }, 409)] } })
  await settle(); application.render()
  button(application, 'کاربر جدید').props.onClick(); application.render()
  const fields = nodes(application.tree).filter(node => node.type === 'input' && node.props.className === 'input-field')
  change(application, fields[0], 'کاربر جدید')
  change(application, find(application, node => node.type === 'input' && node.props.type === 'email'), 'duplicate@example.test')
  change(application, find(application, node => node.type === 'input' && node.props.type === 'password'), 'password-123')
  change(application, find(application, node => node.type === 'input' && node.props.inputMode === 'numeric'), '۱۲۳۴۵۶۷۸۹۰')
  await submit(application); application.render()
  const body = JSON.parse(application.requests.find(request => request.method === 'POST').body)
  assert.equal(body.postalCode, '۱۲۳۴۵۶۷۸۹۰')
  assert.equal(find(application, node => node.type === 'input' && node.props.type === 'email').props.value, 'duplicate@example.test')
  assert.match(text(application.tree), /این ایمیل قبلاً ثبت شده است/)
  application.unmount()
})
