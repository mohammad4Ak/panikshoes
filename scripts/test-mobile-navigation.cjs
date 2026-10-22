const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const jsx = (type, props) => ({ type, props })
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree)
const digits = value => String(value).replace(/[0-9]/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)])
function compile(file, dependencies = {}, globals = {}) {
  const target = { exports: {} }
  const code = transformSync(readFileSync(path.join(root, file), 'utf8'), {
    loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic',
  }).code
  vm.runInNewContext(code, {
    module: target,
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
    ...globals,
  }, { filename: file })
  return target.exports
}

class EventSurface {
  listeners = new Map()
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  dispatch(type, event = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event) }
  count() { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0) }
}
function keyboardBrowser() {
  const viewport = Object.assign(new EventSurface(), { height: 800, scale: 1 })
  const window = Object.assign(new EventSurface(), { innerHeight: 800, scrollY: 0, visualViewport: viewport })
  const document = Object.assign(new EventSurface(), { activeElement: null, body: { style: { overflow: '' } } })
  const microtasks = []
  const model = compile('src/lib/mobile-navigation.ts', {}, { window, document, queueMicrotask: callback => microtasks.push(callback) })
  return { window, document, viewport, model, flush() { microtasks.splice(0).forEach(callback => callback()) } }
}
const model = compile('src/lib/mobile-navigation.ts')

test('Active sections include nested customer routes and reject similar unrelated path prefixes', () => {
  for (const [section, accepted, rejected] of [
    ['home', ['/'], ['/products', '/profile']],
    ['shop', ['/products', '/products/selin-622'], ['/product', '/products-sale']],
    ['cart', ['/cart', '/checkout', '/checkout/address'], ['/cartoon', '/checkout-error']],
    ['account', ['/profile', '/profile/orders', '/login', '/register'], ['/profiles', '/login-help', '/registration']],
  ]) {
    for (const pathname of accepted) assert.equal(model.isMobileNavActive(pathname, section), true, pathname)
    for (const pathname of rejected) assert.equal(model.isMobileNavActive(pathname, section), false, pathname)
  }
})

test('Server rendering and browsers without VisualViewport never assume a keyboard is open', () => {
  assert.equal(model.getMobileKeyboardServerSnapshot(), false)
  assert.equal(model.getMobileKeyboardSnapshot(), false)
  const env = keyboardBrowser()
  env.window.visualViewport = null
  env.document.activeElement = { tagName: 'INPUT', type: 'email' }
  assert.equal(env.model.getMobileKeyboardSnapshot(), false)
})

test('Only editable focus plus substantial viewport shrink hides the nav; toolbar and zoom remain usable', () => {
  const env = keyboardBrowser()
  env.viewport.height = 500
  for (const target of [
    { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true },
    ...['text', 'search', 'password', 'email', 'number', 'tel', 'url'].map(type => ({ tagName: 'INPUT', type })),
  ]) {
    env.document.activeElement = target
    assert.equal(env.model.getMobileKeyboardSnapshot(), true)
  }
  for (const target of [null, { tagName: 'BUTTON' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'checkbox' }]) {
    env.document.activeElement = target
    assert.equal(env.model.getMobileKeyboardSnapshot(), false)
  }
  env.document.activeElement = { tagName: 'INPUT', type: 'text' }
  env.viewport.height = 700
  assert.equal(env.model.getMobileKeyboardSnapshot(), false, 'Browser toolbar shrink is not a keyboard')
  env.viewport.height = 500
  env.viewport.scale = 1.4
  assert.equal(env.model.getMobileKeyboardSnapshot(), false, 'Pinch zoom is not a keyboard')
})

