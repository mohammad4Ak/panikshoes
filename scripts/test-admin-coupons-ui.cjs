const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const row = extra => ({ id: 'coupon-1', code: 'PANIK10', name: 'پیشنهاد پانیک', type: 'PERCENT', value: 10, maxDiscount: 50_000, minSubtotal: 100_000, maxUses: 20, perUserLimit: 1, startsAt: null, endsAt: null, isActive: true, usedCount: 3, version: 7, ...extra })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return tree === null || tree === undefined || typeof tree === 'boolean' ? '' : String(tree) }
function mount({ initial = [row()], queues = {} } = {}) {
  const slots = [], effects = [], timers = new Map(), requests = []
  let cursor = 0, tree, writes = 0, nextTimer = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies }; return slots[index].callback },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) }, '@/lib/utils': { formatPrice: String },
    '@/components/ui/FormattedNumberInput': { __esModule: true, default: ({ onValueChange, ...props }) => jsx('input', { ...props, type: 'text', 'data-formatted-number': true, onChange: event => onValueChange(event.target.value) }) },
    '@/components/ui/PersianDatePicker': { __esModule: true, default: ({ onChange, ...props }) => jsx('input', { ...props, type: 'text', 'data-persian-date': true, onChange: event => onChange(event.target.value) }) },
    './coupons.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }
  const result = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/coupons/page.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: result, AbortController, Date, Error, requestAnimationFrame(callback) { callback() },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options = {}) => { requests.push({ url, ...options }); const queue = queues[(options.method || 'GET') + ' ' + url] || queues[url]; const value = queue?.length ? queue.shift() : response(options.method ? row() : initial); if (value instanceof Error) throw value; return typeof value === 'function' ? value(options) : value },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  const render = () => { cursor = 0; tree = result.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, requests, get tree() { return tree }, get writes() { return writes }, flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()) }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node).trim() === label)
const field = (app, label) => nodes(find(app, node => node.type === 'label' && text(node).startsWith(label))).find(node => node.type === 'input' || node.type === 'select')
const form = app => find(app, node => node.type === 'form')
const writes = app => app.requests.filter(request => request.method)
const reads = app => app.requests.filter(request => !request.method)
async function flush(app) { await settle(); app.render() }
async function ready(options) { const app = mount(options); app.flushTimers(); await flush(app); return app }
function change(app, label, value) { field(app, label).props.onChange({ target: { value } }); app.render() }
const submit = app => form(app).props.onSubmit({ preventDefault() {} })

