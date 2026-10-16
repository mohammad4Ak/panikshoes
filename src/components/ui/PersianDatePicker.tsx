'use client'

import { useId, useRef } from 'react'
import DatePicker, { type DatePickerRef } from 'react-multi-date-picker'
import DateObject from 'react-date-object'
import persian from 'react-date-object/calendars/persian'
import persianFa from 'react-date-object/locales/persian_fa'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { changeCalendarDay, persianInputLabel, readGregorianInput } from '@/lib/persian-date-input'
import { formatIntegerInput } from '@/lib/localized-input'
import EnhancedSelect from '@/components/ui/EnhancedSelect'
import styles from './persian-date-picker.module.css'

interface Props {
  value: string
  onChange: (value: string) => void
  includeTime?: boolean
  id?: string
  disabled?: boolean
  required?: boolean
  min?: string
  max?: string
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export default function PersianDatePicker({ value, onChange, includeTime = false, id, disabled = false, required = false, min, max, className = '', 'aria-label': label, 'aria-describedby': describedBy }: Props) {
  const generatedId = useId()
  const fieldId = id ?? `persian-date-${generatedId}`
  const picker = useRef<DatePickerRef>(null)
  const date = readGregorianInput(value, includeTime)
  const time = date ? value.slice(11) : '00:00'
  const minimum = min ? readGregorianInput(min.slice(0, 10)) ?? undefined : undefined
  const maximum = max ? readGregorianInput(max.slice(0, 10)) ?? undefined : undefined

  return <div className={styles.field} dir="rtl" lang="fa">
    <DatePicker ref={picker} value={date} calendar={persian} locale={persianFa} format="YYYY/MM/DD"
      disabled={disabled} editable={false} calendarPosition="bottom-right" portal zIndex={160} arrow={false}
      minDate={minimum} maxDate={maximum} className={styles.calendar} containerClassName={styles.container}
      onOpen={() => { if (disabled) return false }}
      onChange={selected => {
        if (disabled) return
        if (selected instanceof DateObject && selected.isValid) onChange(changeCalendarDay(selected, value, includeTime))
      }}
      renderButton={(direction: string, handleClick: () => void, isDisabled: boolean) => <button type="button" className={styles.monthButton} onClick={handleClick} disabled={isDisabled} aria-label={direction === 'right' ? 'ماه بعد' : 'ماه قبل'}>{direction === 'right' ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button>}
      mapDays={({ date: day }) => ({ 'aria-label': day.format('dddd D MMMM YYYY') })}
      render={(_display: string, openCalendar: () => void) => <div className={styles.inputWrap}>
        <input id={fieldId} type="text" dir="ltr" readOnly required={required} disabled={disabled} value={persianInputLabel(value, includeTime)}
          placeholder={includeTime ? 'انتخاب تاریخ و ساعت' : 'انتخاب تاریخ شمسی'}
          aria-label={label} aria-describedby={describedBy} aria-haspopup="dialog"
          className={`${styles.input} ${className}`} onClick={openCalendar}
          onKeyDown={event => {
            if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); openCalendar() }
            if (event.key === 'Escape') picker.current?.closeCalendar()
            if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (!disabled) onChange('') }
          }} />
        <CalendarDays size={17} className={styles.icon} aria-hidden="true" />
        {value && <button type="button" className={styles.clear} disabled={disabled} aria-label={`پاک کردن ${label ?? 'تاریخ'}`} onClick={() => { picker.current?.closeCalendar(); onChange('') }}><X size={15} /></button>}
      </div>} />
    {includeTime && <div className={styles.time} aria-label="ساعت انتخاب‌شده">
      <span>ساعت</span>
      <EnhancedSelect nativeAppearance small aria-label={`ساعت ${label ?? 'تاریخ'}`} disabled={disabled || !date} value={time.slice(0, 2)} onChange={event => onChange(`${value.slice(0, 10)}T${event.target.value}:${time.slice(3)}`)}>
        {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={String(hour).padStart(2, '0')}>{formatIntegerInput(String(hour), false).padStart(2, '۰')}</option>)}
      </EnhancedSelect><span aria-hidden="true">:</span>
      <EnhancedSelect nativeAppearance small aria-label={`دقیقه ${label ?? 'تاریخ'}`} disabled={disabled || !date} value={time.slice(3)} onChange={event => onChange(`${value.slice(0, 10)}T${time.slice(0, 2)}:${event.target.value}`)}>
        {Array.from({ length: 60 }, (_, minute) => <option key={minute} value={String(minute).padStart(2, '0')}>{formatIntegerInput(String(minute), false).padStart(2, '۰')}</option>)}
      </EnhancedSelect>
    </div>}
  </div>
}