test('Keyboard subscriptions observe viewport and settled focus, then clean listeners and queued focus callbacks', () => {
  const env = keyboardBrowser()
  const observations = []
  const cleanup = env.model.subscribeToMobileKeyboard(() => observations.push(env.model.getMobileKeyboardSnapshot()))
  env.viewport.height = 500
  env.document.dispatch('focusin')
  assert.equal(observations.length, 0, 'Focus handlers should wait for activeElement')
  env.document.activeElement = { tagName: 'INPUT', type: 'email' }
  env.flush()
  assert.deepEqual(observations, [true])
  env.document.dispatch('focusout')
  env.document.activeElement = { tagName: 'BUTTON' }
  env.flush()
  assert.deepEqual(observations, [true, false])
  env.viewport.dispatch('resize')
  env.window.dispatch('resize')
  assert.equal(observations.length, 4)
  env.document.dispatch('focusin')
  cleanup()
  env.flush()
  env.viewport.dispatch('resize')
  env.window.dispatch('resize')
  assert.equal(observations.length, 4)
  assert.equal(env.viewport.count() + env.window.count() + env.document.count(), 0)
})

function renderNav(overrides = {}, keyboardOpen = false) {
  const calls = { search: 0, account: 0 }
  const Component = compile('src/components/layout/MobileBottomNav.tsx', {
    react: { useSyncExternalStore: () => keyboardOpen },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/lib/utils': { toPersianDigits: digits },
    '@/lib/mobile-navigation': model,
    './mobile-bottom-nav.module.css': { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) },
  }).default
  return {
    tree: Component({ pathname: '/', loggedIn: false, mounted: true, itemsCount: 0, hidden: false,
      onSearch() { calls.search++ }, onAccount() { calls.account++ }, ...overrides }),
    calls,
  }
}

test('Mobile nav provides visible destinations and search/account actions without submitting surrounding forms', () => {
  const app = renderNav()
  const links = nodes(app.tree).filter(node => node.type === 'Link')
  assert.deepEqual(links.map(node => node.props.href), ['/', '/products', '/cart'])
  const buttons = nodes(app.tree).filter(node => node.type === 'button')
  assert.deepEqual(buttons.map(text), ['جستجو', 'حساب'])
  for (const button of buttons) { assert.equal(button.props.type, 'button'); button.props.onClick() }
  assert.equal(buttons[0].props['aria-haspopup'], 'dialog')
  assert.deepEqual(app.calls, { search: 1, account: 1 })
  assert.equal(app.tree.props['aria-label'], 'دسترسی سریع موبایل')
})

test('Account labels and persisted cart counts wait for hydration and retain an uncapped accessible quantity', () => {
  const before = renderNav({ mounted: false, loggedIn: true, itemsCount: 123 }).tree
  assert.match(text(before), /حساب/)
  assert.doesNotMatch(text(before), /حساب من|۹۹\+/)
  assert.equal(nodes(before).find(node => node.props.href === '/cart').props['aria-label'], 'سبد خرید')
  const after = renderNav({ mounted: true, loggedIn: true, itemsCount: 123 }).tree
  assert.match(text(after), /حساب من/)
  assert.match(text(after), /۹۹\+/)
  assert.equal(nodes(after).find(node => node.props.href === '/cart').props['aria-label'], 'سبد خرید، ۱۲۳ کالا')
  assert.match(text(renderNav({ itemsCount: 4 }).tree), /۴/)
})

test('Nested product, checkout and registration pages identify exactly one active destination', () => {
  for (const [pathname, target] of [['/', '/'], ['/products/620', '/products'], ['/checkout', '/cart'], ['/register', 'account']]) {
    const active = nodes(renderNav({ pathname }).tree).filter(node => node.props['aria-current'] === 'page')
    assert.equal(active.length, 1)
    assert.equal(target === 'account' ? text(active[0]) : active[0].props.href, target === 'account' ? 'حساب' : target)
  }
})

test('Overlays and the keyboard remove the mobile nav from keyboard and assistive navigation', () => {
  assert.equal(renderNav({ hidden: true }).tree, null)
  assert.equal(renderNav({}, true).tree, null)
  assert.ok(renderNav().tree)
})

