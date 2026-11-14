const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const base = '/api/admin/inventory/import/'
const storageKey = (userId = 'admin-a') => `panik-warehouse-import-pending-v1:${encodeURIComponent(userId)}`
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const cells = values => values.map(text => ({ text }))
const sheet = (extra = {}) => ({ name: 'موجودی', columnCount: 4, rows: [{ rowNumber: 1, cells: cells(['کد محصول', 'سایز', 'رنگ', 'تعداد']) }, { rowNumber: 2, cells: cells(['PN-001', '38', 'مشکی', '5']) }], ...extra })
const preview = (extra = {}) => ({ token: 'signed-preview-1', expiresAt: Date.now() + 600000, rows: [{ rowNumber: 2, code: 'PN-001', size: 38, color: 'مشکی', quantity: 5, productId: 'p1', variantId: 'v1', productName: 'مدل اول', inventoryVersion: 3, stockBefore: 8, stockAfter: 13, reserved: 3, damaged: 0, isActive: false }], products: [{ productId: 'p1', productName: 'مدل اول', code: 'PN-001', inventoryVersion: 3, rowNumbers: [2] }], summary: { total: 1, valid: 1, invalid: 0, products: 1 }, ...extra })
const confirmation = (productId = 'p1', rowNumber = 2, status = 'success', extra = {}) => ({ productId, results: [{ rowNumber, productId, variantId: `v${rowNumber - 1}`, status, stockBefore: 8, stockAfter: 13, ...extra }], totals: { success: status === 'success' ? 1 : 0, replayed: status === 'replayed' ? 1 : 0, error: status === 'error' ? 1 : 0 } })
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const visibleNodes = tree => Array.isArray(tree) ? tree.flatMap(visibleNodes) : tree?.props && !tree.props.hidden ? [tree, ...visibleNodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && text(node).trim() === label)
const field = (app, label) => nodes(find(app, node => node.type === 'label' && text(node).startsWith(label))).find(node => ['input', 'select'].includes(node.type))
const mutations = app => app.requests.filter(request => request.url === base + 'confirm')
const manualEditor = app => find(app, node => node.type === 'manual-entry')
const manualRows = (extra = {}) => [{ rowNumber: 2, code: 'PN-001', size: '38', color: 'مشکی', quantity: '5', ...extra }]