test('Coupon admin shows canonical usage and uses an uncached read', async () => {
  const app = await ready()
  assert.equal(reads(app)[0].cache, 'no-store'); assert.equal(nodes(app.tree).filter(node => node.type === 'article').length, 1)
  assert.match(text(app.tree), /PANIK10/); assert.match(text(app.tree), /3 از 20|۳ از ۲۰/)
  app.unmount()
})
test('A failed initial read shows its reason and retries without pretending there are no coupons', async () => {
  const app = await ready({ queues: { '/api/admin/coupons': [response({ error: 'سرویس در دسترس نیست' }, 503), response([row()])] } })
  assert.match(text(app.tree), /سرویس در دسترس نیست/); assert.ok(!text(app.tree).includes('هنوز کد تخفیفی تعریف نشده'))
  button(app, 'تازه‌سازی فهرست').props.onClick(); await flush(app)
  assert.equal(find(app, node => node.props.role === 'alert'), undefined); assert.match(text(app.tree), /PANIK10/)
  app.unmount()
})
test('Create sends normalized code, numeric fixed amount and optional limits/dates without a client usage count', async () => {
  const app = await ready(); button(app, 'کد تخفیف جدید').props.onClick(); app.render()
  change(app, 'عنوان', 'پیشنهاد خرید'); change(app, 'کد تخفیف', ' panik-new '); change(app, 'نوع تخفیف', 'FIXED')
  change(app, 'مبلغ تخفیف', '50000'); change(app, 'حداقل خرید', '100000'); change(app, 'حداکثر استفادهٔ کل', '')
  await submit(app); await flush(app)
  const command = writes(app)[0], payload = JSON.parse(command.body)
  assert.equal(command.method, 'POST'); assert.equal(command.url, '/api/admin/coupons')
  assert.equal(payload.code, 'PANIK-NEW'); assert.equal(payload.value, 50000); assert.equal(payload.minSubtotal, 100000)
  assert.equal(payload.maxDiscount, null); assert.equal(payload.maxUses, null); assert.equal(payload.startsAt, null); assert.equal(payload.endsAt, null)
  assert.equal(payload.expectedVersion, undefined); assert.equal(payload.usedCount, undefined); assert.equal(form(app), undefined)
  app.unmount()
})
test('Editing sends the exact current version and clearing the percentage cap stays explicit', async () => {
  const app = await ready(); button(app, 'ویرایش').props.onClick(); app.render()
  assert.equal(field(app, 'درصد تخفیف').props.value, '10'); assert.equal(field(app, 'سقف مبلغ تخفیف').props.value, '50000')
  change(app, 'درصد تخفیف', '15'); change(app, 'سقف مبلغ تخفیف', '')
  await submit(app); await flush(app)
  const command = writes(app)[0], payload = JSON.parse(command.body)
  assert.equal(command.method, 'PUT'); assert.equal(command.url, '/api/admin/coupons/coupon-1'); assert.equal(payload.expectedVersion, 7); assert.equal(payload.value, 15); assert.equal(payload.maxDiscount, null)
  app.unmount()
})
test('Coupon schedules use Persian date/time selectors and all numeric fields delegate grouping without changing stored numbers', async () => {
  const app = await ready({ queues: { 'PUT /api/admin/coupons/coupon-1': [response(row({ version: 8 }))] } })
  button(app, 'ویرایش').props.onClick(); app.render()
  const numeric = nodes(app.tree).filter(node => node.props['data-formatted-number'])
  assert.equal(numeric.length, 5); assert.ok(numeric.every(node => node.props.grouping !== false))
  const dates = nodes(app.tree).filter(node => node.props['data-persian-date'])
  assert.equal(dates.length, 2); assert.ok(dates.every(node => node.props.includeTime === true))
  assert.equal(find(app, node => node.props.htmlFor === 'coupon-start-date')?.type, 'label')
  assert.equal(find(app, node => node.props.htmlFor === 'coupon-end-date')?.type, 'label')
  find(app, node => node.props.id === 'coupon-start-date').props.onChange({ target: { value: '2026-10-15T12:30' } }); app.render()
  find(app, node => node.props.id === 'coupon-end-date').props.onChange({ target: { value: '2026-10-16T18:45' } }); app.render()
  change(app, 'حداقل خرید', '1500000'); change(app, 'حداکثر استفادهٔ کل', '12000')
  await submit(app); await flush(app)
  const payload = JSON.parse(writes(app)[0].body)
  assert.equal(payload.startsAt, new Date('2026-10-15T12:30').toISOString()); assert.equal(payload.endsAt, new Date('2026-10-16T18:45').toISOString())
  assert.equal(payload.minSubtotal, 1500000); assert.equal(payload.maxUses, 12000); app.unmount()
})
test('A revision conflict preserves the edited draft and explains how to refresh', async () => {
  const app = await ready({ queues: { 'PUT /api/admin/coupons/coupon-1': [response({ error: 'این کد هم‌زمان تغییر کرده است؛ دوباره ویرایش کنید' }, 409)] } })
  button(app, 'ویرایش').props.onClick(); app.render(); change(app, 'عنوان', 'پیش‌نویس حفظ شود')
  await submit(app); await flush(app)
  assert.equal(field(app, 'عنوان').props.value, 'پیش‌نویس حفظ شود'); assert.match(text(find(app, node => node.props.role === 'alert')), /هم‌زمان تغییر/)
  assert.equal(reads(app).length, 1); app.unmount()
})
test('The synchronous write lock blocks double submit and disables the form until completion', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve })
  const app = await ready({ queues: { 'PUT /api/admin/coupons/coupon-1': [() => pending] } })
  button(app, 'ویرایش').props.onClick(); app.render()
  const first = submit(app); const second = submit(app); app.render()
  assert.equal(writes(app).length, 1); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, true)
  complete(response(row({ version: 8 }))); await Promise.all([first, second]); await flush(app)
  assert.equal(form(app), undefined); app.unmount()
})
test('Deletion requires an explicit confirmation and sends its version without deleting on initial click', async () => {
  const app = await ready()
  find(app, node => node.type === 'button' && node.props['aria-label'] === 'حذف کد PANIK10').props.onClick(); app.render()
  assert.equal(writes(app).length, 0); assert.ok(find(app, node => node.props.role === 'group' && node.props['aria-label'] === 'تأیید حذف PANIK10'))
  await button(app, 'بله، حذف شود').props.onClick(); await flush(app)
  assert.equal(writes(app)[0].method, 'DELETE'); assert.deepEqual(JSON.parse(writes(app)[0].body), { expectedVersion: 7 })
  assert.match(text(find(app, node => node.props.role === 'status')), /سوابق سفارش/); app.unmount()
})
test('Unmount aborts pending reads and suppresses late updates', async () => {
  let complete; const pending = new Promise(resolve => { complete = resolve })
  const app = mount({ queues: { '/api/admin/coupons': [() => pending] } }); app.flushTimers(); app.render(); app.unmount()
  const before = app.writes; assert.equal(reads(app)[0].signal.aborted, true)
  complete(response([row()])); await settle(); assert.equal(app.writes, before)
})
