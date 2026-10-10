'use client'

import Link from 'next/link'
import { CheckCircle2, X, ShoppingBag, ArrowLeft } from 'lucide-react'
import { useToastStore } from '@/lib/toast'

export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed bottom-6 right-6 z-[100] space-y-3 w-[calc(100vw-3rem)] max-w-sm"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="bg-night text-white rounded-[26px] shadow-2xl shadow-night/20 p-5 animate-toast-in border border-white/10"
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-lime text-night flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-5 h-5" />
            </div>

            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm">{t.title}</p>
              {t.message && (
                <p className="text-white/60 text-xs mt-1 truncate">{t.message}</p>
              )}

              {/* مسیر ادامه خرید */}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Link
                  href="/cart"
                  onClick={() => dismiss(t.id)}
                  className="text-xs font-bold bg-lime text-night hover:bg-lime/90 px-3 py-2 rounded-full inline-flex items-center gap-1.5 transition-colors"
                >
                  <ShoppingBag className="w-3.5 h-3.5" />
                  مشاهده سبد خرید
                </Link>
                <Link
                  href="/checkout"
                  onClick={() => dismiss(t.id)}
                  className="text-xs font-bold text-white/80 hover:text-white px-3 py-2 border border-white/25 hover:border-white/50 rounded-full inline-flex items-center gap-1.5 transition-colors"
                >
                  تکمیل خرید
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>

            <button
              onClick={() => dismiss(t.id)}
              className="text-white/40 hover:text-white transition-colors shrink-0 p-1 rounded-full"
              aria-label="بستن اعلان"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
