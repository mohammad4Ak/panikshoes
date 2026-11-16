const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const config = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/admin-settings-sections.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, config)
const { settingsSections, getSettingsSection, isSettingsSection } = config.module.exports

function browserStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues))
  const state = { values, accesses: 0, reads: [], writes: [], accessBlocked: false, readBlocked: false, writeBlocked: false }
  state.localStorage = {
    getItem(key) {
      state.reads.push(key)
      if (state.readBlocked) throw new Error('Storage reads are blocked')
      return values.get(key) ?? null
    },
    setItem(key, value) {
      state.writes.push([key, value])
      if (state.writeBlocked) throw new Error('Storage writes are blocked')
      values.set(key, String(value))
    },
  }
  return state
}

function navigation(initialPath = '/admin', sectionContainer = null, options = {}) {
  let pathname = initialPath, userId = options.userId || 'admin-one', server = !!options.server, tree, current, cursor, notifications = 0
  const storage = options.storage || browserStorage()
  const slots = new Map(), listeners = new Map(), effects = [], elements = new Map(), focus = []
  const document = { body: { style: { overflow: options.overflow || '' } } }
  const media = {
    matches: false, listeners: new Set(),
    addEventListener(event, callback) { assert.equal(event, 'change'); this.listeners.add(callback) },
    removeEventListener(event, callback) { assert.equal(event, 'change'); this.listeners.delete(callback) },
  }
  const window = {
    location: { hash: '' },
    get localStorage() {
      storage.accesses++
      if (storage.accessBlocked) throw new Error('Storage access is blocked')
      return storage.localStorage
    },
    addEventListener(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback) },
    removeEventListener(event, callback) { listeners.get(event)?.delete(callback) },
    dispatchEvent(event) { listeners.get(event.type)?.forEach((callback) => callback(event)); return true },
    matchMedia(query) { assert.equal(query, '(min-width: 1024px)'); return media },
  }
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in current)) current[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = current[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in current)) current[index] = { current: initial }
      return current[index]
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (server) return
      const previous = current[index]
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        const slot = { dependencies }
        current[index] = slot
        effects.push(() => { previous?.cleanup?.(); slot.cleanup = callback() })
      }
    },
    useCallback(callback, dependencies) {
      const index = cursor++
      const previous = current[index]
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) current[index] = { callback, dependencies }
      return current[index].callback
    },
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
      const index = cursor++
      if (!server && current[index]?.subscribe !== subscribe) {
        current[index]?.cleanup?.()
        current[index] = { subscribe, cleanup: subscribe(() => { notifications++ }) }
      }
      const snapshot = server ? getServerSnapshot : getSnapshot
      const value = snapshot()
      assert.ok(Object.is(value, snapshot()), 'External-store snapshots must be stable between unchanged reads')
      return value
    },
  }
  const jsx = (type, props, key) => ({ type, props, key })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/navigation': { usePathname: () => pathname },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/lib/session-actions': { signOutWithSessionLock() {} },
    '@/lib/admin-settings-sections': config.module.exports,
    '@/components/layout/SiteSettingsProvider': { useSiteSettings: () => ({ storeName: 'پانیک' }) },
    '@/components/ui/BrandLogo': { __esModule: true, default: 'BrandLogo' },
    './admin.module.css': { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) },
  }
  class Event {
    constructor(type, properties = {}) { this.type = type; Object.assign(this, properties) }
  }
  const context = { module: { exports: {} }, window, document, Event, StorageEvent: Event, require(name) { assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] } }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/AdminShell.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, context)
  function render() {
    const used = new Set(), usedElements = new Set()
    function expand(node, owner = 'root') {
      if (Array.isArray(node)) {
        const keys = node.filter((child) => child && child.key != null).map((child) => String(child.key))
        assert.equal(new Set(keys).size, keys.length, 'Sibling navigation keys must remain unique on ' + pathname + ': ' + keys.join(', '))
        return node.map((child, index) => expand(child, owner + '/' + (child?.key ?? index)))
      }
      if (!node || typeof node !== 'object' || !node.props) return node
      if (typeof node.type === 'function') {
        const key = owner + '/' + node.type.name + ':' + (node.key || '')
        used.add(key)
        if (!slots.has(key)) slots.set(key, [])
        current = slots.get(key); cursor = 0
        return expand(node.type(node.props), key)
      }
      if (node.props.ref) {
        if (node.type === 'nav') node.props.ref.current = sectionContainer
        else {
          const key = owner + '/' + node.type + ':' + (node.props.id || node.props['aria-label'] || '')
          usedElements.add(key)
          if (!elements.has(key)) elements.set(key, {
            open: false, shows: 0, closes: 0,
            showModal() { this.open = true; this.shows++ },
            close() { this.open = false; this.closes++; this.props.onClose?.({ currentTarget: this }) },
            focus() { focus.push(this.props['aria-label']) },
            getBoundingClientRect: () => ({ left: 50, right: 350, top: 0, bottom: 700 }),
          })
          const element = elements.get(key)
          element.props = node.props
          element.isConnected = true
          node.props.ref.current = element
        }
      }
      return { ...node, props: { ...node.props, children: expand(node.props.children, owner + '/' + node.type) } }
    }
    tree = expand({ type: context.module.exports.default, props: { userId, children: 'settings form' } })
    for (const [key, element] of elements) if (!usedElements.has(key)) element.isConnected = false
    for (const [key, state] of slots) if (!used.has(key)) { state.forEach((slot) => slot?.cleanup?.()); slots.delete(key) }
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  const app = {
    render, get tree() { return tree }, listeners, document, media, focus, storage,
    get notifications() { return notifications },
    get dialog() { return nodes(tree).find((node) => node.type === 'dialog')?.props.ref.current },
    navigate(next, hash = '') { pathname = next; window.location.hash = hash; render() },
    switchUser(next) { userId = next; render() },
    hydrate() { server = false; render() },
    storageEvent(key, value, storageArea = storage.localStorage) {
      if (key === null) storage.values.clear()
      else if (value === null) storage.values.delete(key)
      else storage.values.set(key, value)
      const previousNotifications = notifications
      window.dispatchEvent(new Event('storage', { key, newValue: value, storageArea }))
      if (notifications !== previousNotifications) render()
    },
    changeHash(hash, event = 'hashchange') { window.location.hash = hash; listeners.get(event)?.forEach((callback) => callback()); render() },
    resizeDesktop(matches) { media.matches = matches; media.listeners.forEach((callback) => callback()); render() },
    unmount() {
      for (const element of elements.values()) element.isConnected = false
      for (const state of slots.values()) state.forEach((slot) => slot?.cleanup?.())
    },
  }
  render()
  return app
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
const links = (tree) => nodes(tree).filter((node) => node.type === 'a' || node.type === 'Link')
const nav = (app, mode = 'desktop') => nodes(app.tree).find((node) => node.type === 'nav' && node.props['aria-label'] === (mode === 'desktop' ? 'منوی مدیریت' : 'ناوبری پنل'))
const groupPanel = (app, id, mode = 'desktop') => nodes(nav(app, mode)).find((node) => node.props.id === `admin-${mode}-${id}`)
const groupToggle = (app, id, mode = 'desktop') => nodes(nav(app, mode)).find((node) => node.type === 'button' && node.props['aria-controls'] === `admin-${mode}-${id}`)
const sectionNav = (app) => nodes(app.tree).find((node) => node.type === 'nav' && node.props['aria-label'] === 'بخش‌های تنظیمات عمومی')
const routeHrefs = (tree) => links(tree).map(({ props }) => props.href)
const groups = {
  sales: ['/admin/orders', '/admin/payments', '/admin/shipments', '/admin/coupons'],
  catalog: ['/admin/products', '/admin/categories', '/admin/inventory'],
  customers: ['/admin/users', '/admin/reviews', '/admin/password-reset'],
  settings: ['/admin/settings', '/admin/payment-methods', '/admin/shipping', '/admin/registration'],
}
const overviewRoutes = ['/admin', '/admin/analytics']
const allRoutes = [...overviewRoutes, ...Object.values(groups).flat()]
const currentRoutes = (app, mode = 'desktop') => links(nav(app, mode)).filter(({ props }) => props['aria-current'] === 'page').map(({ props }) => props.href)
const drawer = (app) => nodes(app.tree).find((node) => node.type === 'dialog')
const menuButton = (app, action = 'open') => nodes(app.tree).find((node) => node.type === 'button' && node.props['aria-label'] === (action === 'open' ? 'باز کردن منوی مدیریت' : 'بستن منوی مدیریت'))
const openMenu = (app) => { menuButton(app).props.onClick(); app.render(); assert.equal(app.dialog.open, true) }
const defaultQuickRoutes = ['/admin/orders', '/admin/products', '/admin/inventory']
const quickStorageKey = (userId = 'admin-one') => `panik-admin-quick-access:v1:${encodeURIComponent(userId)}`
const quickNav = (app, mode = 'desktop') => nodes(app.tree).find((node) => node.type === 'nav' && node.props['aria-label'] === (mode === 'desktop' ? 'دسترسی سریع' : 'دسترسی سریع موبایل'))
const routeLabels = {
  '/admin/orders': 'سفارش‌ها', '/admin/payments': 'بررسی پرداخت‌ها', '/admin/shipments': 'رهگیری مرسوله‌ها', '/admin/coupons': 'کدهای تخفیف',
  '/admin/products': 'محصولات', '/admin/categories': 'دسته‌بندی محصولات', '/admin/inventory': 'انبارداری',
  '/admin/users': 'مدیریت کاربران', '/admin/reviews': 'نظرات و امتیازها', '/admin/password-reset': 'بازیابی رمز عبور', '/admin/settings': 'تنظیمات عمومی',
  '/admin/payment-methods': 'روش‌های پرداخت', '/admin/shipping': 'روش‌های ارسال', '/admin/registration': 'ثبت‌نام و تأیید حساب',
}
const pinButton = (app, href, mode = 'desktop') => nodes(nav(app, mode)).find((node) => node.type === 'button' && [
  `افزودن ${routeLabels[href]} به دسترسی سریع`, `حذف ${routeLabels[href]} از دسترسی سریع`,
].includes(node.props['aria-label']))
const togglePin = (app, href, mode = 'desktop') => { const button = pinButton(app, href, mode); assert.ok(button, href); button.props.onClick(); app.render() }
const assertQuickRoutes = (app, expected) => {
  for (const mode of ['desktop', 'mobile']) {
    assert.ok(quickNav(app, mode), mode + ' quick access exists')
    assert.deepEqual(routeHrefs(quickNav(app, mode)), expected, mode)
  }
}

test('Settings sections have stable unique IDs and unknown hashes use branding', () => {
  assert.equal(settingsSections.length, 7)
  assert.equal(new Set(settingsSections.map(({ id }) => id)).size, 7)
  for (const { id, label } of settingsSections) { assert.ok(label); assert.equal(isSettingsSection(id), true); assert.equal(getSettingsSection('#' + id), id) }
  for (const hash of ['', '#missing', '#__proto__', '#appearance?draft=1']) assert.equal(getSettingsSection(hash), 'branding')
})

test('Desktop and mobile expose every admin route once in the approved two-level groups', () => {
  const app = navigation()
  for (const mode of ['desktop', 'mobile']) {
    const menu = nav(app, mode)
    assert.ok(menu, `${mode} navigation exists`)
    const hrefs = routeHrefs(menu)
    assert.deepEqual(hrefs, allRoutes)
    assert.equal(new Set(hrefs).size, allRoutes.length)
    assert.equal(nodes(menu).filter((node) => node.type === 'button' && node.props['aria-controls']).length, 4)
    for (const [id, routes] of Object.entries(groups)) {
      assert.deepEqual(routeHrefs(groupPanel(app, id, mode)), routes)
      assert.equal(groupToggle(app, id, mode).props.type, 'button')
      assert.equal(nodes(groupPanel(app, id, mode)).filter((node) => node.type === 'button' && node.props['aria-controls']).length, 0, 'No third menu level')
    }
  }
  const ids = nodes(app.tree).map(({ props }) => props.id).filter(Boolean)
  assert.equal(new Set(ids).size, ids.length, 'Desktop and drawer controls must target unique IDs')
  assert.ok(!sectionNav(app), 'Settings sections appear only on the settings page')
  app.unmount()
})

test('Quick access defaults appear before the complete menu and pin controls are accessible sibling buttons', () => {
  const app = navigation('/admin/orders/example')
  assertQuickRoutes(app, defaultQuickRoutes)
  assert.equal(app.storage.writes.length, 0, 'Loading defaults does not overwrite browser preferences')
  for (const mode of ['desktop', 'mobile']) {
    assert.ok(nodes(app.tree).indexOf(quickNav(app, mode)) < nodes(app.tree).indexOf(nav(app, mode)))
    assert.ok(!nodes(nav(app, mode)).includes(quickNav(app, mode)), 'Quick access is a separate navigation region')
    assert.deepEqual(links(quickNav(app, mode)).filter(({ props }) => props['aria-current'] === 'page').map(({ props }) => props.href), ['/admin/orders'])
    assert.equal(nodes(nav(app, mode)).filter((node) => node.type === 'button' && typeof node.props['aria-pressed'] === 'boolean').length, Object.values(groups).flat().length)
    for (const href of Object.values(groups).flat()) {
      const button = pinButton(app, href, mode)
      assert.ok(button, href)
      assert.equal(button.props.type, 'button')
      assert.equal(button.props['aria-pressed'], defaultQuickRoutes.includes(href), href)
      const link = links(nav(app, mode)).find((node) => node.props.href === href)
      assert.ok(!nodes(link).includes(button), 'Pin controls cannot be nested inside navigation links')
      assert.ok(nodes(nav(app, mode)).some((node) => {
        const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children]
        return children.includes(link) && children.includes(button)
      }), 'Pin control and destination link are siblings: ' + href)
    }
  }
  app.unmount()
})

