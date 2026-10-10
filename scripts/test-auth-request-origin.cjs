const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

function load(file, dependencies, globals = {}) {
  const context = { module: { exports: {} }, URL, Request, Response, ...globals, require(name) {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`)
    return dependencies[name]
  } }
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, context)
  return context.module.exports
}

function route(env = 'development') {
  const requests = []
  const helper = load('src/lib/request-origin.ts', {})
  const handlers = Object.fromEntries(['GET', 'POST'].map((method) => [method, async (request) => {
    requests.push({ url: request.url, method: request.method, cookie: request.headers.get('cookie'), body: method === 'POST' ? await request.text() : null })
    return Response.json({ success: true })
  }]))
  return { requests, handlers: load('src/app/api/auth/[...nextauth]/route.ts', {
    '@/lib/auth': { handlers }, '@/lib/request-origin': helper,
    'next/server': { NextRequest: Request, NextResponse: Response },
  }, { process: { env: { NODE_ENV: env } } }) }
}

test('Development auth uses the incoming LAN address while preserving action, query and cookie', async () => {
  const app = route()
  const response = await app.handlers.GET(new Request('http://localhost:3000/api/auth/providers?check=1', {
    headers: { host: '192.168.1.101:3000', cookie: 'example=value' },
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(app.requests, [{ url: 'http://192.168.1.101:3000/api/auth/providers?check=1', method: 'GET', cookie: 'example=value', body: null }])
})

test('Development auth preserves a credential POST body and keeps localhost usable too', async () => {
  const app = route()
  const request = new Request('http://0.0.0.0:3000/api/auth/callback/credentials', {
    method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrfToken=test&email=test',
  })
  assert.equal((await app.handlers.POST(request)).status, 200)
  assert.equal(app.requests[0].url, 'http://localhost:3000/api/auth/callback/credentials')
  assert.equal(app.requests[0].method, 'POST')
  assert.equal(app.requests[0].body, 'csrfToken=test&email=test')
})

test('Development auth rejects an invalid Host before calling authentication', async () => {
  const app = route()
  assert.equal((await app.handlers.GET(new Request('http://localhost:3000/api/auth/providers', { headers: { host: 'evil.example/path' } }))).status, 400)
  assert.equal(app.requests.length, 0)
})

test('Production auth delegates the original request without changing its origin', async () => {
  const app = route('production')
  await app.handlers.GET(new Request('https://shop.example/api/auth/providers', { headers: { host: 'internal.example' } }))
  assert.equal(app.requests[0].url, 'https://shop.example/api/auth/providers')
})
