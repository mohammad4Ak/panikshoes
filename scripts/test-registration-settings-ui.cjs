const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const snapshot = () => ({
  settings: {
    version: 4, emailEnabled: true, smsEnabled: false,
    expiryMinutes: 5, maxAttempts: 5, resendSeconds: 60, destinationHourlyLimit: 5, ipHourlyLimit: 30,
    emailSender: 'auth', smsTemplate: 'signup', smsProvider: 'custom',
    smsApiUrl: 'https://sms.example.test/verify', smsMethod: 'POST', smsBodyFormat: 'json',
    smsBodyTemplate: '{"phone":"{{phone}}","code":"{{code}}"}',
    smsHeaders: [{ name: 'Authorization', value: '', configured: true }],
    smsSuccessPath: '', smsSuccessValue: '200',
  },
  readiness: {
    emailConfigured: true, smsConfigured: true, otpConfigured: true, smsKeyConfigured: true,
    smsStoredKeyConfigured: true, smsEnvironmentKeyConfigured: false,
    settingsEncryptionConfigured: true, smsSecretsReadable: true,
  },
})

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return tree?.props ? [tree, ...nodes(tree.props.children)] : []
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}

async function mount(saveStatus = 200) {
  const slots = [], effects = [], requests = []
  let cursor = 0, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: initial }
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }]
    },
    useRef(initial) {
      const index = cursor++
      slots[index] ??= { current: initial }
      return slots[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { callback, deps }
      return slots[index].callback
    },
    useEffect(callback, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) {
        slots[index]?.cleanup?.()
        slots[index] = { deps }
        effects.push(() => { slots[index].cleanup = callback() })
      }
    },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props }
  const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => name }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '@/components/ui/EnhancedSelect': { __esModule: true, default: 'select' },
    '@/lib/customer-contact': { normalizeContactDigits: value => value.replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))) },
    '@/components/admin/admin.module.css': css, '../settings/settings.module.css': css, './registration.module.css': css,
  }
  const compiled = { exports: {} }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/registration/page.tsx'), 'utf8'), {
    loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic',
  }).code, {
    module: compiled, AbortController, Error,
    setTimeout(callback, delay) { if (delay === 0) effects.push(callback); return 1 }, clearTimeout() {},
    window: { confirm: () => true },
    async fetch(url, options) {
      requests.push({ url, ...options })
      if (options.method === 'PATCH' && saveStatus === 409) return Response.json({ error: 'تنظیمات تغییر کرده است.' }, { status: 409 })
      const data = snapshot()
      if (options.method === 'PATCH') data.settings.version++
      return Response.json(data)
    },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name] },
  })
  function render() {
    cursor = 0
    tree = compiled.exports.default()
    while (effects.length) effects.shift()()
  }
  const ready = async () => { await new Promise(setImmediate); render() }
  const field = id => nodes(tree).find(node => node.props.id === id)
  render()
  await ready()
  return {
    requests, field,
    change(id, value) { field(id).props.onChange({ target: { value } }); render() },
    async click(label) {
      nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label)).props.onClick()
      await ready()
    },
    async submit() { nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await ready() },
    submitDisabled: () => nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled,
  }
}

test('Saving policy settings preserves masked key and header values without echoing server-only fields', async () => {
  const app = await mount()
  assert.equal(app.field('registration-sms-api-key').props.value, '')
  app.change('registration-expiryMinutes', '۶')
  await app.submit()
  const body = JSON.parse(app.requests.at(-1).body)
  assert.equal(body.expiryMinutes, '6')
  assert.equal(body.smsApiKey, '')
  assert.equal(body.clearSmsApiKey, false)
  assert.deepEqual(body.smsHeaders, [{ name: 'Authorization', value: '' }])
  assert.equal(body.smsApiKeyEncrypted, undefined)
  assert.equal(body.smsHeadersEncrypted, undefined)
})

test('Key replacement is sent once, cleared after save, and preserved when a conflict needs review', async () => {
  const app = await mount()
  app.change('registration-sms-api-key', 'replacement-key-fixture')
  app.change('registration-header-value-0', 'Bearer {{apiKey}}')
  await app.submit()
  const body = JSON.parse(app.requests.at(-1).body)
  assert.equal(body.smsApiKey, 'replacement-key-fixture')
  assert.equal(body.smsHeaders[0].value, 'Bearer {{apiKey}}')
  assert.equal(app.field('registration-sms-api-key').props.value, '')
  assert.equal(app.field('registration-header-value-0').props.value, '')

  const conflicted = await mount(409)
  conflicted.change('registration-sms-api-key', 'pending-key-fixture')
  await conflicted.submit()
  assert.equal(conflicted.field('registration-sms-api-key').props.value, 'pending-key-fixture')
  assert.equal(conflicted.submitDisabled(), true)
})

test('Explicit key and header removal are separate from a blank replacement field', async () => {
  const app = await mount()
  await app.click('حذف کلید ذخیره‌شده')
  await app.click('حذف هدر ۱')
  await app.submit()
  const body = JSON.parse(app.requests.at(-1).body)
  assert.equal(body.clearSmsApiKey, true)
  assert.deepEqual(body.smsHeaders, [])
})
