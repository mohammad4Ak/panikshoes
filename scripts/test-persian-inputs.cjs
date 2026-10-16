const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')
const DateObject = require('react-date-object').default
const persian = require('react-date-object/calendars/persian')
const persianFa = require('react-date-object/locales/persian_fa')

function compile(file, dependencies = {}, globals = {}) {
  const result = { exports: {} }
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8')
  // DateObject accepts plain objects from its own realm; keep real library calls
  // in that realm while injecting only the component's hooks/DOM dependencies.
  const injected = { module: result, require(name) { return name in dependencies ? dependencies[name] : require(name) }, ...globals }
  Function(...Object.keys(injected), transformSync(source, { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code)(...Object.values(injected))
  return result.exports
}
const numbers = compile('src/lib/localized-input.ts')
const dates = compile('src/lib/persian-date-input.ts')
const allNodes = tree => Array.isArray(tree) ? tree.flatMap(allNodes) : tree?.props ? [tree, ...allNodes(tree.props.children)] : []
const jsx = (type, props) => ({ type, props })
const css = { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) }
function controls(file, props, extra = {}) {
  const slots = [], effects = [], microtasks = []
  let cursor = 0, currentProps = props, tree
  const dom = { activeElement: null }
  const react = {
    useId() { return 'test-date-id' },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value } },
    useState(value) { const i = cursor++; slots[i] ??= { value }; return [slots[i].value, next => { slots[i].value = next }] },
    useEffect(callback) { effects.push(callback) },
  }
  const component = compile(file, {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/lib/localized-input': numbers, '@/lib/persian-date-input': dates,
    './persian-date-picker.module.css': css,
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    'react-multi-date-picker': { __esModule: true, default: 'DatePicker' },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: 'select' },
  }, { document: dom, queueMicrotask(callback) { microtasks.push(callback) }, ...extra }).default
  function render(next = {}) { currentProps = { ...currentProps, ...next }; cursor = 0; tree = component(currentProps); return tree }
  render()
  return { render, dom, get tree() { return tree }, effects() { effects.splice(0).forEach(callback => callback()) }, microtasks() { microtasks.splice(0).forEach(callback => callback()) } }
}

test('Integer entries accept Persian/Arabic/Latin digits and grouped pasted money, but reject fractions, signs and exponents', () => {
  for (const input of ['۱٬۲۵۰٬۰۰۰', '١,٢٥٠,٠٠٠', '1 250 000', '\u200e1,250,000\u200f']) assert.equal(numbers.parseIntegerInput(input), '1250000')
  assert.equal(numbers.parseIntegerInput('۰۰۰۱۲'), '12')
  assert.equal(numbers.parseIntegerInput('۰'), '0')
  assert.equal(numbers.parseIntegerInput(''), '')
  for (const invalid of ['-12', '1.25', '۱٫۲۵', '1e6', '۱۲تومان', '+2']) assert.equal(numbers.parseIntegerInput(invalid), null)
})

test('Integer formatting preserves every digit and groups only the display value', () => {
  assert.equal(numbers.formatIntegerInput('1250000'), '۱٬۲۵۰٬۰۰۰')
  assert.equal(numbers.formatIntegerInput('120', false), '۱۲۰')
  assert.equal(numbers.formatIntegerInput('0'), '۰')
  assert.equal(numbers.formatIntegerInput(''), '')
  assert.equal(numbers.parseIntegerInput(numbers.formatIntegerInput('900719925474099123456')), '900719925474099123456')
})

test('Text-based number controls still enforce required/min/max and safe integers with Persian validation messages', () => {
  assert.match(numbers.integerInputError('', true, 1, 99), /وارد/)
  assert.equal(numbers.integerInputError('', false, 1, 99), '')
  assert.match(numbers.integerInputError('0', true, 1, 99), /حداقل ۱/)
  assert.match(numbers.integerInputError('100', true, 1, 99), /۹۹/)
  assert.equal(numbers.integerInputError('99', true, 1, 99), '')
  assert.match(numbers.integerInputError('9007199254740992', false), /بزرگ/)
})