function mount({ queues = {}, storage = new Map(), props = {}, userId = 'admin-a' } = {}) {
  const slots = [], effects = [], requests = [], timers = new Map(), events = new Map(), busyEvents = []
  let cursor = 0, tree, timerId = 0, writes = 0, completed = 0, recovered = 0, currentUserId = userId, contentKey, contentRendered
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies }; return slots[index].callback },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies }; effects.push(() => { slots[index].cleanup = callback() }) } },
  }
  const cleanup = () => { slots.forEach(slot => slot?.cleanup?.()); slots.length = 0; effects.length = 0; cursor = 0 }
  const jsx = (type, props, key) => {
    if (typeof type !== 'function') return { type, props, key }
    if (type.name === 'WarehouseImportContent') {
      contentRendered = true
      if (contentKey !== key) { cleanup(); contentKey = key }
    }
    return type(props)
  }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const contract = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/warehouse-import-contract.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, { module: contract })
  const dependencies = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => name }), '@/components/ui/EnhancedSelect': { __esModule: true, default: props => jsx('select', props) }, '@/components/admin/WarehouseManualEntry': { __esModule: true, default: 'manual-entry' }, '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session: currentUserId ? { user: { id: currentUserId } } : null }) }, '@/lib/warehouse-import-contract': contract.exports, './warehouse-import.module.css': css }
  class FormData { constructor() { this.values = new Map() } set(key, value) { this.values.set(key, value) } }
  const result = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/WarehouseImport.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: result, AbortController, Date, Error, TypeError, FormData, Set,
    window: { addEventListener(name, callback) { events.set(name, callback) }, removeEventListener(name) { events.delete(name) } },
    sessionStorage: { getItem(key) { return storage.get(key) ?? null }, setItem(key, value) { storage.set(key, value) }, removeItem(key) { storage.delete(key) } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id }, clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options })
      const value = queues[url]?.length ? queues[url].shift() : response(url.endsWith('workbook') ? { sheets: [sheet()] } : url.endsWith('preview') ? preview() : confirmation())
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value(options) : value
    },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  let currentProps = { open: true, onClose() {}, onRecovery() { recovered++ }, onBusyChange(value) { busyEvents.push(value) }, async onCompleted() { completed++ }, ...props }
  const render = () => { cursor = 0; contentRendered = false; tree = result.exports.default(currentProps); if (!contentRendered && contentKey !== undefined) { cleanup(); contentKey = undefined } effects.splice(0).forEach(effect => effect()); return tree }
  render()
  const app = { render, requests, storage, events, busyEvents, get tree() { return tree }, get writes() { return writes }, get completed() { return completed }, get recovered() { return recovered }, setUserId(value) { currentUserId = value; render() }, setProps(value) { currentProps = { ...currentProps, ...value }; render() }, flushTimers(maximum = 0) { const pending = [...timers.entries()].filter(([, timer]) => timer.delay <= maximum); pending.forEach(([id]) => timers.delete(id)); pending.forEach(([, timer]) => timer.callback()); render() }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
  app.flushTimers()
  return app
}
async function flush(app) { await settle(); app.render() }
function change(app, label, value) { const node = field(app, label); assert.ok(node, label); node.props.onChange({ target: { value } }); app.render() }
function selectMethod(app, method) { const option = button(app, method === 'excel' ? 'فایل اکسل' : 'ورود داخل پنل'); assert.ok(option); option.props.onClick(); app.render() }
function editManual(app, rows = manualRows()) { const editor = manualEditor(app); assert.ok(editor); editor.props.onChange(rows); app.render() }
async function upload(app, file = { name: 'inventory.xlsx', size: 1234 }) { if (button(app, 'فایل اکسل').props['aria-pressed'] !== true) selectMethod(app, 'excel'); find(app, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [file], value: file.name } }); await flush(app) }
async function makePreview(app) { await find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush(app) }
function acknowledge(app) { find(app, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); app.render() }
async function ready(options) { const app = mount(options); await upload(app); change(app, 'علت یا توضیح', 'ورود تولید آبان'); await makePreview(app); return app }
async function manualReady(options, rows = manualRows()) { const app = mount(options); editManual(app, rows); change(app, 'علت یا توضیح', 'ورود تولید آبان'); await makePreview(app); return app }
function confirm(app) { button(app, 'تأیید و ثبت ۱ ردیف معتبر').props.onClick(); app.render() }

test('Direct entry is the default and sends canonical source rows through the shared preview and signed confirmation', async () => {
  const app = mount()
  const methods = find(app, node => node.props.role === 'group' && node.props['aria-label'] === 'روش ورود اطلاعات')
  assert.ok(methods); assert.equal(button(app, 'ورود داخل پنل').props['aria-pressed'], true); assert.equal(button(app, 'فایل اکسل').props['aria-pressed'], false)
  assert.ok(manualEditor(app)); assert.equal(visibleNodes(app.tree).find(node => node.type === 'input' && node.props.type === 'file'), undefined)
  assert.equal(app.requests.length, 0); assert.equal(button(app, 'بررسی و پیش‌نمایش').props.disabled, true)
  editManual(app); await makePreview(app)
  assert.equal(app.requests.length, 0); assert.match(text(app.tree), /علت یا توضیح مشترک/)
  change(app, 'علت یا توضیح', ' ورود داخل پنل '); await makePreview(app)
  assert.deepEqual(app.requests.map(request => request.url), [base + 'preview'])
  assert.deepEqual(JSON.parse(app.requests[0].body), { mode: 'RECEIPT', note: 'ورود داخل پنل', rows: manualRows() })
  acknowledge(app); confirm(app); await flush(app)
  assert.deepEqual(JSON.parse(mutations(app)[0].body), { token: 'signed-preview-1', productId: 'p1' }); assert.equal(app.completed, 1)
  assert.equal(manualEditor(app).props.disabled, true); app.unmount()
})

