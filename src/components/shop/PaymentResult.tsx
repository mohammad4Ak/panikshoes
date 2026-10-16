import { PaymentStatusIcon } from '@/components/ui/BrandIcons'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowUpLeft,
  ChevronLeft,
  CreditCard,
  Headphones,
  Package,
  ReceiptText,
} from 'lucide-react'
import { formatPrice } from '@/lib/utils'
import styles from './payment-result.module.css'

type PaymentStatus = 'success' | 'failed' | 'pending' | 'unknown'

interface PaymentResultProps {
  status: PaymentStatus
  order?: { id: string; amount: number; createdAt: string; shippingMethodName?: string | null; shippingCost?: number; status?: string; subtotal?: number | null; productDiscount?: number; couponDiscount?: number; couponCode?: string | null }
  isPreview?: boolean
  requiresLogin?: boolean
  unavailable?: boolean
}

const resultContent = {
  success: {
    label: 'پرداخت موفق',
    title: 'پرداختت موفق بود.',
    description: 'پرداختت با موفقیت تأیید شد. جزئیات خرید و وضعیت سفارشت رو در حساب کاربری ببین.',
    primary: { label: 'مشاهده و پیگیری سفارش', href: '/profile' },
    secondary: { label: 'بازگشت به فروشگاه', href: '/products' },
    note: 'همهٔ جزئیات، یک‌جا',
    noteText: 'این سفارش در بخش «سفارش‌های من» حسابت در دسترسه.',
  },
  failed: {
    label: 'پرداخت ناموفق',
    title: 'پرداخت تکمیل نشد.',
    description: 'پرداخت این سفارش تأیید نشده است. وضعیت سفارش را در حسابت بررسی کن یا با پشتیبانی تماس بگیر.',
    primary: { label: 'بازگشت به سبد خرید', href: '/cart' },
    secondary: { label: 'تماس با پشتیبانی', href: '/contact' },
    note: 'نیاز به راهنمایی داری؟',
    noteText: 'اگر سؤالی دربارهٔ پرداخت داری، شمارهٔ سفارشت رو برای پشتیبانی بفرست.',
  },
  pending: {
    label: 'در انتظار تأیید پرداخت',
    title: 'سفارشت ثبت شد.',
    description: 'ثبت سفارش انجام شده، اما پرداخت هنوز تأیید نشده است. وضعیت سفارش را در حسابت بررسی کن.',
    primary: { label: 'مشاهدهٔ سفارش‌ها', href: '/profile' },
    secondary: { label: 'تماس با پشتیبانی', href: '/contact' },
    note: 'یک قدم تا تکمیل خرید',
    noteText: 'ثبت سفارش به‌تنهایی به معنی پرداخت موفق نیست. وضعیت پرداخت باید تأیید شود.',
  },
  unknown: {
    label: 'وضعیت پرداخت نامشخص',
    title: 'نتیجهٔ پرداخت مشخص نیست.',
    description: 'اطلاعات کافی برای نمایش نتیجهٔ این پرداخت در دسترس نیست. سفارش‌هایت را در حساب کاربری بررسی کن.',
    primary: { label: 'مشاهدهٔ سفارش‌ها', href: '/profile' },
    secondary: { label: 'تماس با پشتیبانی', href: '/contact' },
    note: 'برای بررسی، کنارت هستیم',
    noteText: 'اگر نتیجهٔ پرداخت رو پیدا نکردی، از صفحهٔ تماس با ما با پشتیبانی در ارتباط باش.',
  },
} satisfies Record<PaymentStatus, {
  label: string
  title: string
  description: string
  primary: { label: string; href: string }
  secondary: { label: string; href: string }
  note: string
  noteText: string
}>