test('Pin changes synchronize both menus, persist for this administrator, and retain an intentionally empty list', () => {
  const storage = browserStorage()
  const app = navigation('/admin/orders', null, { storage, userId: 'admin / one' })
  const before = app.notifications
  togglePin(app, '/admin/payments')
  assert.ok(app.notifications > before, 'A pin change notifies the same browser window')
  assertQuickRoutes(app, [...defaultQuickRoutes, '/admin/payments'])
  assert.deepEqual(JSON.parse(storage.values.get(quickStorageKey('admin / one'))), [...defaultQuickRoutes, '/admin/payments'])
  openMenu(app)
  togglePin(app, '/admin/products', 'mobile')
  assert.equal(app.dialog.open, true, 'Pinning does not navigate or close the drawer')
  assertQuickRoutes(app, ['/admin/orders', '/admin/inventory', '/admin/payments'])
  app.navigate('/admin/settings')
  assertQuickRoutes(app, ['/admin/orders', '/admin/inventory', '/admin/payments'])
  app.unmount()
  const restored = navigation('/admin', null, { storage, userId: 'admin / one' })
  assertQuickRoutes(restored, ['/admin/orders', '/admin/inventory', '/admin/payments'])
  for (const href of ['/admin/orders', '/admin/inventory', '/admin/payments']) togglePin(restored, href)
  assertQuickRoutes(restored, [])
  assert.equal(storage.values.get(quickStorageKey('admin / one')), '[]')
  restored.unmount()
  const empty = navigation('/admin', null, { storage, userId: 'admin / one' })
  assertQuickRoutes(empty, [])
  empty.unmount()
})

