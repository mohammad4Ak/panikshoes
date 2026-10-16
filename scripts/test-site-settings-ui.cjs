const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const { File } = require('node:buffer')
const { webcrypto } = require('node:crypto')

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const settle = () => new Promise(setImmediate)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const contract = { module: { exports: {} }, URL }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/site-settings-contract.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, contract)
const canonical = { ...contract.module.exports.initialSiteSettings, version: 2 }
const sectionContract = { module: { exports: {} } }
vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/lib/admin-settings-sections.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, sectionContract)

function page(queues = {}, options = {}) {
  const slots = [], effects = [], requests = [], timers = new Map(), listeners = new Map(), focus = []
  let currentHash = options.hash || ''
  const dispatch = (type) => { for (const listener of [...(listeners.get(type) || [])]) listener({ type }) }
  const location = {}
  Object.defineProperty(location, 'hash', {
    get() { return currentHash },
    set(value) {
      const next = value && !value.startsWith('#') ? '#' + value : value
      if (next !== currentHash) { currentHash = next; queueMicrotask(() => dispatch('hashchange')) }
    },
  })
  const window = {
    location,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
  }
  let cursor = 0, tree, writes = 0, refreshes = 0, nextTimer = 0
  const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, (next) => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
    useCallback(callback, dependencies) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { callback, dependencies }
      return slots[index].callback
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
  const jsx = (type, props) => ({ type, props })
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'next/image': { __esModule: true, default: 'Image' },
    'next/link': { __esModule: true, default: 'Link' },
    'next/navigation': { useRouter: () => ({ refresh() { refreshes++ } }) },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '@/components/ui/PanikMark': { __esModule: true, default: 'PanikMark' },
    '@/components/admin/HomeHeroSettings': { __esModule: true, default: 'HomeHeroSettings' },
    '@/components/admin/FooterSettings': { __esModule: true, default: 'FooterSettings' },
    '@/components/ui/EnhancedSelect': { __esModule: true, default: 'select' },
    '@/components/ui/SocialIcons': { EitaaIcon: 'EitaaIcon', InstagramIcon: 'InstagramIcon', TelegramIcon: 'TelegramIcon', WhatsAppIcon: 'WhatsAppIcon' },
    './footer-settings.module.css': { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) },
    '@/lib/site-settings-contract': contract.module.exports,
    '@/lib/admin-settings-sections': sectionContract.module.exports,
    '@/components/admin/admin.module.css': { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) },
    './settings.module.css': { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) },
  }
  const fetch = (url, options = {}) => {
    requests.push({ url, ...options })
    const key = `${options.method || 'GET'} ${url}`
    const value = queues[key]?.length ? queues[key].shift() : response(canonical)
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (options.signal?.aborted) return abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      Promise.resolve(value).then((data) => {
        options.signal?.removeEventListener('abort', abort)
        if (data instanceof Error) reject(data)
        else resolve(data)
      }, reject)
    })
  }
  const findSection = (target) => nodes(tree).find((node) => node.props['data-settings-section'] && nodes(node).includes(target))
  const element = (target) => target ? {
    ...target.props,
    dataset: { settingsSection: target.props['data-settings-section'] },
    focus() { focus.push(target.props.id) },
    reportValidity() { return false },
    validationMessage: target.props.type === 'email' ? 'Please enter an email address.' : 'Please fill out this field.',
    getAttribute(name) { return target.props[name] },
    closest() { return element(findSection(target)) },
  } : null
  const invalidNode = () => nodes(tree).find((node) => {
    if (!['input', 'textarea', 'select'].includes(node.type) || node.props.disabled) return false
    const value = String(node.props.value ?? '')
    return (node.props.required && !value.trim()) || (node.props.type === 'email' && value && !/^[^@\s]+@[^@\s]+$/.test(value))
  })
  const document = {
    getElementById(id) { return element(nodes(tree).find((node) => node.props.id === id)) },
    querySelector(selector) { return selector.includes(':invalid') ? element(invalidNode()) : null },
  }
  const context = {
    module: { exports: {} }, AbortController, FormData, fetch, window, document, queueMicrotask, crypto: options.crypto ?? webcrypto,
    requestAnimationFrame(callback) { queueMicrotask(callback); return 0 },
    cancelAnimationFrame() {},
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] },
  }
  // Test settings and footer state through the shared select's public native
  // contract. Desktop/mobile control rendering is covered separately.
  const footerContext = { ...context, module: { exports: {} } }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/components/admin/FooterSettings.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, footerContext)
  dependencies['@/components/admin/FooterSettings'].default = footerContext.module.exports.default
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object' || !node.props) return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  vm.runInNewContext(transformSync(readFileSync(path.join(__dirname, '../src/app/admin/settings/page.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', target: 'es2022', jsx: 'automatic' }).code, context)
  const app = {
    requests, get tree() { return tree }, get writes() { return writes }, get refreshes() { return refreshes },
    get currentHash() { return currentHash }, get focus() { return focus },
    get listeners() { return listeners },
    setHash(hash, type = 'hashchange') { currentHash = hash; dispatch(type); return app.render() },
    submit() { return nodes(tree).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {}, currentTarget: { querySelector() { return element(invalidNode()) } } }) },
    render() { cursor = 0; tree = expand(context.module.exports.default()); effects.splice(0).forEach((effect) => effect()); return tree },
    timeout() { for (const callback of [...timers.values()]) callback() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
  app.render()
  return app
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [tree, ...nodes(tree.props.children)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree && typeof tree === 'object') return text(tree.props?.children)
  return tree == null || typeof tree === 'boolean' ? '' : String(tree)
}
const field = (app, key) => nodes(app.tree).find((node) => node.props.id === `settings-${key}`)
const button = (app, label) => nodes(app.tree).find((node) => node.type === 'button' && text(node).includes(label))
const submit = (app) => app.submit()
const patches = (app) => app.requests.filter((request) => request.method === 'PATCH')
const sections = (app) => nodes(app.tree).filter((node) => node.props['data-settings-section'])
const visibleSections = (app) => sections(app).filter((node) => !node.props.hidden).map((node) => node.props['data-settings-section'])
const logoPreviews = (app) => nodes(app.tree).filter((node) => node.type === 'Image' && node.props.width === 100)
const bannerPreview = (app) => nodes(app.tree).find((node) => node.props['aria-label'] === 'پیش‌نمایش بنر صفحهٔ اول')
const uploadInput = (app, key = 'logoUrl') => nodes(app.tree).find((node) => node.props.id === `settings-upload-${key}`)
const choose = (app, file, key) => uploadInput(app, key).props.onChange({ target: { files: [file], value: 'selected' } })

