const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const componentFile = path.join(root, 'src/components/shop/InvoiceDownload.tsx')
// Embedded font streams contain arbitrary binary bytes; verify that the JSON
// transport preserves them, including NUL and values above ASCII's range.
const pdfBytes = Buffer.concat([
  Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0x80, 0xff]), Buffer.from('\ninvoice document\n%%EOF\n'),
])
const invoice = { id: 42, issuedAt: '2026-10-01T12:30:00.000Z' }
const nextTurn = () => new Promise(setImmediate)

function invoiceResponse(contentType = 'application/json', bytes = pdfBytes) {
  const body = Buffer.from(JSON.stringify({ pdf: Buffer.from(bytes).toString('base64') }))
  return new Response(new Uint8Array(body), {
    headers: contentType ? { 'Content-Type': contentType } : {},
  })
}

function jsonFailure(status, error) {
  return new Response(JSON.stringify({ error }), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree === undefined || tree === null || typeof tree === 'boolean' ? '' : String(tree)
}

// Run the shared component's real event handler and effects, retaining hook state
// between renders. Browser doubles record saved bytes rather than assuming that
// a fulfilled fetch or an anchor creation means a successful download.
function mount({ queue = [invoiceResponse()], props = {} } = {}) {
  const slots = [], effects = [], requests = [], downloads = [], urls = new Map(), timers = [], revoked = []
  let cursor = 0, tree, stateWrites = 0, nextUrl = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: initial }
      return [slots[index].value, (next) => {
        stateWrites++
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useId() { return `invoice-test-${cursor++}` },
    useEffect(effect) {
      const index = cursor++
      if (!(index in slots)) {
        slots[index] = {}
        effects.push(() => { slots[index].cleanup = effect() })
      }
    },
  }
  const document = {
    body: { appendChild(link) { link.connected = true } },
    createElement(tag) {
      assert.equal(tag, 'a')
      return {
        connected: false,
        click() {
          assert.equal(this.connected, true, 'Download links must be attached when activated')
          assert.ok(urls.has(this.href), 'The saved object URL must still exist')
          downloads.push({ name: this.download, file: urls.get(this.href), href: this.href })
        },
        remove() { this.connected = false },
      }
    },
  }
  const URL = {
    createObjectURL(file) {
      assert.ok(file instanceof Blob)
      const value = `blob:invoice-${++nextUrl}`
      urls.set(value, file)
      return value
    },
    revokeObjectURL(value) { revoked.push(value); urls.delete(value) },
  }
  const window = {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length },
  }
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options })
    assert.ok(queue.length, 'Unexpected extra invoice request')
    const result = queue.shift()
    if (result instanceof Error) throw result
    return typeof result === 'function' ? result(options) : result
  }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './invoice-download.module.css': css,
    '@/lib/invoice': { formatInvoiceNumber: () => 'INV-2026-000042' },
  }
  // An optional source path permits a one-off before/after check against the
  // previous component without editing the working application.
  const source = readFileSync(process.env.KATUNI_INVOICE_TEST_COMPONENT || componentFile, 'utf8')
  const { code } = transformSync(source, {
    loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic',
  })
  const context = {
    module: { exports: {} }, AbortController, Blob, Date, Error, TypeError, atob, Uint8Array, fetch, document, URL, window,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`)
      return dependencies[name]
    },
  }
  vm.runInNewContext(code, context, { filename: componentFile })
  const input = { orderId: 'order-1', status: 'PROCESSING', invoice, ...props }
  function render() {
    cursor = 0
    tree = context.module.exports.default(input)
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  render()
  return {
    render, requests, downloads, timers, revoked,
    get tree() { return tree },
    get stateWrites() { return stateWrites },
    button: () => nodes(tree).find((node) => node.type === 'button'),
    alerts: () => nodes(tree).filter((node) => node.props.role === 'alert'),
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

async function finishDownload(app) {
  for (let turns = 0; turns < 20; turns++) {
    await nextTurn()
    app.render()
    if (!app.button()?.props['aria-busy']) return
  }
  assert.fail('Invoice download did not finish')
}

async function assertSavedPdf(app, count = 1) {
  assert.equal(app.downloads.length, count)
  assert.equal(app.alerts().length, 0, 'A successfully saved PDF must not show a failure alert')
  const saved = app.downloads.at(-1)
  assert.equal(saved.name, 'Katuni-INV-2026-000042.pdf')
  assert.equal(saved.file.type, 'application/pdf')
  assert.deepEqual(Buffer.from(await saved.file.arrayBuffer()), pdfBytes)
  assert.equal(app.button().props.disabled, false)
}

for (const [label, mime] of [
  ['the JSON MIME type', 'application/json'],
  ['a rewritten binary MIME type', 'application/octet-stream'],
  ['no MIME type', null],
]) {
  test(`A valid invoice response with ${label} saves its PDF once without a false failure alert`, async () => {
    const app = mount({ queue: [invoiceResponse(mime)] })
    app.button().props.onClick()
    await finishDownload(app)
    await assertSavedPdf(app)
    assert.equal(app.requests.length, 1)
    assert.equal(app.requests[0].headers.Accept, 'application/json', 'Programmatic requests must avoid a downloadable PDF response')
    assert.equal(app.requests[0].credentials, 'same-origin')
    assert.equal(app.revoked.length, 0, 'Saving must start before releasing the browser object URL')
    assert.equal(app.timers.length, 1)
    assert.ok(app.timers[0].delay > 0)
    app.timers[0].callback()
    assert.deepEqual(app.revoked, [app.downloads[0].href])
    app.unmount()
  })
}

test('An encoded HTML payload shows a failure and never saves a corrupt PDF invoice', async () => {
  const app = mount({ queue: [invoiceResponse('application/json', Buffer.from('<html>Login required</html>'))] })
  app.button().props.onClick()
  await finishDownload(app)
  assert.equal(app.downloads.length, 0)
  assert.equal(app.alerts().length, 1)
  assert.match(text(app.alerts()[0]), /فاکتور معتبر نیست/)
  assert.equal(app.timers.length, 0)
  app.unmount()
})

test('An empty response reports an empty invoice instead of saving a file', async () => {
  const app = mount({ queue: [invoiceResponse('application/json', Buffer.alloc(0))] })
  app.button().props.onClick()
  await finishDownload(app)
  assert.equal(app.downloads.length, 0)
  assert.match(text(app.alerts()[0]), /فایل فاکتور خالی است/)
  app.unmount()
})

for (const [label, response] of [
  ['a missing PDF field', new Response(JSON.stringify({ unexpected: true }), { headers: { 'Content-Type': 'application/json' } })],
  ['a non-string PDF field', new Response(JSON.stringify({ pdf: 42 }), { headers: { 'Content-Type': 'application/json' } })],
  ['invalid base64', new Response(JSON.stringify({ pdf: '%not base64!' }), { headers: { 'Content-Type': 'application/json' } })],
  ['HTML mislabeled as JSON', new Response('<html>Login required</html>', { headers: { 'Content-Type': 'application/json' } })],
]) {
  test(`A malformed invoice response with ${label} shows a readable failure and saves no file`, async () => {
    const app = mount({ queue: [response] })
    app.button().props.onClick()
    await finishDownload(app)
    assert.equal(app.downloads.length, 0)
    assert.equal(app.alerts().length, 1)
    assert.match(text(app.alerts()[0]), /فاکتور معتبر نیست/)
    assert.equal(app.button().props.disabled, false)
    app.unmount()
  })
}

for (const [label, result, expected] of [
  ['expired login', jsonFailure(401, 'ورود لازم است'), /دوباره وارد حساب کاربری شو/],
  ['unissued invoice', jsonFailure(409, 'فاکتور پس از تأیید سفارش صادر می‌شود'), /فاکتور پس از تأیید سفارش صادر می‌شود/],
  ['server failure', jsonFailure(500, 'دریافت فاکتور انجام نشد'), /دریافت فاکتور انجام نشد/],
  ['network failure', new TypeError('Failed to fetch'), /خطای ارتباط با سرور/],
]) {
  test(`A real ${label} remains visible and creates no download`, async () => {
    const app = mount({ queue: [result] })
    app.button().props.onClick()
    await finishDownload(app)
    assert.equal(app.downloads.length, 0)
    assert.equal(app.alerts().length, 1)
    assert.match(text(app.alerts()[0]), expected)
    assert.equal(app.button().props.disabled, false)
    assert.equal(app.button().props['aria-describedby'], app.alerts()[0].props.id)
    app.unmount()
  })
}

test('Retrying after a failure clears its alert and subsequent successful downloads stay error-free', async () => {
  const app = mount({ queue: [jsonFailure(500, 'دریافت فاکتور انجام نشد'), invoiceResponse(null), invoiceResponse()] })
  app.button().props.onClick()
  await finishDownload(app)
  assert.equal(app.alerts().length, 1)

  app.button().props.onClick()
  app.render()
  assert.equal(app.alerts().length, 0)
  assert.equal(app.button().props.disabled, true)
  await finishDownload(app)
  await assertSavedPdf(app)

  app.button().props.onClick()
  await finishDownload(app)
  await assertSavedPdf(app, 2)
  assert.equal(app.requests.length, 3)
  app.unmount()
})

test('A rapid second activation cannot duplicate a pending invoice request or download', async () => {
  let resolve
  const pending = new Promise((done) => { resolve = done })
  const app = mount({ queue: [() => pending] })
  const button = app.button()
  button.props.onClick()
  button.props.onClick()
  app.render()
  assert.equal(app.requests.length, 1)
  assert.equal(app.button().props.disabled, true)
  assert.equal(app.downloads.length, 0)
  resolve(invoiceResponse())
  await finishDownload(app)
  await assertSavedPdf(app)
  app.unmount()
})

test('Leaving order details aborts a pending request and ignores a late PDF without showing an error', async () => {
  let resolve
  const pending = new Promise((done) => { resolve = done })
  const app = mount({ queue: [() => pending] })
  app.button().props.onClick()
  const writes = app.stateWrites
  app.unmount()
  assert.equal(app.requests[0].signal.aborted, true)
  resolve(invoiceResponse())
  await nextTurn()
  await nextTurn()
  assert.equal(app.downloads.length, 0)
  assert.equal(app.stateWrites, writes, 'An unmounted component must not update its loading state or error')
  assert.equal(app.timers.length, 0)
})

test('Orders without an issued invoice have no actionable download control', () => {
  const app = mount({ props: { status: 'PENDING', invoice: null } })
  assert.equal(app.button(), undefined)
  assert.match(text(app.tree), /فاکتور پس از تأیید سفارش صادر می‌شود/)
  assert.equal(app.requests.length, 0)
  app.unmount()
})
