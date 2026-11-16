'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Package,
  Tags,
  ShoppingBag,
  Users,
  Store,
  LogOut,
  Truck,
  CreditCard,
  ReceiptText,
  Settings2,
  ChevronDown,
  ChartNoAxesCombined,
  MessageSquareText,
  TicketPercent,
  Warehouse,
  PackageCheck,
  ShieldCheck,
  KeyRound,
  Menu,
  X,
  Pin,
} from 'lucide-react'
import { signOutWithSessionLock as signOut } from '@/lib/session-actions'
import styles from './admin.module.css'
import BrandLogo from '@/components/ui/BrandLogo'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import { getSettingsSection, settingsSections, type SettingsSectionId } from '@/lib/admin-settings-sections'

const overviewNav = [
  { href: '/admin', label: 'داشبورد', Icon: LayoutDashboard },
  { href: '/admin/analytics', label: 'آمار بازدید', Icon: ChartNoAxesCombined },
]

const adminNavGroups = [
  { id: 'sales', label: 'فروش و سفارش‌ها', Icon: ShoppingBag, items: [
    { href: '/admin/orders', label: 'سفارش‌ها', Icon: ShoppingBag },
    { href: '/admin/payments', label: 'بررسی پرداخت‌ها', Icon: ReceiptText },
    { href: '/admin/shipments', label: 'رهگیری مرسوله‌ها', Icon: PackageCheck },
    { href: '/admin/coupons', label: 'کدهای تخفیف', Icon: TicketPercent },
  ] },
  { id: 'catalog', label: 'محصولات و انبار', Icon: Package, items: [
    { href: '/admin/products', label: 'محصولات', Icon: Package },
    { href: '/admin/categories', label: 'دسته‌بندی محصولات', Icon: Tags },
    { href: '/admin/inventory', label: 'انبارداری', Icon: Warehouse },
  ] },
  { id: 'customers', label: 'مشتریان', Icon: Users, items: [
    { href: '/admin/users', label: 'مدیریت کاربران', Icon: Users },
    { href: '/admin/reviews', label: 'نظرات و امتیازها', Icon: MessageSquareText },
    { href: '/admin/password-reset', label: 'بازیابی رمز عبور', Icon: KeyRound },
  ] },
  { id: 'settings', label: 'تنظیمات فروشگاه', Icon: Settings2, items: [
    { href: '/admin/settings', label: 'تنظیمات عمومی', Icon: Settings2 },
    { href: '/admin/payment-methods', label: 'روش‌های پرداخت', Icon: CreditCard },
    { href: '/admin/shipping', label: 'روش‌های ارسال', Icon: Truck },
    { href: '/admin/registration', label: 'ثبت‌نام و تأیید حساب', Icon: ShieldCheck },
  ] },
]

const quickAccessItems = adminNavGroups.flatMap(group => group.items)
const defaultQuickAccess = JSON.stringify(['/admin/orders', '/admin/products', '/admin/inventory'])
const quickAccessEvent = 'panik-admin-quick-access'
const maxQuickAccess = 6
// Keep changes usable for this visit when the browser disallows storage writes.
const temporaryQuickAccess = new Map<string, string>()

function parseQuickAccess(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return [...new Set(parsed.filter((href): href is string =>
      typeof href === 'string' && quickAccessItems.some(item => item.href === href)))].slice(0, maxQuickAccess)
  } catch { /* Invalid or obsolete browser data uses the initial shortcuts. */ }
  return JSON.parse(defaultQuickAccess)
}

