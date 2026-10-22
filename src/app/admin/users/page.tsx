'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, KeyRound, MapPin, Pencil, Plus, ReceiptText, Search, Shield, ShoppingBag, Trash2, UserCheck, Users, X } from 'lucide-react'
import admin from '@/components/admin/admin.module.css'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import { customerContactComplete, normalizePhone } from '@/lib/customer-contact'
import { signOutWithSessionLock } from '@/lib/session-actions'
import { formatPrice } from '@/lib/utils'
import styles from './users.module.css'

type Role = 'USER' | 'ADMIN'
interface User {
  id: string; name: string; email: string; phone: string | null; postalCode: string | null
  role: Role; isActive: boolean; createdAt?: string; _count: { orders: number }
}
interface Address { id?: string; title: string | null; address: string; phone: string; postalCode: string | null; isDefault: boolean }
interface SupportOrder {
  id: string; total: number; status: string; verified: boolean; paymentStatus: string; paymentMethod?: string | null
  createdAt: string; trackingCode?: string | null; _count?: { receipts: number }
  items?: { id: string; quantity: number; size: number; color: string; productName?: string | null; product?: { name: string } }[]
}
interface Detail {
  user: User & { addresses: Address[] }; orders: SupportOrder[]
  summary: { orderCount: number; paidTotal: number }; isSelf: boolean
}
interface Draft { name: string; email: string; phone: string; postalCode: string; role: Role; isActive: boolean; addresses: Address[] }
const emptyCreateForm = { name: '', email: '', password: '', phone: '', postalCode: '', role: 'USER' as Role }
const orderLabels: Record<string, string> = { PENDING: 'در انتظار', PROCESSING: 'در حال پردازش', SHIPPED: 'ارسال‌شده', DELIVERED: 'تحویل‌شده', CANCELLED: 'لغوشده' }
const paymentLabels: Record<string, string> = { UNPAID: 'پرداخت‌نشده', AWAITING_RECEIPT: 'در انتظار رسید', AWAITING_REVIEW: 'رسید منتظر بررسی', REJECTED: 'نیاز به رسید جدید', PAID: 'پرداخت تأییدشده', EXPIRED: 'مهلت پرداخت تمام شده' }
const normalizeSearch = (value: string) => normalizePhone(value).toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\s\u200c\u200e\u200f\-()+]/g, '')
const date = (value?: string) => !value || Number.isNaN(new Date(value).getTime()) ? '—' : new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeZone: 'Asia/Tehran' }).format(new Date(value))
const errorMessage = (cause: unknown) => cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.'
const draftOf = (user: Detail['user']): Draft => ({ name: user.name, email: user.email, phone: user.phone ?? '', postalCode: user.postalCode ?? '', role: user.role, isActive: user.isActive !== false, addresses: user.addresses.map(address => ({ ...address })) })

