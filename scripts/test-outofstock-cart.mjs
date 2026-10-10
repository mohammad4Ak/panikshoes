import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const base = 'http://localhost:3000'

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

const nb = await prisma.product.findUnique({ where: { slug: 'new-balance' } })
const adidas = await prisma.product.findUnique({ where: { slug: 'adidas-ultra' } })
const originalNbStock = nb.stock

// نیوبالانس فقط ۱ عدد - سبد ۵ تا خواسته
await prisma.product.update({ where: { id: nb.id }, data: { stock: 1 } })

const cookie = await login('user@test.com', 'user123')

const ordersBefore = await prisma.order.count({ where: { userId: (await prisma.user.findUnique({ where: { email: 'user@test.com' } })).id } })

const res = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    address: 'تهران، تست',
    phone: '09120000000',
    items: [
      { productId: nb.id, quantity: 5, size: 42, color: 'مشکی' },
      { productId: adidas.id, quantity: 1, size: 42, color: 'سفید' },
    ],
  }),
})
const data = await res.json()

console.log(`HTTP ${res.status}`)
console.log(`پیام: ${data.error}`)
console.log(`outOfStock: ${JSON.stringify(data.outOfStock)}`)

let pass = true
if (res.status !== 400) { console.log('❌ انتظار 400 داشتیم'); pass = false }
if (!Array.isArray(data.outOfStock) || !data.outOfStock.includes(nb.id)) {
  console.log('❌ outOfStock شامل نیوبالانس نیست'); pass = false
} else {
  console.log('✅ قلم ناموجود در پاسخ مشخص شد')
}
if (data.outOfStock?.includes(adidas.id)) { console.log('❌ آدیداس اشتباهی ناموجود علامت خورد'); pass = false }

// هیچ سفارشی ثبت نشده باشد و آدیداس دست نخورده باشد
const ordersAfter = await prisma.order.count({ where: { userId: (await prisma.user.findUnique({ where: { email: 'user@test.com' } })).id } })
const adidasAfter = await prisma.product.findUnique({ where: { id: adidas.id } })

if (ordersAfter === ordersBefore) { console.log('✅ سفارشی ثبت نشد (تراکنش کامل rollback شد)') } else { console.log(`❌ سفارش اضافه شد!`); pass = false }
console.log(`موجودی آدیداس دست نخورده: ${adidasAfter.stock} -> ${adidasAfter.stock === adidas.stock ? '✅' : '❌'}`)

// پاکسازی
await prisma.product.update({ where: { id: nb.id }, data: { stock: originalNbStock } })
console.log(`پاکسازی - موجودی نیوبالانس برگشت به ${originalNbStock}`)

await prisma.$disconnect()
process.exit(pass ? 0 : 1)