function useQuickAccess(userId: string) {
  const storageKey = `panik-admin-quick-access:v1:${encodeURIComponent(userId)}`
  const getSnapshot = useCallback(() => {
    const temporary = temporaryQuickAccess.get(storageKey)
    if (temporary !== undefined) return temporary
    try { return window.localStorage.getItem(storageKey) ?? defaultQuickAccess } catch { return defaultQuickAccess }
  }, [storageKey])
  const subscribe = useCallback((notify: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== storageKey) return
      temporaryQuickAccess.delete(storageKey)
      notify()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(quickAccessEvent, notify)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(quickAccessEvent, notify)
    }
  }, [storageKey])
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => defaultQuickAccess)
  const hrefs = parseQuickAccess(raw)

  const toggle = (href: string) => {
    if (!quickAccessItems.some(item => item.href === href)) return
    const current = parseQuickAccess(getSnapshot())
    if (!current.includes(href) && current.length >= maxQuickAccess) return
    const next = JSON.stringify(current.includes(href) ? current.filter(value => value !== href) : [...current, href])
    temporaryQuickAccess.set(storageKey, next)
    try {
      window.localStorage.setItem(storageKey, next)
      if (window.localStorage.getItem(storageKey) === next) temporaryQuickAccess.delete(storageKey)
    } catch { /* Retain the in-memory choices when reads or writes are blocked. */ }
    window.dispatchEvent(new Event(quickAccessEvent))
  }
  return { hrefs, toggle }
}

type QuickAccess = { hrefs: string[]; toggle: (href: string) => void }

function isActiveRoute(pathname: string, href: string) {
  return pathname === href || href !== '/admin' && pathname.startsWith(`${href}/`)
}

function AdminQuickAccess({ pathname, idPrefix, quickAccess, onNavigate }: {
  pathname: string
  idPrefix: 'desktop' | 'mobile'
  quickAccess: QuickAccess
  onNavigate?: () => void
}) {
  return <nav className={styles.quickAccess} aria-label={idPrefix === 'desktop' ? 'دسترسی سریع' : 'دسترسی سریع موبایل'}>
    <div className={styles.quickHeading}><span><Pin size={13} aria-hidden="true" />دسترسی سریع</span><small>{quickAccess.hrefs.length.toLocaleString('fa-IR')} / {maxQuickAccess.toLocaleString('fa-IR')}</small></div>
    {quickAccess.hrefs.length === 0 && <p className={styles.quickEmpty}>با سنجاق کنار بخش‌ها، میانبر دلخواهت را اضافه کن.</p>}
    {quickAccess.hrefs.map(href => {
      const item = quickAccessItems.find(value => value.href === href)!
      return <div key={href} className={styles.quickRow}>
        <Link href={href} onNavigate={onNavigate} aria-current={isActiveRoute(pathname, href) ? 'page' : undefined}
          className={`${styles.navLink} ${styles.quickLink} ${isActiveRoute(pathname, href) ? styles.quickActive : ''}`}>
          <item.Icon size={16} aria-hidden="true" /><span>{item.label}</span>
        </Link>
        <button type="button" className={styles.pinButton} onClick={() => quickAccess.toggle(href)}
          aria-label={`حذف ${item.label} از دسترسی سریع`} title={`حذف ${item.label} از دسترسی سریع`}><X size={13} aria-hidden="true" /></button>
      </div>
    })}
    <p className={styles.quickHint}>انتخاب با سنجاق کنار بخش‌ها</p>
  </nav>
}

