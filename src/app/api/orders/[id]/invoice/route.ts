import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { formatInvoiceNumber, type InvoiceSnapshot } from '@/lib/invoice'
import { renderInvoicePdf } from '@/lib/invoice-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie, Accept',
  'X-Content-Type-Options': 'nosniff',
}

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) return failure('برای دریافت فاکتور وارد حساب خود شوید', 401)

  const { id } = await params
  if (!id || id.length > 128) return failure('سفارش یافت نشد', 404)

  try {
    const order = await prisma.order.findFirst({
      where: { id, ...(session.user.role === 'ADMIN' ? {} : { userId: session.user.id }) },
      select: {
        status: true,
        invoice: { select: { id: true, issuedAt: true, snapshot: true } },
      },
    })
    if (!order) return failure('سفارش یافت نشد', 404)
    if (!order.invoice) return failure('فاکتور پس از تأیید سفارش توسط فروشگاه صادر می‌شود', 409)

    const invoice = { ...order.invoice, snapshot: order.invoice.snapshot as unknown as InvoiceSnapshot }
    const pdf = await renderInvoicePdf(invoice, order.status)
    // Avoid download extensions treating the fetch as a PDF attachment.
    // The client validates the bytes, then starts the browser's PDF download.
    if (request.headers.get('accept')?.trim().toLowerCase() === 'application/json') {
      return NextResponse.json({ pdf: Buffer.from(pdf).toString('base64') }, { headers: privateHeaders })
    }
    return new Response(new Uint8Array(pdf), {
      headers: {
        ...privateHeaders,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="katuni-${formatInvoiceNumber(invoice)}.pdf"`,
        'Content-Length': String(pdf.byteLength),
      },
    })
  } catch {
    return failure('دریافت فاکتور انجام نشد؛ دوباره تلاش کنید', 500)
  }
}