test('Quick access preferences remain separate when switching administrator accounts', () => {
  const storage = browserStorage({ [quickStorageKey('admin-two')]: JSON.stringify(['/admin/reviews']) })
  const app = navigation('/admin', null, { storage })
  togglePin(app, '/admin/orders')
  assertQuickRoutes(app, ['/admin/products', '/admin/inventory'])
  app.switchUser('admin-two')
  assertQuickRoutes(app, ['/admin/reviews'])
  togglePin(app, '/admin/users', 'mobile')
  assertQuickRoutes(app, ['/admin/reviews', '/admin/users'])
  app.switchUser('admin-one')
  assertQuickRoutes(app, ['/admin/products', '/admin/inventory'])
  assert.deepEqual(JSON.parse(storage.values.get(quickStorageKey('admin-two'))), ['/admin/reviews', '/admin/users'])
  app.unmount()
})

test('Six quick links disable further additions while removal remains available in either menu', () => {
  const app = navigation('/admin/orders')
  for (const href of ['/admin/payments', '/admin/shipments', '/admin/coupons']) togglePin(app, href)
  const full = [...defaultQuickRoutes, '/admin/payments', '/admin/shipments', '/admin/coupons']
  assertQuickRoutes(app, full)
  for (const mode of ['desktop', 'mobile']) {
    for (const href of Object.values(groups).flat()) assert.equal(pinButton(app, href, mode).props.disabled, !full.includes(href), href)
  }
  openMenu(app)
  const remove = nodes(quickNav(app, 'mobile')).find((node) => node.type === 'button' && node.props['aria-label'] === 'حذف سفارش‌ها از دسترسی سریع')
  assert.ok(remove)
  assert.equal(remove.props.type, 'button')
  remove.props.onClick(); app.render()
  assert.equal(app.dialog.open, true, 'Removing a shortcut keeps the drawer open')
  assertQuickRoutes(app, full.filter((href) => href !== '/admin/orders'))
  for (const mode of ['desktop', 'mobile']) assert.equal(pinButton(app, '/admin/categories', mode).props.disabled, false)
  togglePin(app, '/admin/categories', 'mobile')
  assertQuickRoutes(app, [...full.filter((href) => href !== '/admin/orders'), '/admin/categories'])
  app.unmount()
})

