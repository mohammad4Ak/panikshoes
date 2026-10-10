// This module is pure so the stored invoice contract and number formatter can
// also be used by account/admin clients without loading server dependencies.
export interface InvoiceMetadata {
  id: number
  issuedAt: Date | string
}

export interface InvoiceSnapshot {
  schemaVersion: 1
  seller: { name: string }
  buyer: { name: string; email: string }
  recipient: { name: string; address: string; phone: string }
  orderId: string
  orderCreatedAt: string
  items: {
    productId: string
    productName: string
    quantity: number
    size: number
    color: string
    unitPrice: number
    lineTotal: number
  }[]
  subtotal: number
  shippingMethodName: string | null
  shippingCost: number
  total: number
  currency: 'تومان'
}

interface InvoiceOrder {
  id: string
  createdAt: Date | string
  user: { name: string; email: string }
  recipientName: string | null
  address: string
  phone: string
  shippingMethodName: string | null
  shippingCost: number
  total: number
  items: {
    productId: string
    productName: string | null
    product: { name: string }
    quantity: number
    size: number
    color: string
    price: number
  }[]
}

export function isInvoiceEligibleStatus(status: string): boolean {
  return status === 'PROCESSING' || status === 'SHIPPED' || status === 'DELIVERED'
}

export function formatInvoiceNumber(invoice: InvoiceMetadata): string {
  const year = new Date(invoice.issuedAt).getUTCFullYear()
  return `INV-${year}-${String(invoice.id).padStart(6, '0')}`
}

export function buildInvoiceSnapshot(order: InvoiceOrder, sellerName = 'کفش لند'): InvoiceSnapshot {
  const items = order.items.map((item) => ({
    productId: item.productId,
    productName: item.productName ?? item.product.name,
    quantity: item.quantity,
    size: item.size,
    color: item.color,
    unitPrice: item.price,
    lineTotal: item.price * item.quantity,
  }))
  return {
    schemaVersion: 1,
    seller: { name: sellerName },
    buyer: { name: order.user.name, email: order.user.email },
    recipient: {
      name: order.recipientName ?? order.user.name,
      address: order.address,
      phone: order.phone,
    },
    orderId: order.id,
    orderCreatedAt: new Date(order.createdAt).toISOString(),
    items,
    subtotal: items.reduce((total, item) => total + item.lineTotal, 0),
    shippingMethodName: order.shippingMethodName,
    shippingCost: order.shippingCost,
    total: order.total,
    currency: 'تومان',
  }
}
