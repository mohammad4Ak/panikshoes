const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
function compile(file, dependencies = {}, globals = {}) {
  const exportsBox = { exports: {} }
  const input = { module: exportsBox, require: name => name in dependencies ? dependencies[name] : require(name), ...globals }
  Function(...Object.keys(input), transformSync(readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code)(...Object.values(input))
  return exportsBox.exports
}
const model = compile('src/lib/select-options.ts')
const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
const option = (value, text, extra = {}) => React.createElement('option', { value, ...extra }, text)
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree?.props ? [tree, ...nodes(tree.props.children)] : []
function mount(props = {}, desktop = true) {
  const slots = [], effects = [], layouts = [], microtasks = [], observers = [], listeners = new Map()
  let cursor = 0, tree, latest = props, inheritedDisabled = false, events = 0
  const react = {
    useSyncExternalStore(_subscribe, snapshot, serverSnapshot) { return desktop ? snapshot() : serverSnapshot() },
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { slots[i].value = value }] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useId() { return 'select-error' },
    useEffect(callback) { effects.push(callback) }, useLayoutEffect(callback) { layouts.push(callback) },
  }
  const jsx = (type, props) => ({ type, props })
  const component = compile('src/components/ui/EnhancedSelect.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@/lib/select-options': model,
    '@radix-ui/react-select': Object.fromEntries(['Root', 'Trigger', 'Value', 'Icon', 'Portal', 'Content', 'ScrollUpButton', 'ScrollDownButton', 'Viewport', 'Group', 'Label', 'Item', 'ItemText', 'ItemIndicator'].map(name => [name, name])),
    'lucide-react': new Proxy({}, { get: (_, name) => name }), './enhanced-select.module.css': css,
  }, {
    window: { matchMedia(query) { assert.match(query, /min-width: 768px/); assert.match(query, /pointer: fine/); return { matches: true } } },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this) } observe() {} disconnect() {} },
    setTimeout(callback) { microtasks.push(callback); return 1 },
  }).default
  function render(next = {}) { latest = { ...latest, ...next }; cursor = 0; tree = component(latest); layouts.splice(0).forEach(callback => callback()); return tree }
  render()
  const field = {
    value: props.value ?? props.defaultValue ?? '', parentElement: null,
    matches() { return inheritedDisabled || !!latest.disabled },
    form: { addEventListener(name, callback) { listeners.set(name, callback) }, removeEventListener() {} },
    dispatchEvent(event) { events++; nodes(tree).find(node => node.type === 'select').props.onChange({ target: field, currentTarget: field, nativeEvent: event }) },
  }
  nodes(tree).find(node => node.type === 'select').props.ref.current = field
  return {
    render, field, listeners, get tree() { return tree }, get events() { return events },
    root() { return nodes(tree).find(node => node.type === 'Root') },
    trigger() { return nodes(tree).find(node => node.type === 'Trigger') },
    effects() { effects.splice(0).forEach(callback => callback()) },
    microtasks() { microtasks.splice(0).forEach(callback => callback()) },
    disableFieldset() { inheritedDisabled = true; observers.forEach(observer => observer.callback()); render() },
  }
}

test('Option model preserves empty/numeric values, labels, fragments and disabled optgroups', () => {
  const children = React.createElement(React.Fragment, null,
    option('', 'همه'), option(20, '۲۰'),
    React.createElement('optgroup', { label: 'گروه', disabled: true }, option('a', 'الف'), option('b', 'ب', { label: 'عنوان' })),
    option('hidden', 'پنهان', { hidden: true }))
  const options = model.selectOptions(children)
  assert.deepEqual(options.map(value => [value.value, value.label, value.disabled, value.hidden, value.group]), [
    ['', 'همه', false, false, undefined], ['20', '۲۰', false, false, undefined],
    ['a', 'الف', true, false, 'گروه'], ['b', 'عنوان', true, false, 'گروه'], ['hidden', 'پنهان', false, true, undefined],
  ])
  assert.equal(model.selectedOption(options, '20').label, '۲۰')
  assert.equal(model.selectedOption(options, 'missing').value, '')
  for (const raw of ['', '""', '20', 'کفش']) { assert.notEqual(model.selectMenuValue(raw), ''); assert.equal(JSON.parse(model.selectMenuValue(raw)), raw) }
})

test('Server rendering and mobile retain the original native select and HTML form attributes', () => {
  const component = compile('src/components/ui/EnhancedSelect.tsx', { '@/lib/select-options': model, './enhanced-select.module.css': css }).default
  const html = renderToStaticMarkup(React.createElement(component, { id: 'method', name: 'method', value: 'b', nativeAppearance: true, required: true, onChange() {} }, option('a', 'الف'), option('b', 'ب')))
  assert.match(html, /^<select/); assert.match(html, /id="method"/); assert.match(html, /name="method"/); assert.match(html, /required/); assert.match(html, /value="b" selected/)
  const app = mount({ nativeAppearance: true, id: 'sort', className: 'original', value: 'b', children: [option('a', 'الف'), option('b', 'ب')] }, false)
  assert.equal(app.tree.type, 'select'); assert.equal(app.tree.props.className, 'original'); assert.equal(app.tree.props.id, 'sort')
  assert.equal(app.root(), undefined)
})