test('Stored quick access values are validated, deduplicated, and bounded without rewriting them on load', () => {
  const cases = [
    ['invalid JSON', '{', defaultQuickRoutes],
    ['null', 'null', defaultQuickRoutes],
    ['object', '{"href":"/admin/orders"}', defaultQuickRoutes],
    ['number', '42', defaultQuickRoutes],
    ['empty', '[]', []],
    ['mixed routes', JSON.stringify(['/admin/payments', '/admin/payments', '/admin', '/admin/analytics', '/admin/orders/example', '/admin/categories', 'https://example.com', '__proto__', 42, null]), ['/admin/payments', '/admin/categories']],
    ['oversized', JSON.stringify(Object.values(groups).flat()), Object.values(groups).flat().slice(0, 6)],
  ]
  for (const [name, raw, expected] of cases) {
    const storage = browserStorage({ [quickStorageKey()]: raw })
    const app = navigation('/admin', null, { storage })
    assertQuickRoutes(app, expected)
    assert.equal(storage.values.get(quickStorageKey()), raw, name)
    assert.equal(storage.writes.length, 0, name)
    app.unmount()
  }
})

test('Quick access uses server defaults before hydration and reads saved browser choices after hydration', () => {
  const storage = browserStorage({ [quickStorageKey()]: JSON.stringify(['/admin/reviews']) })
  const app = navigation('/admin', null, { storage, server: true })
  assertQuickRoutes(app, defaultQuickRoutes)
  assert.equal(storage.accesses, 0, 'Server rendering cannot read browser storage')
  assert.equal(storage.writes.length, 0)
  app.hydrate()
  assertQuickRoutes(app, ['/admin/reviews'])
  assert.ok(storage.reads.length > 0)
  assert.equal(storage.writes.length, 0)
  app.unmount()
})