test('Number input emits raw ASCII, restores the logical caret and permits deletion beside separators', () => {
  const changes = []
  const app = controls('src/components/ui/FormattedNumberInput.tsx', { value: '1250000', min: 0, max: 2147483647, required: true, onValueChange: value => changes.push(value) })
  assert.equal(app.tree.props.type, 'text'); assert.equal(app.tree.props.value, '۱٬۲۵۰٬۰۰۰'); assert.equal(app.tree.props.inputMode, 'numeric')
  const field = { value: '۱۲٬۵۰۰٬۰۰۰', selectionStart: 2, selectionEnd: 2, setCustomValidity(message) { this.validity = message }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  app.tree.props.ref.current = field; app.dom.activeElement = field
  app.tree.props.onChange({ currentTarget: field }); assert.equal(changes[0], '12500000')
  app.render({ value: changes[0] }); field.value = app.tree.props.value; app.microtasks()
  assert.equal(field.selectionStart, 2)
  field.selectionStart = field.selectionEnd = 3
  app.tree.props.onKeyDown({ currentTarget: field, key: 'Backspace' }); assert.equal(field.selectionStart, 2)
  app.tree.props.onKeyDown({ currentTarget: field, key: 'Delete' }); assert.equal(field.selectionStart, 3)
  app.effects(); assert.equal(field.validity, '')
  app.render({ value: '', required: true }); app.effects(); assert.match(field.validity, /وارد/)
})

test('Calendar conversion round-trips Nowruz, Esfand leap days and local midnight without changing the civil day', () => {
  for (const [input, expected] of [['2024-03-20', '۱۴۰۳/۰۱/۰۱'], ['2025-03-20', '۱۴۰۳/۱۲/۳۰'], ['2025-03-21', '۱۴۰۴/۰۱/۰۱'], ['2026-03-21', '۱۴۰۵/۰۱/۰۱'], ['2026-10-15', '۱۴۰۵/۰۷/۲۳']]) {
    assert.equal(dates.persianInputLabel(input), expected)
    assert.equal(dates.gregorianInput(dates.readGregorianInput(input)), input)
  }
  assert.equal(dates.persianInputLabel('2026-10-15T00:00', true), '۱۴۰۵/۰۷/۲۳ ـ ۰۰:۰۰')
  assert.equal(dates.persianInputLabel('2026-10-15T23:59', true), '۱۴۰۵/۰۷/۲۳ ـ ۲۳:۵۹')
  for (const invalid of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-10-15T24:00', '2026-10-15T12:60']) assert.equal(dates.readGregorianInput(invalid, invalid.includes('T')), null)
})

test('The Persian calendar matches Intl Persian dates across the current decade', () => {
  const calendar = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' })
  for (let year = 2021; year <= 2031; year++) for (let month = 1; month <= 12; month++) {
    const input = `${year}-${String(month).padStart(2, '0')}-20`
    assert.equal(dates.persianInputLabel(input), calendar.format(new Date(`${input}T12:00:00Z`)), input)
  }
})

test('Changing a calendar day preserves the selected time, initializes new times to midnight and never mutates the date argument', () => {
  const selected = new DateObject({ date: '۱۴۰۵/۰۷/۲۴', format: 'YYYY/MM/DD', calendar: persian, locale: persianFa })
  assert.equal(dates.changeCalendarDay(selected, '2026-10-15T18:45', true), '2026-10-16T18:45')
  assert.equal(dates.changeCalendarDay(selected, '', true), '2026-10-16T00:00')
  assert.equal(dates.changeCalendarDay(selected, '', false), '2026-10-16')
  assert.equal(selected.calendar.name, 'persian'); assert.equal(selected.format(), '۱۴۰۵/۰۷/۲۴')
})

test('Date controls use Persian labels/digits, keep Gregorian API values, respect day limits and disable all date/time edits', () => {
  const changes = []
  const app = controls('src/components/ui/PersianDatePicker.tsx', { id: 'start', 'aria-label': 'شروع اعتبار', value: '2026-10-15T18:45', includeTime: true, min: '2026-10-01', max: '2026-10-31', onChange: value => changes.push(value) })
  const picker = allNodes(app.tree).find(node => node.type === 'DatePicker')
  assert.equal(picker.props.locale.name, 'persian_fa'); assert.equal(picker.props.calendar.name, 'persian')
  assert.equal(dates.gregorianInput(picker.props.minDate), '2026-10-01'); assert.equal(dates.gregorianInput(picker.props.maxDate), '2026-10-31')
  const trigger = allNodes(picker.props.render('', () => {})).find(node => node.type === 'input')
  assert.equal(trigger.props.value, '۱۴۰۵/۰۷/۲۳ ـ ۱۸:۴۵'); assert.equal(trigger.props.id, 'start'); assert.equal(trigger.props.type, 'text')
  const selects = allNodes(app.tree).filter(node => node.type === 'select')
  assert.equal(selects.length, 2)
  assert.equal(allNodes(selects[0]).find(node => node.type === 'option' && node.props.value === '18').props.children, '۱۸')
  selects[0].props.onChange({ target: { value: '09' } }); assert.equal(changes[0], '2026-10-15T09:45')
  const disabledTree = app.render({ disabled: true })
  assert.ok(allNodes(disabledTree).filter(node => node.type === 'select').every(node => node.props.disabled))
  allNodes(disabledTree).find(node => node.type === 'DatePicker').props.onChange(new DateObject())
  assert.equal(changes.length, 1)
})
