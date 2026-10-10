const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Run the actual controller against browser event/observer doubles, without a server or database.
class EventSurface {
  listeners = new Map()

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback)
  }

  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) callback(event)
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
  }
}

class AnimationDouble {
  onfinish = null
  currentTime = null
  playState = 'running'
  playCount = 0
  pauseCount = 0
  cancelCount = 0

  constructor(keyframes, options, throwingPause = false) {
    this.keyframes = keyframes
    this.options = options
    this.throwingPause = throwingPause
  }

  pause() {
    this.pauseCount++
    if (this.throwingPause) throw new Error('Unsupported animation pause')
    this.playState = 'paused'
  }
  play() { this.playCount++; this.playState = 'running' }
  cancel() { this.cancelCount++; this.playState = 'idle' }
  finish() { this.playState = 'finished'; this.onfinish?.() }
}

class ElementDouble extends EventSurface {
  children = []
  parentElement = null
  animations = []
  mutations = []

  constructor({ top = 0, reveal = false, delay, throwingAnimate = false, throwingPause = false } = {}) {
    super()
    this.top = top
    this.throwingAnimate = throwingAnimate
    this.throwingPause = throwingPause
    const trackWrites = (target) => new Proxy(target, {
      set: (object, key, value) => { this.mutations.push(['set', key, value]); object[key] = value; return true },
      deleteProperty: (object, key) => { this.mutations.push(['delete', key]); delete object[key]; return true },
    })
    this.dataset = trackWrites({ ...(reveal ? { reveal: '' } : {}), ...(delay === undefined ? {} : { revealDelay: String(delay) }) })
    this.style = trackWrites({})
  }

  append(child) {
    child.parentElement?.remove(child)
    child.parentElement = this
    this.children.push(child)
    return child
  }

  remove(child) {
    this.children = this.children.filter((candidate) => candidate !== child)
    child.parentElement = null
  }

  contains(element) {
    return this === element || this.children.some((child) => child.contains(element))
  }

  matches(selector) {
    assert.equal(selector, '[data-reveal]')
    return 'reveal' in this.dataset
  }

  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }

  getBoundingClientRect() {
    return { top: this.top, bottom: this.top + 100, width: 100, height: 100 }
  }

  animate(keyframes, options) {
    if (this.throwingAnimate) throw new Error('Unsupported native keyframes')
    const animation = new AnimationDouble(keyframes, options, this.throwingPause)
    this.animations.push(animation)
    return animation
  }

  setAttribute(name, value) { this.mutations.push(['attribute', name, value]) }
  removeAttribute(name) { this.mutations.push(['removeAttribute', name]) }
}