test('Desktop bridges an actual native change target, including empty values, while rejecting disabled/hidden options', () => {
  const changes = []
  const app = mount({ id: 'sort', name: 'sort', value: 'b', onChange: event => changes.push(event.target), children: [option('', 'همه'), option('b', 'ب'), option('disabled', 'غیرفعال', { disabled: true }), option('hidden', 'پنهان', { hidden: true })] })
  assert.equal(app.trigger().props.id, 'sort')
  const proxy = nodes(app.tree).find(node => node.type === 'select')
  assert.equal(proxy.props.id, undefined); assert.equal(proxy.props.name, 'sort'); assert.equal(proxy.props['aria-hidden'], true); assert.equal(proxy.props.tabIndex, -1)
  app.root().props.onValueChange(model.selectMenuValue('')); assert.equal(app.field.value, ''); assert.equal(changes[0], app.field)
  app.root().props.onValueChange(model.selectMenuValue('disabled')); app.root().props.onValueChange(model.selectMenuValue('hidden'))
  assert.equal(app.events, 1)
})

test('Disabled fieldsets close the desktop portal and cannot commit another option', () => {
  const app = mount({ value: 'a', children: [option('a', 'الف'), option('b', 'ب')] })
  app.effects(); app.root().props.onOpenChange(true); app.render(); assert.equal(app.root().props.open, true)
  app.disableFieldset(); assert.equal(app.root().props.open, false); assert.equal(app.root().props.disabled, true)
  app.root().props.onValueChange(model.selectMenuValue('b')); assert.equal(app.events, 0)
})

test('Required validation focuses the visible control and keeps the native field invalid until a real choice', () => {
  let focused = 0, prevented = 0
  const app = mount({ required: true, value: '', children: [option('', 'انتخاب کنید', { disabled: true }), option('a', 'الف')] })
  app.trigger().props.ref.current = { focus() { focused++ } }
  nodes(app.tree).find(node => node.type === 'select').props.onInvalid({ preventDefault() { prevented++ } })
  app.render(); assert.equal(focused, 1); assert.equal(prevented, 1); assert.equal(app.trigger().props['aria-invalid'], true)
  assert.ok(nodes(app.tree).some(node => node.props.role === 'alert'))
  app.root().props.onValueChange(model.selectMenuValue('a')); app.render({ value: 'a' }); assert.equal(app.trigger().props['aria-invalid'], undefined)
})

test('Forwarded keyboard handlers retain native targets and stop the original Radix event', () => {
  let seen
  const app = mount({ value: 'a', children: option('a', 'الف'), onKeyDown(event) { seen = event.currentTarget; event.preventDefault(); event.stopPropagation() } })
  const event = { defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.propagationStopped = true }, isDefaultPrevented() { return this.defaultPrevented }, isPropagationStopped() { return this.propagationStopped } }
  app.trigger().props.onKeyDown(event)
  assert.equal(seen, app.field); assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true)
})

test('Form reset restores a nonfirst default after the native action; cancelled resets preserve the current choice', () => {
  const app = mount({ defaultValue: 'b', children: [option('a', 'الف'), option('b', 'ب')] })
  app.effects(); app.listeners.get('reset')({ defaultPrevented: false }); app.field.value = 'a'; app.microtasks()
  assert.equal(app.field.value, 'b'); assert.equal(JSON.parse(app.root().props.value), 'b')
  app.root().props.onValueChange(model.selectMenuValue('a')); app.render()
  app.listeners.get('reset')({ defaultPrevented: true }); app.microtasks(); assert.equal(app.field.value, 'a')
  app.listeners.get('reset')({ defaultPrevented: false }); app.field.value = 'a'; app.microtasks(); app.render()
  assert.equal(app.field.value, 'b'); assert.equal(JSON.parse(app.root().props.value), 'b')
})

test('Controlled resets use the latest committed value and grouped options share one labelled group', () => {
  const app = mount({ value: 'a', children: React.createElement('optgroup', { label: 'کفش‌ها' }, option('a', 'الف'), option('b', 'ب')) })
  app.effects(); app.listeners.get('reset')({ defaultPrevented: false }); app.render({ value: 'b' }); app.field.value = 'a'; app.microtasks()
  assert.equal(app.field.value, 'b')
  assert.equal(nodes(app.tree).filter(node => node.type === 'Group').length, 1)
  assert.equal(nodes(app.tree).filter(node => node.type === 'Item').length, 2)
})
