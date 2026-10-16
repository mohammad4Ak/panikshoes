import DateObject from 'react-date-object'
import gregorian from 'react-date-object/calendars/gregorian'
import persian from 'react-date-object/calendars/persian'
import gregorianEn from 'react-date-object/locales/gregorian_en'
import persianFa from 'react-date-object/locales/persian_fa'

/** Calendar-only values stay as local civil dates, without a UTC conversion. */
export function readGregorianInput(value: string, includeTime = false): DateObject | null {
  if (!(includeTime ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)) return null
  const format = includeTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'
  const text = value.replace('T', ' ')
  const date = new DateObject({ date: text, format, calendar: gregorian, locale: gregorianEn })
  if (!date.isValid || date.format(format) !== text) return null
  return date.convert(persian, persianFa)
}

export function gregorianInput(date: DateObject): string {
  return new DateObject(date).convert(gregorian, gregorianEn).format('YYYY-MM-DD')
}

export function persianInputLabel(value: string, includeTime = false): string {
  return readGregorianInput(value, includeTime)?.format(includeTime ? 'YYYY/MM/DD ـ HH:mm' : 'YYYY/MM/DD') ?? ''
}

export function changeCalendarDay(date: DateObject, previous: string, includeTime: boolean): string {
  return gregorianInput(date) + (includeTime ? `T${readGregorianInput(previous, true) ? previous.slice(11) : '00:00'}` : '')
}