function browser({ reduced = false, intersectionSupport = true, mutationSupport = true } = {}) {
  const intersections = []
  const mutations = []
  const preference = new EventSurface()
  preference.matches = reduced
  const document = { activeElement: null }
  const root = new ElementDouble()

  class IntersectionDouble {
    observed = new Set()
    disconnected = false

    constructor(callback) {
      this.callback = callback
      intersections.push(this)
    }

    observe(element) { this.observed.add(element) }
    unobserve(element) { this.observed.delete(element) }
    disconnect() { this.disconnected = true; this.observed.clear() }
    deliver(entries) { this.callback(entries) }
  }

  class MutationDouble {
    disconnected = false

    constructor(callback) {
      this.callback = callback
      mutations.push(this)
    }

    observe(element) { this.root = element }
    disconnect() { this.disconnected = true }
    deliver(records) { this.callback(records) }
  }

  const window = new EventSurface()
  Object.assign(window, {
    innerHeight: 800,
    matchMedia(query) {
      assert.equal(query, '(prefers-reduced-motion: reduce)')
      return preference
    },
    ...(intersectionSupport ? { IntersectionObserver: IntersectionDouble } : {}),
    ...(mutationSupport ? { MutationObserver: MutationDouble } : {}),
  })
  const source = readFileSync(path.join(__dirname, '../src/lib/shop-motion.ts'), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
  const context = {
    module: { exports: {} }, window, document, HTMLElement: ElementDouble,
    IntersectionObserver: IntersectionDouble, MutationObserver: MutationDouble,
  }
  vm.runInNewContext(code, context)
  return {
    root, window, document, preference, intersections, mutations,
    observe: () => context.module.exports.observeShopMotion(root),
    add: (top, parent = root, options = {}) => parent.append(new ElementDouble({ top, reveal: true, ...options })),
    changePreference(matches) {
      preference.matches = matches
      preference.dispatch('change', { matches })
    },
    insert(parent, element) {
      parent.append(element)
      mutations.at(-1)?.deliver([{ addedNodes: [element], removedNodes: [] }])
    },
    remove(parent, element) {
      parent.remove(element)
      mutations.at(-1)?.deliver([{ addedNodes: [], removedNodes: [element] }])
    },
    enter(element, observer = intersections.at(-1)) {
      observer.deliver([{ target: element, isIntersecting: true }])
    },
  }
}

function expectPending(element) {
  const animation = element.animations.at(-1)
  assert.ok(animation, 'Below-fold content should have a native reveal animation')
  assert.equal(animation.playState, 'paused')
  assert.equal(animation.currentTime, 0)
  assert.equal(animation.playCount, 0)
  assert.equal(animation.cancelCount, 0)
  return animation
}

function expectVisible(element) {
  assert.ok(element.animations.every((animation) => animation.playState === 'idle'), 'Visible content must have no active reveal fill')
}

function expectClean(env) {
  for (const surface of [env.root, env.preference, env.window]) assert.equal(surface.listenerCount(), 0)
  assert.ok(env.intersections.every((observer) => observer.disconnected))
  assert.ok(env.mutations.every((observer) => observer.disconnected))
}

test('Server-rendered content is untouched before initialization; initial and restored viewport content never hides', () => {
  const env = browser()
  const hero = env.add(30)
  const restoredAbove = env.add(-500)
  const below = env.add(1000)
  expectVisible(hero)
  expectVisible(below)
  const cleanup = env.observe()
  expectVisible(hero)
  expectVisible(restoredAbove)
  expectPending(below)
  assert.equal(hero.animations.length, 0)
  assert.equal(restoredAbove.animations.length, 0)
  assert.deepEqual([...env.intersections[0].observed], [below])
  cleanup()
  expectVisible(below)
  expectClean(env)
})

test('Already focused content remains visible even when its bounds are below the viewport', () => {
  const env = browser()
  const panel = env.add(1000)
  const input = panel.append(new ElementDouble({ top: 1100 }))
  env.document.activeElement = input
  const cleanup = env.observe()
  expectVisible(panel)
  assert.equal(panel.animations.length, 0)
  assert.equal(env.intersections[0].observed.size, 0)
  cleanup()
})

test('Below-fold content plays once, unobserves on intersection, and cancels native fill on completion', () => {
  const env = browser()
  const card = env.add(1000)
  const other = env.add(1200)
  const cleanup = env.observe()
  const animation = expectPending(card)
  env.intersections[0].deliver([{ target: card, isIntersecting: false }])
  assert.equal(animation.playCount, 0)
  env.enter(card)
  assert.equal(animation.playCount, 1)
  assert.equal(animation.playState, 'running')
  assert.equal(env.intersections[0].observed.has(card), false)
  animation.finish()
  expectVisible(card)
  assert.equal(animation.cancelCount, 1)
  assert.equal(animation.onfinish, null)
  env.enter(card)
  assert.equal(animation.playCount, 1)
  expectPending(other)
  cleanup()
})

test('Keyboard focus immediately shows nested reveal panels and defeats stale intersection entries', () => {
  const env = browser()
  const panel = env.add(1000)
  const child = env.add(1100, panel)
  const link = child.append(new ElementDouble({ top: 1150 }))
  const cleanup = env.observe()
  const animations = [expectPending(panel), expectPending(child)]
  env.root.dispatch('focusin', { target: link })
  expectVisible(panel)
  expectVisible(child)
  assert.equal(env.intersections[0].observed.size, 0)
  env.enter(panel)
  env.enter(child)
  assert.ok(animations.every((animation) => animation.playCount === 0 && animation.cancelCount === 1))
  cleanup()
})

test('Asynchronously added content is registered, including reveal descendants inside a new wrapper', () => {
  const env = browser()
  const cleanup = env.observe()
  const wrapper = new ElementDouble()
  const visible = env.add(100, wrapper)
  const below = env.add(1000, wrapper)
  env.insert(env.root, wrapper)
  expectVisible(visible)
  assert.equal(visible.animations.length, 0)
  const animation = expectPending(below)
  assert.equal(env.intersections[0].observed.has(below), true)
  env.enter(below)
  assert.equal(animation.playCount, 1)
  cleanup()
})

test('Removing and reinserting a pending DOM node cannot leave it invisibly stranded', () => {
  const env = browser()
  const card = env.add(1000)
  const cleanup = env.observe()
  const animation = expectPending(card)
  env.remove(env.root, card)
  assert.equal(env.intersections[0].observed.has(card), false)
  expectVisible(card)
  env.enter(card)
  assert.equal(animation.playCount, 0)
  env.insert(env.root, card)
  expectVisible(card)
  assert.equal(card.animations.length, 1)
  assert.equal(env.intersections[0].observed.has(card), false)
  cleanup()
})

test('Moving an observed card within the root preserves its once-only observer membership', () => {
  const env = browser()
  const first = env.root.append(new ElementDouble())
  const second = env.root.append(new ElementDouble())
  const card = env.add(1000, first)
  const cleanup = env.observe()
  env.insert(second, card)
  const animation = expectPending(card)
  assert.equal(card.animations.length, 1)
  assert.equal(env.intersections[0].observed.has(card), true)
  env.enter(card)
  assert.equal(animation.playCount, 1)
  cleanup()
})

test('Changing to reduced motion finishes pending entries and disconnects active observers', () => {
  const env = browser()
  const card = env.add(1000)
  const running = env.add(1200)
  const cleanup = env.observe()
  env.enter(running)
  const oldIntersection = env.intersections[0]
  const oldMutations = env.mutations[0]
  env.changePreference(true)
  expectVisible(card)
  expectVisible(running)
  assert.equal(oldIntersection.disconnected, true)
  assert.equal(oldMutations.disconnected, true)
  env.enter(card, oldIntersection)
  assert.equal(card.animations[0].playCount, 0)
  assert.equal(env.intersections.length, 1)
  cleanup()
  expectClean(env)
})

test('Returning from reduced motion never replays existing cards but handles new content', () => {
  const env = browser({ reduced: true })
  const existing = env.add(1000)
  const cleanup = env.observe()
  expectVisible(existing)
  assert.equal(env.intersections.length, 0)
  env.changePreference(false)
  expectVisible(existing)
  assert.equal(existing.animations.length, 0)
  assert.equal(env.intersections[0].observed.has(existing), false)
  const added = new ElementDouble({ top: 1200, reveal: true })
  env.insert(env.root, added)
  const animation = expectPending(added)
  env.enter(added)
  assert.equal(animation.playCount, 1)
  cleanup()
})

for (const [name, options] of [
  ['reduced motion initially enabled', { reduced: true }],
  ['IntersectionObserver unavailable', { intersectionSupport: false }],
  ['MutationObserver unavailable', { mutationSupport: false }],
]) {
  test(`${name} leaves all existing content visible without observers`, () => {
    const env = browser(options)
    const card = env.add(1000)
    const cleanup = env.observe()
    expectVisible(card)
    assert.equal(card.animations.length, 0)
    assert.equal(env.intersections.length, 0)
    assert.equal(env.mutations.length, 0)
    cleanup()
    expectClean(env)
  })
}

test('Route cleanup only finishes owned nodes, preserving a newly committed route for its next controller', () => {
  const env = browser()
  const oldCard = env.add(1000)
  const cleanup = env.observe()
  const oldAnimation = expectPending(oldCard)
  env.root.remove(oldCard)
  // Simulate a new route commit before the old controller receives a mutation callback.
  const newCard = env.add(1100)
  cleanup()
  expectVisible(oldCard)
  expectVisible(newCard)
  assert.equal(newCard.animations.length, 0)
  expectClean(env)
  assert.equal(env.intersections[0].disconnected, true)
  assert.equal(env.mutations[0].disconnected, true)
  env.enter(oldCard, env.intersections[0])
  assert.equal(oldAnimation.playCount, 0)
  const nextCleanup = env.observe()
  const nextAnimation = expectPending(newCard)
  env.enter(newCard)
  assert.equal(nextAnimation.playCount, 1)
  nextCleanup()
})

test('Effect cleanup and remount re-arm unplayed entries while preserving already visible or played content', () => {
  const env = browser()
  const hero = env.add(100)
  const played = env.add(1000)
  const unplayed = env.add(1200)
  const cleanup = env.observe()
  env.enter(played)
  assert.equal(played.animations[0].playCount, 1)
  cleanup()
  expectVisible(hero)
  expectVisible(played)
  expectVisible(unplayed)
  expectClean(env)
  const nextCleanup = env.observe()
  expectVisible(hero)
  expectVisible(played)
  const replay = expectPending(unplayed)
  assert.equal(played.animations.length, 1)
  assert.equal(unplayed.animations.length, 2)
  assert.deepEqual([...env.intersections.at(-1).observed], [unplayed])
  env.enter(unplayed)
  assert.equal(replay.playCount, 1)
  nextCleanup()
})

test('A separate native animation is never cancelled by reveal completion or cleanup', () => {
  const env = browser()
  const card = env.add(1000)
  const unrelated = card.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(1deg)' }], { duration: 100 })
  const cleanup = env.observe()
  const reveal = expectPending(card)
  env.enter(card)
  reveal.finish()
  assert.equal(unrelated.playState, 'running')
  assert.equal(unrelated.cancelCount, 0)
  cleanup()
  assert.equal(unrelated.cancelCount, 0)
})

test('Missing HTMLElement.animate leaves unsupported content visible while supported cards still reveal', () => {
  const env = browser()
  const unsupported = env.add(1000)
  const supported = env.add(1200)
  unsupported.animate = undefined
  const cleanup = env.observe()
  expectVisible(unsupported)
  expectPending(supported)
  assert.equal(env.intersections[0].observed.has(unsupported), false)
  cleanup()
})

for (const failure of ['throwingAnimate', 'throwingPause']) {
  test(`${failure} fails open and setup continues for subsequent cards`, () => {
    const env = browser()
    const before = env.add(1000)
    const failing = env.add(1200, env.root, { [failure]: true })
    const after = env.add(1400)
    const cleanup = env.observe()
    expectPending(before)
    expectVisible(failing)
    expectPending(after)
    assert.equal(env.intersections[0].observed.has(failing), false)
    env.enter(after)
    assert.equal(after.animations[0].playCount, 1)
    cleanup()
    expectVisible(before)
    expectVisible(after)
    expectClean(env)
  })
}

test('Initialization, reveal completion, focus and cleanup never mutate React-owned attributes or inline styles', () => {
  const env = browser()
  const hero = env.add(100)
  const played = env.add(1000)
  const focused = env.add(1200)
  const elements = [hero, played, focused]
  const original = elements.map((element) => JSON.stringify(element.dataset))
  const cleanup = env.observe()
  env.enter(played)
  played.animations[0].finish()
  env.root.dispatch('focusin', { target: focused })
  cleanup()
  for (const [index, element] of elements.entries()) {
    assert.equal(JSON.stringify(element.dataset), original[index])
    assert.equal(element.mutations.length, 0)
  }
})

test('Before printing cancels running and paused native fills so all printed content is visible', () => {
  const env = browser()
  const paused = env.add(1000)
  const running = env.add(1200)
  const cleanup = env.observe()
  env.enter(running)
  const oldIntersection = env.intersections[0]
  env.window.dispatch('beforeprint')
  expectVisible(paused)
  expectVisible(running)
  assert.equal(oldIntersection.disconnected, true)
  assert.equal(env.mutations[0].disconnected, true)
  env.enter(paused, oldIntersection)
  assert.equal(paused.animations[0].playCount, 0)
  cleanup()
  expectClean(env)
})

test('Stagger delay is bounded; native animations pause on their first frame before intersection', () => {
  const env = browser()
  const cards = [-1, 0, 1, 3, 20, 'invalid'].map((delay) => env.add(1000, env.root, { delay }))
  const cleanup = env.observe()
  assert.deepEqual(cards.map((card) => expectPending(card).options.delay), [0, 0, 55, 165, 165, 0])
  for (const card of cards) {
    const animation = card.animations[0]
    assert.deepEqual(JSON.parse(JSON.stringify(animation.keyframes)), [{ opacity: 0, translate: '0 18px' }, { opacity: 1, translate: '0 0' }])
    assert.equal(animation.options.fill, 'both')
  }
  cleanup()
})
