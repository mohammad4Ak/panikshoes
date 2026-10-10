'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, Check, Star } from 'lucide-react'
import { useAppSession } from '@/components/auth/SessionActivityProvider'
import { formatPrice } from '@/lib/utils'
import styles from './product-engagement.module.css'

interface Review {
  id: string
  rating: number
  comment: string
  authorName: string
  verifiedBuyer: boolean
  createdAt: string
}

interface MyReview {
  id: string
  rating: number
  comment: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  moderationNote?: string | null
}

interface ReviewsResponse {
  reviews: Review[]
  total: number
  page: number
  pageSize: number
  summary: { average: number; count: number; distribution: { rating: number; count: number }[] }
  myReview: MyReview | null
}

const ratingLabels = ['ضعیف', 'متوسط', 'خوب', 'خیلی خوب', 'عالی']
const reviewDate = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tehran' })
const averageNumber = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 })

function Stars({ rating }: { rating: number }) {
  return <span className={styles.stars} role="img" aria-label={`امتیاز ${averageNumber.format(rating)} از ۵`}>
    {[1, 2, 3, 4, 5].map((value) => <span key={value} className={styles.starGlyph} aria-hidden="true"><Star size={16} /><span className={styles.starFill} style={{ width: `${Math.min(1, Math.max(0, rating - value + 1)) * 100}%` }}><Star size={16} /></span></span>)}
  </span>
}

function ReviewForm({ productId, myReview, onSaved }: { productId: string; myReview: MyReview | null; onSaved: () => void }) {
  const formId = useId()
  const [rating, setRating] = useState(myReview?.rating ?? 0)
  const [comment, setComment] = useState(myReview?.comment ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const submission = useRef<AbortController | null>(null)

  useEffect(() => () => submission.current?.abort(), [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submission.current) return
    setError('')
    setSubmitted(false)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      setError('اول امتیازت را از ۱ تا ۵ انتخاب کن.')
      return
    }
    if (comment.trim().length > 2000) {
      setError('متن نظر باید حداکثر ۲۰۰۰ نویسه باشد.')
      return
    }
    const controller = new AbortController()
    submission.current = controller
    setSaving(true)
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(productId)}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment: comment.trim() }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : response.status === 401 ? 'برای ثبت نظر، دوباره وارد حسابت شو.' : 'نظر ثبت نشد. دوباره تلاش کن.')
      }
      if (controller.signal.aborted) return
      setSubmitted(true)
      onSaved()
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'ارتباط با سرور برقرار نشد. دوباره تلاش کن.')
    } finally {
      if (submission.current === controller) {
        submission.current = null
        if (!controller.signal.aborted) setSaving(false)
      }
    }
  }

  const status = submitted ? 'PENDING' : myReview?.status
  return <form className={styles.reviewForm} onSubmit={handleSubmit} aria-busy={saving}>
    <div className={styles.formHeading}>
      <h3>{myReview ? 'نظر و امتیاز تو' : 'این مدل را چطور می‌بینی؟'}</h3>
      <p>امتیازت را انتخاب کن؛ اگر دوست داشتی، تجربه‌ات را هم بنویس.</p>
    </div>
    {status && <div className={`${styles.reviewStatus} ${status === 'REJECTED' ? styles.rejectedStatus : ''}`} role="status">
      {status === 'PENDING' ? 'نظر و امتیازت ثبت شده و در انتظار تأیید مدیر است.' : status === 'APPROVED' ? 'نظر و امتیازت تأیید شده و در سایت نمایش داده می‌شود.' : 'نظر قبلی تأیید نشد. می‌توانی آن را ویرایش و دوباره ارسال کنی.'}
      {!submitted && status === 'REJECTED' && myReview?.moderationNote && <p>توضیح مدیر: {myReview.moderationNote}</p>}
    </div>}
    <fieldset disabled={saving} className={styles.ratingField}>
      <legend>امتیاز تو به این کفش</legend>
      <div className={styles.ratingChoice}>
        {[1, 2, 3, 4, 5].map((value) => <label key={value} className={value <= rating ? styles.ratingChosen : ''} title={`${formatPrice(value)} از ۵ — ${ratingLabels[value - 1]}`}>
          <input type="radio" name={`rating-${formId}`} value={value} checked={rating === value} onChange={() => { setRating(value); setSubmitted(false) }} aria-label={`${formatPrice(value)} از ۵ — ${ratingLabels[value - 1]}`} required />
          <Star size={25} aria-hidden="true" />
        </label>)}
      </div>
      <span className={styles.ratingHint} aria-live="polite">{rating ? `${formatPrice(rating)} از ۵ · ${ratingLabels[rating - 1]}` : 'یک امتیاز انتخاب کن'}</span>
    </fieldset>
    <label className={styles.commentLabel} htmlFor={`comment-${formId}`}>نظرت دربارهٔ این کفش <span>(اختیاری)</span></label>
    <textarea id={`comment-${formId}`} value={comment} onChange={(event) => { setComment(event.target.value); setSubmitted(false) }} maxLength={2000} rows={4} disabled={saving} placeholder="دربارهٔ سایز، کیفیت یا تجربهٔ پوشیدن این مدل بنویس…" aria-describedby={`comment-help-${formId}`} />
    <div className={styles.formHelp} id={`comment-help-${formId}`}><span>نظر و امتیاز پس از تأیید مدیر منتشر می‌شوند.</span><span>{formatPrice(comment.length)} / ۲٬۰۰۰</span></div>
    {myReview?.status === 'APPROVED' && !submitted && <p className={styles.editNote}>با ویرایش، نظر و امتیاز قبلی تا تأیید دوباره از نمایش عمومی خارج می‌شوند.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'در حال ثبت…' : myReview ? 'ارسال ویرایش نظر' : 'ثبت نظر و امتیاز'}<ArrowLeft size={17} aria-hidden="true" /></button>
  </form>
}

