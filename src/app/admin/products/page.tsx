'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Plus, Pencil, Trash2, Eye, X, ArrowUp, ArrowDown } from 'lucide-react'
import MultiImageInput from '@/components/admin/MultiImageInput'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import PersianDatePicker from '@/components/ui/PersianDatePicker'
import FormattedNumberInput from '@/components/ui/FormattedNumberInput'
import { formatPrice } from '@/lib/utils'
import { productPricing } from '@/lib/pricing'
import styles from '@/components/admin/admin.module.css'
import productStyles from './products.module.css'

interface Specification { name: string; value: string }
interface SpecificationRow extends Specification { key: number }
const specificationPresets = ['برند', 'جنس رویه', 'جنس زیره', 'ارتفاع پاشنه', 'نوع بسته‌شدن', 'کشور تولید']
const specificationNameKey = (name: string) => name.trim().toLocaleLowerCase('fa-IR').normalize('NFKC')

interface Product {
  id: string
  name: string
  slug: string
  description: string
  price: number
  salePrice?: number | null
  saleStartsAt?: string | null
  saleEndsAt?: string | null
  images: string[]
  type: 'SNEAKER' | 'FORMAL'
  sizes: number[]
  colors: string[]
  stock: number
  featured: boolean
  categoryId: string
  category: { name: string }
  specifications?: Specification[]
}

const emptyForm = {
  name: '',
  description: '',
  price: '',
  salePrice: '',
  saleStartsAt: '',
  saleEndsAt: '',
  images: [] as string[],
  categoryId: '',
  sizes: '40, 41, 42, 43',
  colors: 'مشکی, سفید',
  stock: '',
  featured: false,
  specifications: [] as SpecificationRow[],
}

function dateTimeInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function discountStatus(product: Product) {
  if (product.salePrice == null) return ''
  if (productPricing(product).isDiscounted) return 'تخفیف فعال'
  if (product.saleStartsAt && new Date(product.saleStartsAt).getTime() > Date.now()) return 'تخفیف زمان‌بندی‌شده'
  return 'تخفیف پایان‌یافته'
}

