'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CartItem } from '@/types'

interface CartStore {
  items: CartItem[]
  checkoutAttempt: { key: string } | null
  beginCheckout: () => Promise<string>
  addItem: (item: CartItem) => void
  removeItem: (productId: string, size: number, color: string) => void
  updateQuantity: (productId: string, size: number, color: string, quantity: number) => void
  syncPrices: (prices: { productId: string; price: number }[]) => void
  clearCart: () => void
  getTotal: () => number
  getItemsCount: () => number
}

export const useCart = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],
      checkoutAttempt: null,

      beginCheckout: async () => {
        // Retain an unresolved attempt across reloads and quote/cart edits.
        // The server checks the intent and links a committed conflicting order.
        // Only a random key is stored; recipient details never enter localStorage.
        const existing = get().checkoutAttempt
        if (existing?.key) return existing.key
        const random = crypto.getRandomValues(new Uint8Array(16))
        random[6] = (random[6] & 0x0f) | 0x40
        random[8] = (random[8] & 0x3f) | 0x80
        const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')
        const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
        set({ checkoutAttempt: { key } })
        return key
      },

      addItem: (item) => {
        const existing = get().items.find(
          (i) => i.productId === item.productId && i.size === item.size && i.color === item.color
        )

        if (existing) {
          set({
            items: get().items.map((i) =>
              i.productId === item.productId && i.size === item.size && i.color === item.color
                ? { ...i, quantity: i.quantity + item.quantity }
                : i
            ),
          })
        } else {
          set({ items: [...get().items, item] })
        }
      },

      removeItem: (productId, size, color) => {
        const items = get().items.filter(
            (i) => !(i.productId === productId && i.size === size && i.color === color)
          )
        set({ items, ...(items.length === 0 ? { checkoutAttempt: null } : {}) })
      },

      updateQuantity: (productId, size, color, quantity) => {
        if (quantity <= 0) {
          get().removeItem(productId, size, color)
          return
        }
        set({
          items: get().items.map((i) =>
            i.productId === productId && i.size === size && i.color === color
              ? { ...i, quantity }
              : i
          ),
        })
      },

      syncPrices: (prices) => {
        const byProduct = new Map(prices
          .filter((entry) => entry && typeof entry.productId === 'string' && Number.isSafeInteger(entry.price) && entry.price >= 0)
          .map((entry) => [entry.productId, entry.price]))
        set((state) => ({
          items: state.items.map((item) => byProduct.has(item.productId)
            ? { ...item, price: byProduct.get(item.productId)! }
            : item),
        }))
      },

      clearCart: () => set({ items: [], checkoutAttempt: null }),

      getTotal: () => get().items.reduce((sum, item) => sum + item.price * item.quantity, 0),

      getItemsCount: () => get().items.reduce((sum, item) => sum + item.quantity, 0),
    }),
    { name: 'cart-storage' }
  )
)
