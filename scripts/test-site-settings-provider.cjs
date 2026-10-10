const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
function compile(file, dependencies = {}, globals = {}) {
  const testModule = { exports: {} }
  const code = transformSync(readFileSync(path.join(root, file), 'utf8'), {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic',
  }).code
  vm.runInNewContext(code, { module: testModule, ...globals,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }, { filename: file })
  return testModule.exports
}
const contract = compile('src/lib/site-settings-contract.ts')
const settings = (version, overrides = {}) => ({ ...contract.defaultSiteSettings, version, ...overrides })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// Exercise the actual provider's hooks, focus listeners, response validation and
// cancellation with deterministic doubles. No network or saved settings change.
function mount({ initial = settings(1), pathname = '/', queue = [], visibility = 'visible' } = {}) {
  const slots = [], pendingEffects = [], requests = [], listeners = new Map(), timers = new Map()
  let cursor = 0, tree, props = initial, route = pathname, writes = 0, timerId = 0
  const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    createContext: (value) => ({ value, Provider: 'SettingsProvider' }),
    useContext: (context) => context.value,
    useState(initialValue) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }
      return [slots[index].value, (next) => {
        writes++
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
      }]
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        const previous = slots[index]
        const slot = { dependencies }
        slots[index] = slot
        pendingEffects.push(() => { previous?.cleanup?.(); slot.cleanup = callback() })
      }
    },
  }
  const window = {
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
    },
    removeEventListener(event, handler) { listeners.get(event)?.delete(handler) },
  }
  const document = { visibilityState: visibility, documentElement: { dataset: {} } }
  const fetch = async (url, options) => {
    requests.push({ url, ...options })
    const next = queue.length ? queue.shift() : response(props)
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(options) : next
  }
  const jsx = (type, props) => ({ type, props })
  const provider = compile('src/components/layout/SiteSettingsProvider.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'next/navigation': { usePathname: () => route },
    '@/lib/site-settings-contract': contract,
  }, { fetch, window, document, AbortController })
  const render = () => { cursor = 0; tree = provider.SiteSettingsProvider({ settings: props, children: 'Shop' }); return tree }
  render()
  return {
    render, requests, timers, document,
    get value() { return tree.props.value }, get writes() { return writes },
    effects() { pendingEffects.splice(0).forEach((effect) => effect()) },
    focus() { [...(listeners.get('focus') || [])].forEach((handler) => handler()) },
    route(pathname) { route = pathname; render() },
    serverSettings(next) { props = next; render() },
    focusListeners() { return listeners.get('focus')?.size || 0 },
    timeout() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback() } },
    unmount() { for (const slot of slots) slot.cleanup?.() },
  }
}

test('Initial server settings render immediately and anonymous refresh does not use browser session credentials', async () => {
  const app = mount({ initial: settings(3, { storeName: 'نام اولیه' }) })
  assert.equal(app.value.storeName, 'نام اولیه')
  assert.equal(app.value.version, 3)
  assert.equal(app.requests.length, 0, 'Rendering itself must not fetch or hide initial branding')
  app.effects()
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].url, '/api/site-settings')
  assert.equal(app.requests[0].credentials, 'omit')
  assert.equal(app.requests[0].cache, 'no-store')
  await settle(); app.render()
  assert.equal(app.value.version, 3)
  app.unmount()
})

test('Initial refresh, later focus and client navigation load current public branding and announcement', async () => {
  const app = mount({ queue: [
    response(settings(2, { storeName: 'نام تازه' })),
    response(settings(3, { announcementEnabled: true, announcementText: 'اطلاعیه جدید' })),
    response(settings(4, { logoUrl: '/uploads/new.png' })),
  ] })
  app.effects(); await settle(); app.render()
  assert.equal(app.value.storeName, 'نام تازه')
  assert.equal(app.focusListeners(), 1)
  app.focus(); await settle(); app.render()
  assert.equal(app.value.announcementEnabled, true)
  assert.equal(app.value.announcementText, 'اطلاعیه جدید')
  app.route('/products'); app.effects(); await settle(); app.render()
  assert.equal(app.value.logoUrl, '/uploads/new.png')
  assert.equal(app.value.version, 4)
  assert.equal(app.requests.length, 3)
  assert.equal(app.focusListeners(), 1, 'Navigation must replace its listener rather than accumulate listeners')
  assert.equal(app.timers.size, 0)
  app.unmount()
})

test('A route change aborts its obsolete request and even an ignored-abort response cannot overwrite the new page', async () => {
  const old = deferred(), latest = deferred()
  const app = mount({ queue: [old.promise, latest.promise] })
  app.effects()
  const oldSignal = app.requests[0].signal
  app.route('/contact'); app.effects()
  assert.equal(oldSignal.aborted, true)
  latest.resolve(response(settings(5, { storeName: 'نسخه مسیر جدید' })))
  await settle(); app.render()
  old.resolve(response(settings(99, { storeName: 'پاسخ دیررس مسیر قبلی' })))
  await settle(); app.render()
  assert.equal(app.value.version, 5)
  assert.equal(app.value.storeName, 'نسخه مسیر جدید')
  assert.equal(app.writes, 1)
  app.unmount()
})

