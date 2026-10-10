import type { SVGProps } from 'react'

type MarkProps = SVGProps<SVGSVGElement> & {
  size?: number | string
  variant?: 'dark' | 'light' | 'mono'
}

/** Original mark inspired by the reference shoe's floating sole and flowing side panel. */
export default function ShoeLandMark({ size = 48, variant = 'dark', ...props }: MarkProps) {
  const upper = variant === 'mono' ? 'currentColor' : variant === 'light' ? '#ecfaf7' : '#183d48'
  const sole = variant === 'mono' ? 'currentColor' : '#21d6bd'
  const contour = variant === 'mono' ? 'white' : variant === 'light' ? '#183d48' : '#7aeee0'

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 80 80"
      fill="none" aria-hidden="true" focusable="false" {...props}>
      <g transform="rotate(25 40 40)">
        <path d="M9 41c5 4.9 12.7 7.5 23.7 8.5l30.7 2.8c4.7.4 7.1-1.1 8.6-4.8l.8-2.4-63.1-7.5L9 41Z" fill={sole} />
        <path d="M8.6 35.5c.5-8.2 7.1-13 17.3-13.1l14.8.7c3.8.2 6.6 1.8 8.1 5.2l2.9 6.7c1.3 3 4 4.1 7.1 3l8.4-3.2c2.5-.9 4.5.5 4.8 3.1l.8 7.7c-1.6 4-4.8 4.5-9.4 4l-31.2-3.3C20 45 11.8 42.6 8.6 38.9v-3.4Z" fill={upper} />
        <path d="M24.6 29.1c-4.1-.2-6.1 2.2-4.1 4.6 2.2 2.6 9.9 2.9 14.4 4.6 4.1 1.6 5.6 4.5 8.9 5 2.8.4 4.2-2 2.4-5.4l-3.5-6.1c-1.2-2-2.7-2.5-5.8-2.7H24.6Z" stroke={contour} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m56.4 43.1 8.1-2.8" stroke={contour} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M12.3 41.9c8.8 5.3 22.3 5.9 38.2 7.4" stroke={variant === 'mono' ? 'white' : '#087d78'} strokeWidth="1.7" strokeLinecap="round" opacity=".6" />
      </g>
    </svg>
  )
}
