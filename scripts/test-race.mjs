import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const base = 'http://localhost:3000'
const SLUG = 'new-balance'

async function login(email, password) {
  const jar = []
  const merge = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      jar.push(c.split(';')[0])
    }
  }
  let res = await fetch(`${base}/api/auth/csrf`)
  merge(res)
  const { csrfToken } = await res.json()
  res = await fetch(`${base}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.join('; '),
    },
    body: new URLSearchParams({ csrfToken, email, password, json: 'true' }),
    redirect: 'manual',
  })
  merge(res)
  return jar.join('; ')
}

async function placeOrder(cookie, productId) {
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      address: 'تهران، تست رقابت',
      phone: '09120000000',
      items: [{ productId, quantity: 1, size: 42, color: 'مشکی' }],
    }),
  })
  let body = null
  try {
    body = await res.json()
  } catch {}
  return { status: res.status, body }
}

const product = await prisma.product.findUnique({ where: { slug: SLUG } })
const originalStock = product.stock
console.log(`موجودی اولیه ${SLUG}: ${originalStock}`)

// موجودی را دقیقا 1 میکنیم - شرایط واقعی جنگ بر سر آخرین عدد
await prisma.product.update({ where: { id: product.id }, data: { stock: 1 } })

// دو کاربر مختلف لاگین میکنند
const cookieA = await login('user@test.com', 'user123')
const cookieB = await login('newuser@test.com', 'test1234')

// شلیک همزمان دو سفارش
const [resultA, resultB] = await Promise.allSettled([
  placeOrder(cookieA, product.id),
  placeOrder(cookieB, product.id),
])

const a = resultA.status === 'fulfilled' ? resultA.value : { status: 'ERR' }
const b = resultB.status === 'fulfilled' ? resultB.value : { status: 'ERR' }

console.log(`کاربر A -> HTTP ${a.status}`)
console.log(`کاربر B -> HTTP ${b.status}`)
if (b.status === 400) console.log(`  پیام B: ${b.body?.error}`)

const successes = [a, b].filter((r) => r.status === 201)
const afterStock = (await prisma.product.findUnique({ where: { id: product.id } })).stock

let pass = true
if (successes.length !== 1) {
  console.log(`❌ FAIL: تعداد سفارشهای موفق = ${successes.length} (باید دقیقا ۱ باشد)`)
  pass = false
} else {
  console.log('✅ فقط یک سفارش موفق شد')
}
if (afterStock !== 0) {
  console.log(`❌ FAIL: موجودی نهایی = ${afterStock} (باید ۰ باشد)`)
  pass = false
} else {
  console.log('✅ موجودی نهایی = 0 (نه منفی، نه اضافه فروخته شد)')
}

// پاکسازی
for (const r of successes) {
  if (r.body?.id) {
    await prisma.orderItem.deleteMany({ where: { orderId: r.body.id } })
    await prisma.order.delete({ where: { id: r.body.id } })
  }
}
await prisma.product.update({
  where: { id: product.id },
  data: { stock: originalStock },
})
console.log(`پاکسازی شد - موجودی برگشت به ${originalStock}`)

await prisma.$disconnect()
process.exit(pass ? 0 : 1)