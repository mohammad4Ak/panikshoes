import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // ۱. بازگرداندن نام کاربر تست
  await prisma.user.update({
    where: { email: 'user@test.com' },
    data: { name: 'کاربر تست', phone: '09123456789', role: 'USER' },
  })
  console.log('✅ user@test.com restored')

  // ۲. حذف دسته بندی های تستی خراب (از تستهای قبلی)
  const junk = await prisma.category.findMany({
    where: {
      OR: [{ slug: { contains: 'boots-test' } }, { slug: { contains: 'boots' } }],
    },
  })
  for (const c of junk) {
    const count = await prisma.product.count({ where: { categoryId: c.id } })
    if (count === 0) {
      await prisma.category.delete({ where: { id: c.id } })
      console.log(`🗑️ deleted junk category slug=${c.slug}`)
    }
  }

  // ۳. لیست نهایی دسته بندی ها و کاربران برای اطمینان
  const cats = await prisma.category.findMany({
    select: { name: true, slug: true, _count: { select: { products: true } } },
  })
  console.log('categories:')
  for (const c of cats) console.log(`  - ${c.name} (${c.slug}) x${c._count.products}`)

  const users = await prisma.user.findMany({ select: { name: true, email: true, role: true } })
  console.log('users:')
  for (const u of users) console.log(`  - ${u.name} <${u.email}> ${u.role}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })