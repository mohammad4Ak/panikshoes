import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string }

function IconFrame({ size = 24, children, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 48 48"
      fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  )
}

/** A hiking mid-boot with a padded collar, support panels and a lugged outsole. */
export function SneakerIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M7.6 12.1c3.6 1.6 6.6 1.2 9.5-1.3l2.5-1.9c1.1-.8 2.2-.2 2.5 1.2l1.7 8.4c1.1 4.7 4.4 7.6 9.8 9l5.7 1.3c2.8.7 4.5 2.3 4.6 4.4-12.2 2.7-25.7 2.6-38.1.2-.5-2.9.1-6.1.7-9.6l-.3-9.9c0-1.3.4-2.3 1.4-1.8Z" fill="currentColor" fillOpacity=".08" />
      <path d="m9.4 20.2 3.4-1.7 11.1 15.8-6.1-.2-8.4-11.9v-2Z" fill="currentColor" fillOpacity=".14" stroke="none" />
      <path d="M33.6 27.5c-1.5 1.6-2.2 3.8-2.3 7.1l12.6-1.4c-.1-2.1-1.8-3.7-4.6-4.4l-5.7-1.3Z" fill="currentColor" fillOpacity=".2" stroke="none" />
      <path d="M7.1 16.2c4.5 1.8 9.7.7 14.6-3.7m-12.3 7.7 3.4-1.7 11.1 15.8m-8.2-8.1 4.4-3.4 9.6 11.7M6.6 25.8l3.6-.7c1.1-.2 1.8.2 2.4 1.2l4.6 7.9M33.6 27.5c-1.5 1.6-2.2 3.8-2.3 7.1" />
      <path d="m18.3 16.4 4.2-1.4m-2.8 5.2 4.2-1.4m-1.5 5.1 4.2-1.4" strokeWidth="2.1" />
      <path d="M5.8 33.4c12.4 2.4 25.9 2.5 38.1-.2v2.2c0 1.4-.9 2.5-2.3 2.9l-2.4.5-.6 1h-3.3l-.5-.7-4.1.3-.6 1h-3.4l-.5-1h-3.6l-.5 1h-3.5l-.6-1-3.9-.3-.5.9h-3.4l-.6-1.3-2.1-.3c-1.2-.2-2.1-1.3-2.1-2.5v-2.5Z" fill="currentColor" fillOpacity=".18" />
    </IconFrame>
  )
}

/** Two offset conversation cards with a clear foreground message. */
export function ConversationIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M15 9h21a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-2" opacity=".45" />
      <path d="M7 17a5 5 0 0 1 5-5h17a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H18l-7 4v-4a4 4 0 0 1-4-4V17Z" fill="currentColor" fillOpacity=".09" />
      <path d="M14 21h13m-13 6h9" strokeWidth="2.4" />
    </IconFrame>
  )
}

type PaymentStatus = 'success' | 'failed' | 'pending' | 'unknown'

/** A transaction slip with a contrasting, legible outcome seal. */
export function PaymentStatusIcon({ status, ...props }: IconProps & { status: PaymentStatus }) {
  return (
    <IconFrame {...props}>
      <g transform="rotate(-6 23 24)">
        <path d="M14 6h17a4 4 0 0 1 4 4v29l-4-2.5-4 2.5-4-2.5-4 2.5-4-2.5-4 2.5V10a4 4 0 0 1 4-4Z" fill="currentColor" fillOpacity=".07" strokeOpacity=".55" />
        <path d="M17 14h11m-11 5h7" opacity=".65" />
        <rect x="16.5" y="24" width="11" height="3" rx="1.5" fill="currentColor" stroke="none" fillOpacity=".25" />
      </g>
      <circle cx="34" cy="33" r="10.5" fill="currentColor" stroke="none" />
      <g stroke="white" strokeWidth="2.1">
        {status === 'success' && <path d="m29.3 33 3.1 3.2 6.3-6.4" />}
        {status === 'failed' && <path d="m30.7 29.7 6.6 6.6m0-6.6-6.6 6.6" />}
        {status === 'pending' && <><circle cx="34" cy="33" r="5.2" strokeWidth="1.5" /><path d="M34 29.7V33l2.4 1.4" strokeWidth="1.7" /></>}
        {status === 'unknown' && <><path d="M34 32.5v4" /><circle cx="34" cy="29.3" r="1" fill="white" stroke="none" /></>}
      </g>
    </IconFrame>
  )
}