test('Initial settings load blocks placeholder saves; a failed read offers retry and loads canonical values', async () => {
  const loading = deferred()
  const app = page({ 'GET /api/admin/site-settings': [loading.promise, response(canonical)] })
  assert.ok(!nodes(app.tree).some((node) => node.type === 'form'))
  loading.resolve(response({ error: 'خطای بارگذاری' }, 503)); await settle(); app.render()
  assert.match(text(app.tree), /خطای بارگذاری/)
  assert.equal(patches(app).length, 0)
  button(app, 'تلاش دوباره').props.onClick(); await settle(); app.render()
  assert.equal(field(app, 'storeName').props.value, canonical.storeName)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})

test('A duplicate save is locked, preserves version and draft after failure, and refreshes only after verified success', async () => {
  const saving = deferred()
  const saved = { ...canonical, storeName: 'برند تازه', version: 3 }
  const app = page({ 'PATCH /api/admin/site-settings': [saving.promise, response(saved)] })
  await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: saved.storeName } }); app.render()
  const first = submit(app); await submit(app); app.render()
  assert.equal(patches(app).length, 1)
  assert.equal(JSON.parse(patches(app)[0].body).version, 2)
  assert.equal(field(app, 'storeName').props.disabled, true)
  saving.resolve(response({ error: 'ذخیره نشد' }, 503)); await first; app.render()
  assert.equal(field(app, 'storeName').props.value, saved.storeName)
  assert.equal(app.refreshes, 0)
  await submit(app); app.render()
  assert.equal(app.refreshes, 1)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})

test('Version conflict blocks writes until reload, preserving local edits and merging other admin changes', async () => {
  const latest = { ...canonical, phone: '09998887766', storeName: 'نام ادمین دیگر', homeBannerDescription: 'توضیح ادمین دیگر', version: 3 }
  const app = page({ 'GET /api/admin/site-settings': [response(canonical), response(latest)], 'PATCH /api/admin/site-settings': [response({}, 409)] })
  await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: 'نام پیش‌نویس من' } })
  app.setHash('#homepage')
  field(app, 'homeBannerTitle').props.onChange({ target: { value: 'عنوان پیش‌نویس من' } })
  app.setHash('#appearance')
  field(app, 'colorTheme-honey').props.onChange(); app.render()
  await submit(app); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  await submit(app)
  assert.equal(patches(app).length, 1)
  app.setHash('#contact')
  button(app, 'دریافت آخرین نسخه').props.onClick(); await settle(); app.render()
  assert.deepEqual(visibleSections(app), ['contact'])
  assert.equal(field(app, 'storeName').props.value, 'نام پیش‌نویس من')
  assert.equal(field(app, 'phone').props.value, latest.phone)
  assert.match(text(app.tree), /تغییرات ذخیره‌نشدهٔ شما حفظ شدند/)
  await submit(app)
  const data = JSON.parse(patches(app)[1].body)
  assert.equal(data.version, 3)
  assert.equal(data.storeName, 'نام پیش‌نویس من')
  assert.equal(data.phone, latest.phone)
  assert.equal(data.homeBannerTitle, 'عنوان پیش‌نویس من')
  assert.equal(data.homeBannerDescription, latest.homeBannerDescription)
  assert.equal(data.colorTheme, 'honey')
  assert.equal(field(app, 'colorTheme-honey').props.checked, true)
  app.unmount()
})

test('Logo upload changes only the draft and both previews; final save is required to publish it', async () => {
  const url = '/uploads/logo.png'
  const app = page({ 'POST /api/upload': [response({ url }, 201)] })
  await settle(); app.render()
  choose(app, new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' }))
  await settle(); app.render()
  assert.equal(patches(app).length, 0)
  assert.equal(app.refreshes, 0)
  const previews = logoPreviews(app)
  assert.equal(previews.length, 2)
  assert.ok(previews.every((node) => node.props.src === url))
  assert.match(text(app.tree), /برای نمایش در سایت، تنظیمات را ذخیره کنید/)
  await submit(app)
  assert.equal(JSON.parse(patches(app)[0].body).logoUrl, url)
  app.unmount()
})

test('Upload validates file type/size and ignores duplicate requests; restoring built-in logo is another unsaved edit', async () => {
  const upload = deferred()
  const app = page({ 'GET /api/admin/site-settings': [response({ ...canonical, logoUrl: '/uploads/old.png' })], 'POST /api/upload': [upload.promise] })
  await settle(); app.render()
  choose(app, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })); app.render()
  assert.equal(app.requests.filter((request) => request.url === '/api/upload').length, 0)
  assert.match(text(app.tree), /۵ مگابایت/)
  const file = new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' })
  const preview = nodes(app.tree).find((node) => node.props['aria-label'] === 'پیش‌نمایش لوگوی اصلی')
  preview.props.onDrop({ preventDefault() {}, dataTransfer: { files: [file] } })
  choose(app, file); app.render()
  assert.equal(app.requests.filter((request) => request.url === '/api/upload').length, 1)
  assert.equal(uploadInput(app).props.disabled, true)
  upload.resolve(response({ error: 'آپلود ناموفق' }, 503)); await settle(); app.render()
  assert.equal(nodes(app.tree).find((node) => node.type === 'Image').props.src, '/uploads/old.png')
  button(app, 'بازگشت به لوگوی پیش‌فرض').props.onClick(); app.render()
  assert.equal(logoPreviews(app).length, 0)
  assert.equal(patches(app).length, 0)
  await submit(app)
  assert.equal(JSON.parse(patches(app)[0].body).logoUrl, null)
  app.unmount()
})

test('Client validation rejects enabled empty announcement and an unlabeled CTA without sending a write', async () => {
  const app = page()
  await settle(); app.render()
  field(app, 'announcementEnabled').props.onChange({ target: { checked: true } }); app.render()
  await submit(app); app.render()
  assert.match(text(app.tree), /برای فعال کردن اطلاعیه/)
  field(app, 'announcementText').props.onChange({ target: { value: 'خبر تازه' } })
  field(app, 'announcementLink').props.onChange({ target: { value: '/products' } }); app.render()
  await submit(app); app.render()
  assert.match(text(app.tree), /عنوان دکمه/)
  assert.equal(patches(app).length, 0)
  app.unmount()
})

test('Read timeout unlocks retry and save timeout preserves the draft and offers a status reload', async () => {
  const read = deferred(), save = deferred()
  const app = page({ 'GET /api/admin/site-settings': [read.promise, response(canonical)], 'PATCH /api/admin/site-settings': [save.promise] })
  app.timeout(); await settle(); app.render()
  assert.match(text(app.tree), /دریافت تنظیمات طول کشید/)
  button(app, 'تلاش دوباره').props.onClick(); await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: 'پیش‌نویس' } }); app.render()
  const task = submit(app)
  app.timeout(); await task; app.render()
  assert.equal(field(app, 'storeName').props.value, 'پیش‌نویس')
  assert.equal(field(app, 'storeName').props.disabled, false)
  assert.match(text(app.tree), /ممکن است تغییرات ذخیره شده باشند/)
  assert.equal(app.refreshes, 0)
  app.unmount()
})

test('Malformed server settings cannot become editable placeholders or a claimed successful save', async () => {
  const app = page({ 'GET /api/admin/site-settings': [response({ storeName: 'ناقص', version: 2 }), response(canonical)], 'PATCH /api/admin/site-settings': [response({ version: 3 })] })
  await settle(); app.render()
  assert.match(text(app.tree), /پاسخ تنظیمات فروشگاه معتبر نیست/)
  button(app, 'تلاش دوباره').props.onClick(); await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: 'نام تازه' } }); app.render()
  await submit(app); app.render()
  assert.match(text(app.tree), /پاسخ ذخیره‌سازی معتبر نیست/)
  assert.equal(field(app, 'storeName').props.value, 'نام تازه')
  assert.equal(app.refreshes, 0)
  app.unmount()
})

test('Unmount aborts initial reads and uploads without processing late responses or refreshing the store', async () => {
  const read = deferred()
  const app = page({ 'GET /api/admin/site-settings': [read.promise] })
  app.unmount()
  const before = app.writes
  assert.equal(app.requests[0].signal.aborted, true)
  read.resolve(response(canonical)); await settle()
  assert.equal(app.writes, before)
  const upload = deferred()
  const second = page({ 'POST /api/upload': [upload.promise] })
  await settle(); second.render()
  choose(second, new File(['x'], 'logo.png', { type: 'image/png' }))
  second.unmount()
  const uploadWrites = second.writes
  upload.resolve(response({ url: '/uploads/late.png' })); await settle()
  assert.equal(second.writes, uploadWrites)
  assert.equal(second.refreshes, 0)
})

test('Banner upload and reset remain draft-only; a final save publishes the selected image and all banner fields', async () => {
  const url = '/uploads/trail-banner.webp'
  const saved = { ...canonical, homeBannerImageUrl: url, homeBannerTitle: 'همراه مسیر بعدی', homeBannerImageAlt: 'کفش روی صخره', version: 3 }
  const app = page({ 'POST /api/upload': [response({ url }, 201), response({ url }, 201)], 'PATCH /api/admin/site-settings': [response(saved)] })
  await settle(); app.render()
  assert.equal(nodes(bannerPreview(app)).find((node) => node.type === 'Image').props.src, '/brand/panik-trail-banner.png')
  const file = new File([new Uint8Array([1, 2, 3])], 'trail.webp', { type: 'image/webp' })
  bannerPreview(app).props.onDrop({ preventDefault() {}, dataTransfer: { files: [file] } })
  await settle(); app.render()
  assert.equal(nodes(bannerPreview(app)).find((node) => node.type === 'Image').props.src, url)
  assert.equal(patches(app).length, 0)
  assert.equal(app.refreshes, 0)
  button(app, 'بازگشت به تصویر پیش‌فرض بنر').props.onClick(); app.render()
  assert.equal(nodes(bannerPreview(app)).find((node) => node.type === 'Image').props.src, '/brand/panik-trail-banner.png')
  assert.equal(patches(app).length, 0)
  // Selecting the image through the file input uses the same upload path as dropping it.
  choose(app, file, 'homeBannerImageUrl'); await settle(); app.render()
  field(app, 'homeBannerTitle').props.onChange({ target: { value: saved.homeBannerTitle } })
  field(app, 'homeBannerImageAlt').props.onChange({ target: { value: saved.homeBannerImageAlt } }); app.render()
  assert.match(text(bannerPreview(app)), /همراه مسیر بعدی/)
  assert.equal(nodes(bannerPreview(app)).find((node) => node.type === 'Image').props.alt, saved.homeBannerImageAlt)
  await submit(app); app.render()
  const data = JSON.parse(patches(app)[0].body)
  assert.equal(data.homeBannerImageUrl, url)
  assert.equal(data.homeBannerTitle, saved.homeBannerTitle)
  assert.equal(data.homeBannerImageAlt, saved.homeBannerImageAlt)
  assert.equal(data.homeBannerEnabled, true)
  assert.equal(app.refreshes, 1)
  app.unmount()
})

test('Banner validation requires an enabled title and a labeled CTA; disabling preserves the editable content', async () => {
  const saved = { ...canonical, homeBannerEnabled: false, homeBannerTitle: 'عنوان تازه', homeBannerLink: null, homeBannerLinkLabel: '', version: 3 }
  const app = page({ 'PATCH /api/admin/site-settings': [response(saved)] })
  await settle(); app.render()
  field(app, 'homeBannerTitle').props.onChange({ target: { value: '' } }); app.render()
  assert.equal(field(app, 'homeBannerTitle').props.required, true)
  await submit(app); app.render()
  assert.match(text(app.tree), /برای نمایش بنر صفحهٔ اول، عنوان/)
  field(app, 'homeBannerTitle').props.onChange({ target: { value: 'عنوان تازه' } })
  field(app, 'homeBannerLinkLabel').props.onChange({ target: { value: '' } }); app.render()
  assert.equal(field(app, 'homeBannerLinkLabel').props.required, true)
  await submit(app); app.render()
  assert.match(text(app.tree), /برای لینک بنر صفحهٔ اول، عنوان دکمه/)
  assert.equal(patches(app).length, 0)
  field(app, 'homeBannerLinkLabel').props.onChange({ target: { value: 'کشف مجموعه' } })
  field(app, 'homeBannerEnabled').props.onChange({ target: { checked: false } }); app.render()
  assert.equal(field(app, 'homeBannerTitle').props.required, false)
  assert.equal(field(app, 'homeBannerTitle').props.value, 'عنوان تازه')
  assert.match(text(bannerPreview(app)), /نمایش در سایت خاموش است/)
  field(app, 'homeBannerLink').props.onChange({ target: { value: '' } })
  field(app, 'homeBannerLinkLabel').props.onChange({ target: { value: '' } }); app.render()
  assert.equal(field(app, 'homeBannerLinkLabel').props.required, false)
  await submit(app); app.render()
  const data = JSON.parse(patches(app)[0].body)
  assert.equal(data.homeBannerEnabled, false)
  assert.equal(data.homeBannerTitle, 'عنوان تازه')
  assert.equal(data.homeBannerLink, '')
  assert.equal(app.refreshes, 1)
  assert.equal(field(app, 'homeBannerLink').props.value, '')
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})


test('Native palette radios load saved choice, keep selection as a draft, and publish only after Save', async () => {
  const saved = { ...canonical, colorTheme: 'honey', version: 3 }
  const app = page({ 'PATCH /api/admin/site-settings': [response(saved)] })
  await settle(); app.render()
  const forest = field(app, 'colorTheme-forest'), honey = field(app, 'colorTheme-honey')
  assert.equal(forest.type, 'input')
  assert.equal(forest.props.type, 'radio')
  assert.equal(forest.props.name, 'colorTheme')
  assert.equal(honey.props.name, 'colorTheme')
  assert.equal(forest.props.checked, true)
  assert.equal(honey.props.checked, false)
  assert.equal(nodes(app.tree).find((node) => node.type === 'fieldset').props['aria-describedby'], 'settings-colorTheme-help')
  honey.props.onChange(); app.render()
  assert.equal(field(app, 'colorTheme-honey').props.checked, true)
  assert.equal(field(app, 'colorTheme-forest').props.checked, false)
  assert.equal(patches(app).length, 0)
  assert.equal(app.refreshes, 0)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, false)
  // Returning to the saved palette produces no unsaved changes.
  field(app, 'colorTheme-forest').props.onChange(); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  field(app, 'colorTheme-honey').props.onChange(); app.render()
  await submit(app); app.render()
  assert.equal(JSON.parse(patches(app)[0].body).colorTheme, 'honey')
  assert.equal(JSON.parse(patches(app)[0].body).version, canonical.version)
  assert.equal(app.refreshes, 1)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})

test('Saved honey palette can be restored to forest and palette edits are locked during an in-flight save', async () => {
  const initial = { ...canonical, colorTheme: 'honey' }
  const saving = deferred()
  const saved = { ...canonical, colorTheme: 'forest', version: 3 }
  const app = page({ 'GET /api/admin/site-settings': [response(initial)], 'PATCH /api/admin/site-settings': [saving.promise] })
  await settle(); app.render()
  assert.equal(field(app, 'colorTheme-honey').props.checked, true)
  field(app, 'colorTheme-forest').props.onChange(); app.render()
  const pending = submit(app); app.render()
  assert.equal(field(app, 'colorTheme-honey').props.disabled, true)
  assert.equal(nodes(app.tree).find((node) => node.type === 'fieldset').props.disabled, true)
  field(app, 'colorTheme-honey').props.onChange(); app.render()
  assert.equal(field(app, 'colorTheme-forest').props.checked, true)
  saving.resolve(response(saved)); await pending; app.render()
  assert.equal(JSON.parse(patches(app)[0].body).colorTheme, 'forest')
  assert.equal(field(app, 'colorTheme-forest').props.checked, true)
  assert.equal(app.refreshes, 1)
  app.unmount()
})


test('Settings sections open from direct hashes and follow hashchange/back-forward without refetching or retaining listeners after unmount', async () => {
  for (const id of ['branding', 'appearance', 'homepage', 'announcement', 'contact', 'footer', 'seo']) {
    const app = page({}, { hash: '#' + id })
    await settle(); app.render()
    assert.equal(sections(app).length, 7)
    assert.deepEqual(visibleSections(app), [id])
    assert.equal(sections(app).find((node) => node.props['data-settings-section'] === id).props.id, 'settings-panel-' + id)
    app.unmount()
  }
  const app = page({}, { hash: '#unknown-section' })
  await settle(); app.render()
  assert.deepEqual(visibleSections(app), ['branding'])
  app.setHash('#homepage')
  assert.deepEqual(visibleSections(app), ['homepage'])
  app.setHash('#contact', 'popstate')
  assert.deepEqual(visibleSections(app), ['contact'])
  app.setHash('', 'popstate')
  assert.deepEqual(visibleSections(app), ['branding'])
  assert.equal(app.requests.filter((request) => !request.method).length, 1)
  app.unmount()
  const writes = app.writes
  app.setHash('#seo')
  assert.equal(app.writes, writes)
})

test('Moving between settings sections preserves one shared draft and publishes every changed section in one versioned save', async () => {
  const saved = { ...canonical, storeName: 'پانیک تازه', colorTheme: 'honey', homeBannerTitle: 'مجموعه تازه', phone: '02112345678', version: 3 }
  const app = page({ 'PATCH /api/admin/site-settings': [response(saved)] })
  await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: saved.storeName } })
  app.setHash('#appearance')
  field(app, 'colorTheme-honey').props.onChange()
  app.setHash('#homepage')
  field(app, 'homeBannerTitle').props.onChange({ target: { value: saved.homeBannerTitle } })
  app.setHash('#contact')
  field(app, 'phone').props.onChange({ target: { value: saved.phone } })
  app.setHash('#seo')
  assert.equal(patches(app).length, 0)
  assert.equal(app.requests.filter((request) => !request.method).length, 1)
  assert.equal(nodes(app.tree).find((node) => node.type === 'form').props.noValidate, true)
  await submit(app); app.render()
  assert.equal(patches(app).length, 1)
  const data = JSON.parse(patches(app)[0].body)
  for (const key of ['storeName', 'colorTheme', 'homeBannerTitle', 'phone']) assert.equal(data[key], saved[key])
  assert.equal(data.version, canonical.version)
  assert.equal(app.refreshes, 1)
  assert.deepEqual(visibleSections(app), ['seo'])
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})

test('Saving an invalid field in another settings section reveals and focuses that field without issuing a write', async () => {
  const cases = [
    { key: 'storeName', value: '', section: 'branding' },
    { key: 'seoTitle', value: '', section: 'seo' },
    { key: 'seoDescription', value: '', section: 'seo' },
    { key: 'announcementText', value: '', section: 'announcement', initial: { announcementEnabled: true, announcementText: 'خبر' } },
    { key: 'announcementLinkLabel', value: '', section: 'announcement', initial: { announcementLink: '/products', announcementLinkLabel: 'محصولات' } },
    { key: 'homeBannerTitle', value: '', section: 'homepage' },
    { key: 'homeBannerLinkLabel', value: '', section: 'homepage' },
  ]
  for (const item of cases) {
    const app = page({ 'GET /api/admin/site-settings': [response({ ...canonical, ...item.initial })] }, { hash: '#appearance' })
    await settle(); app.render()
    field(app, item.key).props.onChange({ target: { value: item.value } }); app.render()
    assert.deepEqual(visibleSections(app), ['appearance'])
    await submit(app); app.render()
    assert.equal(patches(app).length, 0, item.key)
    assert.deepEqual(visibleSections(app), [item.section], item.key)
    assert.equal(app.currentHash, '#' + item.section, item.key)
    assert.equal(app.focus.at(-1), 'settings-' + item.key, item.key)
    assert.ok(nodes(app.tree).some((node) => node.props.role === 'alert'), item.key)
    app.unmount()
  }
})

test('Malformed email in a hidden section retains native validity feedback while bringing contact fields into view', async () => {
  const app = page({}, { hash: '#homepage' })
  await settle(); app.render()
  field(app, 'email').props.onChange({ target: { value: 'not-an-email' } }); app.render()
  await submit(app); app.render()
  assert.equal(patches(app).length, 0)
  assert.deepEqual(visibleSections(app), ['contact'])
  assert.equal(app.focus.at(-1), 'settings-email')
  assert.match(text(app.tree), /Please enter an email address/)
  field(app, 'email').props.onChange({ target: { value: 'team@example.com' } }); app.render()
  await submit(app)
  assert.equal(JSON.parse(patches(app)[0].body).email, 'team@example.com')
  app.unmount()
})

test('An in-flight image upload survives section navigation and remains an unsaved shared draft until Save', async () => {
  const upload = deferred()
  const app = page({ 'POST /api/upload': [upload.promise] })
  await settle(); app.render()
  choose(app, new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' }))
  app.render()
  app.setHash('#contact')
  await submit(app)
  assert.equal(patches(app).length, 0)
  upload.resolve(response({ url: '/uploads/shared-draft.png' })); await settle(); app.render()
  assert.deepEqual(visibleSections(app), ['contact'])
  assert.ok(logoPreviews(app).every((node) => node.props.src === '/uploads/shared-draft.png'))
  assert.equal(patches(app).length, 0)
  assert.equal(app.refreshes, 0)
  assert.equal(app.requests.filter((request) => !request.method).length, 1)
  app.setHash('#branding')
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, false)
  await submit(app)
  assert.equal(JSON.parse(patches(app)[0].body).logoUrl, '/uploads/shared-draft.png')
  app.unmount()
})


const heroSettings = app => nodes(app.tree).find(node => node.type === 'HomeHeroSettings')

test('Hero selection arrays compare by value so restoring the same IDs does not leave a false dirty draft', async () => {
  const initial = { ...canonical, homeHeroProductIds: ['shoe-1', 'shoe-2'] }
  const app = page({ 'GET /api/admin/site-settings': [response(initial)] }, { hash: '#homepage' })
  await settle(); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  heroSettings(app).props.onProductIdsChange(['shoe-1', 'shoe-2']); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  heroSettings(app).props.onProductIdsChange(['shoe-2', 'shoe-1']); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, false)
  heroSettings(app).props.onProductIdsChange(['shoe-1', 'shoe-2']); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})

test('Hero selections, timing and other sections share one ordered versioned save', async () => {
  const saved = { ...canonical, version: canonical.version + 1, storeName: 'پانیک تازه', homeHeroProductIds: ['shoe-2', 'shoe-1'], homeHeroIntervalSeconds: 18 }
  const app = page({ 'PATCH /api/admin/site-settings': [response(saved)] })
  await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: saved.storeName } }); app.render()
  app.setHash('#homepage')
  heroSettings(app).props.onProductIdsChange(saved.homeHeroProductIds); app.render()
  heroSettings(app).props.onIntervalChange(saved.homeHeroIntervalSeconds); app.render()
  app.setHash('#contact')
  await submit(app); app.render()
  const payload = JSON.parse(patches(app)[0].body)
  assert.equal(payload.version, canonical.version)
  assert.equal(payload.storeName, saved.storeName)
  assert.deepEqual(payload.homeHeroProductIds, ['shoe-2', 'shoe-1'])
  assert.equal(payload.homeHeroIntervalSeconds, 18)
  assert.equal(app.refreshes, 1)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.unmount()
})

test('Reload adopts another admin hero array when the local array was changed back to its baseline value', async () => {
  const latest = { ...canonical, version: canonical.version + 1, homeHeroProductIds: ['shoe-3'], homeHeroIntervalSeconds: 15 }
  const app = page({ 'GET /api/admin/site-settings': [response(canonical), response(latest)] })
  await settle(); app.render()
  field(app, 'storeName').props.onChange({ target: { value: 'نام ذخیره‌نشده' } }); app.render()
  heroSettings(app).props.onProductIdsChange(['shoe-1']); app.render()
  heroSettings(app).props.onProductIdsChange([]); app.render()
  button(app, 'دریافت آخرین نسخه').props.onClick(); await settle(); app.render()
  assert.deepEqual(Array.from(heroSettings(app).props.productIds), ['shoe-3'])
  assert.equal(heroSettings(app).props.intervalSeconds, 15)
  assert.equal(field(app, 'storeName').props.value, 'نام ذخیره‌نشده')
  await submit(app)
  assert.deepEqual(JSON.parse(patches(app)[0].body).homeHeroProductIds, ['shoe-3'])
  app.unmount()
})

test('Conflict reload preserves a changed hero order and interval while adopting untouched settings', async () => {
  const initial = { ...canonical, homeHeroProductIds: ['shoe-1', 'shoe-2'] }
  const latest = { ...initial, version: initial.version + 1, homeHeroProductIds: ['shoe-3'], homeHeroIntervalSeconds: 12, phone: '09998887766' }
  const app = page({ 'GET /api/admin/site-settings': [response(initial), response(latest)], 'PATCH /api/admin/site-settings': [response({}, 409)] }, { hash: '#homepage' })
  await settle(); app.render()
  heroSettings(app).props.onProductIdsChange(['shoe-2', 'shoe-1']); app.render()
  heroSettings(app).props.onIntervalChange(20); app.render()
  await submit(app); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  button(app, 'دریافت آخرین نسخه').props.onClick(); await settle(); app.render()
  assert.deepEqual(Array.from(heroSettings(app).props.productIds), ['shoe-2', 'shoe-1'])
  assert.equal(heroSettings(app).props.intervalSeconds, 20)
  assert.equal(field(app, 'phone').props.value, latest.phone)
  await submit(app)
  const payload = JSON.parse(patches(app)[1].body)
  assert.equal(payload.version, latest.version)
  assert.deepEqual(payload.homeHeroProductIds, ['shoe-2', 'shoe-1'])
  assert.equal(payload.homeHeroIntervalSeconds, 20)
  app.unmount()
})

for (const interval of [Number.NaN, 4, 121, 5.5]) {
  test('Invalid hero timing is rejected before saving and opens the homepage section: ' + interval, async () => {
    const app = page({}, { hash: '#branding' })
    await settle(); app.render()
    heroSettings(app).props.onIntervalChange(interval); app.render()
    await submit(app); app.render()
    assert.equal(patches(app).length, 0)
    assert.deepEqual(visibleSections(app), ['homepage'])
    assert.match(text(app.tree), /عدد صحیح بین ۵ تا ۱۲۰/)
    app.unmount()
  })
}

test('Hero controls follow the whole-form busy lock during saves and retain their draft after failure', async () => {
  const pending = deferred()
  const app = page({ 'PATCH /api/admin/site-settings': [pending.promise] }, { hash: '#homepage' })
  await settle(); app.render()
  heroSettings(app).props.onProductIdsChange(['shoe-1']); app.render()
  const saving = submit(app); app.render()
  assert.equal(heroSettings(app).props.disabled, true)
  heroSettings(app).props.onProductIdsChange(['shoe-2']); app.render()
  pending.resolve(response({ error: 'تنظیمات ذخیره نشد' }, 503)); await saving; app.render()
  assert.equal(heroSettings(app).props.disabled, false)
  assert.deepEqual(Array.from(heroSettings(app).props.productIds), ['shoe-1'])
  assert.equal(app.refreshes, 0)
  app.unmount()
})

const footerField = (app, prefix) => nodes(app.tree).find((node) => typeof node.props.id === 'string' && node.props.id.startsWith(prefix))
const accessibleButton = (app, label) => nodes(app.tree).find((node) => node.type === 'button' && node.props['aria-label'] === label)

test('Equivalent footer object edits stay clean, and restored link edits restore the clean baseline', async () => {
  const app = page({}, { hash: '#footer' })
  await settle(); app.render()
  const label = footerField(app, 'settings-footer-link-label-')
  const original = label.props.value
  label.props.onChange({ target: { value: original } }); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  footerField(app, 'settings-footer-link-label-').props.onChange({ target: { value: 'عنوان تازه' } }); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, false)
  footerField(app, 'settings-footer-link-label-').props.onChange({ target: { value: original } }); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  assert.equal(app.listeners.get('beforeunload')?.size || 0, 0)
  app.unmount()
})

test('Footer link order, social links and copy publish through the shared versioned save', async () => {
  const app = page({}, { hash: '#footer' })
  await settle(); app.render()
  field(app, 'footerDescription').props.onChange({ target: { value: 'تولیدی کفش زنانه پانیک' } }); app.render()
  field(app, 'footerCopyright').props.onChange({ target: { value: 'حقوق سایت برای پانیک محفوظ است.' } }); app.render()
  button(app, 'افزودن شبکه یا لینک').props.onClick(); app.render()
  footerField(app, 'settings-footer-social-href-').props.onChange({ target: { value: 'https://eitaa.com/kafsh_panik' } }); app.render()
  footerField(app, 'settings-footer-social-icon-').props.onChange({ target: { value: 'eitaa' } }); app.render()
  accessibleButton(app, 'انتقال لینک 1 به پایین').props.onClick(); app.render()
  app.setHash('#contact')
  await submit(app); app.render()
  const payload = JSON.parse(patches(app)[0].body)
  assert.equal(payload.version, canonical.version)
  assert.equal(payload.footerLinks[0].id, canonical.footerLinks[1].id)
  assert.equal(payload.footerLinks[1].id, canonical.footerLinks[0].id)
  assert.equal(payload.footerDescription, 'تولیدی کفش زنانه پانیک')
  assert.equal(payload.footerSocialLinks[0].href, 'https://eitaa.com/kafsh_panik')
  assert.equal(payload.footerSocialLinks[0].icon, 'eitaa')
  assert.equal(payload.footerSocialLinks[0].label, '')
  assert.equal(payload.eitaaUrl, canonical.eitaaUrl)
  assert.equal(app.refreshes, 1)
  app.unmount()
})

test('Badge upload shares the request lock, follows section changes and only publishes after Save', async () => {
  const pending = deferred()
  const app = page({ 'POST /api/upload': [pending.promise] }, { hash: '#footer' })
  await settle(); app.render()
  button(app, 'افزودن نشان').props.onClick(); app.render()
  footerField(app, 'settings-footer-badge-title-').props.onChange({ target: { value: 'نشان رسمی فروشگاه' } }); app.render()
  footerField(app, 'settings-footer-badge-upload-').props.onChange({ target: { files: [new File([new Uint8Array([1])], 'badge.png', { type: 'image/png' })], value: 'selected' } }); app.render()
  assert.equal(button(app, 'دریافت آخرین نسخه').props.disabled, true)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  assert.equal(app.listeners.get('beforeunload').size, 1)
  app.setHash('#branding')
  await submit(app)
  assert.equal(patches(app).length, 0)
  const upload = app.requests.find((request) => request.url === '/api/upload')
  assert.equal(upload.body.get('context'), 'branding')
  pending.resolve(response({ url: '/uploads/official-badge.png' })); await settle(); app.render()
  assert.equal(patches(app).length, 0)
  await submit(app); app.render()
  const badge = JSON.parse(patches(app)[0].body).footerBadges[0]
  assert.equal(badge.title, 'نشان رسمی فروشگاه')
  assert.equal(badge.imageUrl, '/uploads/official-badge.png')
  assert.equal(badge.enabled, true)
  assert.equal(badge.href, null)
  app.unmount()
  assert.equal(app.listeners.get('beforeunload').size, 0)
})

test('Invalid footer URLs reveal the correct hidden section and focus the precise field', async () => {
  const app = page({}, { hash: '#footer' })
  await settle(); app.render()
  const target = footerField(app, 'settings-footer-link-href-')
  target.props.onChange({ target: { value: 'javascript:alert(1)' } }); app.render()
  app.setHash('#contact')
  await submit(app); app.render()
  assert.equal(patches(app).length, 0)
  assert.deepEqual(visibleSections(app), ['footer'])
  assert.equal(app.focus.at(-1), target.props.id)
  assert.match(text(app.tree), /آدرس معتبر HTTPS/)
  app.unmount()
})

test('Incomplete badge blocks saving with a focused title, and the add control enforces the badge limit', async () => {
  const app = page({}, { hash: '#footer' })
  await settle(); app.render()
  for (let i = 0; i < 8; i++) { button(app, 'افزودن نشان').props.onClick(); app.render() }
  assert.equal(button(app, 'افزودن نشان').props.disabled, true)
  const title = footerField(app, 'settings-footer-badge-title-')
  app.setHash('#branding')
  await submit(app); app.render()
  assert.equal(patches(app).length, 0)
  assert.deepEqual(visibleSections(app), ['footer'])
  assert.equal(app.focus.at(-1), title.props.id)
  app.unmount()
})

test('Conflict reload adopts untouched footer objects and preserves only locally changed footer arrays', async () => {
  const latest = { ...canonical, version: 3, footerDescription: 'معرفی ادمین دیگر', footerLinks: canonical.footerLinks.map((link, index) => index === 0 ? { ...link, label: 'عنوان ادمین دیگر' } : link), footerBadges: [{ id: 'official', title: 'نشان', imageUrl: '/uploads/official.png', href: null, enabled: true }] }
  const app = page({ 'GET /api/admin/site-settings': [response(canonical), response(latest)], 'PATCH /api/admin/site-settings': [response({}, 409)] }, { hash: '#footer' })
  await settle(); app.render()
  footerField(app, 'settings-footer-link-label-').props.onChange({ target: { value: 'عنوان محلی' } }); app.render()
  await submit(app); app.render()
  button(app, 'دریافت آخرین نسخه').props.onClick(); await settle(); app.render()
  assert.equal(footerField(app, 'settings-footer-link-label-').props.value, 'عنوان محلی')
  assert.equal(field(app, 'footerDescription').props.value, latest.footerDescription)
  assert.equal(footerField(app, 'settings-footer-badge-title-').props.value, 'نشان')
  await submit(app)
  const payload = JSON.parse(patches(app)[1].body)
  assert.equal(payload.version, 3)
  assert.equal(payload.footerLinks[0].label, 'عنوان محلی')
  assert.equal(payload.footerBadges[0].id, 'official')
  app.unmount()
})

test('Footer link creation works over a LAN origin without the secure-context randomUUID API', async () => {
  const app = page({}, { hash: '#footer', crypto: {} })
  await settle(); app.render()
  button(app, 'افزودن لینک').props.onClick(); app.render()
  const labels = nodes(app.tree).filter((node) => typeof node.props.id === 'string' && node.props.id.startsWith('settings-footer-link-label-'))
  const hrefs = nodes(app.tree).filter((node) => typeof node.props.id === 'string' && node.props.id.startsWith('settings-footer-link-href-'))
  assert.match(labels.at(-1).props.id, /^settings-footer-link-label-footer-[a-z0-9]+-[a-z0-9]+$/)
  labels.at(-1).props.onChange({ target: { value: 'سوالات متداول' } }); app.render()
  nodes(app.tree).find((node) => node.props.id === hrefs.at(-1).props.id).props.onChange({ target: { value: '/faq' } }); app.render()
  await submit(app)
  assert.equal(JSON.parse(patches(app)[0].body).footerLinks.at(-1).href, '/faq')
  app.unmount()
})

test('Custom social icons upload through the shared lock and publish with a genuinely optional blank label', async () => {
  const pending = deferred()
  const social = { id: 'our-channel', label: '', href: 'https://example.com/our-channel', icon: 'link', iconUrl: null, enabled: true }
  const initial = { ...canonical, instagramUrl: 'https://instagram.com/legacy', footerSocialLinks: [social] }
  const saved = { ...initial, version: 3, footerSocialLinks: [{ ...social, icon: 'custom', iconUrl: '/uploads/our-channel.png' }] }
  const app = page({ 'GET /api/admin/site-settings': [response(initial)], 'POST /api/upload': [pending.promise], 'PATCH /api/admin/site-settings': [response(saved)] }, { hash: '#footer' })
  await settle(); app.render()
  const label = footerField(app, 'settings-footer-social-label-')
  assert.equal(label.props.required, undefined)
  assert.match(text(app.tree), /نام نمایشی اختیاری است/)
  footerField(app, 'settings-footer-social-icon-').props.onChange({ target: { value: 'custom' } }); app.render()
  footerField(app, 'settings-footer-social-upload-').props.onChange({ target: { files: [new File([new Uint8Array([1])], 'channel.png', { type: 'image/png' })], value: 'selected' } }); app.render()
  assert.equal(footerField(app, 'settings-footer-social-label-').props.disabled, true)
  assert.equal(footerField(app, 'settings-footer-social-icon-').props.disabled, true)
  assert.equal(accessibleButton(app, 'حذف شبکهٔ اجتماعی 1').props.disabled, true)
  app.setHash('#contact')
  await submit(app)
  assert.equal(patches(app).length, 0)
  pending.resolve(response({ url: '/uploads/our-channel.png' })); await settle(); app.render()
  assert.ok(nodes(app.tree).some((node) => node.type === 'Image' && node.props.src === '/uploads/our-channel.png'))
  await submit(app); app.render()
  const payload = JSON.parse(patches(app)[0].body)
  assert.deepEqual(payload.footerSocialLinks, saved.footerSocialLinks)
  assert.equal(payload.instagramUrl, initial.instagramUrl)
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  app.setHash('#footer')
  footerField(app, 'settings-footer-social-icon-').props.onChange({ target: { value: 'instagram' } }); app.render()
  await submit(app)
  const next = JSON.parse(patches(app)[1].body).footerSocialLinks[0]
  assert.equal(next.icon, 'instagram')
  assert.equal(next.iconUrl, null)
  app.unmount()
})

test('Social list supports reorder, custom names, disable and delete without exposing or resurrecting legacy fields', async () => {
  const first = { id: 'first', label: 'اخبار ما', href: 'https://example.com/first', icon: 'telegram', iconUrl: null, enabled: true }
  const second = { id: 'second', label: '', href: 'https://example.com/second', icon: 'instagram', iconUrl: null, enabled: true }
  const initial = { ...canonical, instagramUrl: 'https://instagram.com/old', telegramUrl: 'https://t.me/old', footerSocialLinks: [first, second] }
  const saved = { ...initial, version: 3, footerSocialLinks: [] }
  const app = page({ 'GET /api/admin/site-settings': [response(initial)], 'PATCH /api/admin/site-settings': [response(saved), response(saved)] }, { hash: '#footer' })
  await settle(); app.render()
  for (const key of ['instagramUrl', 'telegramUrl', 'eitaaUrl', 'whatsappUrl']) assert.equal(field(app, key), undefined)
  accessibleButton(app, 'انتقال شبکهٔ اجتماعی 1 به پایین').props.onClick(); app.render()
  assert.equal(footerField(app, 'settings-footer-social-href-').props.value, second.href)
  footerField(app, 'settings-footer-social-label-').props.onChange({ target: { value: 'همراه ما باشید' } }); app.render()
  footerField(app, 'settings-footer-social-enabled-').props.onChange({ target: { checked: false } }); app.render()
  await submit(app); app.render()
  const payload = JSON.parse(patches(app)[0].body)
  assert.equal(payload.footerSocialLinks[0].id, 'second')
  assert.equal(payload.footerSocialLinks[0].label, 'همراه ما باشید')
  assert.equal(payload.footerSocialLinks[0].enabled, false)
  assert.equal(payload.instagramUrl, initial.instagramUrl)
  assert.equal(footerField(app, 'settings-footer-social-href-'), undefined)
  assert.match(text(app.tree), /هنوز شبکه‌ای اضافه نشده است/)
  field(app, 'footerDescription').props.onChange({ target: { value: 'معرفی تازه' } }); app.render()
  await submit(app)
  assert.deepEqual(JSON.parse(patches(app)[1].body).footerSocialLinks, [])
  app.unmount()

  const deleteApp = page({ 'GET /api/admin/site-settings': [response(initial)] }, { hash: '#footer' })
  await settle(); deleteApp.render()
  accessibleButton(deleteApp, 'حذف شبکهٔ اجتماعی 1').props.onClick(); deleteApp.render()
  assert.equal(footerField(deleteApp, 'settings-footer-social-href-').props.value, second.href)
  accessibleButton(deleteApp, 'حذف شبکهٔ اجتماعی 1').props.onClick(); deleteApp.render()
  await submit(deleteApp)
  assert.deepEqual(JSON.parse(patches(deleteApp)[0].body).footerSocialLinks, [])
  deleteApp.unmount()
})

test('Invalid social URL and a missing custom icon each reveal and focus the correct hidden field', async () => {
  const social = { id: 'custom-link', label: '', href: 'https://example.com/channel', icon: 'link', iconUrl: null, enabled: true }
  for (const scenario of ['href', 'custom']) {
    const app = page({ 'GET /api/admin/site-settings': [response({ ...canonical, footerSocialLinks: [social] })] }, { hash: '#footer' })
    await settle(); app.render()
    let target
    if (scenario === 'href') {
      target = footerField(app, 'settings-footer-social-href-')
      target.props.onChange({ target: { value: '/products' } }); app.render()
    } else {
      footerField(app, 'settings-footer-social-icon-').props.onChange({ target: { value: 'custom' } }); app.render()
      target = footerField(app, 'settings-footer-social-upload-')
    }
    app.setHash('#contact')
    await submit(app); app.render()
    assert.equal(patches(app).length, 0)
    assert.deepEqual(visibleSections(app), ['footer'])
    assert.equal(app.focus.at(-1), target.props.id)
    app.unmount()
  }
})

test('Social list enforces its item limit and duplicate object edits stay clean', async () => {
  const social = { id: 'same', label: '', href: 'https://example.com/same', icon: 'link', iconUrl: null, enabled: true }
  const app = page({ 'GET /api/admin/site-settings': [response({ ...canonical, footerSocialLinks: [social] })] }, { hash: '#footer' })
  await settle(); app.render()
  footerField(app, 'settings-footer-social-label-').props.onChange({ target: { value: '' } }); app.render()
  assert.equal(button(app, 'ذخیره تنظیمات').props.disabled, true)
  for (let i = 1; i < 12; i++) { button(app, 'افزودن شبکه یا لینک').props.onClick(); app.render() }
  assert.equal(button(app, 'افزودن شبکه یا لینک').props.disabled, true)
  app.unmount()
})
