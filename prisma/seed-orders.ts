import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding demo orders...')

  const user = await prisma.user.findUnique({ where: { email: 'user@test.com' } })
  const admin = await prisma.user.findUnique({ where: { email: 'admin@shoeland.ir' } })

  if (!user || !admin) {
    throw new Error('کاربرهای پایه پیدا نشدند - اول seed اصلی را اجرا کنید')
  }

  const products = await prisma.product.findMany({ take: 6 })
  if (products.length === 0) {
    throw new Error('محصولی پیدا نشد - اول seed اصلی را اجرا کنید')
  }

  const statuses = ['DELIVERED', 'DELIVERED', 'SHIPPED', 'PROCESSING', 'PENDING', 'CANCELLED'] as const

  // ۱۸ سفارش پخش شده در ۷ روز اخیر
  let created = 0
  for (let day = 0; day < 7; day++) {
    const ordersThisDay = 2 + ((day * 7) % 3) // ۲ تا ۴ سفارش در روز

    for (let i = 0; i < ordersThisDay; i++) {
      const createdAt = new Date()
      createdAt.setDate(createdAt.getDate() - (6 - day))
      createdAt.setHours(9 + i * 3, 15, 0, 0)

      const product = products[(day + i) % products.length]
      const quantity = 1 + ((day + i) % 3)
      const status = statuses[(day * 3 + i) % statuses.length]

      const order = await prisma.order.create({
        data: {
          userId: i % 2 === 0 ? user.id : admin.id,
          total: product.price * quantity,
          status,
          address: 'تهران، خیابان ولیعصر، پلاک ۱۲۳',
          phone: '09123456789',
          verified: status !== 'PENDING',
          createdAt,
          items: {
            create: [
              {
                productId: product.id,
                quantity,
                size: 41 + (i % 3),
                color: 'مشکی',
                price: product.price,
              },
            ],
          },
        },
      })
      created++
    }
  }

  console.log(`✅ ${created} سفارش نمونه ساخته شد`)
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })