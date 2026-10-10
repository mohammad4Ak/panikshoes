import type { SVGProps } from 'react'

type MarkProps = SVGProps<SVGSVGElement> & {
  size?: number | string
  variant?: 'dark' | 'light' | 'mono'
}

/** Compact version of the open P in the PANIK wordmark. */
export default function PanikMark({ size = 48, variant = 'dark', ...props }: MarkProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 80 80"
      fill={variant === 'mono' ? 'currentColor' : variant === 'light' ? '#ffffff' : '#111713'}
      aria-hidden="true" focusable="false" {...props}>
      <path d="M16 12h26c16 0 28 11 28 26S58 63 42 63H31c5-7 13-6 19-12 4-3 7-7 7-13 0-9-7-15-16-15H16V12Zm0 19h12v39H16V31Z" />
    </svg>
  )
}