test('Direct edits and method switches clear the signed preview and acknowledgment', async () => {
  const app = await manualReady()
  acknowledge(app); editManual(app, manualRows({ quantity: '7' }))
  assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined)
  await makePreview(app)
  assert.equal(JSON.parse(app.requests.at(-1).body).rows[0].quantity, '7')
  assert.equal(find(app, node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false)
  acknowledge(app); selectMethod(app, 'excel')
  assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined); assert.equal(button(app, 'فایل اکسل').props['aria-pressed'], true)
  await upload(app); await makePreview(app)
  assert.deepEqual(JSON.parse(app.requests.at(-1).body).rows, manualRows())
  acknowledge(app)
  selectMethod(app, 'manual')
  assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined); assert.ok(manualEditor(app)); assert.equal(mutations(app).length, 0)
  await makePreview(app); assert.deepEqual(JSON.parse(app.requests.at(-1).body).rows, manualRows({ quantity: '7' }))
  assert.equal(find(app, node => node.type === 'input' && node.props.type === 'checkbox').props.checked, false)
  app.unmount()
})

test('Incomplete direct rows retain their source errors and cannot authorize stock writes', async () => {
  const incomplete = manualRows({ size: '', color: '', quantity: '', sourceError: 'رنگ، سایز و تعداد را تکمیل کنید.' })
  const invalid = preview({ rows: [{ rowNumber: 2, code: 'PN-001', size: null, color: '', quantity: null, error: incomplete[0].sourceError }], products: [], summary: { total: 1, valid: 0, invalid: 1, products: 0 } })
  const app = await manualReady({ queues: { [base + 'preview']: [response(invalid)] } }, incomplete)
  assert.deepEqual(JSON.parse(app.requests[0].body).rows, incomplete)
  assert.match(text(app.tree), /قابل ثبت نیست: رنگ، سایز و تعداد را تکمیل کنید/)
  assert.equal(find(app, node => node.type === 'input' && node.props.type === 'checkbox').props.disabled, true)
  const action = button(app, 'تأیید و ثبت ۰ ردیف معتبر'); assert.equal(action.props.disabled, true)
  action.props.onClick(); await flush(app); assert.equal(mutations(app).length, 0); app.unmount()
})

test('Preview locks methods and ignores direct edits before React renders the busy state', async () => {
  const loading = deferred(), app = mount({ queues: { [base + 'preview']: [() => loading.promise] } })
  editManual(app); change(app, 'علت یا توضیح', 'ورود')
  const chooseExcel = button(app, 'فایل اکسل').props.onClick, edit = manualEditor(app).props.onChange
  const pendingPreview = makePreview(app)
  chooseExcel(); edit(manualRows({ quantity: '99' })); app.render()
  assert.equal(button(app, 'ورود داخل پنل').props['aria-pressed'], true); assert.equal(button(app, 'فایل اکسل').props.disabled, true); assert.equal(manualEditor(app).props.disabled, true)
  assert.equal(JSON.parse(app.requests[0].body).rows[0].quantity, '5')
  loading.resolve(response(preview())); await pendingPreview; await flush(app)
  assert.ok(button(app, 'تأیید و ثبت ۱ ردیف معتبر')); assert.equal(button(app, 'ورود داخل پنل').props['aria-pressed'], true)
  app.unmount()
})

test('Direct stocktaking forwards an explicit zero and does not add unselected rows', async () => {
  const zero = preview({ rows: [{ ...preview().rows[0], quantity: 0, stockAfter: 0 }] })
  const app = mount({ queues: { [base + 'preview']: [response(zero)] } })
  change(app, 'نوع عملیات', 'ADJUSTMENT'); change(app, 'علت یا توضیح', 'شمارش'); editManual(app, manualRows({ quantity: '0' })); await makePreview(app)
  assert.deepEqual(JSON.parse(app.requests[0].body), { mode: 'ADJUSTMENT', note: 'شمارش', rows: manualRows({ quantity: '0' }) })
  assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر').props.disabled, true); assert.match(text(app.tree), /رزرو سفارش‌ها را در این عدد حساب نکنید/)
  app.unmount()
})

test('Starting a fresh direct entry remounts the editor and clears its previous source rows', async () => {
  const app = await manualReady(), oldEditorKey = manualEditor(app).key
  button(app, 'پاک‌کردن و شروع ورود تازه').props.onClick(); app.render()
  assert.notEqual(manualEditor(app).key, oldEditorKey); assert.equal(button(app, 'بررسی و پیش‌نمایش').props.disabled, true)
  assert.equal(field(app, 'علت یا توضیح').props.value, ''); assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined)
  change(app, 'علت یا توضیح', 'ورود تازه'); const requestCount = app.requests.length; await makePreview(app)
  assert.equal(app.requests.length, requestCount); app.unmount()
})

