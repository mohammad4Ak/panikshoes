'use client'

import styles from '@/components/admin/admin.module.css'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'

import { useState, useEffect } from 'react'
import { Shield, Trash2, Pencil, X, Plus, UserPlus, KeyRound } from 'lucide-react'

interface User {
  id: string
  name: string
  email: string
  phone: string | null
  role: 'USER' | 'ADMIN'
  _count: { orders: number }
}

const emptyCreateForm = { name: '', email: '', password: '', phone: '', role: 'USER' as 'USER' | 'ADMIN' }

export default function AdminUsersPage() {
  const settings = useSiteSettings()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [form, setForm] = useState({ name: '', phone: '', role: 'USER' as 'USER' | 'ADMIN' })
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState('')

  // فرم ایجاد کاربر جدید
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState(emptyCreateForm)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function loadUsers() {
      try {
        const res = await fetch('/api/users', { signal: controller.signal, cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'دریافت کاربران انجام نشد.')
        if (!Array.isArray(data)) throw new Error('پاسخ کاربران معتبر نیست.')
        if (!controller.signal.aborted) {
          setUsers(data)
          setLoadError('')
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void loadUsers()
    return () => controller.abort()
  }, [reloadKey])

  const openEditModal = (user: User) => {
    setEditingUser(user)
    setForm({
      name: user.name,
      phone: user.phone ?? '',
      role: user.role,
    })
    setNewPassword('')
    setModalError('')
    setModalOpen(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingUser) return

    setSaving(true)
    setModalError('')

    try {
      const res = await fetch(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          ...(newPassword !== '' && { newPassword }),
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setModalError(data.error || 'خطا در ذخیره تغییرات')
        return
      }

      setUsers((prev) =>
        prev.map((u) =>
          u.id === editingUser.id
            ? { ...u, name: data.name, phone: data.phone, role: data.role }
            : u
        )
      )
      setModalOpen(false)
    } catch {
      setModalError('خطای ارتباط با سرور')
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setCreateError('')

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm),
      })

      const data = await res.json()

      if (!res.ok) {
        setCreateError(data.error || 'خطا در ایجاد کاربر')
        return
      }

      setUsers((prev) => [data, ...prev])
      setCreateOpen(false)
      setCreateForm(emptyCreateForm)
    } catch {
      setCreateError('خطای ارتباط با سرور')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('این کاربر حذف شود؟ حساب‌های دارای سابقهٔ سفارش قابل حذف نیستند.')) return
    setActionError('')
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(typeof data?.error === 'string' ? data.error : 'خطا در حذف کاربر')
      }
      setUsers((prev) => prev.filter((u) => u.id !== id))
    } catch (cause) {
      setActionError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد.')
    }
  }

  return (
    <div>
      <div className={styles.pageHeader}>
        <div><span className={styles.eyebrow}>همراهان {settings.storeName}</span><h1>مدیریت کاربران</h1><p>حساب‌ها و دسترسی‌ها را به‌سادگی مدیریت کن.</p></div>
        <button
          onClick={() => { setCreateForm(emptyCreateForm); setCreateError(''); setCreateOpen(true) }}
          disabled={loading || !!loadError}
          className="btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          <Plus className="w-5 h-5" />
          کاربر جدید
        </button>
      </div>

      {actionError && <p role="alert" className="bg-red-50 text-red-700 px-4 py-3 rounded-2xl mb-6">{actionError}</p>}

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
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">نام</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">ایمیل</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">تلفن</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">سفارشها</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">نقش</th>
                <th className="px-4 py-3 md:px-6 md:py-4 text-right">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-fog/30">
                  <td className="px-6 py-4">
                    <span className="font-medium flex items-center gap-2">
                      {user.name}
                      {user.role === 'ADMIN' && (
                        <span title="مدیر">
                          <Shield className="w-4 h-4 text-brand" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-mist">{user.email}</td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-mist" dir="ltr">
                    {user.phone || '—'}
                  </td>
                  <td className="px-6 py-4">{user._count.orders}</td>
                  <td className="px-6 py-4">
                    <span
                      className={`px-3 py-1 rounded-full text-sm ${
                        user.role === 'ADMIN'
                          ? 'bg-brand/10 text-brand'
                          : 'bg-fog text-mist'
                      }`}
                    >
                      {user.role === 'ADMIN' ? 'مدیر' : 'کاربر'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => openEditModal(user)}
                        className="p-2 hover:bg-fog rounded-2xl transition-colors"
                        title="ویرایش کاربر"
                      >
                        <Pencil className="w-5 h-5 text-brand" />
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        disabled={user.role === 'ADMIN'}
                        className={`p-2 rounded-2xl transition-colors ${
                          user.role === 'ADMIN'
                            ? 'opacity-30 cursor-not-allowed'
                            : 'hover:bg-fog'
                        }`}
                        title={user.role === 'ADMIN' ? 'کاربران مدیر قابل حذف نیستند' : 'حذف کاربر'}
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

      {/* Edit Modal */}
      {modalOpen && editingUser && (
        <div className={styles.dialogBackdrop}>
          <div className={`${styles.dialog} max-w-md`} role="dialog" aria-modal="true" aria-label="ویرایش کاربر">
            <div className={styles.dialogHeader}>
              <h2 className="text-xl font-bold">ویرایش کاربر</h2>
              <button
                onClick={() => setModalOpen(false)}
                aria-label="بستن فرم کاربر"
                className="p-2 hover:bg-fog rounded-2xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="block font-bold mb-2">ایمیل</label>
                <input className="input-field bg-fog/60" dir="ltr" value={editingUser.email} disabled />
              </div>

              <div>
                <label className="block font-bold mb-2">نام</label>
                <input
                  required
                  className="input-field"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-bold mb-2">تلفن</label>
                <input
                  className="input-field"
                  dir="ltr"
                  placeholder="09123456789"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-bold mb-2">نقش</label>
                <select
                  className="input-field"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as 'USER' | 'ADMIN' })}
                >
                  <option value="USER">کاربر</option>
                  <option value="ADMIN">مدیر</option>
                </select>
              </div>

              <div>
                <label className="block font-bold mb-2 flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-brand" />
                  رمز عبور جدید
                </label>
                <input
                  type="password"
                  dir="ltr"
                  className="input-field"
                  placeholder="خالی = بدون تغییر"
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <p className="text-xs text-mist mt-1">
                  فقط اگر بخوای رمز جدید ست کنی پر کن (حداقل ۶ کاراکتر)
                </p>
              </div>

              {modalError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-sm">
                  {modalError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={saving} className="btn-primary flex-1 disabled:opacity-50">
                  {saving ? 'در حال ذخیره...' : 'ذخیره تغییرات'}
                </button>
                <button type="button" onClick={() => setModalOpen(false)} className="btn-outline flex-1">
                  انصراف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {createOpen && (
        <div className={styles.dialogBackdrop}>
          <div className={`${styles.dialog} max-w-md`} role="dialog" aria-modal="true" aria-label="کاربر جدید">
            <div className={styles.dialogHeader}>
              <h2 className="text-xl font-bold flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-brand" />
                کاربر جدید
              </h2>
              <button
                onClick={() => setCreateOpen(false)}
                aria-label="بستن فرم کاربر جدید"
                className="p-2 hover:bg-fog rounded-2xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div>
                <label className="block font-bold mb-2">نام و نام خانوادگی *</label>
                <input
                  required
                  className="input-field"
                  placeholder="محمد محمدی"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-bold mb-2">ایمیل *</label>
                <input
                  required
                  type="email"
                  dir="ltr"
                  className="input-field"
                  placeholder="email@example.com"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                />
              </div>

              <div>
                <label className="block font-bold mb-2">رمز عبور *</label>
                <input
                  required
                  type="password"
                  minLength={6}
                  dir="ltr"
                  className="input-field"
                  placeholder="حداقل ۶ کاراکتر"
                  value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold mb-2">تلفن</label>
                  <input
                    type="tel"
                    dir="ltr"
                    className="input-field"
                    placeholder="09123456789"
                    value={createForm.phone}
                    onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block font-bold mb-2">نقش</label>
                  <select
                    className="input-field"
                    value={createForm.role}
                    onChange={(e) =>
                      setCreateForm({ ...createForm, role: e.target.value as 'USER' | 'ADMIN' })
                    }
                  >
                    <option value="USER">کاربر</option>
                    <option value="ADMIN">مدیر</option>
                  </select>
                </div>
              </div>

              {createError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-2xl text-sm">
                  {createError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={creating} className="btn-primary flex-1 disabled:opacity-50">
                  {creating ? 'در حال ایجاد...' : 'ایجاد کاربر'}
                </button>
                <button type="button" onClick={() => setCreateOpen(false)} className="btn-outline flex-1">
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