test('Blocked or full browser storage leaves usable favorites synchronized throughout navigation', () => {
  for (const failure of ['accessBlocked', 'readBlocked', 'writeBlocked']) {
    const storage = browserStorage()
    storage[failure] = true
    const app = navigation('/admin/orders', null, { storage })
    assertQuickRoutes(app, defaultQuickRoutes)
    togglePin(app, '/admin/orders')
    assertQuickRoutes(app, ['/admin/products', '/admin/inventory'])
    app.navigate('/admin/settings')
    assertQuickRoutes(app, ['/admin/products', '/admin/inventory'])
    togglePin(app, '/admin/reviews', 'mobile')
    assertQuickRoutes(app, ['/admin/products', '/admin/inventory', '/admin/reviews'])
    storage[failure] = false
    app.storageEvent(quickStorageKey(), JSON.stringify(['/admin/payments']))
    assertQuickRoutes(app, ['/admin/payments'])
    app.unmount()
  }
})

test('Cross-tab preferences update only the active administrator and browser clear restores defaults', () => {
  const app = navigation()
  const before = app.notifications
  app.storageEvent(quickStorageKey('someone-else'), '[]')
  assert.equal(app.notifications, before, 'Another administrator storage event is ignored')
  assertQuickRoutes(app, defaultQuickRoutes)
  app.storageEvent(quickStorageKey(), JSON.stringify(['/admin/reviews', '/admin/coupons']))
  assert.ok(app.notifications > before)
  assertQuickRoutes(app, ['/admin/reviews', '/admin/coupons'])
  app.storageEvent(quickStorageKey(), '[]')
  assertQuickRoutes(app, [])
  app.storageEvent(quickStorageKey(), null)
  assertQuickRoutes(app, defaultQuickRoutes)
  app.storageEvent(quickStorageKey(), JSON.stringify(['/admin/users']))
  assertQuickRoutes(app, ['/admin/users'])
  app.storageEvent(null, null)
  assertQuickRoutes(app, defaultQuickRoutes)
  app.unmount()
  assert.equal(app.listeners.get('storage').size, 0)
  assert.equal(app.listeners.get('panik-admin-quick-access').size, 0)
})