function mountHeader({ cachedSession = null, refreshedSession = null, refreshError = false } = {}) {
  const env = keyboardBrowser()
  const slots = [], effects = new Map(), pushes = []
  let cursor = 0, dirty = false, tree, pathname = '/', refreshes = 0
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const react = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: initial }
      return [slots[index].value, next => {
        const value = typeof next === 'function' ? next(slots[index].value) : next
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true }
      }]
    },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) effects.set(index, { callback, dependencies })
    },
  }
  const Header = compile('src/components/layout/Header.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/navigation': { usePathname: () => pathname, useRouter: () => ({ push: value => pushes.push(value) }) },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/lib/session-actions': { signOutWithSessionLock: async () => {} },
    '@/lib/cart': { useCart: selector => selector({ getItemsCount: () => 3 }) },
    '@/lib/utils': { toPersianDigits: digits },
    './NavSearch': { __esModule: true, default: 'NavSearch' },
    './MobileBottomNav': { __esModule: true, default: 'MobileBottomNav' },
    '@/components/ui/BrandLogo': { __esModule: true, default: 'BrandLogo' },
    './SiteSettingsProvider': { useSiteSettings: () => ({ storeName: 'پانیک' }) },
    '@/components/auth/SessionActivityProvider': { useAppSession: () => ({ session: cachedSession, refresh: async () => {
      refreshes++
      if (refreshError) throw new Error('Offline')
      return refreshedSession
    } }) },
  }, { window: env.window, document: env.document }).default
  function render() {
    let attempts = 0
    do {
      assert.ok(attempts++ < 10, 'Header should settle after a route change')
      cursor = 0; dirty = false; tree = Header()
    } while (dirty)
    for (const [index, effect] of effects) {
      slots[index]?.cleanup?.()
      slots[index] = { dependencies: effect.dependencies, cleanup: effect.callback() }
    }
    effects.clear()
    return tree
  }
  render()
  return {
    env, render, pushes, get refreshes() { return refreshes }, get tree() { return tree },
    nav: () => nodes(tree).find(node => node.type === 'MobileBottomNav'),
    route(next) { pathname = next; render() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

for (const [label, options, destination] of [
  ['a stale guest cache with a freshly authenticated user', { refreshedSession: { user: { id: 'user' } } }, '/profile'],
  ['an expired authenticated cache', { cachedSession: { user: { id: 'user', role: 'USER' } } }, '/login'],
  ['an unavailable session endpoint', { cachedSession: { user: { id: 'user', role: 'USER' } }, refreshError: true }, '/login'],
]) {
  test(`Mobile account routing refreshes ${label} before navigation`, async () => {
    const app = mountHeader(options)
    await app.nav().props.onAccount()
    assert.equal(app.refreshes, 1)
    assert.deepEqual(app.pushes, [destination])
    app.unmount()
    assert.equal(app.env.window.count(), 0)
  })
}

test('Header opens and closes search/menu from the mobile actions, then resets overlays on route changes', () => {
  const app = mountHeader()
  assert.equal(app.nav().props.hidden, false)
  app.nav().props.onSearch(); app.render()
  assert.equal(app.nav().props.hidden, true)
  nodes(app.tree).find(node => node.type === 'NavSearch').props.onClose(); app.render()
  assert.equal(app.nav().props.hidden, false)
  nodes(app.tree).find(node => node.props['aria-label'] === 'باز کردن منو').props.onClick(); app.render()
  assert.equal(app.nav().props.hidden, true)
  assert.equal(app.env.document.body.style.overflow, 'hidden')
  app.route('/products')
  assert.equal(app.nav().props.pathname, '/products')
  assert.equal(app.nav().props.hidden, false)
  assert.equal(app.env.document.body.style.overflow, '')
  app.nav().props.onSearch(); app.render()
  app.route('/cart')
  assert.equal(app.nav().props.hidden, false)
  assert.ok(!nodes(app.tree).some(node => node.type === 'NavSearch'))
  app.unmount()
})

test('Scrolling the floating header away leaves primary mobile destinations available', () => {
  const app = mountHeader()
  app.env.window.scrollY = 300
  app.env.window.dispatch('scroll'); app.render()
  assert.match(nodes(app.tree).find(node => node.type === 'header').props.className, /-translate-y/)
  assert.equal(app.nav().props.hidden, false)
  assert.equal(app.nav().props.itemsCount, 3)
  app.unmount()
})
