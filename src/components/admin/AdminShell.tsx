'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
} from 'lucide-react'
import { signOutWithSessionLock as signOut } from '@/lib/session-actions'
import styles from './admin.module.css'
import BrandLogo from '@/components/ui/BrandLogo'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'
import { getSettingsSection, settingsSections, type SettingsSectionId } from '@/lib/admin-settings-sections'

const adminNav = [
  { href: '/admin', label: 'داشبورد', Icon: LayoutDashboard },
  { href: '/admin/analytics', label: 'آمار بازدید', Icon: ChartNoAxesCombined },
  { href: '/admin/reviews', label: 'نظرات و امتیازها', Icon: MessageSquareText },
  { href: '/admin/products', label: 'محصولات', Icon: Package },
  { href: '/admin/categories', label: 'دسته‌بندی‌ها', Icon: Tags },
  { href: '/admin/orders', label: 'سفارش‌ها', Icon: ShoppingBag },
  { href: '/admin/payments', label: 'بررسی پرداخت‌ها', Icon: ReceiptText },
  { href: '/admin/payment-methods', label: 'روش‌های پرداخت', Icon: CreditCard },
  { href: '/admin/shipping', label: 'روش‌های ارسال', Icon: Truck },
  { href: '/admin/users', label: 'کاربران', Icon: Users },
  { href: '/admin/settings', label: 'تنظیمات عمومی', Icon: Settings2 },
]

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

function SettingsMenu({
  isSettingsPage,
  activeSection,
}: {
  isSettingsPage: boolean
  activeSection: SettingsSectionId
}) {
  const [expanded, setExpanded] = useState(isSettingsPage)
  return (
    <div className={styles.settingsMenu}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="admin-settings-submenu"
        className={`${styles.navLink} ${styles.settingsToggle} ${isSettingsPage ? styles.active : ''}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <Settings2 className={`w-5 h-5 ${isSettingsPage ? '' : 'opacity-70'}`} />
        <span>تنظیمات عمومی</span>
        <ChevronDown aria-hidden="true" className={`${styles.submenuChevron} ${expanded ? styles.submenuChevronOpen : ''}`} />
      </button>
      <div id="admin-settings-submenu" className={styles.settingsSubmenu} hidden={!expanded}>
        <SettingsSectionLinks isSettingsPage={isSettingsPage} activeSection={activeSection} />
      </div>
    </div>
  )
}

export default function AdminShell({
  children,
  userName,
}: {
  children: React.ReactNode
  userName?: string | null
}) {
  const pathname = usePathname()
  const settings = useSiteSettings()
  const isSettingsPage = pathname === '/admin/settings'
  const activeSection = useSyncExternalStore(subscribeToSectionChange, readSettingsSection, serverSettingsSection)
  const mobileSettingsNavRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const container = mobileSettingsNavRef.current
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

      {/* Mobile horizontal nav */}
      <nav
        aria-label="ناوبری پنل"
        className={styles.mobileNav}
      >
        <div className="flex gap-2 px-4 py-3 w-max">
          {adminNav.map(({ href, label, Icon }) => {
            const active = pathname === href
            if (isSettingsPage && href === '/admin/settings') {
              return (
                <a key={href} href="#branding" aria-current="page" className={`${styles.navLink} ${styles.active}`}>
                  <Icon className="w-4 h-4" />
                  {label}
                </a>
              )
            }
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`${styles.navLink} ${active ? styles.active : ''}`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            )
          })}
        </div>
      </nav>
      {isSettingsPage && (
        <nav ref={mobileSettingsNavRef} aria-label="بخش‌های تنظیمات عمومی" className={styles.mobileSettingsNav}>
          <div>
            <SettingsSectionLinks isSettingsPage={isSettingsPage} activeSection={activeSection} />
          </div>
        </nav>
      )}

      <div className={styles.workspace}>
        {/* Desktop sticky sidebar */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarInner}>
            <p className={styles.navLabel}>
              فضای مدیریت
            </p>
            <nav className="space-y-2" aria-label="منوی مدیریت">
              {adminNav.map(({ href, label, Icon }) => {
                if (href === '/admin/settings') {
                  return <SettingsMenu key={`settings-menu:${pathname}`} isSettingsPage={isSettingsPage} activeSection={activeSection} />
                }
                const active = pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={`${styles.navLink} ${active ? styles.active : ''}`}
                  >
                    <Icon className={`w-5 h-5 ${active ? '' : 'opacity-70'}`} />
                    {label}
                  </Link>
                )
              })}
            </nav>

            {/* Footer info */}
            <div className={styles.sidebarNote}>
              <span aria-hidden="true" />
              <p>همه‌چیز برای قدم بعدی.</p>
            </div>
          </div>
        </aside>

        {/* Content */}
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  )
}