test('Closing and reopening the panel retains the manual source and editor instance', async () => {
  const app = mount(); editManual(app); change(app, 'علت یا توضیح', 'ورود')
  const key = manualEditor(app).key
  app.setProps({ open: false })
  assert.equal(find(app, node => node.type === 'section').props.hidden, true); assert.equal(manualEditor(app).key, key)
  app.setProps({ open: true }); assert.equal(find(app, node => node.type === 'section').props.hidden, false)
  assert.equal(manualEditor(app).key, key); await makePreview(app)
  assert.deepEqual(JSON.parse(app.requests[0].body).rows, manualRows()); app.unmount()
})

test('A pending direct entry restores the same signed preview without writes and keeps methods locked until explicit retry', async () => {
  const storage = new Map(), app = await manualReady({ storage, queues: { [base + 'confirm']: [new TypeError('lost')] } })
  acknowledge(app); confirm(app); await flush(app)
  const saved = JSON.parse(storage.get(storageKey()))
  assert.equal(saved.entryMethod, 'manual'); assert.equal(saved.preview.token, 'signed-preview-1')
  selectMethod(app, 'excel'); editManual(app, manualRows({ quantity: '99' }))
  assert.equal(button(app, 'ورود داخل پنل').props['aria-pressed'], true); assert.equal(manualEditor(app).props.disabled, true)
  assert.equal(app.requests.filter(request => request.url === base + 'preview').length, 1); app.unmount()
  const restored = mount({ storage, queues: { [base + 'confirm']: [response(confirmation('p1', 2, 'replayed'))] } })
  assert.equal(restored.recovered, 1); assert.equal(restored.requests.length, 0); assert.equal(button(restored, 'ورود داخل پنل').props['aria-pressed'], true)
  assert.equal(manualEditor(restored).props.disabled, true); assert.equal(button(restored, 'فایل اکسل').props.disabled, true)
  button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
  assert.deepEqual(JSON.parse(mutations(restored)[0].body), { token: saved.preview.token, productId: saved.pendingProductId })
  assert.equal(storage.size, 0); assert.equal(restored.completed, 1); assert.match(text(restored.tree), /قبلاً ثبت شده/); restored.unmount()
})

test('An externally disabled panel cannot change its source or start a preview', async () => {
  const app = mount(); editManual(app); change(app, 'علت یا توضیح', 'ورود')
  app.setProps({ disabled: true })
  assert.equal(manualEditor(app).props.disabled, true); assert.equal(button(app, 'فایل اکسل').props.disabled, true)
  editManual(app, manualRows({ quantity: '99' })); selectMethod(app, 'excel'); await makePreview(app)
  assert.equal(app.requests.length, 0); assert.equal(button(app, 'ورود داخل پنل').props['aria-pressed'], true)
  app.setProps({ disabled: false }); await makePreview(app)
  assert.deepEqual(JSON.parse(app.requests[0].body).rows, manualRows()); app.unmount()
})

test('Legacy scoped recovery restores its Excel method without issuing a fresh preview', () => {
  const saved = { version: 1, preview: preview(), mode: 'RECEIPT', note: 'ورود قدیمی', fileName: 'stock.xlsx', results: {}, pendingProductId: 'p1' }
  const app = mount({ storage: new Map([[storageKey(), JSON.stringify(saved)]]) })
  assert.equal(app.recovered, 1); assert.equal(app.requests.length, 0); assert.equal(button(app, 'فایل اکسل').props['aria-pressed'], true)
  assert.ok(button(app, 'پیگیری دوبارهٔ همان عملیات')); app.unmount()
})

