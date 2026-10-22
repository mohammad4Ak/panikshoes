// Contact identifiers remain strings so leading zeros survive forms and imports.
// This module is intentionally dependency-free for both server and client use.
export function normalizeContactDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, character => String(character.charCodeAt(0) >= 0x6f0
    ? character.charCodeAt(0) - 0x6f0 : character.charCodeAt(0) - 0x660))
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') return ''
  const phone = normalizeContactDigits(value).trim().replace(/[\s\-()\u200c\u200e\u200f]/g, '')
  if (phone.startsWith('+98')) return `0${phone.slice(3)}`
  if (phone.startsWith('0098')) return `0${phone.slice(4)}`
  return phone
}

export function normalizePostalCode(value: unknown): string {
  return typeof value === 'string'
    ? normalizeContactDigits(value).trim().replace(/[\s\-\u200c\u200e\u200f]/g, '') : ''
}

export function isValidCustomerPhone(value: unknown): boolean {
  return /^0[1-9]\d{9}$/.test(normalizePhone(value))
}

export function isValidPostalCode(value: unknown): boolean {
  const postalCode = normalizePostalCode(value)
  return /^\d{10}$/.test(postalCode) && !/^(\d)\1{9}$/.test(postalCode)
}

export function customerContactComplete(phone: unknown, postalCode: unknown): boolean {
  return isValidCustomerPhone(phone) && isValidPostalCode(postalCode)
}
