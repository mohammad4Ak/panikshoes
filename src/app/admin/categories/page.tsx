'use client'

import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, X, Tags } from 'lucide-react'
import MultiImageInput from '@/components/admin/MultiImageInput'
import styles from '@/components/admin/admin.module.css'

interface Category {
  id: string
  name: string
  slug: string
  image: string | null
  _count: { products: number }
}

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', slug: '', image: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function loadCategories() {
      try {
        const res = await fetch('/api/categories', { signal: controller.signal, cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'دریافت دسته‌بندی‌ها انجام نشد.')
        if (!Array.isArray(data)) throw new Error('پاسخ دسته‌بندی‌ها معتبر نیست.')
        if (!controller.signal.aborted) {
          setCategories(data)
          setLoadError('')
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void loadCategories()
    return () => controller.abort()
  }, [reloadKey])

  const openCreateModal = () => {
    setEditingId(null)
    setForm({ name: '', slug: '', image: '' })
    setError('')
    setModalOpen(true)
  }

  const openEditModal = (category: Category) => {
    setEditingId(category.id)
    setForm({ name: category.name, slug: category.slug, image: category.image ?? '' })
    setError('')
    setModalOpen(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')

    try {
      const res = await fetch(editingId ? `/api/categories/${editingId}` : '/api/categories', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'خطا در ذخیره دسته بندی')
        return
      }

      setModalOpen(false)
      setLoading(true)
      setReloadKey((value) => value + 1)
    } catch {
      setError('خطای ارتباط با سرور')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('این دسته بندی حذف شود؟')) return
    setActionError('')
    try {
      const res = await fetch(`/api/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(typeof data?.error === 'string' ? data.error : 'خطا در حذف دسته بندی')
      }
      setCategories((prev) => prev.filter((c) => c.id !== id))
    } catch (cause) {
      setActionError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد.')
    }
  }

  return (
    <div>
      <div className={styles.pageHeader}>
        <div><span className={styles.eyebrow}>مجموعه‌های فروشگاه</span><h1>مدیریت دسته‌بندی‌ها</h1><p>پیدا کردن جفت مناسب را برای مشتری‌ها ساده‌تر کن.</p></div>
        <button onClick={openCreateModal} disabled={loading || !!loadError} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          <Plus className="w-5 h-5" />
          دسته بندی جدید
        </button>
      </div>

      {actionError && <p role="alert" className="bg-red-50 text-red-700 px-4 py-3 rounded-2xl mb-6">{actionError}</p>}

      <div className={styles.tablePanel}>
        {loading ? (
          <div className="p-12 text-center text-mist">در حال بارگذاری...</div>
        ) : loadError ? (
          <div className="p-12 text-center"><p role="alert" className="text-red-700 mb-4">{loadError}</p><button className="btn-outline" onClick={() => { setLoading(true); setLoadError(''); setReloadKey((value) => value + 1) }}>تلاش دوباره</button></div>
        ) : categories.length === 0 ? (
          <div className="p-12 text-center">
            <Tags className="w-12 h-12 text-line mx-auto mb-4" />
            <p className="text-xl font-bold mb-2">هنوز دسته بندی ای ثبت نشده</p>
            <p className="text-mist mb-6">اولین دسته بندی را اضافه کنید</p>
            <button onClick={openCreateModal} className="btn-primary">
              افزودن دسته بندی
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
            <thead className="bg-night text-white">
              <tr>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">تصویر</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">نام</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">شناسه (slug)</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">تعداد محصولات</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {categories.map((category) => (
                <tr key={category.id} className="hover:bg-fog/30">
                  <td className="px-6 py-4">
                    {category.image ? (
                      <img
                        src={category.image}
                        alt={category.name}
                        className="w-12 h-12 rounded-2xl object-cover border border-line"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-2xl bg-line/50 flex items-center justify-center">
                        <Tags className="w-5 h-5 text-mist" />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4 font-bold">{category.name}</td>
                  <td className="px-4 py-3 md:px-6 md:py-4 font-mono text-mist" dir="ltr">
                    {category.slug}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 bg-brand/10 text-brand rounded-full text-sm">
                      {category._count.products} محصول
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEditModal(category)}
                        className="p-2 hover:bg-fog rounded-2xl transition-colors"
                        title="ویرایش"
                      >
                        <Pencil className="w-5 h-5 text-brand" />
                      </button>
                      <button
                        onClick={() => handleDelete(category.id)}
                        disabled={category._count.products > 0}
                        className={`p-2 rounded-2xl transition-colors ${
                          category._count.products > 0
                            ? 'opacity-30 cursor-not-allowed'
                            : 'hover:bg-fog'
                        }`}
                        title={
                          category._count.products > 0
                            ? 'ابتدا محصولات این دسته را حذف کنید'
                            : 'حذف'
                        }
                      >
                        <Trash2 className="w-5 h-5 text-red-600" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className={styles.dialogBackdrop}>
          <div className={`${styles.dialog} max-w-md`} role="dialog" aria-modal="true" aria-label={editingId ? 'ویرایش دسته‌بندی' : 'دسته‌بندی جدید'}>
            <div className={styles.dialogHeader}>
              <h2 className="text-xl font-bold">
                {editingId ? 'ویرایش دسته بندی' : 'دسته بندی جدید'}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                aria-label="بستن فرم دسته‌بندی"
                className="p-2 hover:bg-fog rounded-2xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="block font-bold mb-2">نام دسته بندی *</label>
                <input
                  required
                  className="input-field"
                  placeholder="مثال: بوت و نیمبوت"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-bold mb-2">شناسه (اختیاری)</label>
                <input
                  className="input-field"
                  dir="ltr"
                  placeholder="boots"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                />
                <p className="text-xs text-mist mt-1">
                  اگر خالی بگذارید خودکار ساخته میشود
                </p>
              </div>

              <MultiImageInput
                multiple={false}
                label="تصویر دسته بندی (نمایش در صفحه اصلی)"
                images={form.image ? [form.image] : []}
                onChange={(imgs) => setForm((f) => ({ ...f, image: imgs[0] ?? '' }))}
              />

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-sm">
                  {error}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={saving} className="btn-primary flex-1 disabled:opacity-50">
                  {saving ? 'در حال ذخیره...' : editingId ? 'ذخیره تغییرات' : 'افزودن'}
                </button>
                <button type="button" onClick={() => setModalOpen(false)} className="btn-outline flex-1">
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
