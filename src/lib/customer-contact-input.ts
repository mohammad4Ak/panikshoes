import { ApiInputError } from './api-input'
import { isValidCustomerPhone, isValidPostalCode, normalizePhone, normalizePostalCode } from './customer-contact'

export function customerPhoneField(value: unknown, optional = false): string | null {
  if (optional && (value === null || (typeof value === 'string' && !value.trim()))) return null
  if (!isValidCustomerPhone(value)) throw new ApiInputError('شماره تلفن باید یک شمارهٔ معتبر ۱۱ رقمی ایران باشد')
  return normalizePhone(value)
}

export function customerPostalCodeField(value: unknown, optional = false): string | null {
  if (optional && (value === null || (typeof value === 'string' && !value.trim()))) return null
  if (!isValidPostalCode(value)) throw new ApiInputError('کدپستی باید ۱۰ رقم معتبر باشد')
  return normalizePostalCode(value)
}