test('Template upload requires reason, uses canonical string rows and exposes reservation-safe adjustment semantics', async () => {
  const app = mount()
  selectMethod(app, 'excel')
  assert.equal(find(app, node => node.type === 'a').props.href, base + 'workbook')
  await upload(app); await makePreview(app)
  assert.equal(app.requests.length, 1); assert.match(text(app.tree), /علت یا توضیح مشترک/)
  change(app, 'نوع عملیات', 'ADJUSTMENT'); change(app, 'علت یا توضیح', ' شمارش موجودی '); await makePreview(app)
  const payload = JSON.parse(app.requests.at(-1).body)
  assert.equal(payload.mode, 'ADJUSTMENT'); assert.equal(payload.note, 'شمارش موجودی'); assert.deepEqual(payload.rows, [{ rowNumber: 2, code: 'PN-001', size: '38', color: 'مشکی', quantity: '5' }])
  assert.match(text(app.tree), /رزرو سفارش‌ها را در این عدد حساب نکنید/); assert.match(text(app.tree), /تنوع غیرفعال است؛ این ورود آن را فعال نمی‌کند/)
  const headers = nodes(app.tree).filter(node => node.type === 'th').map(text)
  assert.deepEqual(headers.slice(3, 7), ['قابل فروش قبل', 'رزرو', 'معیوب (بدون تغییر)', 'نهایی قابل فروش'])
  assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر').props.disabled, true)
  confirm(app); assert.equal(mutations(app).length, 0)
  acknowledge(app); confirm(app); await flush(app)
  assert.equal(mutations(app).length, 1); assert.deepEqual(JSON.parse(mutations(app)[0].body), { token: 'signed-preview-1', productId: 'p1' }); assert.equal(app.completed, 1)
  assert.match(text(app.tree), /ثبت شد؛ قفل‌شده/); app.unmount()
})

test('Source errors and numeric product codes survive workbook mapping; wrong headers never preview', async () => {
  const badSheet = sheet({ rows: [sheet().rows[0], { rowNumber: 4, cells: [{ text: '001', numeric: true }, { text: '38' }, { text: 'مشکی' }, { text: '=5', error: 'فرمول مجاز نیست' }] }] })
  const app = mount({ queues: { [base + 'workbook']: [response({ sheets: [badSheet] })] } })
  await upload(app); change(app, 'علت یا توضیح', 'ورود'); await makePreview(app)
  assert.match(JSON.parse(app.requests.at(-1).body).rows[0].sourceError, /فرمول مجاز نیست.*کد محصول باید/)
  app.unmount()
  const invalid = mount({ queues: { [base + 'workbook']: [response({ sheets: [sheet({ rows: [{ rowNumber: 1, cells: cells(['کد محصول', 'سایز', 'رنگ', 'رنگ']) }, sheet().rows[1]] })] })] } })
  await upload(invalid); change(invalid, 'علت یا توضیح', 'ورود'); await makePreview(invalid)
  assert.equal(invalid.requests.length, 1); assert.match(text(invalid.tree), /عنوان ستون‌ها باید فقط یک بار/); invalid.unmount()
})

test('Changing mode, reason, sheet or file invalidates preview and acknowledgment', async () => {
  const app = await ready({ queues: { [base + 'workbook']: [response({ sheets: [sheet(), sheet({ name: 'برگه دوم' })] })] } })
  acknowledge(app); change(app, 'نوع عملیات', 'ADJUSTMENT'); assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined)
  await makePreview(app); acknowledge(app); change(app, 'علت یا توضیح', 'شمارش تازه'); assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined)
  await makePreview(app); change(app, 'برگهٔ اکسل', '1'); assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined)
  await makePreview(app); await upload(app, { name: 'bad.csv', size: 1 }); assert.equal(button(app, 'تأیید و ثبت ۱ ردیف معتبر'), undefined); assert.match(text(app.tree), /یک فایل xlsx/)
  app.unmount()
})

test('Valid-only acknowledgment shows skipped count and confirms atomic product groups sequentially', async () => {
  const first = deferred()
  const secondRow = { ...preview().rows[0], rowNumber: 3, productId: 'p2', variantId: 'v2', code: 'PN-002', productName: 'مدل دوم' }
  const data = preview({ rows: [...preview().rows, secondRow, { rowNumber: 4, code: 'missing', color: '', size: null, quantity: null, error: 'کد ناشناخته' }], products: [...preview().products, { productId: 'p2', productName: 'مدل دوم', code: 'PN-002', inventoryVersion: 1, rowNumbers: [3] }], summary: { total: 3, valid: 2, invalid: 1, products: 2 } })
  const app = await ready({ queues: { [base + 'preview']: [response(data)], [base + 'confirm']: [() => first.promise, response(confirmation('p2', 3, 'error', { error: 'موجودی تغییر کرده است' }))] } })
  assert.match(text(app.tree), /۱ ردیف خطادار ثبت نمی‌شود و فقط ۲ ردیف معتبر/)
  acknowledge(app); const action = button(app, 'تأیید و ثبت ۲ ردیف معتبر'); action.props.onClick(); action.props.onClick(); app.render()
  assert.equal(mutations(app).length, 1); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, true)
  first.resolve(response(confirmation())); await flush(app)
  assert.equal(mutations(app).length, 2); assert.deepEqual(mutations(app).map(request => JSON.parse(request.body).productId), ['p1', 'p2'])
  assert.match(text(app.tree), /ثبت شد؛ قفل‌شده/); assert.match(text(app.tree), /ثبت نشد: موجودی تغییر کرده است/); assert.match(text(app.tree), /کد ناشناخته/); assert.equal(app.completed, 1)
  app.unmount()
})

