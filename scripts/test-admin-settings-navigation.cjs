const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const config = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/admin-settings-sections.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, config)
const { settingsSections, getSettingsSection, isSettingsSection } = config.module.exports

function navigation(initialPath = '/admin', mobileContainer = null) {
  let pathname = initialPath, tree, current, cursor
  const slots = new Map(), listeners = new Map(), effects = []
  const window = {
    location: { hash: '' },
    addEventListener(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback) },
    removeEventListener(event, callback) { listeners.get(event)?.delete(callback) },
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
      const previous = current[index]
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        const slot = { dependencies }
        current[index] = slot
        effects.push(() => { previous?.cleanup?.(); slot.cleanup = callback() })
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++
      if (!(index in current)) current[index] = { cleanup: subscribe(() => {}) }
      return getSnapshot()
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
  const context = { module: { exports: {} }, window, require(name) { assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] } }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/AdminShell.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, context)
  function render() {
    const used = new Set()
    function expand(node) {
      if (Array.isArray(node)) {
        const keys = node.filter((child) => child && child.key != null).map((child) => String(child.key))
        assert.equal(new Set(keys).size, keys.length, 'Sibling navigation keys must remain unique on ' + pathname + ': ' + keys.join(', '))
        return node.map(expand)
      }
      if (!node || typeof node !== 'object' || !node.props) return node
      if (typeof node.type === 'function') {
        const key = node.type.name + ':' + (node.key || '')
        used.add(key)
        if (!slots.has(key)) slots.set(key, [])
        current = slots.get(key); cursor = 0
        return expand(node.type(node.props))
      }
      if (node.props.ref) node.props.ref.current = mobileContainer
      return { ...node, props: { ...node.props, children: expand(node.props.children) } }
    }
    tree = expand({ type: context.module.exports.default, props: { children: 'settings form' } })
    for (const [key, state] of slots) if (!used.has(key)) { state.forEach((slot) => slot?.cleanup?.()); slots.delete(key) }
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  const app = {
    render, get tree() { return tree }, listeners,
    navigate(next, hash = '') { pathname = next; window.location.hash = hash; render() },
    changeHash(hash, event = 'hashchange') { window.location.hash = hash; listeners.get(event)?.forEach((callback) => callback()); render() },
    unmount() { for (const state of slots.values()) state.forEach((slot) => slot?.cleanup?.()) },
  }
  render()
  return app
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
const toggle = (app) => nodes(app.tree).find((node) => node.type === 'button' && node.props['aria-controls'] === 'admin-settings-submenu')
const submenu = (app) => nodes(app.tree).find((node) => node.props.id === 'admin-settings-submenu')
const links = (tree) => nodes(tree).filter((node) => node.type === 'a' || node.type === 'Link')

test('Settings sections have stable unique IDs and unknown hashes use branding', () => {
  assert.equal(settingsSections.length, 7)
  assert.equal(new Set(settingsSections.map(({ id }) => id)).size, 7)
  for (const { id, label } of settingsSections) { assert.ok(label); assert.equal(isSettingsSection(id), true); assert.equal(getSettingsSection('#' + id), id) }
  for (const hash of ['', '#missing', '#__proto__', '#appearance?draft=1']) assert.equal(getSettingsSection(hash), 'branding')
})

test('Desktop settings parent is a collapsible button with links to every section', () => {
  const app = navigation()
  assert.equal(toggle(app).props.type, 'button')
  assert.equal(toggle(app).props['aria-expanded'], false)
  assert.equal(submenu(app).props.hidden, true)
  toggle(app).props.onClick(); app.render()
  assert.equal(toggle(app).props['aria-expanded'], true)
  assert.equal(submenu(app).props.hidden, false)
  assert.deepEqual(links(submenu(app)).map(({ props }) => props.href), Array.from(settingsSections, ({ id }) => '/admin/settings#' + id))
  app.unmount()
})

test('Entering settings expands the menu and uses native hash anchors without a route change', () => {
  const app = navigation()
  app.navigate('/admin/settings', '#appearance')
  assert.equal(toggle(app).props['aria-expanded'], true)
  assert.ok(links(submenu(app)).every((node) => node.type === 'a' && node.props.href.startsWith('#')))
  assert.equal(links(submenu(app)).find((node) => node.props['aria-current'] === 'location').props.href, '#appearance')
  toggle(app).props.onClick(); app.render()
  assert.equal(submenu(app).props.hidden, true)
  app.navigate('/admin/products'); app.navigate('/admin/settings')
  assert.equal(submenu(app).props.hidden, false)
  app.unmount()
})

test('Hash changes and browser history keep desktop and compact mobile sections active', () => {
  const app = navigation('/admin/settings')
  assert.equal(app.listeners.get('hashchange').size, 1)
  assert.equal(app.listeners.get('popstate').size, 1)
  app.changeHash('#contact')
  const current = () => links(app.tree).filter((node) => node.props['aria-current'] === 'location')
  assert.equal(current().length, 2)
  assert.ok(current().every((node) => node.props.href === '#contact'))
  app.changeHash('#seo', 'popstate')
  assert.ok(current().every((node) => node.props.href === '#seo'))
  const mobile = nodes(app.tree).find((node) => node.type === 'nav' && node.props['aria-label'] === 'بخش‌های تنظیمات عمومی')
  assert.equal(links(mobile).length, 7)
  app.navigate('/admin/products')
  assert.ok(!nodes(app.tree).some((node) => node.props['aria-label'] === 'بخش‌های تنظیمات عمومی'))
  app.unmount()
  assert.equal(app.listeners.get('hashchange').size, 0)
  assert.equal(app.listeners.get('popstate').size, 0)
})


test('Mobile section selection reveals clipped links by scrolling only its horizontal container', () => {
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


test('Every admin route keeps navigation sibling keys unique and its settings submenu usable', () => {
  const app = navigation('/admin/settings')
  const mobile = nodes(app.tree).find((node) => node.type === 'nav' && node.props['aria-label'] === 'ناوبری پنل')
  const routes = links(mobile).map((node) => node.props.href).filter((href) => href.startsWith('/admin'))
  for (const route of [...routes, '/admin/products/example', '/admin/settings']) {
    app.navigate(route)
    assert.equal(toggle(app).props['aria-expanded'], route === '/admin/settings')
    toggle(app).props.onClick(); app.render()
    assert.equal(toggle(app).props['aria-expanded'], route !== '/admin/settings')
  }
  app.unmount()
})