test('Refreshed server props appear immediately and an older public response cannot roll them back', async () => {
  const obsolete = deferred()
  const app = mount({ queue: [obsolete.promise, response(settings(4)), response(settings(7))] })
  app.effects()
  app.serverSettings(settings(6, { storeName: 'نام ذخیره‌شده توسط ادمین' }))
  assert.equal(app.value.version, 6, 'New server props must work before background refresh completes')
  assert.equal(app.value.storeName, 'نام ذخیره‌شده توسط ادمین')
  app.effects(); await settle(); app.render()
  assert.equal(app.requests[0].signal.aborted, true)
  assert.equal(app.value.version, 6)
  obsolete.resolve(response(settings(100))); await settle(); app.render()
  assert.equal(app.value.version, 6)
  app.focus(); await settle(); app.render()
  assert.equal(app.value.version, 7)
  app.serverSettings(settings(5)); app.effects(); await settle(); app.render()
  assert.equal(app.value.version, 7, 'A cached server payload must not replace a newer completed public read')
  app.unmount()
})

for (const [label, failure] of [
  ['network failure', new TypeError('Offline')],
  ['HTTP failure', response({ error: 'Unavailable' }, 503)],
  ['invalid JSON', { ok: true, json: async () => { throw new SyntaxError('Invalid JSON') } }],
  ['missing fields', response({ storeName: 'Incomplete', version: 10 })],
  ['null payload', response(null)],
  ['array payload', response([])],
  ['wrong field type', response(settings(10, { announcementEnabled: 'true' }))],
  ['invalid revision', response(settings(-1))],
]) {
  test(`A ${label} preserves displayed settings and focus can retry successfully`, async () => {
    const initial = settings(3, { storeName: 'نام قابل استفاده' })
    const app = mount({ initial, queue: [failure, response(settings(4, { storeName: 'پس از اتصال' }))] })
    app.effects(); await settle(); app.render()
    assert.equal(app.value, initial)
    assert.equal(app.timers.size, 0)
    app.focus(); await settle(); app.render()
    assert.equal(app.value.storeName, 'پس از اتصال')
    assert.equal(app.value.version, 4)
    assert.equal(app.requests.length, 2)
    app.unmount()
  })
}

test('A completed newer revision is retained when a later focus response contains an older revision', async () => {
  const app = mount({ queue: [response(settings(8, { storeName: 'نسخه تازه' })), response(settings(7, { storeName: 'نسخه قدیمی' }))] })
  app.effects(); await settle(); app.render()
  app.focus(); await settle(); app.render()
  assert.equal(app.value.version, 8)
  assert.equal(app.value.storeName, 'نسخه تازه')
  app.unmount()
})

test('Repeated focus events share one pending request and timeout abort prevents a late update', async () => {
  const pending = deferred()
  const app = mount({ queue: [pending.promise, response(settings(3, { storeName: 'تلاش دوباره' }))] })
  app.effects(); app.focus(); app.focus()
  assert.equal(app.requests.length, 1)
  assert.equal(app.timers.size, 1)
  assert.equal([...app.timers.values()][0].delay, 10_000)
  app.timeout()
  assert.equal(app.requests[0].signal.aborted, true)
  pending.resolve(response(settings(99))); await settle(); app.render()
  assert.equal(app.value.version, 1)
  assert.equal(app.writes, 0)
  app.focus(); await settle(); app.render()
  assert.equal(app.requests.length, 2)
  assert.equal(app.value.storeName, 'تلاش دوباره')
  app.unmount()
})

test('Unmount removes focus listeners and timeout, aborts pending fetch and ignores late settlement', async () => {
  const pending = deferred()
  const app = mount({ queue: [pending.promise] })
  app.effects()
  assert.equal(app.focusListeners(), 1)
  assert.equal(app.timers.size, 1)
  app.unmount()
  assert.equal(app.requests[0].signal.aborted, true)
  assert.equal(app.focusListeners(), 0)
  assert.equal(app.timers.size, 0)
  app.focus()
  assert.equal(app.requests.length, 1)
  pending.resolve(response(settings(99))); await settle()
  assert.equal(app.writes, 0)
})

test('Hidden tabs avoid unnecessary reads and becoming visible then focusing refreshes settings', async () => {
  const app = mount({ visibility: 'hidden', queue: [response(settings(2))] })
  app.effects(); app.focus()
  assert.equal(app.requests.length, 0)
  assert.equal(app.timers.size, 0)
  app.document.visibilityState = 'visible'
  app.focus(); await settle(); app.render()
  assert.equal(app.value.version, 2)
  assert.equal(app.requests.length, 1)
  app.unmount()
})


test('Server and refreshed palettes update the persistent document theme and switching back removes honey styling', async () => {
  const app = mount({ initial: settings(2, { colorTheme: 'honey' }), queue: [response(settings(2, { colorTheme: 'honey' })), response(settings(3, { colorTheme: 'forest' }))] })
  app.effects(); await settle(); app.render(); app.effects()
  assert.equal(app.document.documentElement.dataset.colorTheme, 'honey')
  app.focus(); await settle(); app.render(); app.effects()
  assert.equal(app.value.colorTheme, 'forest')
  assert.equal(app.document.documentElement.dataset.colorTheme, 'forest')
  app.unmount()
})

test('An invalid public palette or stale theme revision cannot change the rendered palette', async () => {
  const app = mount({ initial: settings(7, { colorTheme: 'honey' }), queue: [response(settings(8, { colorTheme: 'arbitrary' })), response(settings(6, { colorTheme: 'forest' }))] })
  app.effects(); await settle(); app.render(); app.effects()
  app.focus(); await settle(); app.render(); app.effects()
  assert.equal(app.value.colorTheme, 'honey')
  assert.equal(app.document.documentElement.dataset.colorTheme, 'honey')
  app.unmount()
})

test('An administrator save applies the new server palette before a background public refresh completes', () => {
  const pending = deferred()
  const app = mount({ initial: settings(1), queue: [pending.promise] })
  app.effects()
  app.serverSettings(settings(2, { colorTheme: 'honey' })); app.effects()
  assert.equal(app.document.documentElement.dataset.colorTheme, 'honey')
  app.unmount()
})