test('Unknown response locks inputs, persists exact operation, and only explicit retry reconciles it', async () => {
  const app = await ready({ queues: { [base + 'confirm']: [new TypeError('lost'), response(confirmation('p1', 2, 'replayed'))] } })
  acknowledge(app); confirm(app); await flush(app)
  assert.equal(mutations(app).length, 1); assert.equal(app.storage.size, 1); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, true)
  assert.equal(button(app, 'پاک‌کردن و شروع ورود تازه'), undefined); assert.equal(button(app, 'بستن ورود گروهی'), undefined)
  const before = app.requests.length; change(app, 'نوع عملیات', 'ADJUSTMENT'); await makePreview(app); assert.equal(app.requests.length, before)
  assert.equal(field(app, 'نوع عملیات').props.value, 'RECEIPT'); assert.equal(app.busyEvents.at(-1), true)
  let prevented = false; app.events.get('beforeunload')({ preventDefault() { prevented = true } }); assert.equal(prevented, true)
  button(app, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(app)
  assert.deepEqual(mutations(app).map(request => JSON.parse(request.body)), [{ token: 'signed-preview-1', productId: 'p1' }, { token: 'signed-preview-1', productId: 'p1' }])
  assert.match(text(app.tree), /قبلاً ثبت شده؛ دوباره اعمال نشد/); assert.equal(app.storage.size, 0); assert.equal(app.completed, 1); assert.equal(app.busyEvents.at(-1), false)
  app.unmount()
})

test('Reload restores a pending operation without writing; unauthenticated retry cannot erase unknown result', async () => {
  const storage = new Map()
  const app = await ready({ storage, queues: { [base + 'confirm']: [new TypeError('lost')] } })
  acknowledge(app); confirm(app); await flush(app); app.unmount()
  const restored = mount({ storage, queues: { [base + 'confirm']: [response({ error: 'دوباره وارد حساب شوید' }, 401), response(confirmation('p1', 2, 'replayed'))] } })
  assert.equal(restored.recovered, 1); assert.equal(restored.requests.length, 0)
  button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
  assert.equal(storage.size, 1); assert.ok(button(restored, 'پیگیری دوبارهٔ همان عملیات')); assert.equal(button(restored, 'پاک‌کردن و شروع ورود تازه'), undefined)
  button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
  assert.equal(storage.size, 0); assert.match(text(restored.tree), /قبلاً ثبت شده/); restored.unmount()
})

test('After reconciling an unknown group, remaining groups require explicit continuation and skip successes', async () => {
  const data = preview({ rows: [...preview().rows, { ...preview().rows[0], rowNumber: 3, productId: 'p2', variantId: 'v2' }], products: [...preview().products, { ...preview().products[0], productId: 'p2', rowNumbers: [3] }], summary: { total: 2, valid: 2, invalid: 0, products: 2 } })
  const storage = new Map()
  const app = await ready({ storage, queues: { [base + 'preview']: [response(data)], [base + 'confirm']: [new TypeError('lost')] } })
  acknowledge(app); button(app, 'تأیید و ثبت ۲ ردیف معتبر').props.onClick(); await flush(app); app.unmount()
  const restored = mount({ storage, queues: { [base + 'confirm']: [response(confirmation('p1', 2, 'replayed')), response(confirmation('p2', 3))] } })
  button(restored, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restored)
  assert.equal(mutations(restored).length, 1); assert.equal(find(restored, node => node.type === 'fieldset').props.disabled, true)
  button(restored, 'تأیید و ادامهٔ ثبت ۱ ردیف باقیمانده').props.onClick(); await flush(restored)
  assert.deepEqual(mutations(restored).map(request => JSON.parse(request.body).productId), ['p1', 'p2']); restored.unmount()
})

