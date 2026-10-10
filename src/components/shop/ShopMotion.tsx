'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { observeShopMotion } from '@/lib/shop-motion'

export default function ShopMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  useEffect(() => {
    if (root.current) return observeShopMotion(root.current)
  }, [pathname])

  return <div ref={root} className="shop-shell min-h-screen flex flex-col">{children}</div>
}
