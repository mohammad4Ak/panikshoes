import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { jsPDF, type TextOptionsLight } from 'jspdf'
import { formatInvoiceNumber, type InvoiceMetadata, type InvoiceSnapshot } from './invoice'

const PAGE_WIDTH = 210
const MARGIN = 15
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const CONTENT_BOTTOM = 273
const LINE_HEIGHT = 4.8
const ROW_PADDING = 3
const FONT_NAME = 'Vazirmatn'
const COLORS = {
  night: '#14211C',
  brand: '#12664A',
  soft: '#EAF3EE',
  muted: '#69746E',
  line: '#E2E8E3',
  alternate: '#F7FAF8',
}

// PDF text is written in visual LTR order, while Persian input is logical RTL.
// Setting R2L globally would reverse Latin names and numbers as well.
const RTL_TEXT: TextOptionsLight = {
  align: 'right',
  isInputVisual: false,
  isInputRtl: true,
  isOutputVisual: true,
  isOutputRtl: false,
  isSymmetricSwapping: true,
}

let fontBase64: Promise<string> | undefined

function loadFont(): Promise<string> {
  fontBase64 ??= readFile(path.join(process.cwd(), 'src/assets/fonts/Vazirmatn-Regular.ttf'))
    .then((font) => font.toString('base64'))
    .catch((error: unknown) => {
      fontBase64 = undefined
      throw error
    })
  return fontBase64
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('fa-IR').format(value)
}

function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