export default function PaymentResult({ status, order, isPreview = false, requiresLogin = false, unavailable = false }: PaymentResultProps) {
  const visibleStatus = requiresLogin || unavailable ? 'unknown' : status
  const content = resultContent[visibleStatus]
  const primary = requiresLogin ? { label: 'ورود به حساب کاربری', href: '/login' } : content.primary
  const paidCancellation = visibleStatus === 'success' && order?.status === 'CANCELLED'
  const description = requiresLogin
    ? 'وارد حساب کاربری خودت شو؛ سپس از بخش «سفارش‌های من»، وضعیت سفارشت را بررسی کن.'
    : unavailable
      ? 'در حال حاضر امکان دریافت اطلاعات این پرداخت نیست. کمی بعد وضعیت سفارش را در حسابت بررسی کن یا با پشتیبانی تماس بگیر.'
      : paidCancellation
        ? 'پرداخت این سفارش قبلاً تأیید شده، اما سفارش لغو شده است. وضعیت بازگشت وجه را از پشتیبانی پیگیری کن.'
        : content.description
  const receipt = !requiresLogin && !unavailable ? order : undefined
  const orderDate = receipt ? new Date(receipt.createdAt) : undefined
  const validDate = orderDate && !Number.isNaN(orderDate.getTime()) ? orderDate : undefined

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="مسیر صفحه">
          <Link href="/">خانه</Link><ChevronLeft size={13} /><Link href="/cart">سبد خرید</Link><ChevronLeft size={13} /><span>نتیجهٔ پرداخت</span>
        </nav>

        {isPreview && (
          <aside className={styles.preview} aria-label="پیش‌نمایش طراحی">
            <div><span className={styles.previewLabel}>نسخهٔ نمایشی</span><p>این صفحه نمونهٔ طراحی است و نتیجهٔ یک پرداخت واقعی نیست.</p></div>
            <nav aria-label="حالت‌های نمایشی">
              <Link href="/payment/result?preview=success" aria-current={visibleStatus === 'success' ? 'page' : undefined}>موفق</Link>
              <Link href="/payment/result?preview=failed" aria-current={visibleStatus === 'failed' ? 'page' : undefined}>ناموفق</Link>
              <Link href="/payment/result?preview=pending" aria-current={visibleStatus === 'pending' ? 'page' : undefined}>در انتظار</Link>
            </nav>
          </aside>
        )}

        <section className={`${styles.result} ${styles[visibleStatus]}`} aria-labelledby="payment-result-title">
          <div className={styles.topLine}>
            <span className={styles.sectionLabel}><CreditCard size={16} /> نتیجهٔ پرداخت</span>
            <span className={styles.status}><span />{content.label}</span>
          </div>

          <div className={styles.summary}>
            <div className={styles.resultMark} aria-hidden="true">
              <span className={styles.icon}><PaymentStatusIcon status={visibleStatus} size={124} /></span>
            </div>
            <h1 id="payment-result-title">{content.title}</h1>
            <p className={styles.description}>{description}</p>
          </div>

          {receipt && (
            <section className={styles.receipt} aria-labelledby="receipt-heading">
              <h2 id="receipt-heading"><ReceiptText size={17} /> {isPreview ? 'مشخصات سفارش نمایشی' : 'مشخصات سفارش'}</h2>
              <dl>
                <div className={styles.orderId}><dt>شمارهٔ سفارش</dt><dd dir="ltr">{receipt.id}</dd></div>
                {receipt.status === 'CANCELLED' && <div><dt>وضعیت سفارش</dt><dd>لغو شده</dd></div>}
                {validDate && <div><dt>تاریخ ثبت سفارش</dt><dd><time dateTime={validDate.toISOString()}>{new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tehran' }).format(validDate)}</time></dd></div>}
                {((receipt.productDiscount ?? 0) > 0 || (receipt.couponDiscount ?? 0) > 0) && <>
                  <div><dt>جمع اولیهٔ کالاها</dt><dd>{formatPrice(receipt.subtotal ?? receipt.amount - (receipt.shippingCost ?? 0) + (receipt.productDiscount ?? 0) + (receipt.couponDiscount ?? 0))} <span>تومان</span></dd></div>
                  {(receipt.productDiscount ?? 0) > 0 && <div><dt>تخفیف محصولات</dt><dd>−{formatPrice(receipt.productDiscount!)} <span>تومان</span></dd></div>}
                  {(receipt.couponDiscount ?? 0) > 0 && <div><dt>تخفیف کد {receipt.couponCode && <bdi>{receipt.couponCode}</bdi>}</dt><dd>−{formatPrice(receipt.couponDiscount!)} <span>تومان</span></dd></div>}
                </>}
                {receipt.shippingCost !== undefined && <>
                  <div><dt>روش ارسال</dt><dd>{receipt.shippingMethodName || 'ثبت نشده'}</dd></div>
                  <div><dt>هزینهٔ ارسال</dt><dd>{formatPrice(receipt.shippingCost)} <span>تومان</span></dd></div>
                </>}
                <div className={styles.amount}><dt>{visibleStatus === 'success' ? 'مبلغ پرداخت‌شده' : 'مبلغ سفارش'}</dt><dd>{formatPrice(receipt.amount)} <span>تومان</span></dd></div>
              </dl>
            </section>
          )}

          <div className={styles.actions}>
            <Link href={primary.href} className={styles.primary}>{primary.label}<ArrowLeft size={18} /></Link>
            <Link href={content.secondary.href} className={styles.secondary}>{content.secondary.label}<ArrowUpLeft size={17} /></Link>
          </div>
          {visibleStatus === 'failed' && <Link href="/profile" className={styles.orderLink}>بررسی وضعیت در سفارش‌های من <ChevronLeft size={14} /></Link>}
        </section>

        <aside className={styles.help}>
          <span className={styles.helpIcon}>{visibleStatus === 'success' && !paidCancellation ? <Package size={22} /> : <Headphones size={22} />}</span>
          <div><h2>{paidCancellation ? 'پیگیری سفارش لغوشده' : content.note}</h2><p>{paidCancellation ? 'تأیید پرداخت به معنی تأیید بازگشت وجه نیست؛ برای بررسی، شمارهٔ سفارش را به پشتیبانی بده.' : content.noteText}</p></div>
          <Link href="/contact" aria-label="تماس با پشتیبانی"><ArrowUpLeft size={20} /></Link>
        </aside>
      </div>
    </div>
  )
}
