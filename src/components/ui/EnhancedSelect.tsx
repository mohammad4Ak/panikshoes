import type { ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './enhanced-select.module.css'

type EnhancedSelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  icon?: ReactNode
  compact?: boolean
  wrapperClassName?: string
}

// Retain the browser's keyboard and mobile picker behavior while sharing a themed control.
export default function EnhancedSelect({ icon, compact = false, wrapperClassName = '', className = '', children, ...props }: EnhancedSelectProps) {
  return (
    <span className={[styles.control, compact ? styles.compact : '', icon ? styles.hasIcon : '', wrapperClassName].filter(Boolean).join(' ')}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <select {...props} className={[styles.select, className].filter(Boolean).join(' ')}>{children}</select>
      <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
    </span>
  )
}
