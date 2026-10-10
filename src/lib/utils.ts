import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat('fa-IR').format(price)
}

export function toPersianDigits(num: number): string {
  return num.toString().replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d])
}