export default function AdminProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [originalStock, setOriginalStock] = useState<number | null>(null)
  const [originalPricing, setOriginalPricing] = useState<Pick<Product, 'price' | 'salePrice' | 'saleStartsAt' | 'saleEndsAt'> | null>(null)
  const [stockConflict, setStockConflict] = useState(false)
  const [priceConflict, setPriceConflict] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const nextSpecificationKey = useRef(0)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function loadProducts() {
      try {
        const responses = await Promise.all([
          fetch('/api/products', { signal: controller.signal, cache: 'no-store' }),
          fetch('/api/categories', { signal: controller.signal, cache: 'no-store' }),
        ])
        const data = await Promise.all(responses.map((response) => response.json().catch(() => null)))
        for (const [index, response] of responses.entries()) {
          if (!response.ok) throw new Error(typeof data[index]?.error === 'string' ? data[index].error : 'دریافت محصولات و دسته‌بندی‌ها انجام نشد.')
          if (!Array.isArray(data[index])) throw new Error('پاسخ محصولات یا دسته‌بندی‌ها معتبر نیست.')
        }
        if (!controller.signal.aborted) {
          setProducts(data[0])
          setCategories(data[1])
          setLoadError('')
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void loadProducts()
    return () => controller.abort()
  }, [reloadKey])

  const openCreateModal = () => {
    setEditingId(null)
    setOriginalStock(null)
    setOriginalPricing(null)
    setStockConflict(false)
    setPriceConflict(false)
    setForm({ ...emptyForm, categoryId: categories[0]?.id ?? '' })
    setMessage(null)
    setModalOpen(true)
  }


  const openEditModal = (product: Product) => {
    setEditingId(product.id)
    setOriginalStock(product.stock)
    setOriginalPricing({ price: product.price, salePrice: product.salePrice ?? null, saleStartsAt: product.saleStartsAt ?? null, saleEndsAt: product.saleEndsAt ?? null })
    setStockConflict(false)
    setPriceConflict(false)
    setForm({
      name: product.name,
      description: product.description,
      price: String(product.price),
      salePrice: product.salePrice == null ? '' : String(product.salePrice),
      saleStartsAt: dateTimeInput(product.saleStartsAt),
      saleEndsAt: dateTimeInput(product.saleEndsAt),
      images: product.images,
      categoryId: product.categoryId,
      sizes: product.sizes.join(', '),
      colors: product.colors.join(', '),
      stock: String(product.stock),
      featured: product.featured,
      specifications: (product.specifications ?? []).map((row) => ({ ...row, key: ++nextSpecificationKey.current })),
    })
    setMessage(null)
    setModalOpen(true)
  }

  const addSpecification = (name = '') => {
    const key = ++nextSpecificationKey.current
    setForm((previous) => previous.specifications.length >= 30 ? previous : {
      ...previous, specifications: [...previous.specifications, { key, name, value: '' }],
    })
  }

  const updateSpecification = (key: number, changes: Partial<Specification>) => {
    setForm((previous) => ({ ...previous, specifications: previous.specifications.map((row) => row.key === key ? { ...row, ...changes } : row) }))
  }

  const moveSpecification = (index: number, offset: number) => {
    setForm((previous) => {
      const next = index + offset
      if (next < 0 || next >= previous.specifications.length) return previous
      const specifications = [...previous.specifications]
      ;[specifications[index], specifications[next]] = [specifications[next], specifications[index]]
      return { ...previous, specifications }
    })
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || stockConflict || priceConflict) return
    const sizeText = form.sizes.trim()
      .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - '۰'.charCodeAt(0)))
      .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - '٠'.charCodeAt(0)))
    const sizeEntries = sizeText === '' ? [] : sizeText.split(/[,،]/).map((value) => value.trim())
    if (sizeEntries.some((value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2_147_483_647)) {
      setMessage({ text: 'سایزها باید عدد صحیح و بزرگ‌تر از صفر باشند و با کاما جدا شوند؛ مثل ۴۰، ۴۱، ۴۲. سایز اعشاری یا متن نامعتبر ذخیره نمی‌شود.', error: true })
      return
    }
    const specifications = form.specifications.map(({ name, value }) => ({ name: name.trim(), value: value.trim() }))
    if (specifications.some((row) => !row.name || !row.value)) {
      setMessage({ text: 'نام و مقدار هر مشخصه را وارد کن یا ردیف خالی را حذف کن.', error: true })
      return
    }
    if (specifications.some((row) => row.name.length > 80 || row.value.length > 500) || specifications.length > 30) {
      setMessage({ text: 'حداکثر ۳۰ مشخصه می‌توانی ثبت کنی؛ نام تا ۸۰ و مقدار تا ۵۰۰ کاراکتر.', error: true })
      return
    }
    const specificationNames = specifications.map((row) => specificationNameKey(row.name))
    if (new Set(specificationNames).size !== specificationNames.length) {
      setMessage({ text: 'نام مشخصه‌ها تکراری است. برای هر مشخصه فقط یک ردیف نگه دار.', error: true })
      return
    }
    if (form.salePrice !== '' && (!Number.isSafeInteger(Number(form.salePrice)) || Number(form.salePrice) < 1 || Number(form.salePrice) >= Number(form.price))) {
      setMessage({ text: 'قیمت بعد از تخفیف باید عدد صحیح، بیشتر از صفر و کمتر از قیمت اصلی باشد.', error: true })
      return
    }
    const saleStartsAt = form.salePrice && form.saleStartsAt ? new Date(form.saleStartsAt) : null
    const saleEndsAt = form.salePrice && form.saleEndsAt ? new Date(form.saleEndsAt) : null
    if ((saleStartsAt && !Number.isFinite(saleStartsAt.getTime())) || (saleEndsAt && !Number.isFinite(saleEndsAt.getTime())) || (saleStartsAt && saleEndsAt && saleEndsAt <= saleStartsAt)) {
      setMessage({ text: 'زمان‌بندی تخفیف معتبر نیست؛ پایان باید بعد از شروع باشد.', error: true })
      return
    }
    setSaving(true)
    setMessage(null)

    const pricing = {
      price: Number(form.price), salePrice: form.salePrice === '' ? null : Number(form.salePrice),
      saleStartsAt: saleStartsAt?.toISOString() ?? null, saleEndsAt: saleEndsAt?.toISOString() ?? null,
    }
    // Preserve exact stored timestamps unless their minute-level inputs changed.
    if (originalPricing && form.salePrice !== '') {
      if (form.saleStartsAt === dateTimeInput(originalPricing.saleStartsAt)) pricing.saleStartsAt = originalPricing.saleStartsAt ?? null
      if (form.saleEndsAt === dateTimeInput(originalPricing.saleEndsAt)) pricing.saleEndsAt = originalPricing.saleEndsAt ?? null
    }
    const pricingChanged = !originalPricing || Object.entries(pricing).some(([key, value]) => value !== originalPricing[key as keyof typeof originalPricing])
    const payload = {
      name: form.name,
      description: form.description,
      ...(pricingChanged ? { ...pricing, ...(editingId ? { expectedPricing: originalPricing } : {}) } : {}),
      images: form.images,
      categoryId: form.categoryId,
      sizes: sizeEntries.map(Number),
      colors: form.colors.split(',').map((c) => c.trim()).filter(Boolean),
      ...(!editingId ? { stock: Number(form.stock) } : Number(form.stock) !== originalStock
        ? { stock: Number(form.stock), expectedStock: originalStock }
        : {}),
      featured: form.featured,
      specifications,
    }

    try {
      const res = await fetch(editingId ? `/api/products/${editingId}` : '/api/products', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json()

      if (!res.ok) {
        if (data.code === 'PRODUCT_STOCK_CHANGED') setStockConflict(true)
        if (data.code === 'PRODUCT_PRICE_CHANGED') setPriceConflict(true)
        setMessage({ text: data.error || 'خطا در ذخیره محصول', error: true })
        return
      }

      setMessage({ text: editingId ? 'محصول ویرایش شد ✓' : 'محصول اضافه شد ✓', error: false })
      setModalOpen(false)
      setLoading(true)
      setReloadKey((value) => value + 1)
    } catch {
      setMessage({ text: 'خطای ارتباط با سرور', error: true })
    } finally {
      setSaving(false)
    }
  }

  const refreshStock = async (pricingOnly = false) => {
    if (!editingId || saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(editingId)}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'دریافت اطلاعات تازه انجام نشد.')
      if (pricingOnly) {
        if (!Number.isSafeInteger(data.price) || data.price < 1) throw new Error('پاسخ قیمت معتبر نیست.')
        setOriginalPricing({ price: data.price, salePrice: data.salePrice ?? null, saleStartsAt: data.saleStartsAt ?? null, saleEndsAt: data.saleEndsAt ?? null })
        setForm(previous => ({ ...previous, price: String(data.price), salePrice: data.salePrice == null ? '' : String(data.salePrice), saleStartsAt: dateTimeInput(data.saleStartsAt), saleEndsAt: dateTimeInput(data.saleEndsAt) }))
        setPriceConflict(false)
      } else {
        if (!Number.isSafeInteger(data.stock) || data.stock < 0) throw new Error('پاسخ موجودی معتبر نیست.')
        setOriginalStock(data.stock)
        setForm((previous) => ({ ...previous, stock: String(data.stock) }))
        setStockConflict(false)
      }
      setMessage({ text: pricingOnly ? 'قیمت و تخفیف تازه بارگذاری شدند. آن‌ها را بررسی کن و سپس تغییرات را ذخیره کن.' : 'موجودی تازه بارگذاری شد. مقدار موجودی را بررسی کن و سپس تغییرات را ذخیره کن.', error: false })
    } catch (cause) {
      setMessage({ text: cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'دریافت موجودی تازه انجام نشد.', error: true })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('این محصول حذف شود؟')) return
    setMessage(null)
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(typeof data?.error === 'string' ? data.error : 'خطا در حذف محصول')
      }
      setProducts((prev) => prev.filter((p) => p.id !== id))
    } catch (cause) {
      setMessage({ text: cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد.', error: true })
    }
  }

  const filtered = products.filter((p) => p.name.includes(searchQuery))

  return (
    <div>
      <div className={styles.pageHeader}>
        <div><span className={styles.eyebrow}>ویترین فروشگاه</span><h1>مدیریت محصولات</h1><p>مدل‌ها، مشخصات، قیمت و موجودی را از اینجا مدیریت کن.</p></div>
        <button onClick={openCreateModal} disabled={loading || !!loadError} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          <Plus className="w-5 h-5" />
          محصول جدید
        </button>
      </div>

      {message && !modalOpen && <p role={message.error ? 'alert' : 'status'} className={`px-4 py-3 rounded-2xl mb-6 ${message.error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{message.text}</p>}

      {/* Search */}
      <div className={styles.searchPanel}>
        <input
          type="text"
          placeholder="جستجو در محصولات..."
          aria-label="جستجو در محصولات"
          className="input-field"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Products Table */}
      <div className={styles.tablePanel}>
        {loading ? (
          <div className="p-12 text-center text-mist">در حال بارگذاری...</div>
        ) : loadError ? (
          <div className="p-12 text-center"><p role="alert" className="text-red-700 mb-4">{loadError}</p><button className="btn-outline" onClick={() => { setLoading(true); setLoadError(''); setReloadKey((value) => value + 1) }}>تلاش دوباره</button></div>
        ) : (
          <div className="overflow-x-auto">
        <table className="w-full min-w-[720px]">
            <thead className="bg-night text-white">
              <tr>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">نام محصول</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">دسته بندی</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">قیمت</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">موجودی</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">ویژه</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((product) => (
                <tr key={product.id} className="hover:bg-fog/30">
                  <td className="px-4 py-3 md:px-6 md:py-4 font-medium">{product.name}</td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 bg-brand/10 text-brand rounded-full text-sm">
                      {product.category.name}
                    </span>
                  </td>
                  <td className="px-6 py-4"><div className={productStyles.tablePrice}>{productPricing(product).isDiscounted && <del>{formatPrice(product.price)} تومان</del>}<span>{formatPrice(productPricing(product).effectivePrice)} تومان</span>{product.salePrice != null && <small>{discountStatus(product)}</small>}</div></td>
                  <td className="px-6 py-4">{product.stock.toLocaleString('fa-IR')}</td>
                  <td className="px-6 py-4">
                    {product.featured && <span className="text-green-600 font-bold">✓</span>}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/products/${product.slug}`}
                        className="p-2 hover:bg-fog rounded-2xl transition-colors"
                        title="مشاهده در فروشگاه"
                      >
                        <Eye className="w-5 h-5 text-night" />
                      </Link>
                      <button
                        onClick={() => openEditModal(product)}
                        className="p-2 hover:bg-fog rounded-2xl transition-colors"
                        title="ویرایش"
                      >
                        <Pencil className="w-5 h-5 text-brand" />
                      </button>
                      <button
                        onClick={() => handleDelete(product.id)}
                        className="p-2 hover:bg-fog rounded-2xl transition-colors"
                        title="حذف"
                      >
                        <Trash2 className="w-5 h-5 text-red-600" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-mist">
                    محصولی پیدا نشد
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className={styles.dialogBackdrop}>
          <div className={`${styles.dialog} max-w-2xl`} role="dialog" aria-modal="true" aria-label={editingId ? 'ویرایش محصول' : 'محصول جدید'}>
            <div className={styles.dialogHeader}>
              <h2 className="text-xl font-bold">
                {editingId ? 'ویرایش محصول' : 'محصول جدید'}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                disabled={saving}
                aria-label="بستن فرم محصول"
                className="p-2 hover:bg-fog rounded-2xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block font-bold mb-2">نام محصول *</label>
                <input
                  required
                  className="input-field"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-bold mb-2">توضیحات</label>
                <textarea
                  rows={3}
                  className="input-field"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold mb-2">قیمت اصلی (تومان) *</label>
                  <FormattedNumberInput
                    required
                    min={1}
                    max={2_147_483_647}
                    className="input-field"
                    value={form.price}
                    onValueChange={value => setForm({ ...form, price: value })}
                  />
                </div>
                <div>
                  <label className="block font-bold mb-2">موجودی</label>
                  <FormattedNumberInput
                    min={0}
                    max={2_147_483_647}
                    className="input-field"
                    value={form.stock}
                    onValueChange={value => setForm({ ...form, stock: value })}
                  />
                </div>
                <div>
                  <label htmlFor="product-category" className="block font-bold mb-2">دسته‌بندی *</label>
                  <EnhancedSelect
                    id="product-category"
                    required
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                  >
                    <option value="" disabled>
                      انتخاب دسته بندی
                    </option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </EnhancedSelect>
                  <p className="text-xs text-mist mt-1">
                    به‌عنوان برچسب روی کارت محصول نمایش داده می‌شود
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold mb-2">سایزها (با کاما جدا کنید)</label>
                  <input
                    className="input-field"
                    dir="ltr"
                    value={form.sizes}
                    onChange={(e) => setForm({ ...form, sizes: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block font-bold mb-2">رنگها (با کاما جدا کنید)</label>
                  <input
                    className="input-field"
                    value={form.colors}
                    onChange={(e) => setForm({ ...form, colors: e.target.value })}
                  />
                </div>
              </div>

              <fieldset className={productStyles.discount} disabled={saving}>
                <legend>تخفیف مستقیم محصول</legend>
                <p className={productStyles.hint}>قیمت نهاییِ بعد از تخفیف را وارد کن. با خالی گذاشتن این قیمت، محصول با قیمت اصلی فروخته می‌شود.</p>
                <div className={productStyles.discountGrid}>
                  <div><label htmlFor="product-sale-price">قیمت بعد از تخفیف (تومان)</label><FormattedNumberInput id="product-sale-price" className="input-field" min={1} max={2_147_483_647} value={form.salePrice} placeholder="بدون تخفیف" onValueChange={value => setForm({ ...form, salePrice: value, ...(value === '' ? { saleStartsAt: '', saleEndsAt: '' } : {}) })} /></div>
                  <div><label htmlFor="product-sale-start">شروع تخفیف (اختیاری)</label><PersianDatePicker aria-label="شروع تخفیف" id="product-sale-start" includeTime disabled={!form.salePrice || saving} value={form.saleStartsAt} onChange={value => setForm({ ...form, saleStartsAt: value })} /></div>
                  <div><label htmlFor="product-sale-end">پایان تخفیف (اختیاری)</label><PersianDatePicker aria-label="پایان تخفیف" id="product-sale-end" includeTime disabled={!form.salePrice || saving} value={form.saleEndsAt} onChange={value => setForm({ ...form, saleEndsAt: value })} /></div>
                </div>
                <p className={productStyles.hint}>بدون زمان شروع، تخفیف بلافاصله فعال می‌شود؛ بدون زمان پایان، تا حذف آن ادامه دارد. ساعت‌ها مطابق منطقهٔ زمانی دستگاه شما هستند.</p>
                {form.salePrice && <button className={productStyles.clearDiscount} type="button" onClick={() => setForm({ ...form, salePrice: '', saleStartsAt: '', saleEndsAt: '' })}>حذف تخفیف محصول</button>}
              </fieldset>

              <fieldset className={productStyles.specifications} disabled={saving}>
                <legend>مشخصات کفش</legend>
                <p className={productStyles.hint}>اطلاعات دقیق این مدل را وارد کن. ترتیب ردیف‌ها، ترتیب نمایش مشخصات در صفحهٔ محصول است.</p>
                <div className={productStyles.presets} aria-label="افزودن مشخصه‌های پیشنهادی">
                  {specificationPresets.map((name) => <button key={name} type="button" disabled={form.specifications.length >= 30 || form.specifications.some((row) => specificationNameKey(row.name) === specificationNameKey(name))} onClick={() => addSpecification(name)}><Plus size={12} />{name}</button>)}
                </div>
                {form.specifications.length === 0 ? <p className={productStyles.empty}>هنوز مشخصه‌ای برای این مدل ثبت نشده.</p> : <div className={productStyles.rows}>
                  {form.specifications.map((row, index) => <div key={row.key} className={productStyles.row}>
                    <div>
                      <label htmlFor={'spec-name-' + row.key}>نام مشخصه {new Intl.NumberFormat('fa-IR').format(index + 1)}</label>
                      <input id={'spec-name-' + row.key} className="input-field" required maxLength={80} value={row.name} placeholder="مثلاً جنس رویه" onChange={(event) => updateSpecification(row.key, { name: event.target.value })} />
                    </div>
                    <div>
                      <label htmlFor={'spec-value-' + row.key}>مقدار مشخصه {new Intl.NumberFormat('fa-IR').format(index + 1)}</label>
                      <textarea id={'spec-value-' + row.key} rows={2} className="input-field" required maxLength={500} value={row.value} placeholder="اطلاعات همین مدل" onChange={(event) => updateSpecification(row.key, { value: event.target.value })} />
                    </div>
                    <div className={productStyles.actions}>
                      <button type="button" disabled={index === 0} aria-label={'بالا بردن مشخصه ' + (index + 1)} onClick={() => moveSpecification(index, -1)}><ArrowUp size={14} /></button>
                      <button type="button" disabled={index === form.specifications.length - 1} aria-label={'پایین بردن مشخصه ' + (index + 1)} onClick={() => moveSpecification(index, 1)}><ArrowDown size={14} /></button>
                      <button type="button" aria-label={'حذف مشخصه ' + (index + 1)} onClick={() => setForm((previous) => ({ ...previous, specifications: previous.specifications.filter((item) => item.key !== row.key) }))}><Trash2 size={14} /></button>
                    </div>
                  </div>)}
                </div>}
                <button className={productStyles.addRow} type="button" disabled={form.specifications.length >= 30} onClick={() => addSpecification()}><Plus size={15} />افزودن مشخصه</button>
                <p className={productStyles.hint}>{new Intl.NumberFormat('fa-IR').format(form.specifications.length)} از ۳۰ مشخصه</p>
              </fieldset>

              <MultiImageInput
                images={form.images}
                onChange={(imgs) => setForm((f) => ({ ...f, images: imgs }))}
              />


              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.featured}
                  onChange={(e) => setForm({ ...form, featured: e.target.checked })}
                  className="w-5 h-5 accent-brand"
                />
                <span className="font-medium">نمایش در محصولات ویژه صفحه اصلی</span>
              </label>

              {message && (
                <div
                  role={message.error ? 'alert' : 'status'}
                  className={`px-4 py-3 rounded-2xl ${
                    message.error
                      ? 'bg-red-50 border border-red-200 text-red-700'
                      : 'bg-green-50 border border-green-200 text-green-700'
                  }`}
                >
                  {message.text}
                  {stockConflict && <button type="button" onClick={() => void refreshStock()} disabled={saving} className="btn-outline mt-3 block disabled:opacity-50">تازه‌سازی موجودی</button>}
                  {priceConflict && <button type="button" onClick={() => void refreshStock(true)} disabled={saving} className="btn-outline mt-3 block disabled:opacity-50">تازه‌سازی قیمت و تخفیف</button>}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving || stockConflict || priceConflict}
                  className="btn-primary flex-1 disabled:opacity-50"
                >
                  {saving ? 'در حال ذخیره...' : editingId ? 'ذخیره تغییرات' : 'افزودن محصول'}
                </button>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                  className="btn-outline flex-1"
                >
                  انصراف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