function AdminNavigation({ pathname, idPrefix, quickAccess, onNavigate }: {
  pathname: string
  idPrefix: 'desktop' | 'mobile'
  quickAccess: QuickAccess
  onNavigate?: () => void
}) {
  const [expandedGroups, setExpandedGroups] = useState(() => adminNavGroups
    .filter(group => group.items.some(item => isActiveRoute(pathname, item.href))).map(group => group.id))

  return <nav className={styles.navigation} aria-label={idPrefix === 'desktop' ? 'منوی مدیریت' : 'ناوبری پنل'}>
    <div className={styles.overviewLinks}>
      {overviewNav.map(({ href, label, Icon }) => <Link key={href} href={href} onNavigate={onNavigate}
        aria-current={isActiveRoute(pathname, href) ? 'page' : undefined}
        className={`${styles.navLink} ${isActiveRoute(pathname, href) ? styles.active : ''}`}>
        <Icon size={19} aria-hidden="true" /><span>{label}</span>
      </Link>)}
    </div>
    <div className={styles.navGroups}>
      {adminNavGroups.map(({ id, label, Icon, items }) => {
        const active = items.some(item => isActiveRoute(pathname, item.href))
        const expanded = expandedGroups.includes(id)
        const panelId = `admin-${idPrefix}-${id}`
        return <div key={id} className={styles.navGroup}>
          <button type="button" aria-expanded={expanded} aria-controls={panelId}
            className={`${styles.navLink} ${styles.groupToggle} ${active ? styles.groupActive : ''}`}
            onClick={() => setExpandedGroups(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])}>
            <Icon size={19} aria-hidden="true" /><span>{label}</span>
            <ChevronDown size={15} aria-hidden="true" className={`${styles.submenuChevron} ${expanded ? styles.submenuChevronOpen : ''}`} />
          </button>
          <div id={panelId} className={styles.groupLinks} hidden={!expanded}>
            {items.map(({ href, label: itemLabel, Icon: ItemIcon }) => {
              const pinned = quickAccess.hrefs.includes(href)
              const pinLabel = pinned ? `حذف ${itemLabel} از دسترسی سریع` : `افزودن ${itemLabel} به دسترسی سریع`
              return <div key={href} className={styles.navItem}>
                <Link href={href} onNavigate={onNavigate} aria-current={isActiveRoute(pathname, href) ? 'page' : undefined}
                  className={`${styles.navLink} ${styles.groupLink} ${isActiveRoute(pathname, href) ? styles.active : ''}`}>
                  <ItemIcon size={16} aria-hidden="true" /><span>{itemLabel}</span>
                </Link>
                <button type="button" className={`${styles.pinButton} ${pinned ? styles.pinSelected : ''}`} aria-label={pinLabel}
                  title={pinLabel} aria-pressed={pinned} disabled={!pinned && quickAccess.hrefs.length >= maxQuickAccess}
                  onClick={() => quickAccess.toggle(href)}><Pin size={14} aria-hidden="true" /></button>
              </div>
            })}
          </div>
        </div>
      })}
    </div>
  </nav>
}

function MobileAdminMenu({ pathname, storeName, quickAccess }: { pathname: string; storeName: string; quickAccess: QuickAccess }) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    const trigger = triggerRef.current
    const previousOverflow = document.body.style.overflow
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false) }
    if (!dialog.open) dialog.showModal()
    document.body.style.overflow = 'hidden'
    desktop.addEventListener('change', closeOnDesktop)
    closeOnDesktop()
    return () => {
      desktop.removeEventListener('change', closeOnDesktop)
      if (dialog.open) dialog.close()
      document.body.style.overflow = previousOverflow
      if (trigger?.isConnected) trigger.focus()
    }
  }, [open])

  return <>
    <button ref={triggerRef} type="button" className={styles.mobileMenuButton} aria-label="باز کردن منوی مدیریت"
      aria-controls="admin-mobile-menu" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Menu size={21} aria-hidden="true" />
    </button>
    <dialog ref={dialogRef} id="admin-mobile-menu" className={styles.mobileDrawer} aria-modal="true" aria-labelledby="admin-mobile-menu-title"
      onCancel={() => setOpen(false)} onClose={event => { if (!event.currentTarget.open) setOpen(false) }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false)
      }}>
      <div className={styles.drawerHeader}>
        <div><h2 id="admin-mobile-menu-title">منوی مدیریت</h2><p>{storeName}</p></div>
        <button type="button" aria-label="بستن منوی مدیریت" onClick={() => setOpen(false)}><X size={20} aria-hidden="true" /></button>
      </div>
      <div className={styles.drawerBody}>
        <AdminQuickAccess pathname={pathname} idPrefix="mobile" quickAccess={quickAccess} onNavigate={() => setOpen(false)} />
        <AdminNavigation key={`mobile:${pathname}`} pathname={pathname} idPrefix="mobile" quickAccess={quickAccess} onNavigate={() => setOpen(false)} />
      </div>
      <div className={styles.drawerFooter}><Store size={16} aria-hidden="true" /><Link href="/" onNavigate={() => setOpen(false)}>مشاهدهٔ فروشگاه</Link></div>
    </dialog>
  </>
}

function subscribeToSectionChange(callback: () => void) {
  window.addEventListener('hashchange', callback)
  window.addEventListener('popstate', callback)
  return () => {
    window.removeEventListener('hashchange', callback)
    window.removeEventListener('popstate', callback)
  }
}

function readSettingsSection() {
  return getSettingsSection(window.location.hash)
}

