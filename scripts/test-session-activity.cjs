const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const root = path.join(__dirname, '..')
const idleTimeout = 30 * 60 * 1000
const start = 1_800_000_000_000

function loadModule(filename, globals = {}, dependencies = {}) {
  const cache = new Map()
  function readModule(file) {
    const absolute = path.resolve(root, file)
    if (cache.has(absolute)) return cache.get(absolute)
    const testModule = { exports: {} }
    cache.set(absolute, testModule.exports)
    const { code } = transformSync(readFileSync(absolute, 'utf8'), {
      loader: path.extname(absolute) === '.tsx' ? 'tsx' : 'ts',
      jsx: 'automatic', format: 'cjs', target: 'es2022',
    })
    const requireDependency = (name) => {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('./')) return readModule(path.relative(root, path.join(path.dirname(absolute), `${name}.ts`)))
      throw new Error(`Unexpected dependency ${name}`)
    }
    vm.runInNewContext(code, { module: testModule, require: requireDependency, Date, ...globals }, { filename: absolute })
    cache.set(absolute, testModule.exports)
    return testModule.exports
  }
  return readModule(filename)
}

async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

function fakeClock() {
  let now = start
  let id = 0
  const timers = new Map()
  return {
    now: () => now,
    schedule(callback, delay) {
      assert.ok(Number.isFinite(delay), 'Timer delay must be finite')
      const timerId = ++id
      timers.set(timerId, { callback, at: now + Math.max(0, delay) })
      return timerId
    },
    cancel: (timerId) => timers.delete(timerId),
    sleep: (duration) => { now += duration },
    async advance(duration) {
      const target = now + duration
      let executions = 0
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        assert.ok(++executions <= 100, 'Timer/network retry loop must remain bounded')
        const [timerId, timer] = due
        timers.delete(timerId)
        now = Math.max(now, timer.at)
        timer.callback()
        await settle()
      }
      now = target
      await settle()
    },
    timers: () => timers.size,
  }
}

function activityFixture(overrides = {}) {
  const clock = fakeClock()
  let serverActivityAt = start
  let reads = 0
  let renewals = 0
  let expired = 0
  const sessions = []
  const events = []
  const session = () => clock.now() - serverActivityAt >= idleTimeout ? null : {
    user: { id: 'customer', role: 'USER', name: 'Name', email: 'user@example.com' },
    expires: new Date(serverActivityAt + idleTimeout).toISOString(),
  }
  const { createSessionActivity } = loadModule('src/lib/session-activity.ts')
  const controller = createSessionActivity({
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    read: async () => {
      reads++
      events.push('GET')
      return overrides.read ? overrides.read({ session, clock }) : session()
    },
    renew: async () => {
      renewals++
      events.push('POST')
      if (overrides.renew) return overrides.renew({ session, clock })
      if (!session()) return null
      serverActivityAt = clock.now()
      return session()
    },
    onSession: (next) => sessions.push(next),
    onExpired: () => { expired++ },
  })
  return {
    controller, clock, events, sessions, session,
    reads: () => reads, renewals: () => renewals, expired: () => expired,
    renewInAnotherTab: () => { serverActivityAt = clock.now() },
  }
}

test('The actual provider preserves customer sessions across refreshes and cancels browser timers safely', async () => {
  const clock = fakeClock()
  const effects = []
  const sessions = []
  const listeners = new Map()
  const canceledTimers = []
  let reads = 0
  let routeRefreshes = 0
  const browserWindow = {
    addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: (event) => listeners.delete(event),
    clearTimeout: function (timer) {
      // Native browser timers reject the options object as their receiver.
      // An arrow fakeClock.cancel alone cannot catch that provider wiring bug.
      if (this !== browserWindow) throw new TypeError('Illegal invocation')
      canceledTimers.push(timer)
      clock.cancel(timer)
    },
  }
  const BrowserDate = class extends Date { static now() { return clock.now() } }
  const { createSessionActivity } = loadModule('src/lib/session-activity.ts')
  const { default: SessionActivityProvider } = loadModule('src/components/auth/SessionActivityProvider.tsx', {
    Date: BrowserDate,
    window: browserWindow,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    localStorage: { setItem() {} },
    BroadcastChannel: undefined,
    setTimeout: clock.schedule,
    clearTimeout: browserWindow.clearTimeout,
  }, {
    react: {
      createContext: () => ({ Provider: 'session-provider' }),
      useState: () => [null, (session) => sessions.push(session)],
      useRef: (current) => ({ current }),
      useEffect: (effect) => effects.push(effect),
      useCallback: (callback) => callback,
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    'next/navigation': { usePathname: () => '/login', useRouter: () => ({ refresh: () => { routeRefreshes++ } }) },
    '@/lib/session-activity': { createSessionActivity },
    '@/lib/session-client': { requestSession: async () => {
      reads++
      return {
        user: { id: 'customer', role: 'USER', name: 'Name', email: 'user@example.com' },
        expires: new Date(start + idleTimeout).toISOString(),
      }
    } },
  })
  const provider = SessionActivityProvider({ children: null })
  const cleanup = effects[0]()
  effects[1]()
  await settle()
  assert.equal(reads, 1, 'Initial effects share the in-flight session read')
  assert.equal(clock.timers(), 1)

  for (let i = 0; i < 3; i++) {
    const session = await provider.props.value.refresh()
    assert.equal(session.user.id, 'customer')
    assert.equal(clock.timers(), 1, 'Each refresh replaces the expiry timer')
  }
  assert.equal(reads, 4, 'Valid responses must not enter the network retry delay')
  assert.equal(canceledTimers.length, 3)
  assert.equal(sessions.at(-1).user.role, 'USER')
  assert.equal(routeRefreshes, 0)

  listeners.get('pointerdown')({ isTrusted: true })
  assert.equal(clock.timers(), 2, 'Actual input schedules the throttled activity renewal')
  cleanup()
  assert.equal(clock.timers(), 0, 'Unmount cancels both expiry and activity timers')
  assert.equal(canceledTimers.length, 5)
  assert.equal(listeners.size, 0)
})

test('An idle session expires after 30 minutes without any activity renewal', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  await fixture.clock.advance(idleTimeout)
  assert.deepEqual(fixture.events, ['GET', 'GET'])
  assert.equal(fixture.renewals(), 0)
  assert.equal(fixture.sessions.at(-1), null)
  assert.equal(fixture.expired(), 1)
  assert.equal(fixture.clock.timers(), 0)
})

test('Continuous actual activity stays signed in beyond 30 minutes with throttled renewal', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  for (let i = 0; i < 180; i++) {
    await fixture.clock.advance(30_000)
    fixture.controller.activity()
    await settle()
  }
  assert.equal(fixture.expired(), 0)
  assert.ok(fixture.sessions.at(-1)?.user)
  assert.ok(fixture.renewals() >= 89 && fixture.renewals() <= 91)
  assert.equal(fixture.reads(), 1)
  fixture.controller.dispose()
})

test('The last pending input is flushed once after activity stops and then expires', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  await fixture.clock.advance(5000)
  fixture.controller.activity()
  fixture.controller.activity()
  await fixture.clock.advance(55_000)
  assert.equal(fixture.renewals(), 1)
  await fixture.clock.advance(idleTimeout - 1)
  assert.equal(fixture.expired(), 0)
  await fixture.clock.advance(1)
  assert.equal(fixture.renewals(), 1)
  assert.equal(fixture.expired(), 1)
})

test('Activity after a sleeping tab passes expiry checks GET before POST and cannot revive it', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  fixture.clock.sleep(idleTimeout + 1)
  fixture.controller.activity()
  await settle()
  assert.deepEqual(fixture.events, ['GET', 'GET'])
  assert.equal(fixture.sessions.at(-1), null)
  assert.equal(fixture.expired(), 1)
  assert.equal(fixture.renewals(), 0)
})

test('A pending activity timer resumed after sleep checks server validity before renewal', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  await fixture.clock.advance(5000)
  fixture.controller.activity()
  fixture.clock.sleep(idleTimeout + 1)
  await fixture.clock.advance(0)
  assert.deepEqual(fixture.events, ['GET', 'GET'])
  assert.equal(fixture.renewals(), 0)
  assert.equal(fixture.expired(), 1)
})

test('An idle tab reads another tab renewal at its stale deadline instead of logging out', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  await fixture.clock.advance(20 * 60 * 1000)
  fixture.renewInAnotherTab()
  await fixture.clock.advance(10 * 60 * 1000)
  assert.equal(fixture.reads(), 2)
  assert.equal(fixture.expired(), 0)
  assert.equal(fixture.renewals(), 0)
  assert.equal(fixture.sessions.at(-1).expires, new Date(start + 50 * 60 * 1000).toISOString())
  await fixture.clock.advance(20 * 60 * 1000)
  assert.equal(fixture.expired(), 1)
})

test('New input in a sleeping tab can renew after GET confirms another tab kept the session valid', async () => {
  const fixture = activityFixture()
  await fixture.controller.refresh()
  fixture.clock.sleep(idleTimeout + 1)
  fixture.renewInAnotherTab()
  fixture.controller.activity()
  await settle()
  assert.deepEqual(fixture.events, ['GET', 'GET'])
  assert.equal(fixture.expired(), 0)
  await fixture.clock.advance(60_000)
  assert.deepEqual(fixture.events, ['GET', 'GET', 'POST'])
  assert.equal(fixture.expired(), 0)
  fixture.controller.dispose()
})

test('Pending input during a slow session read is retained and renewed once after it finishes', async () => {
  let holdRead = false
  let releaseRead
  const fixture = activityFixture({ read: ({ session }) => holdRead
    ? new Promise((resolve) => { releaseRead = () => resolve(session()) }) : session() })
  await fixture.controller.refresh()
  await fixture.clock.advance(30_000)
  holdRead = true
  const reading = fixture.controller.refresh()
  fixture.controller.activity()
  await fixture.clock.advance(40_000)
  assert.equal(fixture.renewals(), 0)
  holdRead = false
  releaseRead()
  await reading
  await fixture.clock.advance(0)
  assert.equal(fixture.renewals(), 1)
  await fixture.clock.advance(60_000)
  assert.equal(fixture.renewals(), 1)
  fixture.controller.dispose()
})

test('A temporary network read failure preserves the session and retries after a bounded delay', async () => {
  let failRead = false
  const fixture = activityFixture({ read: ({ session }) => {
    if (failRead) throw new Error('offline')
    return session()
  } })
  await fixture.controller.refresh()
  await fixture.clock.advance(1000)
  failRead = true
  await assert.rejects(fixture.controller.refresh(), /offline/)
  assert.equal(fixture.expired(), 0)
  assert.ok(fixture.sessions.at(-1)?.user)
  await fixture.clock.advance(9999)
  assert.equal(fixture.reads(), 2)
  failRead = false
  await fixture.clock.advance(1)
  assert.equal(fixture.reads(), 3)
  assert.equal(fixture.expired(), 0)
  fixture.controller.dispose()
})

test('A failed renewal near expiry avoids an immediate POST retry loop and recovers with GET', async () => {
  const fixture = activityFixture({ renew: () => { throw new Error('offline') } })
  await fixture.controller.refresh()
  await fixture.clock.advance(idleTimeout - 500)
  fixture.controller.activity()
  await fixture.clock.advance(1000)
  assert.ok(fixture.renewals() <= 1)
  assert.equal(fixture.expired(), 0)
  await fixture.clock.advance(10_000)
  assert.equal(fixture.sessions.at(-1), null)
  assert.equal(fixture.expired(), 1)
})

