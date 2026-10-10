'use client'

import { create } from 'zustand'

export interface ToastItem {
  id: number
  title: string
  message?: string
}

interface ToastStore {
  toasts: ToastItem[]
  push: (toast: { title: string; message?: string }) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  push: (toast) => {
    const id = nextId++
    set({ toasts: [...get().toasts, { id, ...toast }] })
    // حذف خودکار بعد از ۵ ثانیه
    setTimeout(() => get().dismiss(id), 5000)
  },

  dismiss: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
}))

/** فراخوانی سریع از هر جای اپ */
export const toast = (title: string, message?: string) =>
  useToastStore.getState().push({ title, message })