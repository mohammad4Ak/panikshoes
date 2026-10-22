import { ApiInputError } from './api-input'

const digits = '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩'

/** Product codes are identifiers: keep leading zeroes and never convert to Number. */
export function normalizeProductCode(value: string): string {
  return value.trim().replace(/[۰-۹٠-٩]/g, digit => String(digits.indexOf(digit) % 10)).toUpperCase()
}

export function productCodeField(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiInputError('کد محصول را وارد کنید')
  // Check the original alphabet before uppercasing; e.g. ß must not become SS.
  if (!/^[A-Za-z0-9۰-۹٠-٩._-]{1,64}$/.test(value.trim())) {
    throw new ApiInputError('کد محصول باید حداکثر ۶۴ نویسه و شامل حروف انگلیسی، عدد، خط تیره، زیرخط یا نقطه باشد')
  }
  return normalizeProductCode(value)
}

/** Do not misreport slug or another model's uniqueness violation as a code collision. */
export function isProductCodeConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') return false
  const meta = 'meta' in error && error.meta && typeof error.meta === 'object' ? error.meta as Record<string, unknown> : null
  if (meta?.modelName !== undefined && meta.modelName !== 'Product') return false
  const target = meta?.target
  const targets = Array.isArray(target) ? target : [target]
  return targets.some(field => typeof field === 'string' && ['code', 'upper(code)', 'Product_code_key', 'Product_code_upper_key'].includes(field))
}