test('Every quick destination closes the mobile drawer, including the current route', () => {
  const app = navigation('/admin/orders')
  for (const href of defaultQuickRoutes) {
    openMenu(app)
    const destination = links(quickNav(app, 'mobile')).find((node) => node.props.href === href)
    assert.equal(typeof destination.props.onNavigate, 'function', href)
    destination.props.onNavigate(); app.render()
    assert.equal(app.dialog.open, false, href)
    assert.equal(app.document.body.style.overflow, '', href)
  }
  app.unmount()
})

test('Collapsing one group hides its links without changing the other groups or the other menu', () => {
  const app = navigation()
  for (const id of Object.keys(groups)) {
    assert.equal(groupToggle(app, id).props['aria-expanded'], false)
    assert.equal(groupPanel(app, id).props.hidden, true)
    groupToggle(app, id).props.onClick(); app.render()
    assert.equal(groupToggle(app, id).props['aria-expanded'], true)
    assert.equal(groupPanel(app, id).props.hidden, false)
    for (const other of Object.keys(groups).filter((candidate) => candidate !== id)) assert.equal(groupPanel(app, other).props.hidden, true)
    assert.equal(groupPanel(app, id, 'mobile').props.hidden, true)
    groupToggle(app, id).props.onClick(); app.render()
    assert.equal(groupToggle(app, id).props['aria-expanded'], false)
    assert.equal(groupPanel(app, id).props.hidden, true)
  }
  app.unmount()
})

test('Every route opens its own group and marks one current link, including nested route navigation', () => {
  const app = navigation()
  for (const route of allRoutes) {
    for (const pathname of route === '/admin' ? [route] : [route, route + '/example']) {
      app.navigate(pathname)
      for (const mode of ['desktop', 'mobile']) {
        assert.deepEqual(currentRoutes(app, mode), [route], pathname)
        for (const [id, routes] of Object.entries(groups)) {
          const active = routes.includes(route)
          assert.equal(groupToggle(app, id, mode).props['aria-expanded'], active, pathname + ': ' + id)
          assert.equal(groupPanel(app, id, mode).props.hidden, !active, pathname + ': ' + id)
        }
      }
    }
  }
  for (const pathname of ['/administer', '/admin/unknown', '/admin/products-archive', '/admin/payment-methods-old']) {
    app.navigate(pathname)
    for (const mode of ['desktop', 'mobile']) {
      assert.deepEqual(currentRoutes(app, mode), [], pathname)
      for (const id of Object.keys(groups)) assert.equal(groupPanel(app, id, mode).props.hidden, true, pathname + ': ' + id)
    }
  }
  app.unmount()
})