export default function ProductReviews({ productId, slug, initialAverage = 0, initialCount = 0, onSummaryChange }: { productId: string; slug?: string; initialAverage?: number; initialCount?: number; onSummaryChange?: (summary: { average: number; count: number }) => void }) {
  const { session } = useAppSession()
  const userId = session?.user.id
  const loginHref = slug ? `/login?callbackUrl=${encodeURIComponent(`/products/${encodeURIComponent(slug)}#product-reviews`)}` : '/login'
  const scope = `${productId}:${userId ?? 'guest'}`
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [report, setReport] = useState<{ scope: string; data: ReviewsResponse } | null>(null)
  const requestKey = `${scope}:${page}:${revision}`
  const [settled, setSettled] = useState<{ key: string; error: string } | null>(null)
  const loading = settled?.key !== requestKey
  const error = settled?.key === requestKey ? settled.error : ''
  const visibleReport = report?.scope === scope ? report.data : null

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/products/${encodeURIComponent(productId)}/reviews?page=${page}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('دریافت نظرات انجام نشد. دوباره تلاش کن.')
        const data: ReviewsResponse = await response.json()
        if (!Array.isArray(data.reviews) || !data.summary || !Array.isArray(data.summary.distribution) || !Number.isFinite(data.summary.count) || !Number.isFinite(data.summary.average) || !Number.isFinite(data.total) || !(data.pageSize > 0)) {
          throw new Error('دریافت نظرات انجام نشد. دوباره تلاش کن.')
        }
        if (!controller.signal.aborted) {
          setReport({ scope, data })
          onSummaryChange?.(data.summary)
          const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize))
          if (page > lastPage) setPage(lastPage)
          setSettled({ key: requestKey, error: '' })
        }
      })
      .catch(() => { if (!controller.signal.aborted) setSettled({ key: requestKey, error: 'نظرات فعلاً در دسترس نیستند. دوباره تلاش کن.' }) })
    return () => controller.abort()
  }, [productId, scope, page, requestKey, onSummaryChange])

  const summary = visibleReport?.summary ?? { average: initialAverage, count: initialCount, distribution: [] }
  const pages = visibleReport ? Math.max(1, Math.ceil(visibleReport.total / visibleReport.pageSize)) : 1
  const reviews = visibleReport?.page === page ? visibleReport.reviews : []
  const onSaved = () => { setPage(1); setRevision((current) => current + 1) }

  return <section id="product-reviews" className={styles.engagementSection} aria-labelledby="product-reviews-title">
    <header className={styles.sectionHeading}><div><span className={styles.eyebrow}>از نگاه شما</span><h2 id="product-reviews-title">امتیاز و نظرات کاربران</h2></div><span className={styles.sectionCount}>{formatPrice(summary.count)} امتیاز تأییدشده</span></header>
    <div className={styles.reviewsGrid}>
      <aside className={styles.reviewSidebar}>
        <div className={styles.ratingSummary}>
          <div className={styles.average}><strong>{summary.count ? averageNumber.format(summary.average) : '—'}</strong><span>از ۵</span></div>
          <Stars rating={summary.average} />
          <p>{summary.count ? `بر اساس ${formatPrice(summary.count)} امتیاز تأییدشده` : 'هنوز امتیازی ثبت نشده'}</p>
          <div className={styles.distribution}>
            {[5, 4, 3, 2, 1].map((rating) => {
              const count = summary.distribution.find((item) => item.rating === rating)?.count ?? 0
              return <div key={rating} aria-label={`${formatPrice(rating)} ستاره: ${formatPrice(count)} امتیاز`}><span>{formatPrice(rating)}<Star size={12} aria-hidden="true" /></span><span className={styles.distributionTrack} aria-hidden="true"><i style={{ width: `${summary.count ? Math.min(100, count / summary.count * 100) : 0}%` }} /></span><span>{formatPrice(count)}</span></div>
            })}
          </div>
        </div>
        {userId && visibleReport ? <ReviewForm key={`${scope}:${visibleReport.myReview?.id ?? 'new'}`} productId={productId} myReview={visibleReport.myReview} onSaved={onSaved} /> : !userId ? <div className={styles.loginPrompt}><h3>نوبت تجربهٔ توست</h3><p>برای ثبت نظر و امتیاز، وارد حسابت شو.</p><Link href={loginHref} className="btn-outline">ورود به حساب<ArrowLeft size={16} aria-hidden="true" /></Link></div> : null}
      </aside>
      <div className={styles.reviewList} aria-busy={loading}>
        {error && <div className={styles.loadError} role="alert"><p>{error}</p><button type="button" onClick={() => setRevision((current) => current + 1)} className="btn-outline">تلاش دوباره</button></div>}
        {loading && <p className={styles.loading} role="status">در حال دریافت نظرات…</p>}
        {!loading && !error && reviews.length === 0 && <div className={styles.noReviews}><span className={styles.emptyStars} aria-hidden="true"><Star size={29} /></span><h3>اولین تجربه را تو بنویس</h3><p>هنوز نظری برای این کفش منتشر نشده. نظرت می‌تواند به انتخاب دیگران کمک کند.</p></div>}
        {reviews.map((review) => {
          const date = new Date(review.createdAt)
          return <article key={review.id} className={styles.review}>
            <div className={styles.reviewHeader}><div className={styles.author}><span className={styles.avatar} aria-hidden="true">{Array.from(review.authorName || 'کاربر')[0]}</span><div><h3>{review.authorName || 'کاربر فروشگاه'}</h3>{review.verifiedBuyer && <span className={styles.buyerBadge}><Check size={12} aria-hidden="true" />خریدار این محصول</span>}</div></div>{Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()}>{reviewDate.format(date)}</time>}</div>
            <Stars rating={review.rating} />
            {review.comment ? <p className={styles.reviewComment}>{review.comment}</p> : <p className={styles.ratingOnly}>فقط امتیاز ثبت کرده است.</p>}
          </article>
        })}
        {pages > 1 && <nav className={styles.pagination} aria-label="صفحه‌های نظرات"><button type="button" className="btn-outline" aria-label="صفحهٔ قبل نظرات" disabled={loading || page <= 1} onClick={() => setPage((current) => current - 1)}><ArrowRight size={16} aria-hidden="true" />قبل</button><span>صفحهٔ {formatPrice(page)} از {formatPrice(pages)}</span><button type="button" className="btn-outline" aria-label="صفحهٔ بعد نظرات" disabled={loading || page >= pages} onClick={() => setPage((current) => current + 1)}>بعد<ArrowLeft size={16} aria-hidden="true" /></button></nav>}
      </div>
    </div>
  </section>
}
