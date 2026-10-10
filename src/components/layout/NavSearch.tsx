'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Search, X, ArrowLeft, ShoppingBag } from 'lucide-react'
import { formatPrice } from '@/lib/utils'

interface SearchResult {
  id: string
  name: string
  slug: string
  price: number
  images: string[]
  category: { name: string }
}

export default function NavSearch({ onClose }: { onClose: () => void }) {
  const [term, setTerm] = useState('')
  const [response, setResponse] = useState<{ query: string; items: SearchResult[] }>({ query: '', items: [] })
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const query = term.trim()
  const loading = query.length >= 2 && response.query !== query
  const results = query.length >= 2 && response.query === query ? response.items : []

  // فوکوس خودکار + بستن با Escape
  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  // جستجوی زنده با debounce
  useEffect(() => {
    if (query.length < 2) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/products?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (r) => (r.ok ? r.json() : []))
        .then((data: SearchResult[]) => {
          if (!controller.signal.aborted) setResponse({ query, items: data.slice(0, 6) })
        })
        .catch(() => {
          if (!controller.signal.aborted) setResponse({ query, items: [] })
        })
    }, 250)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const goToListing = () => {
    if (!term.trim()) return
    onClose()
    router.push(`/products?q=${encodeURIComponent(term.trim())}`)
  }

  const goProduct = (slug: string) => {
    onClose()
    router.push(`/products/${encodeURIComponent(slug)}`)
  }

  return (
    <div className="fixed inset-0 z-[90] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="search-title">
      <button
        aria-label="بستن جستجو"
        onClick={onClose}
        className="fixed inset-0 w-full bg-night/60 backdrop-blur-sm animate-fade-in cursor-default"
      />

      <div className="relative mx-auto my-6 md:my-16 max-w-2xl px-4">
        <div className="bg-paper rounded-[28px] shadow-2xl shadow-night/20 border border-white overflow-hidden animate-toast-in">
          <div className="flex items-center justify-between gap-4 px-5 pt-5 md:px-7">
            <h2 id="search-title" className="font-black text-lg">قدم بعدیت رو پیدا کن.</h2>
            <button onClick={onClose} aria-label="بستن" className="rounded-full p-2 bg-fog hover:bg-brand-soft transition-colors">
              <X className="w-4 h-4 text-mist" />
            </button>
          </div>
          {/* Input */}
          <div className="flex items-center gap-3 m-5 md:mx-7 p-4 rounded-2xl bg-brand-soft border border-brand/10 focus-within:border-brand/40">
            <Search className="w-5 h-5 text-brand shrink-0" />
            <input
              ref={inputRef}
              type="text"
              aria-label="جستجو در محصولات"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') goToListing()
              }}
              placeholder="جستجو در محصولات..."
              className="min-w-0 flex-1 bg-transparent outline-none text-base font-medium text-night placeholder:text-mist/70 focus-visible:outline-none"
            />
          </div>

          {/* Results */}
          <div className="max-h-[50vh] overflow-y-auto">
            {loading && (
              <p role="status" className="px-5 py-6 text-sm text-mist">در حال جستجو...</p>
            )}

            {!loading && term.trim().length >= 2 && results.length === 0 && (
              <p className="px-5 py-6 text-sm text-mist">
                محصولی برای «{term}» پیدا نشد
              </p>
            )}

            {!loading &&
              results.map((product) => (
                <button
                  key={product.id}
                  onClick={() => goProduct(product.slug)}
                  className="w-full flex items-center gap-4 px-5 md:px-7 py-3 hover:bg-brand-soft/70 transition-colors text-right"
                >
                  {product.images[0] ? <Image
                    src={product.images[0]}
                    alt=""
                    width={64}
                    height={64}
                    unoptimized={product.images[0].startsWith('http') || product.images[0].startsWith('/api/')}
                    className="w-16 h-16 rounded-2xl object-cover shrink-0 bg-fog"
                  /> : <span className="grid place-items-center w-16 h-16 rounded-2xl bg-fog shrink-0"><ShoppingBag aria-hidden="true" className="w-6 h-6 text-mist" /></span>}
                  <span className="flex-1 min-w-0">
                    <span className="block font-bold text-sm text-night truncate">
                      {product.name}
                    </span>
                    <span className="block text-xs text-mist mt-1">
                      {product.category?.name}
                    </span>
                    <span className="block text-brand font-bold text-xs mt-2">
                      {formatPrice(product.price)}
                    </span>
                  </span>
                  <ArrowLeft className="w-4 h-4 text-mist shrink-0" aria-hidden="true" />
                </button>
              ))}
          </div>

          {/* Footer action */}
          {term.trim().length >= 2 && (
            <Link
              href={`/products?q=${encodeURIComponent(term.trim())}`}
              onClick={onClose}
              className="flex items-center justify-center gap-2 p-4 m-4 rounded-full bg-lime hover:bg-lime/80 text-sm font-bold text-night transition-colors"
            >
              <span className="truncate">مشاهده همه نتایج برای «{term.trim()}»</span>
              <ArrowLeft className="w-4 h-4 shrink-0" />
            </Link>
          )}
          {!term && (
            <p className="text-mist text-xs px-6 pb-6 leading-7">اسم کفش یا مدل مورد علاقه‌ات را بنویس. برای جستجو حداقل ۲ حرف وارد کن.</p>
          )}
        </div>

        {!term && (
          <p className="text-center text-white/70 text-xs mt-4">
            Enter برای دیدن همهٔ نتایج · Esc برای بستن
          </p>
        )}
      </div>
    </div>
  )
}
