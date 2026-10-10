const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Exercise the real component with deterministic hooks, browser events and time.
// No HTTP requests, database writes, real browser profiles or wall-clock delays.
const product = (id, overrides = {}) => ({ id: String(id), slug: 'panik-' + id, name: 'کفش پانیک مدل ' + id, image: '/uploads/model-' + id + '.webp', eyebrow: 'از مجموعهٔ کفش زنانه', ...overrides })
const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
function surface(extra = {}) {
  const listeners = new Map()
  return {
    ...extra, listeners,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    dispatch(type) { [...listeners.get(type) || []].forEach(listener => listener()) },
    listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0) },
  }
}
function mount({ products = [product(1), product(2), product(3)], intervalSeconds = 10, reduced = false, hidden = false, heroTop = 110, scrollY = 0 } = {}) {
  const slots = [], effects = [], timers = new Map(), frames = new Map(), observers = []
  let cursor = 0, timerId = 0, frameId = 0, now = 0, tree, dirty = false, stateWrites = 0, mounted = true
  let props = { products, intervalSeconds }
  const preference = surface({ matches: reduced })
  const document = surface({ visibilityState: hidden ? 'hidden' : 'visible', activeElement: null })
  const panel = surface({ hovered: false, matches(selector) { assert.equal(selector, ':hover'); return this.hovered }, contains(element) { return !!element?.withinHero } })
  const header = {}, properties = new Map()
  const shell = { querySelector(selector) { assert.equal(selector, 'header'); return header } }
  const hero = {
    top: heroTop,
    getBoundingClientRect() { return { top: this.top } },
    closest(selector) { assert.equal(selector, '.shop-shell'); return shell },
    style: { setProperty(name, value) { properties.set(name, value) }, removeProperty(name) { properties.delete(name) }, getPropertyValue(name) { return properties.get(name) || '' } },
  }
  panel.parentElement = hero
  const root = { parentElement: panel }
  const window = surface({
    scrollY,
    matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return preference },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, due: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
  })
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this) }
    observe(target) { this.targets.add(target) }
    disconnect() { this.targets.clear() }
    notify() { if (this.targets.size) this.callback() }
  }
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, next => { stateWrites++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true }]
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useId() { const index = cursor++; return 'carousel-' + index },
    useMemo(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { dependencies, value: callback() }; return slots[index].value },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.()
        slots[index] = { dependencies }
        effects.push(() => { slots[index].cleanup = callback() })
      }
    },
    useSyncExternalStore(subscribe, snapshot) {
      const index = cursor++
      const value = snapshot()
      if (!slots[index] || slots[index].subscribe !== subscribe) {
        slots[index]?.cleanup?.()
        slots[index] = { subscribe, value }
        effects.push(() => {
          slots[index].cleanup = subscribe(() => { dirty = true })
          if (!Object.is(value, snapshot())) dirty = true
        })
      }
      return value
    },
  }
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/image': { __esModule: true, default: 'Image' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
  }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const compiledModule = { exports: {} }
  const { code } = transformSync(readFileSync(path.join(__dirname, '../src/components/shop/HomeHeroCarousel.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' })
  vm.runInNewContext(code, {
    module: compiledModule, document, window, ResizeObserver,
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, 'Unexpected dependency ' + name); return dependencies[name] },
  })
  const component = compiledModule.exports.default
  function render() {
    let attempts = 0
    do {
      dirty = false; cursor = 0; tree = component(props)
      nodes(tree).forEach(node => { if (node.props.ref) node.props.ref.current = root })
      effects.splice(0).forEach(effect => effect())
      assert.ok(++attempts < 20, 'Render failed to settle')
    } while (dirty)
    return tree
  }
  render()
  return {
    render, panel, preference, document, window, hero, shell, header, frames, observers,
    get tree() { return tree }, get timers() { return timers }, get stateWrites() { return stateWrites },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) },
    tick(ms) {
      const end = now + ms
      let iterations = 0
      while (mounted) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        assert.ok(++iterations < 1000, 'Timer loop did not settle')
        now = next[1].due; timers.delete(next[0]); next[1].callback(); render()
      }
      now = end
    },
    update(next) { props = { ...props, ...next }; render() },
    hover(value) { panel.hovered = value; panel.dispatch(value ? 'mouseenter' : 'mouseleave'); render() },
    focus(value) { document.activeElement = value ? { withinHero: true } : null; panel.dispatch(value ? 'focusin' : 'focusout'); render() },
    visibility(value) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatch('visibilitychange'); render() },
    motion(value) { preference.matches = value; preference.dispatch('change'); render() },
    unmount() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); nodes(tree).forEach(node => { if (node.props.ref) node.props.ref.current = null }) },
  }
}
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [] }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree && typeof tree === 'object') return text(tree.props?.children); return tree == null || typeof tree === 'boolean' ? '' : String(tree) }
const find = (app, predicate) => nodes(app.tree).find(predicate)
const button = (app, label) => find(app, node => node.type === 'button' && node.props['aria-label'] === label)
const activeLinks = app => nodes(app.tree).filter(node => node.type === 'Link' && node.props.tabIndex === 0)
const active = app => activeLinks(app)[0]?.props.href
const controls = app => find(app, node => node.props['aria-label'] === 'کنترل نمایش محصولات')
function click(app, label) { const target = button(app, label); assert.ok(target, 'Button not found: ' + label); target.props.onClick(); app.render() }
function key(app, value, modifiers = {}) { let prevented = false; controls(app).props.onKeyDown({ key: value, ...modifiers, preventDefault() { prevented = true } }); app.render(); return prevented }

