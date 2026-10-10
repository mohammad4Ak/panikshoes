const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const moduleContext = { module: { exports: {} }, URL, TypeError }
const source = readFileSync(path.join(__dirname, '..', 'src/lib/request-origin.ts'), 'utf8')
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, moduleContext)
const { getRequestOrigin, isSameOriginRequest } = moduleContext.module.exports
const request = (url = 'http://localhost:3000/api/orders', headers = {}) => new Request(url, { headers })

test('LAN mutations use the incoming host rather than Next\'s internal listening hostname', () => {
  for (const internalHost of ['localhost', '0.0.0.0']) {
    const input = request(`http://${internalHost}:3000/api/orders`, {
      Host: '192.168.1.101:3000', Origin: 'http://192.168.1.101:3000', 'Sec-Fetch-Site': 'same-origin',
    })
    assert.equal(getRequestOrigin(input), 'http://192.168.1.101:3000')
    assert.equal(isSameOriginRequest(input), true)
  }
})

test('Localhost and requests without Host keep their matching origin', () => {
  assert.equal(isSameOriginRequest(request('http://0.0.0.0:3000/api/orders', {
    Host: 'localhost:3000', Origin: 'http://localhost:3000',
  })), true)
  const fallback = request('https://shop.example/api/orders', { Origin: 'https://shop.example' })
  assert.equal(getRequestOrigin(fallback), 'https://shop.example')
  assert.equal(isSameOriginRequest(fallback), true)
  assert.equal(isSameOriginRequest(request()), true)
})

test('Canonical hostname, IPv6, and default ports match browser origins', () => {
  for (const [url, host, origin] of [
    ['http://localhost/api', 'LOCALHOST:80', 'http://localhost'],
    ['https://localhost/api', 'shop.example:443', 'https://shop.example'],
    ['http://localhost:3000/api', '[::1]:3000', 'http://[::1]:3000'],
  ]) {
    const input = request(url, { Host: host, Origin: origin })
    assert.equal(getRequestOrigin(input), origin)
    assert.equal(isSameOriginRequest(input), true)
  }
})

test('Foreign origins, different ports, and cross-site fetches remain rejected', () => {
  for (const origin of ['https://foreign.example', 'http://localhost:3000', 'http://192.168.1.101:3001', 'null', '']) {
    assert.equal(isSameOriginRequest(request(undefined, { Host: '192.168.1.101:3000', Origin: origin })), false)
  }
  for (const site of ['cross-site', 'same-site']) {
    assert.equal(isSameOriginRequest(request(undefined, {
      Host: '192.168.1.101:3000', Origin: 'http://192.168.1.101:3000', 'Sec-Fetch-Site': site,
    })), false)
    assert.equal(isSameOriginRequest(request(undefined, { 'Sec-Fetch-Site': site })), false)
  }
})

test('Malformed Host authorities cannot supply credentials, paths, extra hosts, or invalid ports', () => {
  for (const host of [
    '', 'user@localhost:3000', 'user:pass@localhost:3000', 'localhost:3000/path',
    'localhost:3000\\path', 'localhost:3000?target=foreign', 'localhost:3000#fragment',
    'localhost:3000,foreign.example', 'localhost :3000', 'local\thost:3000',
    'localhost:65536', 'localhost:', 'localhost:abc', '-localhost:3000',
    'localhost..example:3000', '[invalid]:3000', 'localhost%2f:3000',
    `${'a'.repeat(64)}.example:3000`, `${Array(5).fill('a'.repeat(60)).join('.')}:3000`,
  ]) {
    const input = request(undefined, { Host: host, Origin: 'http://localhost:3000' })
    assert.throws(() => getRequestOrigin(input), TypeError, host)
    assert.equal(isSameOriginRequest(input), false, host)
    assert.equal(isSameOriginRequest(request(undefined, { Host: host })), false, host)
  }
  // Headers itself rejects control bytes; also cover adapters supplying such values.
  for (const host of ['localhost\r\n:3000', 'localhost\u0000:3000']) {
    const input = { url: 'http://localhost:3000/api', headers: { get: (name) => name === 'host' ? host : null } }
    assert.throws(() => getRequestOrigin(input), TypeError)
    assert.equal(isSameOriginRequest(input), false)
  }
})

test('Forwarded host and protocol cannot replace the direct request authority', () => {
  const forwarded = {
    'X-Forwarded-Host': 'foreign.example', 'X-Forwarded-Proto': 'https',
    Forwarded: 'host=foreign.example;proto=https',
  }
  const sameOrigin = request(undefined, { ...forwarded, Host: '192.168.1.101:3000', Origin: 'http://192.168.1.101:3000' })
  assert.equal(getRequestOrigin(sameOrigin), 'http://192.168.1.101:3000')
  assert.equal(isSameOriginRequest(sameOrigin), true)
  assert.equal(isSameOriginRequest(request(undefined, { ...forwarded, Origin: 'https://foreign.example' })), false)
  assert.equal(isSameOriginRequest(request(undefined, { ...forwarded, Host: '192.168.1.101:3000', Origin: 'https://192.168.1.101:3000' })), false)
})
