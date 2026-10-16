'use client'

import { useEffect, useRef, type InputHTMLAttributes } from 'react'
import { caretAfterDigits, formatIntegerInput, integerInputError, parseIntegerInput, toAsciiDigits } from '@/lib/localized-input'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: string
  onValueChange: (value: string) => void
  grouping?: boolean
  min?: number | string
  max?: number | string
}

export default function FormattedNumberInput({ value, onValueChange, grouping = true, min, max, required = false, onKeyDown, onInvalid, style, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const formatError = useRef('')
  useEffect(() => { formatError.current = ''; input.current?.setCustomValidity(integerInputError(value, required, min, max)) }, [value, required, min, max])

  return <input {...props} ref={input} type="text" lang="fa" dir="ltr" inputMode="numeric" autoComplete="off" required={required}
    value={formatIntegerInput(value, grouping)} style={{ fontVariantNumeric: 'tabular-nums', ...style }}
    onInvalid={event => {
      event.currentTarget.setCustomValidity(formatError.current || integerInputError(value, required, min, max))
      onInvalid?.(event)
    }}
    onKeyDown={event => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      const field = event.currentTarget, caret = field.selectionStart
      if (caret === null || caret !== field.selectionEnd) return
      // A separator must not trap Backspace/Delete by being immediately reinserted.
      if (event.key === 'Backspace' && field.value[caret - 1] === '٬') field.setSelectionRange(caret - 1, caret - 1)
      if (event.key === 'Delete' && field.value[caret] === '٬') field.setSelectionRange(caret + 1, caret + 1)
    }}
    onChange={event => {
      const field = event.currentTarget, raw = parseIntegerInput(field.value)
      if (raw === null) { formatError.current = 'فقط عدد صحیح و نامنفی وارد کنید.'; field.setCustomValidity(formatError.current); return }
      formatError.current = ''
      const digitsBeforeCaret = toAsciiDigits(field.value.slice(0, field.selectionStart ?? field.value.length)).replace(/\D/g, '').length
      field.setCustomValidity(integerInputError(raw, required, min, max))
      onValueChange(raw)
      queueMicrotask(() => {
        if (!input.current || document.activeElement !== input.current) return
        const caret = caretAfterDigits(input.current.value, digitsBeforeCaret)
        input.current.setSelectionRange(caret, caret)
      })
    }} />
}