test('Automatic rotation switches the image, caption and product URL together with only two arrow controls', () => {
  const app = mount()
  assert.equal(active(app), '/products/panik-1'); assert.equal(app.timers.size, 1)
  app.tick(9999); assert.equal(active(app), '/products/panik-1')
  app.tick(1); assert.equal(active(app), '/products/panik-2')
  assert.deepEqual(activeLinks(app).map(node => node.props.href), ['/products/panik-2', '/products/panik-2'])
  assert.match(text(activeLinks(app)[1]), /کفش پانیک مدل 2/)
  assert.match(text(activeLinks(app)[1]), /از مجموعهٔ کفش زنانه/)
  assert.deepEqual(nodes(app.tree).filter(node => node.type === 'button').map(node => node.props['aria-label']).sort(), ['نمایش محصول بعدی', 'نمایش محصول قبلی'].sort())
  app.tick(20000); assert.equal(active(app), '/products/panik-1')
  app.unmount()
})

test('Previous and next wrap, while manual navigation starts a complete fresh interval', () => {
  const app = mount()
  app.tick(8000); click(app, 'نمایش محصول قبلی'); assert.equal(active(app), '/products/panik-3')
  app.tick(9999); assert.equal(active(app), '/products/panik-3')
  app.tick(1); assert.equal(active(app), '/products/panik-1')
  click(app, 'نمایش محصول بعدی'); assert.equal(active(app), '/products/panik-2')
  app.unmount()
})

test('Keyboard selection of the current or last product resets the rotation deadline', () => {
  const app = mount()
  app.tick(9000); assert.equal(key(app, 'Home'), true)
  app.tick(9000); assert.equal(active(app), '/products/panik-1')
  assert.equal(key(app, 'End'), true); app.tick(9999); assert.equal(active(app), '/products/panik-3')
  app.tick(1); assert.equal(active(app), '/products/panik-1')
  app.unmount()
})

for (const [name, pause, resume] of [
  ['hovering anywhere on the visual panel', app => app.hover(true), app => app.hover(false)],
  ['keyboard focus inside the visual panel', app => app.focus(true), app => app.focus(false)],
  ['a hidden browser tab', app => app.visibility(false), app => app.visibility(true)],
]) test(name + ' suspends rotation and resumes with a fresh interval', () => {
  const app = mount(); app.tick(9000); pause(app)
  assert.equal(app.timers.size, 0); app.tick(30000); assert.equal(active(app), '/products/panik-1')
  resume(app); app.tick(9999); assert.equal(active(app), '/products/panik-1')
  app.tick(1); assert.equal(active(app), '/products/panik-2'); app.unmount()
})

test('Hover and focus pauses are independent, and leaving one does not cancel the other', () => {
  const app = mount(); app.hover(true); app.focus(true); app.hover(false)
  assert.equal(app.timers.size, 0); app.tick(20000); assert.equal(active(app), '/products/panik-1')
  app.focus(false); assert.equal(app.timers.size, 1); app.unmount()
})