test('Repeated expired input while offline does not bypass the 10-second retry delay', async () => {
  let offline = false
  const fixture = activityFixture({ read: ({ session }) => {
    if (offline) throw new Error('offline')
    return session()
  } })
  await fixture.controller.refresh()
  fixture.clock.sleep(idleTimeout + 1)
  offline = true
  fixture.controller.activity()
  await settle()
  for (let i = 0; i < 100; i++) {
    fixture.controller.activity()
    await settle()
  }
  assert.equal(fixture.reads(), 2)
  assert.equal(fixture.expired(), 0)
  assert.equal(fixture.renewals(), 0)
  await fixture.clock.advance(9999)
  assert.equal(fixture.reads(), 2)
  offline = false
  await fixture.clock.advance(1)
  assert.equal(fixture.reads(), 3)
  assert.equal(fixture.expired(), 1)
})

test('Disposing the monitor cancels timers and ignores a delayed session response', async () => {
  let resolveRead
  const fixture = activityFixture({ read: () => new Promise((resolve) => { resolveRead = resolve }) })
  const request = fixture.controller.refresh()
  fixture.controller.dispose()
  resolveRead(fixture.session())
  await request
  assert.equal(fixture.sessions.length, 0)
  assert.equal(fixture.clock.timers(), 0)
  fixture.controller.activity()
  assert.equal(fixture.renewals(), 0)
})

function jsonResponse(body, ok = true) { return { ok, json: async () => body } }

test('Session networking serializes GET and CSRF-protected activity POST and ignores background renewal', async () => {
  const calls = []
  let releaseRead
  const session = { user: { id: 'customer' }, expires: new Date(start + idleTimeout).toISOString() }
  const { requestSession } = loadModule('src/lib/session-client.ts', { fetch: async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) await new Promise((resolve) => { releaseRead = resolve })
    return jsonResponse(url.endsWith('/csrf') ? { csrfToken: 'csrf-from-server' } : session)
  } })
  const reading = requestSession()
  const renewing = requestSession(true)
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, undefined)
  releaseRead()
  assert.equal((await reading).user.id, 'customer')
  assert.equal((await renewing).user.id, 'customer')
  assert.deepEqual(calls.map(({ url }) => url), ['/api/auth/session', '/api/auth/csrf', '/api/auth/session'])
  assert.equal(calls[2].options.method, 'POST')
  assert.equal(calls[2].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[2].options.body), { csrfToken: 'csrf-from-server', data: { activity: true } })
  assert.ok(calls.every(({ options }) => options.cache === 'no-store'))
})

test('The Web Lock serializes session cookie reads and writes across separate tab modules', async () => {
  let lockTail = Promise.resolve()
  const lockNames = []
  const locks = { request(name, work) {
    lockNames.push(name)
    const next = lockTail.then(work)
    lockTail = next.catch(() => {})
    return next
  } }
  const calls = []
  let releaseFirst
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) await new Promise((resolve) => { releaseFirst = resolve })
    return jsonResponse(url.endsWith('/csrf') ? { csrfToken: 'csrf' } : {
      user: { id: 'customer' }, expires: new Date(start + idleTimeout).toISOString(),
    })
  }
  const tabA = loadModule('src/lib/session-client.ts', { fetch, navigator: { locks } })
  const tabB = loadModule('src/lib/session-client.ts', { fetch, navigator: { locks } })
  const reading = tabA.requestSession()
  const renewing = tabB.requestSession(true)
  await settle()
  assert.equal(calls.length, 1)
  releaseFirst()
  await Promise.all([reading, renewing])
  assert.deepEqual(calls.map(({ url }) => url), ['/api/auth/session', '/api/auth/csrf', '/api/auth/session'])
  assert.deepEqual(lockNames, ['shoeland-session', 'shoeland-session'])
})