export default function AdminUsersPage() {
  const settings = useSiteSettings()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailReload, setDetailReload] = useState(0)
  const [tab, setTab] = useState('account')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState('')
  const [success, setSuccess] = useState('')
  const [addressConflict, setAddressConflict] = useState(false)
  const [refreshingAddresses, setRefreshingAddresses] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState(emptyCreateForm)
  const [createError, setCreateError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const writeControllersRef = useRef(new Set<AbortController>())
  const modalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    const controllers = writeControllersRef.current
    return () => { mountedRef.current = false; for (const controller of controllers) controller.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    async function loadUsers() {
      try {
        const res = await fetch('/api/users', { signal: controller.signal, cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'دریافت کاربران انجام نشد.')
        if (!Array.isArray(data)) throw new Error('پاسخ کاربران معتبر نیست.')
        if (!controller.signal.aborted) { setUsers(data); setLoadError('') }
      } catch (cause) { if (!controller.signal.aborted) setLoadError(errorMessage(cause)) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void loadUsers()
    return () => controller.abort()
  }, [reloadKey])
  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    async function loadDetail() {
      try {
        const res = await fetch(`/api/users/${encodeURIComponent(selectedId!)}`, { signal: controller.signal, cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'دریافت اطلاعات کاربر انجام نشد.')
        if (data?.user?.id !== selectedId || !Array.isArray(data.user.addresses) || !Array.isArray(data.orders) || !data.summary) throw new Error('پاسخ اطلاعات کاربر معتبر نیست.')
        if (!controller.signal.aborted) { setDetail(data); setDraft(draftOf(data.user)) }
      } catch (cause) { if (!controller.signal.aborted) setDetailError(errorMessage(cause)) }
      finally { if (!controller.signal.aborted) setDetailLoading(false) }
    }
    void loadDetail()
    return () => controller.abort()
  }, [selectedId, detailReload])

  // Trap keyboard focus while a dialog is open, then restore its opener.
  useEffect(() => {
    if ((!selectedId && !createOpen) || typeof document === 'undefined') return
    const opener = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    modalRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { setSelectedId(null); setCreateOpen(false) }
      if (event.key !== 'Tab' || !modalRef.current) return
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(element => element.getClientRects().length > 0)
      if (!focusable.length) { event.preventDefault(); modalRef.current.focus(); return }
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalRef.current)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKeyDown); opener?.focus() }
  }, [selectedId, createOpen])

  const openSupport = (user: User) => {
    if (busyRef.current) return
    setDetail(null); setDraft(null); setDetailError(''); setModalError(''); setSuccess(''); setAddressConflict(false)
    setNewPassword(''); setConfirmed(false); setTab('account'); setDetailLoading(true); setSelectedId(user.id)
  }
  const closeModal = () => { if (!busyRef.current) { setSelectedId(null); setCreateOpen(false) } }
  const startWrite = () => {
    if (busyRef.current) return null
    busyRef.current = true
    const controller = new AbortController()
    writeControllersRef.current.add(controller); setSaving(true)
    return controller
  }
  const finishWrite = (controller: AbortController) => {
    writeControllersRef.current.delete(controller); busyRef.current = false
    if (mountedRef.current && !controller.signal.aborted) { setSaving(false); setDeletingId(null) }
  }
  const requiresConfirmation = Boolean(detail && draft && (newPassword || (detail.user.isActive !== false && !draft.isActive) || detail.user.role !== draft.role))
  const updateDraft = (patch: Partial<Draft>) => { setDraft(previous => previous ? { ...previous, ...patch } : previous); setConfirmed(false); setSuccess('') }
  const updateAddress = (index: number, patch: Partial<Address>) => {
    if (!draft) return
    updateDraft({ addresses: draft.addresses.map((address, position) => position === index ? { ...address, ...patch } : patch.isDefault === true ? { ...address, isDefault: false } : address) })
  }

  const handleSave = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedId || !detail || !draft || detailLoading || addressConflict || (requiresConfirmation && !confirmed)) return
    if (!draft.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()) || (newPassword !== '' && newPassword.length < 6)) {
      setTab('account'); setModalError('نام و ایمیل معتبر لازم است و رمز جدید باید حداقل ۶ نویسه داشته باشد.'); return
    }
    const controller = startWrite()
    if (!controller) return
    setModalError(''); setSuccess('')
    const baseline = draftOf(detail.user)
    const payload: Record<string, unknown> = {}
    for (const key of ['name', 'email', 'phone', 'postalCode', 'role', 'isActive'] as const) if (draft[key] !== baseline[key]) payload[key] = draft[key]
    if (JSON.stringify(draft.addresses) !== JSON.stringify(baseline.addresses)) {
      payload.addresses = draft.addresses.map(({ id, title, address, phone, postalCode, isDefault }) => ({ ...(id ? { id } : {}), title, address, phone, postalCode, isDefault }))
      payload.expectedAddresses = baseline.addresses.map(({ id, title, address, phone, postalCode, isDefault }) => ({ id, title, address, phone, postalCode, isDefault }))
    }
    if (newPassword !== '') payload.newPassword = newPassword
    if (!Object.keys(payload).length) { setSuccess('تغییری برای ذخیره وجود ندارد.'); finishWrite(controller); return }
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(selectedId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(payload) })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        if (res.status === 409 && data?.code === 'USER_ADDRESSES_CHANGED' && !controller.signal.aborted && mountedRef.current) setAddressConflict(true)
        throw new Error(typeof data?.error === 'string' ? data.error : 'ذخیرهٔ تغییرات انجام نشد.')
      }
      const updated = data?.user ?? data
      if (updated?.id !== selectedId) throw new Error('پاسخ ذخیره معتبر نیست. پیش از تلاش دوباره، اطلاعات کاربر را دوباره بررسی کنید.')
      if (!controller.signal.aborted && mountedRef.current) {
        setUsers(previous => previous.map(user => user.id === selectedId ? { ...user, ...updated } : user))
        if (detail.isSelf && newPassword !== '') {
          setNewPassword(''); setConfirmed(false); setSuccess('رمز شما تغییر کرد؛ دوباره با رمز جدید وارد شوید.')
          try { await signOutWithSessionLock({ redirectTo: '/login' }) }
          catch { if (!controller.signal.aborted && mountedRef.current) setModalError('رمز تغییر کرده است. برای ورود دوباره، صفحهٔ ورود را باز کنید.') }
          return
        }
        setNewPassword(''); setConfirmed(false); setAddressConflict(false); setSuccess('تغییرات کاربر ذخیره شد.'); setDetailLoading(true); setDetailError(''); setDetailReload(value => value + 1)
      }
    } catch (cause) { if (!controller.signal.aborted && mountedRef.current) setModalError(errorMessage(cause)) }
    finally { finishWrite(controller) }
  }
  const refreshAddresses = async () => {
    if (!selectedId || !detail || !draft) return
    const controller = startWrite()
    if (!controller) return
    const previousBaseline = draftOf(detail.user)
    setRefreshingAddresses(true); setModalError('')
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(selectedId)}`, { signal: controller.signal, cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'بازخوانی نشانی‌ها انجام نشد.')
      if (data?.user?.id !== selectedId || !Array.isArray(data.user.addresses) || !Array.isArray(data.orders) || !data.summary) throw new Error('پاسخ اطلاعات کاربر معتبر نیست.')
      if (!controller.signal.aborted && mountedRef.current) {
        const next = draftOf(data.user)
        // Preserve intentional account edits, while accepting current server values
        // for untouched fields and explicitly discarding only stale address drafts.
        for (const key of ['name', 'email', 'phone', 'postalCode', 'role', 'isActive'] as const) {
          if (draft[key] !== previousBaseline[key]) Object.assign(next, { [key]: draft[key] })
        }
        setDetail(data); setDraft(next); setAddressConflict(false); setConfirmed(false); setTab('addresses'); setSuccess('نشانی‌های تازه دریافت شدند؛ تغییرات اطلاعات حساب حفظ شد.')
        setUsers(previous => previous.map(user => user.id === selectedId ? { ...user, ...data.user } : user))
      }
    } catch (cause) { if (!controller.signal.aborted && mountedRef.current) setModalError(errorMessage(cause)) }
    finally { if (!controller.signal.aborted && mountedRef.current) setRefreshingAddresses(false); finishWrite(controller) }
  }
  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    const controller = startWrite()
    if (!controller) return
    setCreateError('')
    try {
      const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(createForm) })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'ایجاد کاربر انجام نشد.')
      if (!data?.id) throw new Error('پاسخ ایجاد کاربر معتبر نیست.')
      if (!controller.signal.aborted && mountedRef.current) { setUsers(previous => [data, ...previous]); setCreateOpen(false); setCreateForm(emptyCreateForm); setPage(1) }
    } catch (cause) { if (!controller.signal.aborted && mountedRef.current) setCreateError(errorMessage(cause)) }
    finally { finishWrite(controller) }
  }
  const handleDelete = async (id: string) => {
    if (busyRef.current || !confirm('این کاربر حذف شود؟ حساب‌های دارای سابقهٔ سفارش قابل حذف نیستند.')) return
    const controller = startWrite()
    if (!controller) return
    setDeletingId(id); setActionError('')
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE', signal: controller.signal })
      if (!res.ok) { const data = await res.json().catch(() => null); throw new Error(typeof data?.error === 'string' ? data.error : 'حذف کاربر انجام نشد.') }
      if (!controller.signal.aborted && mountedRef.current) setUsers(previous => previous.filter(user => user.id !== id))
    } catch (cause) { if (!controller.signal.aborted && mountedRef.current) setActionError(errorMessage(cause)) }
    finally { finishWrite(controller) }
  }

  const query = normalizeSearch(search)
  const filtered = users.filter(user => (roleFilter === 'all' || user.role === roleFilter) && (statusFilter === 'all' || (statusFilter === 'active' ? user.isActive !== false : user.isActive === false)) && (!query || [user.name, user.email, user.phone ?? '', user.postalCode ?? '', user.id].some(value => normalizeSearch(value).includes(query))))
  const pages = Math.max(1, Math.ceil(filtered.length / 20)), currentPage = Math.min(page, pages)
  const displayed = filtered.slice((currentPage - 1) * 20, currentPage * 20)
  const blocked = users.filter(user => user.isActive === false).length
  const incomplete = users.filter(user => !customerContactComplete(user.phone, user.postalCode)).length

  return <div className={styles.page}>
    <div className={admin.pageHeader}>
      <div><span className={admin.eyebrow}>همراهان {settings.storeName}</span><h1>مدیریت کاربران</h1><p>اطلاعات حساب، نشانی‌ها و سابقهٔ خرید مشتری را در یک جا بررسی کن.</p></div>
      <button type="button" onClick={() => { setCreateForm(emptyCreateForm); setCreateError(''); setCreateOpen(true) }} disabled={loading || !!loadError || saving} className="btn-primary flex items-center gap-2 disabled:opacity-50"><Plus size={18} />کاربر جدید</button>
    </div>
    {!loadError && <section className={styles.stats} aria-label="خلاصهٔ کاربران">
      <div><Users size={20} /><span>کل حساب‌ها</span><strong>{formatPrice(users.length)}</strong></div>
      <div><UserCheck size={20} /><span>حساب فعال</span><strong>{formatPrice(users.length - blocked)}</strong></div>
      <div><CircleAlert size={20} /><span>تلفن یا کدپستی ناقص</span><strong>{formatPrice(incomplete)}</strong></div>
      <div><Shield size={20} /><span>حساب مسدود</span><strong>{formatPrice(blocked)}</strong></div>
    </section>}
    <section className={styles.filters} aria-label="جستجو و فیلتر کاربران">
      <label className={styles.search}><Search size={18} /><input aria-label="جستجوی کاربران" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} placeholder="نام، ایمیل، تلفن یا کدپستی" /></label>
      <label className={styles.field}><span>نقش</span><EnhancedSelect nativeAppearance aria-label="فیلتر نقش کاربران" value={roleFilter} onChange={event => { setRoleFilter(event.target.value); setPage(1) }}><option value="all">همهٔ نقش‌ها</option><option value="USER">کاربر</option><option value="ADMIN">مدیر</option></EnhancedSelect></label>
      <label className={styles.field}><span>وضعیت حساب</span><EnhancedSelect nativeAppearance aria-label="فیلتر وضعیت کاربران" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1) }}><option value="all">همهٔ حساب‌ها</option><option value="active">فعال</option><option value="blocked">مسدود</option></EnhancedSelect></label>
    </section>
    {actionError && <p role="alert" className={styles.error}>{actionError}</p>}
    <div className={admin.tablePanel}>
      {loading ? <div role="status" className={styles.empty}>در حال بارگذاری کاربران...</div> : loadError ? <div className={styles.empty}><p role="alert" className={styles.error}>{loadError}</p><button className="btn-outline" onClick={() => { setLoading(true); setLoadError(''); setReloadKey(value => value + 1) }}>تلاش دوباره</button></div> : <>
        <div className={styles.listHeading}><h2>فهرست کاربران</h2><span>{formatPrice(filtered.length)} حساب</span></div>
        {!displayed.length ? <p className={styles.empty}>{users.length ? 'کاربری با این جستجو و فیلتر پیدا نشد.' : 'هنوز کاربری ثبت نشده است.'}</p> : <div className={styles.tableScroll}><table className={styles.table}>
          <thead><tr><th>نام و ایمیل</th><th>اطلاعات تماس</th><th>سفارش‌ها</th><th>نقش و وضعیت</th><th>عملیات</th></tr></thead>
          <tbody>{displayed.map(user => <tr key={user.id}>
            <td data-label="کاربر"><strong className={styles.userName}>{user.name}{user.role === 'ADMIN' && <Shield size={14} aria-label="مدیر" />}</strong><span className={styles.email} dir="ltr">{user.email}</span><span className={styles.muted}>عضویت: {date(user.createdAt)}</span></td>
            <td data-label="اطلاعات تماس"><span className={styles.contactValue}>تلفن: <b dir="ltr">{user.phone || 'ثبت نشده'}</b></span><span className={styles.contactValue}>کدپستی: <b dir="ltr">{user.postalCode || 'ثبت نشده'}</b></span><span className={`${styles.badge} ${customerContactComplete(user.phone, user.postalCode) ? styles.good : styles.warning}`}>{customerContactComplete(user.phone, user.postalCode) ? 'اطلاعات خرید کامل' : 'نیاز به تکمیل اطلاعات'}</span></td>
            <td data-label="سفارش‌ها">{formatPrice(user._count?.orders ?? 0)} سفارش</td>
            <td data-label="وضعیت"><span className={styles.role}>{user.role === 'ADMIN' ? 'مدیر' : 'کاربر'}</span><span className={`${styles.badge} ${user.isActive === false ? styles.danger : styles.good}`}>{user.isActive === false ? 'مسدود' : 'فعال'}</span></td>
            <td data-label="عملیات"><div className={styles.rowActions}><button type="button" className={styles.supportButton} disabled={saving} onClick={() => openSupport(user)} aria-label={`بررسی و ویرایش ${user.name}`}><Pencil size={15} />بررسی و ویرایش</button><button type="button" title="حذف کاربر" aria-label={`حذف کاربر ${user.name}`} disabled={saving || user.role === 'ADMIN'} onClick={() => handleDelete(user.id)} className={styles.deleteButton}>{deletingId === user.id ? '…' : <Trash2 size={17} />}</button></div></td>
          </tr>)}</tbody>
        </table></div>}
        {pages > 1 && <nav className={styles.pagination} aria-label="صفحه‌بندی کاربران"><button disabled={currentPage <= 1 || saving} onClick={() => setPage(currentPage - 1)}><ArrowRight size={16} />قبلی</button><span>صفحهٔ {formatPrice(currentPage)} از {formatPrice(pages)}</span><button disabled={currentPage >= pages || saving} onClick={() => setPage(currentPage + 1)}>بعدی<ArrowLeft size={16} /></button></nav>}
      </>}
    </div>

    {selectedId && <div className={admin.dialogBackdrop} onClick={event => { if (event.target === event.currentTarget) closeModal() }}>
      <div ref={modalRef} tabIndex={-1} className={`${admin.dialog} ${styles.supportDialog}`} role="dialog" aria-modal="true" aria-labelledby="user-support-title">
        <div className={admin.dialogHeader}><div><h2 id="user-support-title">بررسی و ویرایش کاربر</h2><p className={styles.muted}>{detail?.user.name || 'دریافت اطلاعات حساب'}</p></div><button type="button" disabled={saving} onClick={closeModal} aria-label="بستن فرم کاربر"><X size={20} /></button></div>
        {detailLoading ? <p role="status" className={styles.empty}>در حال دریافت اطلاعات کاربر...</p> : detailError ? <div className={styles.empty}><p role="alert" className={styles.error}>{detailError}</p><button type="button" className="btn-outline" onClick={() => { setDetailLoading(true); setDetailError(''); setDetailReload(value => value + 1) }}>تلاش دوباره</button></div> : detail && draft && <>
          <div className={styles.tabs} role="tablist" aria-label="بخش‌های حساب کاربر">{[{ id: 'account', text: 'اطلاعات حساب' }, { id: 'addresses', text: 'نشانی‌ها' }, { id: 'orders', text: 'سفارش‌ها و پرداخت‌ها' }].map(item => <button type="button" role="tab" id={`support-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`support-panel-${item.id}`} key={item.id} onClick={() => setTab(item.id)}>{item.text}</button>)}</div>
          <form onSubmit={handleSave} className={styles.supportForm}>
            <fieldset disabled={saving} className={styles.formFields}>
              <section role="tabpanel" id="support-panel-account" aria-labelledby="support-tab-account" hidden={tab !== 'account'}>
                <p className={styles.info}>شمارهٔ تماس و کدپستی حساب برای ثبت خرید لازم‌اند. اصلاح این اطلاعات، اطلاعات سفارش‌های قبلی را تغییر نمی‌دهد.</p>
                <div className={styles.formGrid}>
                  <label className={styles.field}><span>نام و نام خانوادگی</span><input required={tab === 'account'} maxLength={200} className="input-field" value={draft.name} onChange={event => updateDraft({ name: event.target.value })} /></label>
                  <label className={styles.field}><span>ایمیل</span><input required={tab === 'account'} type={tab === 'account' ? 'email' : 'text'} maxLength={254} dir="ltr" className="input-field" value={draft.email} onChange={event => updateDraft({ email: event.target.value })} /></label>
                  <label className={styles.field}><span>شمارهٔ تماس</span><input type="tel" inputMode="tel" maxLength={24} dir="ltr" placeholder="09123456789" className="input-field" value={draft.phone} onChange={event => updateDraft({ phone: event.target.value })} /></label>
                  <label className={styles.field}><span>کدپستی</span><input inputMode="numeric" maxLength={20} dir="ltr" placeholder="کدپستی ۱۰ رقمی" className="input-field" value={draft.postalCode} onChange={event => updateDraft({ postalCode: event.target.value })} /></label>
                  <label className={styles.field}><span>نقش</span><EnhancedSelect nativeAppearance className="input-field" value={draft.role} disabled={detail.isSelf} onChange={event => updateDraft({ role: event.target.value as Role })}><option value="USER">کاربر</option><option value="ADMIN">مدیر</option></EnhancedSelect></label>
                  <label className={styles.activeControl}><input type="checkbox" checked={draft.isActive} disabled={detail.isSelf} onChange={event => updateDraft({ isActive: event.target.checked })} /><span><strong>حساب فعال است</strong><small>{detail.isSelf ? 'نقش و دسترسی حساب خودت قابل لغو نیست.' : 'با برداشتن تیک، ورود و خرید کاربر مسدود می‌شود.'}</small></span></label>
                </div>
                <div className={styles.passwordBlock}><label className={styles.field}><span><KeyRound size={16} />تعیین رمز عبور جدید</span><input type="password" autoComplete="new-password" minLength={tab === 'account' ? 6 : undefined} maxLength={72} dir="ltr" className="input-field" placeholder="خالی بماند = رمز فعلی حفظ شود" value={newPassword} onChange={event => { setNewPassword(event.target.value); setConfirmed(false); setSuccess('') }} /></label><p>{detail.isSelf ? 'با تغییر رمز حساب خودت، از حساب خارج می‌شوی و باید با رمز جدید وارد شوی.' : 'حداقل ۶ نویسه. تغییر رمز، نشست‌های قبلی کاربر را باطل می‌کند؛ رمز جدید را از مسیر مطمئن به او برسان.'}</p></div>
              </section>
              <section role="tabpanel" id="support-panel-addresses" aria-labelledby="support-tab-addresses" hidden={tab !== 'addresses'}>
                <div className={styles.sectionHeading}><div><h3>نشانی‌های ذخیره‌شده</h3><p>تغییر نشانی روی سفارش‌های ثبت‌شده اثر ندارد.</p></div><button type="button" className="btn-outline" disabled={draft.addresses.length >= 20} onClick={() => updateDraft({ addresses: [...draft.addresses, { title: '', address: '', phone: draft.phone, postalCode: draft.postalCode, isDefault: draft.addresses.length === 0 }] })}><Plus size={16} />نشانی جدید</button></div>
                {!draft.addresses.length && <p className={styles.empty}>کاربر هنوز نشانی ذخیره‌شده ندارد.</p>}
                <div className={styles.addresses}>{draft.addresses.map((address, index) => <div className={styles.addressCard} key={address.id ?? `new-${index}`}>
                  <div className={styles.addressHeading}><strong><MapPin size={17} />نشانی {formatPrice(index + 1)}</strong><button type="button" className={styles.textDanger} onClick={() => { const next = draft.addresses.filter((_, position) => index !== position); if (next.length && !next.some(item => item.isDefault)) next[0] = { ...next[0], isDefault: true }; updateDraft({ addresses: next }) }} aria-label={`حذف نشانی ${index + 1}`}><Trash2 size={16} />حذف</button></div>
                  <div className={styles.formGrid}><label className={styles.field}><span>عنوان نشانی</span><input maxLength={200} className="input-field" value={address.title ?? ''} onChange={event => updateAddress(index, { title: event.target.value })} placeholder="مثلاً منزل" /></label><label className={styles.field}><span>شمارهٔ تماس گیرنده</span><input required={tab === 'addresses'} maxLength={24} type="tel" dir="ltr" className="input-field" value={address.phone} onChange={event => updateAddress(index, { phone: event.target.value })} /></label><label className={styles.field}><span>کدپستی گیرنده</span><input inputMode="numeric" maxLength={20} dir="ltr" className="input-field" value={address.postalCode ?? ''} onChange={event => updateAddress(index, { postalCode: event.target.value })} /></label><label className={styles.defaultControl}><input type="radio" name="support-default-address" checked={address.isDefault} onChange={() => updateAddress(index, { isDefault: true })} />نشانی پیش‌فرض</label><label className={`${styles.field} ${styles.fullWidth}`}><span>نشانی کامل</span><textarea required={tab === 'addresses'} maxLength={3000} className="input-field" value={address.address} onChange={event => updateAddress(index, { address: event.target.value })} /></label></div>
                </div>)}</div>
              </section>
              <section role="tabpanel" id="support-panel-orders" aria-labelledby="support-tab-orders" hidden={tab !== 'orders'}>
                <div className={styles.orderSummary}><div><ShoppingBag size={18} /><span>تعداد کل سفارش‌ها<strong>{formatPrice(detail.summary.orderCount)}</strong></span></div><div><ReceiptText size={18} /><span>مجموع پرداخت تأییدشده<strong>{formatPrice(detail.summary.paidTotal)} تومان</strong></span></div></div>
                <p className={styles.info}>حداکثر ۱۰۰ سفارش اخیر نمایش داده می‌شود. برای پیگیری هر سفارش، جزئیات همان سفارش یا بررسی پرداخت را باز کن.</p>
                {!detail.orders.length ? <p className={styles.empty}>این کاربر هنوز سفارشی ثبت نکرده است.</p> : <div className={styles.orderList}>{detail.orders.map(order => <article className={styles.orderCard} key={order.id}>
                  <div className={styles.orderHeader}><strong dir="ltr">#{order.id.slice(-6)}</strong><time>{date(order.createdAt)}</time><b>{formatPrice(order.total)} تومان</b></div>
                  <div className={styles.orderBadges}><span className={styles.badge}>{orderLabels[order.status] || order.status}</span><span className={`${styles.badge} ${order.verified ? styles.good : styles.warning}`}>{order.verified ? 'پرداخت تأییدشده' : paymentLabels[order.paymentStatus] || 'پرداخت‌نشده'}</span></div>
                  {!!order.items?.length && <p className={styles.orderItems}>{order.items.map(item => `${item.productName || item.product?.name || 'محصول'} · ${formatPrice(item.size)} · ${item.color} · ${formatPrice(item.quantity)} جفت`).join(' / ')}</p>}
                  {order.trackingCode && <p className={styles.tracking}>کد رهگیری: <b dir="ltr">{order.trackingCode}</b></p>}
                  <div className={styles.orderLinks}><Link href={`/admin/orders?q=${encodeURIComponent(order.id)}`}>جزئیات سفارش<ArrowLeft size={15} /></Link>{(order.paymentMethod === 'bank_transfer' || (order._count?.receipts ?? 0) > 0) && <Link href={`/admin/payments?orderId=${encodeURIComponent(order.id)}`}>بررسی پرداخت<ArrowLeft size={15} /></Link>}</div>
                </article>)}</div>}
              </section>
            </fieldset>
            {requiresConfirmation && <label className={styles.confirmation}><input type="checkbox" checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} /><span>تغییر رمز، نقش یا مسدودکردن حساب را برای این کاربر تأیید می‌کنم. نشست‌های قبلی او باطل خواهند شد.</span></label>}
            {modalError && <p role="alert" className={styles.error}>{modalError}</p>}
            {addressConflict && <div className={styles.info}><p>برای ادامه، نسخهٔ تازهٔ نشانی‌ها را دریافت کن. این کار فقط تغییرات ذخیره‌نشدهٔ نشانی‌ها را کنار می‌گذارد.</p><button type="button" className="btn-outline" disabled={saving} onClick={refreshAddresses}>بازخوانی نشانی‌ها</button></div>}
            {success && <p role="status" className={styles.success}><Check size={17} />{success}</p>}
            <div className={styles.formActions}><button type="submit" disabled={saving || addressConflict || (requiresConfirmation && !confirmed)} className="btn-primary">{refreshingAddresses ? 'در حال بازخوانی...' : saving ? 'در حال ذخیره...' : 'ذخیره تغییرات'}</button><button type="button" disabled={saving} onClick={closeModal} className="btn-outline">بستن</button></div>
          </form>
        </>}
      </div>
    </div>}

    {createOpen && <div className={admin.dialogBackdrop} onClick={event => { if (event.target === event.currentTarget) closeModal() }}>
      <div ref={modalRef} tabIndex={-1} className={`${admin.dialog} ${styles.createDialog}`} role="dialog" aria-modal="true" aria-labelledby="user-create-title">
        <div className={admin.dialogHeader}><h2 id="user-create-title">کاربر جدید</h2><button type="button" disabled={saving} onClick={closeModal} aria-label="بستن فرم کاربر جدید"><X size={20} /></button></div>
        <form onSubmit={handleCreate}><fieldset disabled={saving} className={styles.formFields}><div className={styles.formGrid}>
          <label className={styles.field}><span>نام و نام خانوادگی *</span><input required maxLength={200} className="input-field" value={createForm.name} onChange={event => setCreateForm({ ...createForm, name: event.target.value })} /></label>
          <label className={styles.field}><span>ایمیل *</span><input required type="email" maxLength={254} dir="ltr" className="input-field" value={createForm.email} onChange={event => setCreateForm({ ...createForm, email: event.target.value })} /></label>
          <label className={`${styles.field} ${styles.fullWidth}`}><span>رمز عبور *</span><input required type="password" autoComplete="new-password" minLength={6} maxLength={72} dir="ltr" className="input-field" placeholder="حداقل ۶ نویسه" value={createForm.password} onChange={event => setCreateForm({ ...createForm, password: event.target.value })} /></label>
          <label className={styles.field}><span>شمارهٔ تماس</span><input type="tel" maxLength={24} dir="ltr" className="input-field" value={createForm.phone} onChange={event => setCreateForm({ ...createForm, phone: event.target.value })} /></label>
          <label className={styles.field}><span>کدپستی</span><input inputMode="numeric" maxLength={20} dir="ltr" className="input-field" value={createForm.postalCode} onChange={event => setCreateForm({ ...createForm, postalCode: event.target.value })} /></label>
          <label className={`${styles.field} ${styles.fullWidth}`}><span>نقش</span><EnhancedSelect nativeAppearance className="input-field" value={createForm.role} onChange={event => setCreateForm({ ...createForm, role: event.target.value as Role })}><option value="USER">کاربر</option><option value="ADMIN">مدیر</option></EnhancedSelect></label>
        </div></fieldset><p className={styles.info}>تلفن و کدپستی می‌توانند بعداً تکمیل شوند؛ تا تکمیل هر دو، ثبت خرید برای حساب ممکن نیست.</p>{createError && <p role="alert" className={styles.error}>{createError}</p>}<div className={styles.formActions}><button type="submit" disabled={saving} className="btn-primary">{saving ? 'در حال ایجاد...' : 'ایجاد کاربر'}</button><button type="button" disabled={saving} onClick={closeModal} className="btn-outline">انصراف</button></div></form>
      </div>
    </div>}
  </div>
}