test('Reduced motion stays static while both arrows support manual browsing without playback controls', () => {
  const app = mount({ reduced: true }); assert.equal(app.timers.size, 0)
  app.tick(30000); assert.equal(active(app), '/products/panik-1')
  click(app, 'نمایش محصول بعدی'); assert.equal(active(app), '/products/panik-2')
  click(app, 'نمایش محصول قبلی'); assert.equal(active(app), '/products/panik-1')
  app.hover(true); app.hover(false); app.focus(true); app.focus(false)
  app.visibility(false); app.visibility(true); app.tick(30000)
  assert.equal(app.timers.size, 0); assert.equal(active(app), '/products/panik-1')
  assert.deepEqual(nodes(app.tree).filter(node => node.type === 'button').map(node => node.props['aria-label']).sort(), ['نمایش محصول بعدی', 'نمایش محصول قبلی'].sort())
  app.unmount()
})

test('Changing operating-system motion preferences stops rotation and resumes with a fresh complete interval', () => {
  const app = mount(); app.tick(9000); app.motion(true)
  assert.equal(app.timers.size, 0); app.tick(60000); assert.equal(active(app), '/products/panik-1')
  app.motion(false); assert.equal(app.timers.size, 1)
  app.tick(9999); assert.equal(active(app), '/products/panik-1')
  app.tick(1); assert.equal(active(app), '/products/panik-2')
  app.motion(true); assert.equal(app.timers.size, 0); app.tick(30000); assert.equal(active(app), '/products/panik-2')
  app.unmount()
})

for (const [provided, expected] of [[1, 5000], [0, 5000], [300, 120000], [NaN, 10000], [Infinity, 10000], [17, 17000]]) {
  test('Defensive interval ' + provided + ' resolves to ' + expected + ' milliseconds', () => {
    const app = mount({ intervalSeconds: provided })
    app.tick(expected - 1); assert.equal(active(app), '/products/panik-1')
    app.tick(1); assert.equal(active(app), '/products/panik-2'); app.unmount()
  })
}

test('Changing interval props cancels the old deadline and uses the updated setting', () => {
  const app = mount(); app.tick(9000); app.update({ intervalSeconds: 20 })
  app.tick(19999); assert.equal(active(app), '/products/panik-1')
  app.tick(1); assert.equal(active(app), '/products/panik-2'); app.unmount()
})

test('Keyboard navigation follows RTL arrow direction with Home/End, ignores modified or unrelated keys, and never moves focus', () => {
  const app = mount(); app.focus(true); const focused = app.document.activeElement
  assert.equal(key(app, 'ArrowLeft'), true); assert.equal(active(app), '/products/panik-2')
  assert.equal(key(app, 'ArrowRight'), true); assert.equal(active(app), '/products/panik-1')
  assert.equal(key(app, 'End'), true); assert.equal(active(app), '/products/panik-3')
  assert.equal(key(app, 'Home'), true); assert.equal(active(app), '/products/panik-1')
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) assert.equal(key(app, 'ArrowLeft', { [modifier]: true }), false)
  assert.equal(key(app, 'Escape'), false); assert.equal(active(app), '/products/panik-1')
  assert.equal(app.document.activeElement, focused); assert.equal(app.timers.size, 0); app.unmount()
})

test('Only the active image and caption are keyboard reachable; inactive slides are hidden from accessibility APIs', () => {
  const app = mount(); const links = nodes(app.tree).filter(node => node.type === 'Link')
  assert.equal(links.length, 6); assert.equal(activeLinks(app).length, 2)
  assert.ok(links.filter(node => node.props.tabIndex === -1).every(node => node.props['aria-hidden'] === true))
  assert.ok(activeLinks(app).every(node => node.props['aria-hidden'] === false))
  assert.equal(app.tree.props['aria-live'], 'off'); app.unmount()
})

test('A single product keeps the existing image and caption without controls or a rotation timer', () => {
  const app = mount({ products: [product(1)] })
  assert.equal(activeLinks(app).length, 2); assert.equal(controls(app), undefined); assert.equal(app.timers.size, 0)
  assert.equal(nodes(app.tree).filter(node => node.type === 'button').length, 0)
  app.tick(100000); assert.equal(active(app), '/products/panik-1')
  app.unmount()
})

test('An empty or unusable product list renders no broken image or controls and starts no timer', () => {
  for (const products of [[], [product(1, { image: ' ' })], [product(1, { slug: '' })]]) {
    const app = mount({ products }); assert.equal(app.tree, null); assert.equal(app.timers.size, 0); app.unmount()
  }
})