test('Changing routes reopens the active group after a manual collapse, including within the same group', () => {
  const app = navigation('/admin/orders')
  groupToggle(app, 'sales').props.onClick(); app.render()
  assert.equal(groupPanel(app, 'sales').props.hidden, true)
  app.navigate('/admin/payments')
  assert.equal(groupPanel(app, 'sales').props.hidden, false)
  assert.deepEqual(currentRoutes(app), ['/admin/payments'])
  groupToggle(app, 'sales').props.onClick(); app.render()
  app.navigate('/admin/products/example')
  assert.equal(groupPanel(app, 'catalog').props.hidden, false)
  assert.equal(groupPanel(app, 'sales').props.hidden, true)
  app.navigate('/admin/orders')
  assert.equal(groupPanel(app, 'sales').props.hidden, false)
  app.unmount()
})

test('Settings section navigation is page-local and uses native anchors without another menu level', () => {
  const app = navigation('/admin/settings')
  const local = sectionNav(app)
  assert.ok(local)
  assert.equal(nodes(app.tree).filter((node) => node.type === 'nav' && node.props['aria-label'] === 'بخش‌های تنظیمات عمومی').length, 1)
  const main = nodes(app.tree).find((node) => node.type === 'main')
  assert.ok(nodes(main).includes(local), 'Settings sections belong to the page content')
  assert.deepEqual(routeHrefs(local), Array.from(settingsSections, ({ id }) => '#' + id))
  assert.ok(links(local).every((node) => node.type === 'a' && !node.props.onClick))
  for (const mode of ['desktop', 'mobile']) {
    assert.ok(!nodes(nav(app, mode)).includes(local))
    assert.deepEqual(routeHrefs(groupPanel(app, 'settings', mode)), groups.settings)
  }
  app.unmount()
})

test('Hash changes and browser history keep the single page-local settings section current', () => {
  const app = navigation('/admin/settings')
  assert.equal(app.listeners.get('hashchange').size, 1)
  assert.equal(app.listeners.get('popstate').size, 1)
  const current = () => links(sectionNav(app)).filter((node) => node.props['aria-current'] === 'location')
  assert.deepEqual(current().map(({ props }) => props.href), ['#branding'])
  app.changeHash('#contact')
  assert.deepEqual(current().map(({ props }) => props.href), ['#contact'])
  app.changeHash('#seo', 'popstate')
  assert.deepEqual(current().map(({ props }) => props.href), ['#seo'])
  app.changeHash('#unknown')
  assert.deepEqual(current().map(({ props }) => props.href), ['#branding'])
  app.changeHash('', 'popstate')
  assert.deepEqual(current().map(({ props }) => props.href), ['#branding'])
  assert.equal(links(sectionNav(app)).length, 7)
  assert.deepEqual(currentRoutes(app), ['/admin/settings'])
  app.navigate('/admin/products')
  assert.ok(!sectionNav(app))
  app.unmount()
  assert.equal(app.listeners.get('hashchange').size, 0)
  assert.equal(app.listeners.get('popstate').size, 0)
})


test('Settings section selection reveals clipped links by scrolling only its own horizontal container', () => {
  const scrolls = []
  let viewport = { left: 16, right: 374, width: 358 }
  let item = { left: -30, right: 100 }
  const container = {
    querySelector(selector) { assert.equal(selector, '[aria-current="location"]'); return { getBoundingClientRect: () => item } },
    getBoundingClientRect: () => viewport,
    scrollBy(options) { scrolls.push({ ...options }) },
  }
  const app = navigation('/admin/settings', container)
  assert.deepEqual(scrolls.pop(), { left: -55, behavior: 'auto' })
  item = { left: 320, right: 430 }
  app.changeHash('#contact')
  assert.deepEqual(scrolls.pop(), { left: 65, behavior: 'auto' })
  item = { left: 50, right: 180 }
  app.changeHash('#seo')
  assert.equal(scrolls.length, 0)
  viewport = { left: 0, right: 0, width: 0 }
  app.listeners.get('resize').forEach((callback) => callback())
  assert.equal(scrolls.length, 0)
  app.unmount()
  assert.equal(app.listeners.get('resize').size, 0)
})