test('Malformed success and server errors are uncertain, while fresh validation rejection reports known no-write', async () => {
  for (const result of [response({ productId: 'p1', results: [] }), response({ error: 'سرور قطع است' }, 503)]) {
    const app = await ready({ queues: { [base + 'confirm']: [result] } }); acknowledge(app); confirm(app); await flush(app)
    assert.equal(app.storage.size, 1); assert.ok(button(app, 'پیگیری دوبارهٔ همان عملیات')); app.unmount()
  }
  const app = await ready({ queues: { [base + 'confirm']: [response({ error: 'پیش‌نمایش نامعتبر است' }, 400)] } }); acknowledge(app); confirm(app); await flush(app)
  assert.equal(app.storage.size, 0); assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined); assert.match(text(app.tree), /ثبت نشد: پیش‌نمایش نامعتبر است/); app.unmount()
})

test('Unmount aborts read and write requests, suppresses late updates, and retains pending write recovery', async () => {
  const loading = deferred()
  const reader = mount({ queues: { [base + 'workbook']: [() => loading.promise] } })
  const uploadTask = upload(reader); reader.unmount(); const before = reader.writes
  assert.equal(reader.requests[0].signal.aborted, true); loading.resolve(response({ sheets: [sheet()] })); await uploadTask; assert.equal(reader.writes, before)
  const writing = deferred(), app = await ready({ queues: { [base + 'confirm']: [() => writing.promise] } })
  acknowledge(app); confirm(app); assert.equal(app.storage.size, 1); app.unmount(); const beforeWrite = app.writes
  assert.equal(mutations(app)[0].signal.aborted, true); writing.resolve(response(confirmation())); await settle(); assert.equal(app.writes, beforeWrite); assert.equal(app.storage.size, 1)
})

test('An expired fresh preview never writes and can be replaced before confirmation starts', async () => {
  const app = await ready({ queues: { [base + 'preview']: [response(preview({ expiresAt: Date.now() - 1000 })), response(preview())] } })
  acknowledge(app); confirm(app); await flush(app); assert.equal(mutations(app).length, 0); assert.match(text(app.tree), /مهلت پیش‌نمایش تمام شده/)
  await makePreview(app); acknowledge(app); confirm(app); await flush(app); assert.equal(mutations(app).length, 1); app.unmount()
})

test('Malformed workbook, preview and local recovery data never render unsafe rows or authorize writes', async () => {
  const malformedWorkbook = mount({ queues: { [base + 'workbook']: [response({ sheets: [{ name: 'بد', columnCount: 4, rows: [null] }] })] } })
  await upload(malformedWorkbook); assert.match(text(malformedWorkbook.tree), /پاسخ آن کامل نیست/); malformedWorkbook.unmount()
  const badPreview = await ready({ queues: { [base + 'preview']: [response(preview({ rows: [null] }))] } })
  assert.match(text(badPreview.tree), /پیش‌نمایش کامل دریافت نشد/); assert.equal(button(badPreview, 'تأیید و ثبت ۱ ردیف معتبر'), undefined); badPreview.unmount()
  const valid = { version: 1, preview: preview(), mode: 'RECEIPT', note: 'ورود', fileName: 'stock.xlsx', results: {}, pendingProductId: 'p1' }
  for (const raw of ['broken-json', JSON.stringify({ ...valid, note: {} }), JSON.stringify({ ...valid, mode: 'SALE' }), JSON.stringify({ ...valid, entryMethod: 'other' }), JSON.stringify({ ...valid, results: [] }), JSON.stringify({ ...valid, preview: preview({ products: [{ ...preview().products[0], rowNumbers: [999] }] }) }), JSON.stringify({ ...valid, results: { 2: confirmation().results[0] } }), 'x'.repeat(2500001)]) {
    const storage = new Map([[storageKey(), raw]])
    const app = mount({ storage }); assert.equal(storage.size, 0); assert.equal(app.recovered, 0); assert.equal(app.requests.length, 0); assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined); app.unmount()
  }
})