test('Prop updates preserve the selected product when reordered and safely fall back when it is removed', () => {
  const app = mount(); click(app, 'نمایش محصول بعدی'); app.update({ products: [product(3), product(2), product(1)] })
  assert.equal(active(app), '/products/panik-2')
  app.update({ products: [product(3), product(1)] }); assert.equal(active(app), '/products/panik-3')
  app.tick(10000); assert.equal(active(app), '/products/panik-1')
  app.update({ products: [product(1)] }); assert.equal(app.timers.size, 0); assert.equal(controls(app), undefined)
  app.update({ products: [] }); assert.equal(app.tree, null); assert.equal(app.timers.size, 0); app.unmount()
})

test('Defensive filtering deduplicates IDs, bounds slides to ten and keeps exactly two navigation arrows', () => {
  const app = mount({ products: [product(1), product(1), product(0, { image: '' }), ...Array.from({ length: 12 }, (_, index) => product(index + 2))] })
  assert.equal(nodes(app.tree).filter(node => node.type === 'Image').length, 10)
  assert.deepEqual(nodes(app.tree).filter(node => node.type === 'button').map(node => node.props['aria-label']).sort(), ['نمایش محصول بعدی', 'نمایش محصول قبلی'].sort())
  click(app, 'نمایش محصول قبلی'); assert.equal(active(app), '/products/panik-10'); app.unmount()
})

test('Product paths are encoded and the first image alone is preloaded, with local/remote image handling preserved', () => {
  const app = mount({ products: [product(1, { slug: 'مدل ۱', image: 'https://example.com/shoe.webp' }), product(2)] })
  assert.equal(active(app), '/products/' + encodeURIComponent('مدل ۱'))
  const images = nodes(app.tree).filter(node => node.type === 'Image')
  assert.equal(images[0].props.preload, true); assert.equal(images[0].props.loading, undefined); assert.equal(images[0].props.unoptimized, true)
  assert.equal(images[1].props.preload, false); assert.equal(images[1].props.unoptimized, false); app.unmount()
})

test('Hero measurement accounts for scrolling, responds to layout and viewport changes, and cleans up every resource', () => {
  const app = mount({ heroTop: -39.75, scrollY: 150 }); assert.equal(app.timers.size, 1); assert.equal(app.panel.listenerCount(), 4)
  assert.equal(app.preference.listenerCount(), 1); assert.equal(app.document.listenerCount(), 1)
  assert.equal(app.hero.style.getPropertyValue('--hero-top'), '111px')
  assert.equal(app.window.listenerCount(), 1); assert.equal(app.observers.length, 1)
  const observer = app.observers[0]
  assert.deepEqual([...observer.targets], [app.shell, app.header])
  app.hero.top = -9.75; observer.notify()
  const pendingFrame = [...app.frames.keys()][0]
  observer.notify(); assert.equal(app.frames.size, 1); assert.equal(app.frames.has(pendingFrame), false)
  app.flushFrames(); assert.equal(app.hero.style.getPropertyValue('--hero-top'), '141px')
  app.hero.top = -29.75; app.window.dispatch('resize'); assert.equal(app.frames.size, 1)
  app.flushFrames(); assert.equal(app.hero.style.getPropertyValue('--hero-top'), '121px')
  app.window.scrollY = 180; app.hero.top = -59.75; app.window.dispatch('resize'); app.flushFrames()
  assert.equal(app.hero.style.getPropertyValue('--hero-top'), '121px')
  app.window.dispatch('resize'); assert.equal(app.frames.size, 1)
  const writes = app.stateWrites; app.unmount(); assert.equal(app.timers.size, 0)
  assert.equal(app.frames.size, 0); assert.equal(observer.targets.size, 0); assert.equal(app.window.listenerCount(), 0)
  assert.equal(app.hero.style.getPropertyValue('--hero-top'), '')
  assert.equal(app.panel.listenerCount(), 0); assert.equal(app.preference.listenerCount(), 0); assert.equal(app.document.listenerCount(), 0)
  app.tick(30000); app.panel.dispatch('mouseenter'); app.preference.dispatch('change'); app.document.dispatch('visibilitychange')
  app.window.dispatch('resize'); observer.notify(); app.flushFrames()
  assert.equal(app.frames.size, 0); assert.equal(app.hero.style.getPropertyValue('--hero-top'), '')
  assert.equal(app.stateWrites, writes)
})