/** Generate a downloadable Persian invoice from its immutable issuance snapshot. */
export async function renderInvoicePdf(
  invoice: InvoiceMetadata & { snapshot: InvoiceSnapshot },
  orderStatus: string,
): Promise<Uint8Array> {
  const snapshot = invoice.snapshot
  const invoiceNumber = formatInvoiceNumber(invoice)
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true })
  doc.addFileToVFS('Vazirmatn-Regular.ttf', await loadFont())
  doc.addFont('Vazirmatn-Regular.ttf', FONT_NAME, 'normal')
  doc.setFont(FONT_NAME, 'normal')
  doc.setLanguage('fa-IR')
  doc.viewerPreferences({ Direction: 'R2L', DisplayDocTitle: true })
  doc.setProperties({ title: `فاکتور فروش ${invoiceNumber}`, author: snapshot.seller.name })
  doc.setCreationDate(new Date(invoice.issuedAt))

  function text(value: string, x: number, y: number, options: TextOptionsLight = {}) {
    doc.text(cleanText(value), x, y, { ...RTL_TEXT, ...options })
  }

  // Measuring complete, shaped words also keeps connected Persian glyphs inside
  // their cell. Break oversized tokens explicitly (addresses and long SKUs).
  function wrap(value: string, width: number): string[] {
    const lines: string[] = []
    for (const paragraph of cleanText(value).split('\n')) {
      let line = ''
      for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word
        if (doc.getTextWidth(candidate) <= width) {
          line = candidate
          continue
        }
        if (line) {
          lines.push(line)
          line = ''
        }
        for (const character of Array.from(word)) {
          if (line && doc.getTextWidth(line + character) > width) {
            lines.push(line)
            line = ''
          }
          line += character
        }
      }
      if (line || !paragraph.trim()) lines.push(line)
    }
    return lines.length ? lines : ['']
  }

  function newPage(addPage = true): number {
    if (addPage) doc.addPage()
    doc.setFillColor(COLORS.soft)
    doc.roundedRect(MARGIN, 13, CONTENT_WIDTH, 30, 4, 4, 'F')
    doc.setTextColor(COLORS.brand)
    doc.setFontSize(19)
    text('فاکتور فروش', 190, 26)
    doc.setFontSize(10)
    const sellerName = wrap(snapshot.seller.name, 90)[0]
    text(sellerName, 190, 36)
    doc.setFontSize(10)
    text(invoiceNumber, 20, 25, { align: 'left', isInputRtl: false })
    doc.setFontSize(8.5)
    text(`تاریخ صدور: ${formatDate(invoice.issuedAt)}`, 20, 35, { align: 'left' })
    let bodyTop = 50
    const banner = orderStatus === 'CANCELLED'
      ? 'این سفارش لغو شده است؛ فاکتور برای سابقه سفارش نگهداری می‌شود.'
      : orderStatus === 'PENDING'
        ? 'سفارش اکنون در انتظار تأیید است؛ این فاکتور مربوط به تأیید قبلی سفارش است.'
        : null
    if (banner) {
      doc.setFillColor(orderStatus === 'CANCELLED' ? '#FFF1F2' : '#FFF8E5')
      doc.roundedRect(MARGIN, 47, CONTENT_WIDTH, 12, 2, 2, 'F')
      doc.setTextColor(orderStatus === 'CANCELLED' ? '#9F1239' : '#92400E')
      doc.setFontSize(8.5)
      text(banner, 190, 54.5)
      bodyTop = 65
    }
    doc.setTextColor(COLORS.night)
    return bodyTop
  }

  let y = newPage(false)

  function sectionHeading(title: string) {
    if (y + 16 > CONTENT_BOTTOM) y = newPage()
    doc.setFontSize(11)
    doc.setTextColor(COLORS.brand)
    text(title, 195, y + 4)
    doc.setDrawColor(COLORS.line)
    doc.setLineWidth(0.25)
    doc.line(MARGIN, y + 7, 195, y + 7)
    doc.setTextColor(COLORS.night)
    y += 13
  }

  function field(label: string, value: string, section: string) {
    doc.setFontSize(9.5)
    const lines = wrap(`${label}: ${value}`, CONTENT_WIDTH - 4)
    for (const line of lines) {
      if (y + LINE_HEIGHT > CONTENT_BOTTOM) {
        y = newPage()
        sectionHeading(`${section} (ادامه)`)
        doc.setFontSize(9.5)
      }
      text(line, 193, y + 1)
      y += LINE_HEIGHT
    }
    y += 2
  }

  sectionHeading('مشخصات سفارش')
  field('شماره سفارش', snapshot.orderId, 'مشخصات سفارش')
  field('تاریخ ثبت سفارش', formatDate(snapshot.orderCreatedAt), 'مشخصات سفارش')
  y += 3
  sectionHeading('مشخصات خریدار')
  field('نام', snapshot.buyer.name, 'مشخصات خریدار')
  field('ایمیل', snapshot.buyer.email, 'مشخصات خریدار')
  y += 3
  sectionHeading('مشخصات گیرنده')
  field('نام', snapshot.recipient.name, 'مشخصات گیرنده')
  field('شماره تماس', snapshot.recipient.phone, 'مشخصات گیرنده')
  field('نشانی', snapshot.recipient.address, 'مشخصات گیرنده')
  y += 5

  const columns = [
    { left: 131, right: 195, title: 'شرح کالا', align: 'right' as const },
    { left: 96, right: 131, title: 'سایز و رنگ', align: 'right' as const },
    { left: 81, right: 96, title: 'تعداد', align: 'center' as const },
    { left: 48, right: 81, title: 'قیمت واحد', align: 'center' as const },
    { left: 15, right: 48, title: 'مبلغ کل', align: 'center' as const },
  ]

  function tableHeader(continuation = false) {
    if (y + 43 > CONTENT_BOTTOM) y = newPage()
    sectionHeading(continuation ? 'کالاهای سفارش (ادامه)' : 'کالاهای سفارش')
    doc.setFontSize(8)
    doc.setTextColor(COLORS.muted)
    text(`همه مبالغ به ${snapshot.currency} است.`, 195, y)
    y += 4
    doc.setFillColor(COLORS.brand)
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 10, 2, 2, 'F')
    doc.setTextColor('#FFFFFF')
    doc.setFontSize(9)
    for (const column of columns) {
      const x = column.align === 'right' ? column.right - 3 : (column.left + column.right) / 2
      text(column.title, x, y + 6.4, { align: column.align })
    }
    y += 10
    doc.setTextColor(COLORS.night)
    doc.setFontSize(9)
  }

  function nextTablePage() {
    y = newPage()
    tableHeader(true)
  }

  // The table's top margin is identical on every continued page.
  const freshTableTop = (orderStatus === 'CANCELLED' || orderStatus === 'PENDING' ? 65 : 50) + 27
  const fullPageLineCapacity = Math.floor((CONTENT_BOTTOM - freshTableTop - ROW_PADDING * 2) / LINE_HEIGHT)

  function itemCells(item: InvoiceSnapshot['items'][number]): string[][] {
    doc.setFontSize(9)
    return [
      wrap(item.productName, 58),
      wrap(`سایز ${formatNumber(item.size)}\nرنگ: ${item.color}`, 29),
      wrap(formatNumber(item.quantity), 9),
      wrap(formatNumber(item.unitPrice), 27),
      wrap(formatNumber(item.lineTotal), 27),
    ]
  }

  // Keep the first table header with its first row when the whole row can fit
  // on a fresh page. Very tall rows can instead continue across pages.
  const firstItem = snapshot.items[0]
  if (firstItem) {
    const firstLineCount = Math.max(...itemCells(firstItem).map((cell) => cell.length))
    const firstRowHeight = Math.max(15, firstLineCount * LINE_HEIGHT + ROW_PADDING * 2)
    if (firstLineCount <= fullPageLineCapacity && y + 27 + firstRowHeight > CONTENT_BOTTOM) y = newPage()
  }
  tableHeader()

  snapshot.items.forEach((item, itemIndex) => {
    const cells = itemCells(item)
    const lineCount = Math.max(...cells.map((cell) => cell.length))
    let offset = 0
    while (offset < lineCount) {
      const continuation = offset > 0
      const prefixLines = continuation ? 1 : 0
      const remainingLines = lineCount - offset
      const requiredHeight = Math.max(15, (remainingLines + prefixLines) * LINE_HEIGHT + ROW_PADDING * 2)
      if (
        (remainingLines + prefixLines <= fullPageLineCapacity && y + requiredHeight > CONTENT_BOTTOM)
        || CONTENT_BOTTOM - y < 15 + prefixLines * LINE_HEIGHT
      ) {
        nextTablePage()
      }
      const capacity = Math.floor((CONTENT_BOTTOM - y - ROW_PADDING * 2) / LINE_HEIGHT) - prefixLines
      const count = Math.min(remainingLines, capacity)
      const rowHeight = Math.max(15, (count + prefixLines) * LINE_HEIGHT + ROW_PADDING * 2)
      doc.setFillColor(itemIndex % 2 ? '#FFFFFF' : COLORS.alternate)
      doc.rect(MARGIN, y, CONTENT_WIDTH, rowHeight, 'F')
      doc.setDrawColor(COLORS.line)
      doc.setLineWidth(0.2)
      for (const x of [15, 48, 81, 96, 131, 195]) doc.line(x, y, x, y + rowHeight)
      doc.line(MARGIN, y + rowHeight, 195, y + rowHeight)
      if (continuation) {
        doc.setTextColor(COLORS.muted)
        doc.setFontSize(8)
        text('ادامه کالا', 192, y + ROW_PADDING + 3)
      }
      doc.setTextColor(COLORS.night)
      doc.setFontSize(9)
      cells.forEach((cell, columnIndex) => {
        const column = columns[columnIndex]
        const x = column.align === 'right' ? column.right - 3 : (column.left + column.right) / 2
        cell.slice(offset, offset + count).forEach((line, lineIndex) => {
          text(line, x, y + ROW_PADDING + 3 + (lineIndex + prefixLines) * LINE_HEIGHT, { align: column.align })
        })
      })
      y += rowHeight
      offset += count
      if (offset < lineCount) nextTablePage()
    }
  })

  y += 3
  if (snapshot.shippingMethodName) {
    field('روش ارسال', snapshot.shippingMethodName, 'ارسال سفارش')
  }
  if (y + 40 > CONTENT_BOTTOM) y = newPage()
  doc.setFillColor(COLORS.soft)
  doc.roundedRect(100, y, 95, 40, 3, 3, 'F')
  doc.setFontSize(10)
  text('جمع کالاها', 190, y + 9)
  text(formatNumber(snapshot.subtotal), 105, y + 9, { align: 'left' })
  text('هزینه ارسال', 190, y + 19)
  text(snapshot.shippingCost === 0 ? 'رایگان' : formatNumber(snapshot.shippingCost), 105, y + 19, { align: 'left' })
  doc.setDrawColor('#C4DCCE')
  doc.line(105, y + 24, 190, y + 24)
  doc.setTextColor(COLORS.brand)
  doc.setFontSize(11)
  text(`مبلغ کل (${snapshot.currency})`, 190, y + 33)
  text(formatNumber(snapshot.total), 105, y + 33, { align: 'left' })

  const pageCount = doc.getNumberOfPages()
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page)
    doc.setDrawColor(COLORS.line)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, 282, 195, 282)
    doc.setTextColor(COLORS.muted)
    doc.setFontSize(8)
    text(invoiceNumber, MARGIN, 287, { align: 'left', isInputRtl: false })
    text(`صفحه ${formatNumber(page)} از ${formatNumber(pageCount)}`, 195, 287)
    text('صدور فاکتور به معنی تأیید پرداخت نیست.', PAGE_WIDTH / 2, 293, { align: 'center' })
  }
  return new Uint8Array(doc.output('arraybuffer'))
}
