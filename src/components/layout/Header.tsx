'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  ShoppingBag,
  User,
  Menu,
  X,
  LayoutDashboard,
  ArrowLeft,
  ArrowUpLeft,
  Search,
  LogOut,
} from 'lucide-react'
import { useState, useEffect, useSyncExternalStore } from 'react'
import { signOutWithSessionLock as signOut } from '@/lib/session-actions'
import { useCart } from '@/lib/cart'
import { toPersianDigits } from '@/lib/utils'
import NavSearch from './NavSearch'
import BrandLogo from '@/components/ui/BrandLogo'
import { useSiteSettings } from './SiteSettingsProvider'
import { useAppSession } from '@/components/auth/SessionActivityProvider'

const navItems = [
  { href: '/', label: 'خانه' },
  { href: '/products', label: 'محصولات' },
  { href: '/about', label: 'درباره ما' },
  { href: '/contact', label: 'تماس' },
]

const subscribeToHydration = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

export default function Header() {
  const settings = useSiteSettings()
  const pathname = usePathname()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const mounted = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot)
  const [previousPathname, setPreviousPathname] = useState(pathname)
  const { session, refresh: refreshSession } = useAppSession()
  const isAdmin = session?.user.role === 'ADMIN'
  const loggedIn = !!session?.user
  const [scrolled, setScrolled] = useState(false)
  const [hidden, setHidden] = useState(false)
  const itemsCount = useCart((state) => state.getItemsCount())

  // رفتار هوشمند اسکرول: پایین -> مخفی، بالا -> ظاهر
  useEffect(() => {
    let lastY = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 8)
      setHidden(y > lastY && y > 180 && !menuOpen)
      lastY = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [menuOpen])

  // قفل اسکرول + Escape
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // باز کردن جستجو با Ctrl+K یا /
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A new route starts with its navigation visible and its mobile menu closed.
  if (previousPathname !== pathname) {
    setPreviousPathname(pathname)
    setMenuOpen(false)
    setHidden(false)
    setScrolled(false)
  }

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  // در لحظه کلیک مستقیم از سرور میپرسیم کاربر کیست - ضد کش و ضد stale
  const handleUserClick = async () => {
    try {
      const currentSession = await refreshSession()
      router.push(currentSession?.user ? '/profile' : '/login')
    } catch {
      router.push('/login')
    }
  }

  const handleLogout = async () => {
    setMenuOpen(false)
    await signOut({ redirectTo: '/' })
  }

  return (
    <>
      {/* Floating Pill Header */}
      <header
        className={`home-navigation sticky top-4 z-50 transition-transform duration-300 will-change-transform ${
          hidden ? '-translate-y-[140%]' : 'translate-y-0'
        }`}
      >
        <div className="container mx-auto px-4">
          <div
            className={`flex items-center justify-between gap-3 h-14 md:h-16 px-3 md:px-5 rounded-2xl border transition-all duration-300 ${
              scrolled || menuOpen
                ? 'bg-paper/85 backdrop-blur-2xl border-line shadow-lg shadow-night/[0.07]'
                : 'bg-paper/55 backdrop-blur-md border-transparent'
            }`}
          >
            {/* Logo */}
            <Link href="/" className="home-header-brand flex min-w-0 items-center gap-2">
              <span className="home-header-mark shrink-0 flex items-center justify-center" aria-hidden="true">
                <BrandLogo />
              </span>
              <span className="home-header-name max-w-[140px] truncate font-black text-night text-base md:text-lg tracking-tight md:max-w-[200px]" title={settings.storeName}>
                {settings.storeName}
              </span>
            </Link>

            {/* Desktop Links */}
            <nav className="hidden lg:flex items-center gap-1" aria-label="ناوبری اصلی">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={`px-4 py-2 rounded-full text-sm font-bold transition-colors ${
                    isActive(item.href)
                      ? 'bg-night text-white'
                      : 'text-mist hover:text-night hover:bg-line/70'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* Actions */}
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => setSearchOpen(true)}
                aria-label="جستجو"
                title="جستجو (Ctrl+K)"
                className="p-2.5 hover:bg-line/70 rounded-full transition-colors"
              >
                <Search className="w-[18px] h-[18px] text-night" />
              </button>

              {mounted && isAdmin && (
                <Link
                  href="/admin"
                  aria-label="پنل مدیریت"
                  title="پنل مدیریت"
                  className="hidden sm:inline-flex p-2.5 hover:bg-line/70 rounded-full transition-colors"
                >
                  <LayoutDashboard className="w-[18px] h-[18px] text-night" />
                </Link>
              )}

              <button
                onClick={handleUserClick}
                aria-label="حساب کاربری"
                title="حساب کاربری"
                className="hidden sm:inline-flex p-2.5 hover:bg-line/70 rounded-full transition-colors"
              >
                <User className="w-[18px] h-[18px] text-night" />
              </button>

              <Link
                href="/cart"
                aria-label="سبد خرید"
                className="relative p-2.5 hover:bg-line/70 rounded-full transition-colors"
              >
                <ShoppingBag className="w-[18px] h-[18px] text-night" />
                {mounted && itemsCount > 0 && (
                  <span className="absolute -top-0.5 -left-0.5 bg-brand text-white text-[11px] min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center font-black">
                    {toPersianDigits(itemsCount)}
                  </span>
                )}
              </Link>

              <button
                onClick={() => setMenuOpen(!menuOpen)}
                aria-expanded={menuOpen}
                aria-label={menuOpen ? 'بستن منو' : 'باز کردن منو'}
                className="lg:hidden p-2.5 hover:bg-line/70 rounded-full transition-colors"
              >
                {menuOpen ? (
                  <X className="w-6 h-6 text-night" />
                ) : (
                  <Menu className="w-6 h-6 text-night" />
                )}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Full-Screen Takeover Menu (Mobile) */}
      {menuOpen && (
        <div
          className="home-mobile-menu fixed inset-0 z-[80] lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="منوی اصلی"
        >
          <div className="absolute inset-0 bg-night flex flex-col animate-fade-in">
            {/* Top bar */}
            <div className="flex items-center justify-between p-5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="home-menu-mark shrink-0 flex items-center justify-center" aria-hidden="true">
                  <BrandLogo variant="light" />
                </span>
                <span className="min-w-0 max-w-[220px] truncate font-black text-white" title={settings.storeName}>{settings.storeName}</span>
              </span>
              <button
                onClick={() => setMenuOpen(false)}
                aria-label="بستن منو"
                className="shrink-0 p-2.5 border border-white/15 hover:border-white/40 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Giant links */}
            <nav className="flex-1 flex flex-col justify-center px-7 gap-1 overflow-y-auto">
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setSearchOpen(true)
                }}
                className="flex items-center gap-3 mb-4 px-4 py-3.5 rounded-2xl bg-white/10 hover:bg-white/20 text-white/80 transition-colors"
              >
                <Search className="w-5 h-5" />
                <span className="text-sm">جستجو در محصولات...</span>
              </button>

              {navItems.map((item, i) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  onClick={() => setMenuOpen(false)}
                  style={{ animationDelay: `${100 + i * 70}ms` }}
                  className={`animate-link-in group flex items-center justify-between py-4 border-b border-white/10 ${
                    isActive(item.href) ? 'text-brand' : 'text-white'
                  }`}
                >
                  <span className="text-[2.6rem] leading-none font-black tracking-tight group-hover:text-brand transition-colors">
                    {item.label}
                  </span>
                  <ArrowUpLeft className="w-7 h-7 opacity-30 group-hover:opacity-100 group-hover:text-brand transition-all" />
                </Link>
              ))}
            </nav>

            {/* Bottom actions */}
            <div
              style={{ animationDelay: '420ms' }}
              className="animate-link-in p-7 pt-4 space-y-4"
            >
              <Link
                href="/products"
                onClick={() => setMenuOpen(false)}
                className="flex items-center justify-center gap-2 w-full bg-brand hover:bg-brand-strong text-white py-4 rounded-2xl font-black transition-colors"
              >
                شروع خرید
                <ArrowLeft className="w-5 h-5" />
              </Link>

              {mounted && isAdmin ? (
                <Link
                  href="/admin"
                  className="flex items-center justify-center gap-2 w-full border border-dashed border-white/20 hover:border-white/50 text-white py-3.5 rounded-2xl font-bold transition-colors"
                >
                  <LayoutDashboard className="w-4 h-4" />
                  پنل مدیریت
                </Link>
              ) : mounted && loggedIn ? (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handleUserClick}
                    className="flex items-center justify-center gap-2 border border-white/15 hover:border-white/40 text-white py-3.5 rounded-2xl font-bold transition-colors"
                  >
                    <User className="w-4 h-4" />
                    حساب من
                  </button>
                  <button
                    onClick={handleLogout}
                    className="flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/40 text-red-200 py-3.5 rounded-2xl font-bold transition-colors"
                  >
                    <LogOut className="w-4 h-4 rotate-180" />
                    خروج
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Link
                    href="/login"
                    className="text-center border border-white/15 hover:border-white/40 text-white py-3.5 rounded-2xl font-bold transition-colors"
                  >
                    ورود
                  </Link>
                  <Link
                    href="/register"
                    className="text-center bg-white/10 hover:bg-white/20 text-white py-3.5 rounded-2xl font-bold transition-colors"
                  >
                    ثبت نام
                  </Link>
                </div>
              )}

              {(settings.phone || settings.email) && <p className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-center text-xs text-white/40" dir="ltr">
                {settings.phone && <a href={`tel:${settings.phone}`}>{settings.phone.replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)])}</a>}
                {settings.email && <a href={`mailto:${settings.email}`}>{settings.email}</a>}
              </p>}
            </div>
          </div>
        </div>
      )}

      {/* Search Overlay */}
      {searchOpen && <NavSearch onClose={() => setSearchOpen(false)} />}
    </>
  )
}
