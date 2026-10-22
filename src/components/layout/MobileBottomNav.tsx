'use client'

import Link from 'next/link'
import { House, Store, Search, ShoppingBag, UserRound } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { toPersianDigits } from '@/lib/utils'
import {
  getMobileKeyboardSnapshot,
  getMobileKeyboardServerSnapshot,
  isMobileNavActive,
  subscribeToMobileKeyboard,
  type MobileNavSection,
} from '@/lib/mobile-navigation'
import styles from './mobile-bottom-nav.module.css'

type Props = {
  pathname: string
  loggedIn: boolean
  mounted: boolean
  itemsCount: number
  hidden: boolean
  onSearch: () => void
  onAccount: () => void
}

export default function MobileBottomNav({ pathname, loggedIn, mounted, itemsCount, hidden, onSearch, onAccount }: Props) {
  const keyboardOpen = useSyncExternalStore(subscribeToMobileKeyboard, getMobileKeyboardSnapshot, getMobileKeyboardServerSnapshot)
  if (hidden || keyboardOpen) return null

  const active = (section: MobileNavSection) => isMobileNavActive(pathname, section)
  const itemClass = (section?: MobileNavSection) => `${styles.item} ${section && active(section) ? styles.active : ''}`
  const accountLabel = mounted && loggedIn ? 'حساب من' : 'حساب'
  const count = mounted ? itemsCount : 0

  return (
    <nav className={styles.nav} aria-label="دسترسی سریع موبایل">
      <Link href="/" className={itemClass('home')} aria-current={active('home') ? 'page' : undefined}>
        <House aria-hidden="true" />
        <span>خانه</span>
      </Link>
      <Link href="/products" className={itemClass('shop')} aria-current={active('shop') ? 'page' : undefined}>
        <Store aria-hidden="true" />
        <span>فروشگاه</span>
      </Link>
      <button type="button" className={itemClass()} onClick={onSearch} aria-haspopup="dialog">
        <Search aria-hidden="true" />
        <span>جستجو</span>
      </button>
      <Link href="/cart" className={itemClass('cart')} aria-current={active('cart') ? 'page' : undefined}
        aria-label={count > 0 ? `سبد خرید، ${toPersianDigits(count)} کالا` : 'سبد خرید'}>
        <span className={styles.icon}>
          <ShoppingBag aria-hidden="true" />
          {count > 0 && <span className={styles.badge} aria-hidden="true">{count > 99 ? '۹۹+' : toPersianDigits(count)}</span>}
        </span>
        <span>سبد خرید</span>
      </Link>
      <button type="button" className={itemClass('account')} onClick={onAccount} aria-current={active('account') ? 'page' : undefined}>
        <UserRound aria-hidden="true" />
        <span>{accountLabel}</span>
      </button>
    </nav>
  )
}