function serverSettingsSection(): SettingsSectionId {
  return 'branding'
}

function SettingsSectionLinks({
  isSettingsPage,
  activeSection,
}: {
  isSettingsPage: boolean
  activeSection: SettingsSectionId
}) {
  return settingsSections.map(({ id, label }) => {
    const active = isSettingsPage && activeSection === id
    const className = `${styles.submenuLink} ${active ? styles.submenuActive : ''}`
    // Native same-page anchors preserve the draft and notify hash listeners.
    return isSettingsPage ? (
      <a key={id} href={`#${id}`} aria-current={active ? 'location' : undefined} className={className}>
        {label}
      </a>
    ) : (
      <Link key={id} href={`/admin/settings#${id}`} className={className}>
        {label}
      </Link>
    )
  })
}

export default function AdminShell({
  children,
  userName,
  userId,
}: {
  children: React.ReactNode
  userName?: string | null
  userId: string
}) {
  const pathname = usePathname()
  const settings = useSiteSettings()
  const quickAccess = useQuickAccess(userId)
  const isSettingsPage = pathname === '/admin/settings'
  const activeSection = useSyncExternalStore(subscribeToSectionChange, readSettingsSection, serverSettingsSection)
  const settingsNavRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const container = settingsNavRef.current
    if (!isSettingsPage || !container) return
    const revealActiveSection = () => {
      const link = container.querySelector<HTMLElement>('[aria-current="location"]')
      if (!link) return
      const viewport = container.getBoundingClientRect()
      if (!viewport.width) return
      const item = link.getBoundingClientRect()
      const inset = 9
      const delta = item.left < viewport.left + inset
        ? item.left - viewport.left - inset
        : item.right > viewport.right - inset
          ? item.right - viewport.right + inset
          : 0
      if (delta) container.scrollBy({ left: delta, behavior: 'auto' })
    }
    revealActiveSection()
    window.addEventListener('resize', revealActiveSection)
    return () => window.removeEventListener('resize', revealActiveSection)
  }, [activeSection, isSettingsPage])

  return (
    <div className={styles.shell}>
      {/* Top bar */}
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <MobileAdminMenu key={pathname} pathname={pathname} storeName={settings.storeName} quickAccess={quickAccess} />
          <Link href="/admin" className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              <BrandLogo />
            </span>
            <span title={settings.storeName}>{settings.storeName} <small>مدیریت فروشگاه</small></span>
          </Link>

          <div className="flex shrink-0 items-center gap-3">
            {userName && (
              <span className={styles.avatar} title={userName}>
                {userName.trim().charAt(0)}
              </span>
            )}
            <Link
              href="/"
              className={styles.storeLink}
              aria-label="مشاهده فروشگاه"
            >
              <Store className="w-4 h-4" />
              <span className="hidden sm:inline">فروشگاه</span>
            </Link>
            <button
              onClick={() => signOut({ redirectTo: '/' })}
              aria-label="خروج از حساب"
              title="خروج از حساب"
              className={styles.logout}
            >
              <LogOut className="w-4 h-4 rotate-180" />
            </button>
          </div>
        </div>
      </header>

      <div className={styles.workspace}>
        {/* Desktop sticky sidebar */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarInner}>
            <p className={styles.navLabel}>
              فضای مدیریت
            </p>
            <AdminQuickAccess pathname={pathname} idPrefix="desktop" quickAccess={quickAccess} />
            <AdminNavigation key={`desktop:${pathname}`} pathname={pathname} idPrefix="desktop" quickAccess={quickAccess} />

            {/* Footer info */}
            <div className={styles.sidebarNote}>
              <span aria-hidden="true" />
              <p>همه‌چیز برای قدم بعدی.</p>
            </div>
          </div>
        </aside>

        {/* Content */}
        <main className={styles.content}>
          {isSettingsPage && <nav ref={settingsNavRef} aria-label="بخش‌های تنظیمات عمومی" className={styles.settingsPageNav}>
            <div><SettingsSectionLinks isSettingsPage={isSettingsPage} activeSection={activeSection} /></div>
          </nav>}
          {children}
        </main>
      </div>
    </div>
  )
}