test('A logout is queued after renewal and before the next session read so it cannot be overwritten', async () => {
  const calls = []
  let releaseRenewal
  let signedIn = true
  const session = { user: { id: 'customer' }, expires: new Date(start + idleTimeout).toISOString() }
  const networking = loadModule('src/lib/session-client.ts', { fetch: async (url, options) => {
    if (url.endsWith('/csrf')) return jsonResponse({ csrfToken: 'csrf' })
    calls.push(options.method === 'POST' ? 'renew' : 'read')
    if (options.method === 'POST') {
      await new Promise((resolve) => { releaseRenewal = resolve })
      signedIn = true
    }
    return jsonResponse(signedIn ? session : {})
  } })
  const actions = loadModule('src/lib/session-actions.ts', {}, {
    './session-client': networking,
    'next-auth/react': { signOut: async (options) => {
      calls.push('logout')
      assert.equal(options.redirectTo, '/')
      signedIn = false
    } },
  })
  const renewal = networking.requestSession(true)
  const logout = actions.signOutWithSessionLock({ redirectTo: '/' })
  const reading = networking.requestSession()
  await settle()
  assert.deepEqual(calls, ['renew'])
  releaseRenewal()
  await renewal
  await logout
  assert.equal(await reading, null)
  assert.deepEqual(calls, ['renew', 'logout', 'read'])
  assert.equal(signedIn, false)
})

test('Invalid expiry or failed HTTP responses do not become authenticated sessions', async () => {
  for (const response of [
    jsonResponse({ user: { id: 'customer' } }),
    jsonResponse({ user: { id: 'customer' }, expires: 'not-a-date' }),
    jsonResponse({ user: { id: 'customer' }, expires: new Date(start).toISOString() }, false),
  ]) {
    const { requestSession } = loadModule('src/lib/session-client.ts', { fetch: async () => response })
    await assert.rejects(requestSession(), /Session check failed/)
  }
})

test('Server remaining idle time is preserved when the browser clock is hours ahead or behind', async () => {
  for (const offset of [-2 * 60 * 60 * 1000, 2 * 60 * 60 * 1000]) {
    const clock = fakeClock()
    clock.sleep(offset)
    const LocalDate = class extends Date { static now() { return clock.now() } }
    let reads = 0
    const { requestSession } = loadModule('src/lib/session-client.ts', { Date: LocalDate,
      fetch: async () => {
        reads++
        return jsonResponse(clock.now() - offset >= start + idleTimeout ? {} : {
          user: { id: 'customer' }, serverTime: clock.now() - offset,
          expires: new Date(start + idleTimeout).toISOString(),
        })
      },
    })
    const firstSession = await requestSession()
    assert.equal(Date.parse(firstSession.expires) - clock.now(), idleTimeout)
    const { createSessionActivity } = loadModule('src/lib/session-activity.ts')
    let expired = 0
    let renewalCalls = 0
    const controller = createSessionActivity({
      read: () => requestSession(), renew: async () => { renewalCalls++; return null },
      now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
      onSession: () => {}, onExpired: () => { expired++ },
    })
    await controller.refresh()
    await clock.advance(idleTimeout - 1)
    assert.equal(expired, 0)
    assert.equal(reads, 2, 'No early or repeated session reads due to clock skew')
    await clock.advance(1)
    assert.equal(expired, 1)
    assert.equal(reads, 3)
    assert.equal(renewalCalls, 0)
  }
})

test('A failed request does not poison the session queue, and missing CSRF prevents a POST', async () => {
  const calls = []
  let failRead = true
  const { requestSession } = loadModule('src/lib/session-client.ts', { fetch: async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/csrf')) return jsonResponse({ csrfToken: '' })
    if (failRead) { failRead = false; throw new Error('offline') }
    return jsonResponse({})
  } })
  await assert.rejects(requestSession(), /offline/)
  assert.equal(await requestSession(), null)
  await assert.rejects(requestSession(true), /Session check failed/)
  assert.equal(calls.length, 3)
  assert.ok(!calls.some(({ options }) => options.method === 'POST'))
})
