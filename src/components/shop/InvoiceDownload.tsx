'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { formatInvoiceNumber, type InvoiceMetadata } from '@/lib/invoice'
import styles from './invoice-download.module.css'

interface InvoiceDownloadProps {
  orderId: string
  status: string
  invoice?: InvoiceMetadata | null
}

function DocumentMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 3.5h7l4 4v13h-11v-17Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M13.5 3.5v4h4M9 11h6M9 14h6M9 17h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function InvoiceDownload({ orderId, status, invoice }: InvoiceDownloadProps) {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const labelId = useId()
  const errorId = useId()

  useEffect(() => () => { request.current?.abort() }, [])

  const downloadInvoice = async () => {
    if (!invoice || request.current) return
    const controller = new AbortController()
    request.current = controller
    setError('')
    setDownloading(true)

    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/invoice`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (response.status === 401) throw new Error('برای دریافت فاکتور، دوباره وارد حساب کاربری شو.')
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(typeof data?.error === 'string' ? data.error : 'فاکتور دریافت نشد. دوباره تلاش کن.')
      }
      const data = await response.json().catch(() => null)
      if (controller.signal.aborted) return
      if (typeof data?.pdf !== 'string') throw new Error('فایل دریافتی فاکتور معتبر نیست. دوباره تلاش کن.')
      let decoded: string
      try {
        decoded = atob(data.pdf)
      } catch {
        throw new Error('فایل دریافتی فاکتور معتبر نیست. دوباره تلاش کن.')
      }
      if (decoded.length === 0) throw new Error('فایل فاکتور خالی است. دوباره تلاش کن.')
      if (!decoded.startsWith('%PDF-')) throw new Error('فایل دریافتی فاکتور معتبر نیست. دوباره تلاش کن.')

      const file = new Blob([Uint8Array.from(decoded, (character) => character.charCodeAt(0))], { type: 'application/pdf' })
      const objectUrl = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = `Katuni-${formatInvoiceNumber(invoice)}.pdf`
      try {
        document.body.appendChild(link)
        link.click()
      } finally {
        link.remove()
        // Give the browser time to start saving before releasing the PDF.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && cause.name !== 'TypeError' ? cause.message : 'خطای ارتباط با سرور؛ دوباره تلاش کن.')
      }
    } finally {
      request.current = null
      if (!controller.signal.aborted) setDownloading(false)
    }
  }

  if (!invoice) {
    return (
      <p className={styles.pending}>
        <DocumentMark />
        {status === 'CANCELLED' ? 'برای این سفارش لغوشده فاکتوری صادر نشده است.' : 'فاکتور پس از تأیید سفارش صادر می‌شود.'}
      </p>
    )
  }

  const number = formatInvoiceNumber(invoice)

  return (
    <section className={styles.panel} aria-labelledby={labelId}>
      <div className={styles.row}>
        <span className={styles.mark}><DocumentMark /></span>
        <div className={styles.details}>
          <h3 id={labelId}>فاکتور سفارش</h3>
          <p>شماره <bdi className={styles.number}>{number}</bdi><span className={styles.separator} aria-hidden="true">·</span><time dateTime={new Date(invoice.issuedAt).toISOString()}>{new Date(invoice.issuedAt).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })}</time></p>
        </div>
        <button
          type="button"
          className={styles.download}
          onClick={() => void downloadInvoice()}
          disabled={downloading}
          aria-busy={downloading}
          aria-describedby={error ? errorId : undefined}
          aria-label={`دریافت فاکتور ${number} به صورت PDF`}
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v9m-3-3 3 3 3-3M4 13v3h12v-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {downloading ? 'در حال دریافت…' : 'دریافت فاکتور'}
          {!downloading && <span className={styles.pdf}>PDF</span>}
        </button>
      </div>
      {status === 'CANCELLED' && <p className={styles.cancelled}>این سفارش لغو شده است؛ فاکتور برای حفظ سابقه در دسترس است.</p>}
      {error && <p id={errorId} className={styles.error} role="alert">{error}</p>}
    </section>
  )
}