test('New operation after success keeps the duplicate receipt warning visible for either input method', async () => {
  for (const prepare of [ready, manualReady]) {
    const app = await prepare(); acknowledge(app); confirm(app); await flush(app)
    assert.match(text(app.tree), /ثبت دوبارهٔ ردیف‌های موفق در حالت ورود کالا، موجودی آن‌ها را دوباره اضافه می‌کند/)
    button(app, 'پاک‌کردن و شروع ورود تازه').props.onClick(); app.render()
    assert.match(text(app.tree), /۱ ردیف از عملیات قبلی ثبت شده است/); assert.match(text(app.tree), /فقط ردیف‌های ثبت‌نشده را وارد یا بارگذاری کنید/)
    assert.equal(field(app, 'علت یا توضیح').props.value, ''); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, false); app.unmount()
  }
})

test('Recovery belongs to its administrator; a second administrator cannot see or retry the first pending import', async () => {
  const storage = new Map()
  const first = await ready({ storage, userId: 'admin-a', queues: { [base + 'confirm']: [new TypeError('lost A')] } })
  acknowledge(first); confirm(first); await flush(first); first.unmount()
  assert.ok(storage.has(storageKey('admin-a')))
  const second = await ready({ storage, userId: 'admin-b', queues: { [base + 'confirm']: [new TypeError('lost B')] } })
  assert.equal(second.recovered, 0); assert.equal(button(second, 'پیگیری دوبارهٔ همان عملیات'), undefined)
  acknowledge(second); confirm(second); await flush(second); assert.ok(storage.has(storageKey('admin-b'))); assert.equal(storage.size, 2); second.unmount()
  const restoredA = mount({ storage, userId: 'admin-a', queues: { [base + 'confirm']: [response(confirmation('p1', 2, 'replayed'))] } })
  assert.equal(restoredA.recovered, 1); assert.equal(restoredA.requests.length, 0)
  button(restoredA, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(restoredA)
  assert.equal(storage.has(storageKey('admin-a')), false); assert.equal(storage.has(storageKey('admin-b')), true); restoredA.unmount()
})

test('Identity change aborts old writes, preserves scoped recovery and releases the old busy lock', async () => {
  const writing = deferred(), storage = new Map()
  const app = await ready({ storage, queues: { [base + 'confirm']: [() => writing.promise, response(confirmation('p1', 2, 'replayed'))] } })
  acknowledge(app); confirm(app); assert.equal(app.busyEvents.at(-1), true)
  app.setUserId('admin-b'); app.flushTimers()
  assert.equal(mutations(app)[0].signal.aborted, true); assert.equal(app.busyEvents.at(-1), false); assert.equal(storage.has(storageKey('admin-a')), true)
  assert.equal(field(app, 'علت یا توضیح').props.value, ''); assert.equal(find(app, node => node.type === 'fieldset').props.disabled, false); assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined)
  const before = app.writes; writing.resolve(response(confirmation())); await settle(); assert.equal(app.writes, before); assert.equal(app.completed, 0)
  app.setUserId(null); assert.match(text(app.tree), /در حال بررسی حساب مدیر/); assert.equal(find(app, node => node.type === 'input'), undefined)
  app.setUserId('admin-a'); app.flushTimers(); assert.equal(app.recovered, 1); assert.equal(mutations(app).length, 1)
  button(app, 'پیگیری دوبارهٔ همان عملیات').props.onClick(); await flush(app); assert.equal(mutations(app).length, 2); assert.equal(storage.size, 0); app.unmount()
})

test('Missing session identity never restores a draft or offers file upload, and legacy unscoped recovery is ignored', () => {
  const storage = new Map([['panik-warehouse-import-pending-v1', JSON.stringify({ version: 1, preview: preview(), mode: 'RECEIPT', note: 'ورود مدیر دیگر', fileName: 'old.xlsx', results: {}, pendingProductId: 'p1' })]])
  const app = mount({ storage, userId: null })
  assert.match(text(app.tree), /در حال بررسی حساب مدیر/); assert.equal(app.requests.length, 0); assert.equal(app.recovered, 0)
  app.setUserId('admin-a'); app.flushTimers(); assert.equal(app.recovered, 0); assert.equal(button(app, 'پیگیری دوبارهٔ همان عملیات'), undefined); assert.equal(field(app, 'علت یا توضیح').props.value, ''); app.unmount()
})
