'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SelectHTMLAttributes, type SyntheticEvent } from 'react'
import * as Select from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { selectedOption, selectMenuValue, selectOptions } from '@/lib/select-options'
import styles from './enhanced-select.module.css'

type EnhancedSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  icon?: ReactNode
  compact?: boolean
  wrapperClassName?: string
  nativeAppearance?: boolean
  small?: boolean
}

export const desktopSelectQuery = '(min-width: 768px) and (hover: hover) and (pointer: fine)'
function subscribeDesktop(callback: () => void) {
  const media = window.matchMedia(desktopSelectQuery)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}
const desktopSnapshot = () => window.matchMedia(desktopSelectQuery).matches
const nativeSnapshot = () => false

export default function EnhancedSelect({ icon, compact = false, small = false, nativeAppearance = false, wrapperClassName = '', className = '', children, value, defaultValue, onChange, onInvalid, onFocus, onBlur, onKeyDown, onKeyUp, onClick, autoFocus, ...props }: EnhancedSelectProps) {
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, nativeSnapshot) && !props.multiple && !(props.size && props.size > 1)
  const options = selectOptions(children)
  const controlled = value !== undefined
  const initialValue = String(defaultValue ?? options.find(option => !option.disabled)?.value ?? '')
  const [localValue, setLocalValue] = useState(initialValue)
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [fieldsetDisabled, setFieldsetDisabled] = useState(false)
  const native = useRef<HTMLSelectElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const errorId = useId()
  const selected = selectedOption(options, String(controlled ? value : localValue))
  const latest = useRef({ value: selected?.value ?? '', resetValue: selectedOption(options, initialValue)?.value ?? '', controlled })
  useLayoutEffect(() => { latest.current = { value: selected?.value ?? '', resetValue: selectedOption(options, initialValue)?.value ?? '', controlled } })
  const disabled = !!props.disabled || fieldsetDisabled
  const controlClass = [styles.control, compact && styles.compact, small && styles.small, icon && styles.hasIcon, wrapperClassName].filter(Boolean).join(' ')

  useEffect(() => {
    const field = native.current
    if (!field) return
    const syncDisabled = () => {
      const next = field.matches(':disabled')
      setFieldsetDisabled(next)
      if (next) setOpen(false)
    }
    syncDisabled()
    const observer = new MutationObserver(syncDisabled)
    for (let parent = field.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'FIELDSET') observer.observe(parent, { attributes: true, attributeFilter: ['disabled'] })
    }
    const form = field.form
    const reset = (event: Event) => setTimeout(() => {
      if (event.defaultPrevented || !native.current || native.current.form !== form) return
      setInvalid(false); setOpen(false)
      if (props.multiple) return
      const current = latest.current
      if (!current.controlled) setLocalValue(current.resetValue)
      // The browser's default reset happens after its event, even for a controlled
      // select. Restore the current/default value after that action completes.
      native.current.value = current.controlled ? current.value : current.resetValue
    }, 0)
    form?.addEventListener('reset', reset)
    return () => { observer.disconnect(); form?.removeEventListener('reset', reset) }
  }, [desktop, controlled, initialValue, props.form, props.disabled, props.multiple])

  useEffect(() => {
    // Changing input mode must dismiss an open portal, including when resizing
    // back to desktop later. It must never reopen a stale menu on its own.
    if (!desktop || disabled) setOpen(false) // eslint-disable-line react-hooks/set-state-in-effect
  }, [desktop, disabled])

  // Keep the real select authoritative for form values, validity and React change
  // events. Callers receive an actual select event, including numeric/empty values.
  const nativeControl = <select {...props} ref={native} id={desktop ? undefined : props.id}
    value={props.multiple ? value : controlled ? value : localValue} defaultValue={props.multiple ? defaultValue : undefined}
    autoFocus={!desktop && autoFocus} className={desktop ? styles.proxy : nativeAppearance ? className : [styles.select, className].filter(Boolean).join(' ')}
    tabIndex={desktop ? -1 : props.tabIndex} aria-hidden={desktop ? true : undefined}
    onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onClick={onClick}
    onChange={event => { if (!controlled) setLocalValue(event.target.value); setInvalid(false); onChange?.(event) }}
    onInvalid={event => {
      onInvalid?.(event)
      if (desktop) { event.preventDefault(); setInvalid(true); trigger.current?.focus() }
    }}>{children}</select>

  if (!desktop) {
    if (nativeAppearance || props.multiple || props.size && props.size > 1) return nativeControl
    return <span className={controlClass}>{icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}{nativeControl}<ChevronDown className={styles.chevron} size={16} aria-hidden="true" /></span>
  }

  function forwardEvent<T extends SyntheticEvent<HTMLSelectElement>>(event: SyntheticEvent<HTMLButtonElement>, callback?: (event: T) => void) {
    if (!callback || !native.current) return
    callback(Object.assign(Object.create(event), {
      target: native.current, currentTarget: native.current,
      preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(),
      isDefaultPrevented: () => event.isDefaultPrevented(), isPropagationStopped: () => event.isPropagationStopped(),
    }) as T)
  }

  const groups: { label?: string; options: typeof options }[] = []
  for (const option of options.filter(option => !option.hidden)) {
    const last = groups[groups.length - 1]
    if (last && last.label === option.group) last.options.push(option)
    else groups.push({ label: option.group, options: [option] })
  }

  return <span className={controlClass}>
    <Select.Root dir={props.dir === 'ltr' ? 'ltr' : 'rtl'} value={selectMenuValue(selected?.value ?? '')} disabled={disabled} open={open && !disabled}
      onOpenChange={next => { if (!native.current?.matches(':disabled')) setOpen(next) }}
      onValueChange={encoded => {
        const field = native.current
        if (!field || field.matches(':disabled')) return
        const next: unknown = JSON.parse(encoded)
        if (typeof next !== 'string' || !options.some(option => option.value === next && !option.disabled && !option.hidden)) return
        field.value = next
        field.dispatchEvent(new Event('change', { bubbles: true }))
      }}>
      <Select.Trigger ref={trigger} id={props.id} type="button" autoFocus={autoFocus} tabIndex={props.tabIndex}
        aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']} aria-describedby={[props['aria-describedby'], invalid && props.required && !selected?.value && errorId].filter(Boolean).join(' ') || undefined}
        aria-invalid={props['aria-invalid'] ?? (invalid && props.required && !selected?.value || undefined)} aria-required={props.required}
        title={props.title ?? selected?.label} style={props.style} className={[styles.select, styles.trigger, className].filter(Boolean).join(' ')}
        onFocus={event => forwardEvent(event, onFocus)} onBlur={event => forwardEvent(event, onBlur)}
        onKeyDown={event => forwardEvent(event, onKeyDown)} onKeyUp={event => forwardEvent(event, onKeyUp)} onClick={event => forwardEvent(event, onClick)}>
        {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
        <Select.Value className={styles.value}>{selected?.label ?? 'انتخاب کنید'}</Select.Value>
        <Select.Icon asChild><ChevronDown className={styles.chevron} size={16} aria-hidden="true" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal><Select.Content position="popper" align="start" sideOffset={8} collisionPadding={12} className={styles.content}>
        <Select.ScrollUpButton className={styles.scrollButton} aria-label="گزینه‌های بالاتر"><ChevronUp size={15} /></Select.ScrollUpButton>
        <Select.Viewport className={styles.viewport}>
          {groups.map((group, groupIndex) => <Select.Group key={groupIndex}>
            {group.label && <Select.Label className={styles.groupLabel}>{group.label}</Select.Label>}
            {group.options.map((option, index) => <Select.Item key={`${index}:${option.value}`} value={selectMenuValue(option.value)} disabled={option.disabled} textValue={option.label} className={styles.item} style={{ animationDelay: `${Math.min(index, 6) * 14}ms` }}>
              <Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className={styles.indicator}><Check size={15} strokeWidth={2.4} /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.Group>)}
        </Select.Viewport>
        <Select.ScrollDownButton className={styles.scrollButton} aria-label="گزینه‌های پایین‌تر"><ChevronDown size={15} /></Select.ScrollDownButton>
      </Select.Content></Select.Portal>
    </Select.Root>
    {nativeControl}
    {invalid && props.required && !selected?.value && <span id={errorId} role="alert" className={styles.error}>یک گزینه انتخاب کنید.</span>}
  </span>
}
