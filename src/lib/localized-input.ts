const persianDigits = '۰۱۲۳۴۵۶۷۸۹'
const arabicDigits = '٠١٢٣٤٥٦٧٨٩'

export function toAsciiDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, digit => String(Math.max(persianDigits.indexOf(digit), arabicDigits.indexOf(digit))))
}

export function parseIntegerInput(value: string): string | null {
  const clean = toAsciiDigits(value).replace(/[٬,\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
  if (!/^\d*$/.test(clean)) return null
  return clean.replace(/^0+(?=\d)/, '')
}

export function formatIntegerInput(value: string, grouping = true): string {
  const raw = parseIntegerInput(value)
  if (raw === null || raw === '') return ''
  return (grouping ? raw.replace(/\B(?=(\d{3})+(?!\d))/g, '٬') : raw).replace(/\d/g, digit => persianDigits[Number(digit)])
}

export function integerInputError(value: string, required: boolean, min?: number | string, max?: number | string): string {
  if (value === '') return required ? 'این عدد را وارد کنید.' : ''
  if (!/^\d+$/.test(value)) return 'فقط عدد صحیح و نامنفی وارد کنید.'
  const amount = BigInt(value)
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return 'عدد واردشده بیش از حد بزرگ است.'
  if (min !== undefined && amount < BigInt(min)) return `عدد باید حداقل ${formatIntegerInput(String(min))} باشد.`
  if (max !== undefined && amount > BigInt(max)) return `عدد نباید بیشتر از ${formatIntegerInput(String(max))} باشد.`
  return ''
}

/** Preserve the logical caret position when grouping separators are inserted. */
export function caretAfterDigits(formatted: string, digitsBeforeCaret: number): number {
  if (digitsBeforeCaret <= 0) return 0
  let count = 0
  for (let index = 0; index < formatted.length; index++) {
    if (/[0-9۰-۹٠-٩]/.test(formatted[index]) && ++count === digitsBeforeCaret) return index + 1
  }
  return formatted.length
}