test('The mobile menu opens a named native modal and restores scrolling and trigger focus when closed', () => {
  const app = navigation('/admin/orders', null, { overflow: 'clip' })
  const modal = drawer(app)
  assert.equal(modal.props.id, menuButton(app).props['aria-controls'])
  assert.equal(menuButton(app).props['aria-haspopup'], 'dialog')
  assert.equal(menuButton(app).props['aria-expanded'], false)
  assert.equal(modal.props['aria-modal'], 'true')
  assert.ok(nodes(modal).some((node) => node.type === 'h2' && node.props.id === modal.props['aria-labelledby']))
  assert.equal(app.dialog.open, false)
  assert.equal(app.media.listeners.size, 0)
  openMenu(app)
  assert.equal(app.dialog.shows, 1, 'Opening uses the browser modal API for focus and background isolation')
  assert.equal(menuButton(app).props['aria-expanded'], true)
  assert.equal(app.document.body.style.overflow, 'hidden')
  assert.equal(app.media.listeners.size, 1)
  menuButton(app, 'close').props.onClick(); app.render()
  assert.equal(app.dialog.open, false)
  assert.equal(menuButton(app).props['aria-expanded'], false)
  assert.equal(app.document.body.style.overflow, 'clip')
  assert.deepEqual(app.focus, ['باز کردن منوی مدیریت'])
  assert.equal(app.media.listeners.size, 0)
  app.unmount()
})

test('Escape and true backdrop clicks close the drawer while clicks inside it leave it open', () => {
  const app = navigation()
  openMenu(app)
  drawer(app).props.onClick({ target: {}, currentTarget: app.dialog, clientX: 0, clientY: 20 }); app.render()
  assert.equal(app.dialog.open, true, 'A click on drawer descendants is not a backdrop click')
  drawer(app).props.onClick({ target: app.dialog, currentTarget: app.dialog, clientX: 100, clientY: 200 }); app.render()
  assert.equal(app.dialog.open, true, 'Empty space inside the drawer is not a backdrop click')
  drawer(app).props.onClick({ target: app.dialog, currentTarget: app.dialog, clientX: 20, clientY: 200 }); app.render()
  assert.equal(app.dialog.open, false)
  openMenu(app)
  drawer(app).props.onCancel(); app.render()
  assert.equal(app.dialog.open, false)
  assert.equal(app.document.body.style.overflow, '')
  openMenu(app)
  drawer(app).props.onClose({ currentTarget: app.dialog }); app.render()
  assert.equal(app.dialog.open, true, 'A delayed native close event must not close a reopened modal')
  app.dialog.close(); app.render()
  assert.equal(menuButton(app).props['aria-expanded'], false)
  app.unmount()
})

test('Selecting any mobile destination closes the drawer, including the current page and storefront', () => {
  const app = navigation('/admin/orders')
  for (const href of [...allRoutes, '/']) {
    openMenu(app)
    const destination = links(drawer(app)).find((node) => node.props.href === href)
    assert.ok(destination, href)
    assert.equal(typeof destination.props.onNavigate, 'function', href)
    destination.props.onNavigate(); app.render()
    assert.equal(app.dialog.open, false, href)
    assert.equal(app.document.body.style.overflow, '', href)
  }
  app.unmount()
})

test('Desktop resizing, route changes and unmounting release the modal and its scroll lock', () => {
  const app = navigation('/admin/orders', null, { overflow: 'auto' })
  openMenu(app)
  app.resizeDesktop(true)
  assert.equal(app.dialog.open, false)
  assert.equal(app.document.body.style.overflow, 'auto')
  assert.equal(app.media.listeners.size, 0)
  app.resizeDesktop(false)
  openMenu(app)
  const previousDialog = app.dialog
  app.navigate('/admin/products/example')
  assert.equal(previousDialog.open, false, 'A route change closes the old modal')
  assert.equal(app.dialog.open, false, 'The new page starts with a closed menu')
  assert.equal(menuButton(app).props['aria-expanded'], false)
  assert.equal(app.document.body.style.overflow, 'auto')
  assert.equal(app.media.listeners.size, 0)
  openMenu(app)
  const lastDialog = app.dialog
  app.unmount()
  assert.equal(lastDialog.open, false)
  assert.equal(app.document.body.style.overflow, 'auto')
  assert.equal(app.media.listeners.size, 0)
})
