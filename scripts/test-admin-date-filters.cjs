const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

// Exercise dashboard range state with the shared picker's public contract.
// Calendar conversion itself is covered by the shared date-control suite.
function dashboard() {
  const slots = [], effects = [], requests = []
  let cursor = 0, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }]
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index]?.cleanup?.()
        slots[index] = { dependencies }
        effects.push(() => { slots[index].cleanup = callback() })
      }
    },
  }
  const jsx = (type, props) => ({ type: typeof type === 'function' ? type.name : type, props })
  const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    recharts: new Proxy({}, { get: (_, key) => key }),
    '@/lib/utils': { formatPrice: String, toPersianDigits: String },
    '@/components/ui/PersianDatePicker': { __esModule: true, default: 'PersianDatePicker' },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: 'select' },
  }
  const compiled = { exports: {} }
  const source = readFileSync(path.join(__dirname, '../src/app/admin/page.tsx'), 'utf8')
  vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, {
    module: compiled, AbortController, URLSearchParams, Date, Intl,
    fetch(url, options) { requests.push({ url, ...options }); return new Promise(() => {}) },
    require(name) { if (name.endsWith('.css')) return css; assert.ok(name in dependencies, 'Unexpected dashboard dependency ' + name); return dependencies[name] },
  })
  function render() { cursor = 0; tree = compiled.exports.default(); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, requests, get tree() { return tree }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree?.props) return []
  return [tree, ...nodes(tree.props.children)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}
const find = (app, predicate) => nodes(app.tree).find(predicate)
const picker = (app, id) => find(app, node => node.type === 'PersianDatePicker' && node.props.id === id)
const openCustom = app => { find(app, node => node.type === 'button' && text(node) === 'بازهٔ دلخواه').props.onClick(); app.render() }
const setDates = (app, from, to) => {
  picker(app, 'sales-date-from').props.onChange(from); app.render()
  picker(app, 'sales-date-to').props.onChange(to); app.render()
}
const apply = app => { find(app, node => node.type === 'form').props.onSubmit({ preventDefault() {} }); app.render() }

test('Dashboard uses Persian date controls while its report query retains Gregorian dates and Tehran semantics', () => {
  const app = dashboard()
  assert.equal(app.requests.length, 1)
  openCustom(app)
  assert.equal(nodes(app.tree).filter(node => node.type === 'PersianDatePicker').length, 2)
  assert.ok(!nodes(app.tree).some(node => node.type === 'input' && node.props.type === 'date'))
  assert.match(text(app.tree), /تاریخ‌ها شمسی هستند/)
  assert.match(text(app.tree), /ساعت تهران/)
  assert.ok(!text(app.tree).includes('میلادی'))
  setDates(app, '2026-10-15', '2026-10-21')
  assert.equal(app.requests.length, 1, 'Date drafts do not silently submit a new report')
  assert.equal(picker(app, 'sales-date-from').props.max, '2026-10-21')
  assert.equal(picker(app, 'sales-date-to').props.min, '2026-10-15')
  assert.equal(picker(app, 'sales-date-from').props.required, true)
  assert.equal(picker(app, 'sales-date-to').props['aria-describedby'], 'date-picker-note')
  apply(app)
  const query = new URL(app.requests.at(-1).url, 'http://localhost').searchParams
  assert.equal(query.get('range'), 'custom')
  assert.equal(query.get('from'), '2026-10-15')
  assert.equal(query.get('to'), '2026-10-21')
  assert.equal(app.requests[0].signal.aborted, true)
  app.unmount()
})

test('Persian date selection preserves range validation, inclusive single days and preset resets', () => {
  const app = dashboard()
  openCustom(app)
  for (const [from, to, message] of [
    ['', '2026-10-15', /تاریخ شروع و پایان را انتخاب کن/],
    ['2026-10-21', '2026-10-15', /تاریخ پایان باید بعد/],
    ['2025-01-01', '2026-10-15', /حداکثر ۳۶۶ روز/],
  ]) {
    setDates(app, from, to)
    apply(app)
    assert.equal(app.requests.length, 1)
    assert.match(text(app.tree), message)
  }
  setDates(app, '2026-10-15', '2026-10-15'); apply(app)
  assert.equal(app.requests.length, 2)
  const query = new URL(app.requests.at(-1).url, 'http://localhost').searchParams
  assert.equal(query.get('from'), query.get('to'))
  find(app, node => node.type === 'button' && text(node) === '۷ روز اخیر').props.onClick(); app.render()
  assert.equal(new URL(app.requests.at(-1).url, 'http://localhost').searchParams.get('range'), '7d')
  assert.equal(nodes(app.tree).filter(node => node.type === 'PersianDatePicker').length, 0)
  app.unmount()
})
