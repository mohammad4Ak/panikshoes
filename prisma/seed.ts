import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // Create admin user
  const hashedPassword = await bcrypt.hash('admin123', 10)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@shoeland.ir' },
    update: {},
    create: {
      email: 'admin@shoeland.ir',
      name: 'مدیر سیستم',
      password: hashedPassword,
      role: 'ADMIN',
    },
  })

  console.log('✅ Admin user created:', admin.email)

  // Create test user
  const userPassword = await bcrypt.hash('user123', 10)
  const user = await prisma.user.upsert({
    where: { email: 'user@test.com' },
    update: {},
    create: {
      email: 'user@test.com',
      name: 'کاربر تست',
      password: userPassword,
      role: 'USER',
    },
  })

  console.log('✅ Test user created:', user.email)

  // Create categories
  const sneakerCategory = await prisma.category.upsert({
    where: { slug: 'sneaker' },
    update: {},
    create: {
      name: 'کتانی',
      slug: 'sneaker',
    },
  })

  const formalCategory = await prisma.category.upsert({
    where: { slug: 'formal' },
    update: {},
    create: {
      name: 'رسمی',
      slug: 'formal',
    },
  })

  console.log('✅ Categories created')

  // Create products
  const products = [
    {
      name: 'کفش کتانی نایک ایر مکس',
      slug: 'nike-air-max',
      description: 'کفش کتانی نایک با تکنولوژی ایر مکس برای راحتی بیشتر در راه رفتن و دویدن. جنس رویه از چرم طبیعی و پارچه تنفس‌پذیر.',
      price: 4500000,
      images: ['https://images.unsplash.com/photo-1549298916-b41d501d3772?w=600&q=80'],
      categoryId: sneakerCategory.id,
      type: 'SNEAKER' as const,
      sizes: [40, 41, 42, 43, 44],
      colors: ['مشکی', 'سفید', 'سورمه‌ای'],
      stock: 25,
      featured: true,
    },
    {
      name: 'کفش رسمی چرم طبیعی',
      slug: 'leather-formal',
      description: 'کفش کلاسیک رسمی از چرم طبیعی دست‌دوز. مناسب برای مجالس و جلسات مهم. طراحی کلاسیک و زیبا.',
      price: 3800000,
      images: ['https://images.unsplash.com/photo-1533867617858-e7b97e060509?w=600&q=80'],
      categoryId: formalCategory.id,
      type: 'FORMAL' as const,
      sizes: [39, 40, 41, 42, 43],
      colors: ['مشکی', 'قهوه‌ای'],
      stock: 18,
      featured: true,
    },
    {
      name: 'کفش ورزشی آدیداس الترا',
      slug: 'adidas-ultra',
      description: 'کفش ورزشی حرفه‌ای آدیداس با طراحی مدرن و زیبا. مناسب برای ورزش‌های مختلف و استفاده روزمره.',
      price: 5200000,
      images: ['https://images.unsplash.com/photo-1600185365483-26d7a4cc7519?w=600&q=80'],
      categoryId: sneakerCategory.id,
      type: 'SNEAKER' as const,
      sizes: [40, 41, 42, 43, 44, 45],
      colors: ['سفید', 'سرمه‌ای'],
      stock: 12,
      featured: true,
    },
    {
      name: 'کفش کلاسیک چرم دستدوز',
      slug: 'classic-leather',
      description: 'کفش کلاسیک چرم طبیعی دست‌دوز با طراحی زیبا و منحصر به فرد. مناسب برای استایل‌های مختلف.',
      price: 4200000,
      images: ['https://images.unsplash.com/photo-1449505278894-297fdb3edbc1?w=600&q=80'],
      categoryId: formalCategory.id,
      type: 'FORMAL' as const,
      sizes: [38, 39, 40, 41, 42, 43],
      colors: ['مشکی', 'قهوه‌ای', 'خاکی'],
      stock: 15,
      featured: false,
    },
    {
      name: 'کفش روزمره نیوبالانس',
      slug: 'new-balance',
      description: 'کفش روزمره نیوبالانس با راحتی فوق‌العاده. مناسب برای پیاده‌روی طولانی و استفاده روزانه.',
      price: 3200000,
      images: ['https://images.unsplash.com/photo-1560769629-975ec94e6a86?w=600&q=80'],
      categoryId: sneakerCategory.id,
      type: 'SNEAKER' as const,
      sizes: [39, 40, 41, 42, 43],
      colors: ['خاکستری', 'سرمه‌ای', 'سفید'],
      stock: 30,
      featured: false,
    },
    {
      name: 'کفش بیزینسی قهوه‌ای',
      slug: 'business-brown',
      description: 'کفش رسمی بیزینسی از چرم طبیعی درجه یک. مناسب برای محیط‌های کاری و جلسات مهم.',
      price: 4500000,
      images: ['https://images.unsplash.com/photo-1614252235316-8c857d38b5f4?w=600&q=80'],
      categoryId: formalCategory.id,
      type: 'FORMAL' as const,
      sizes: [39, 40, 41, 42, 43, 44],
      colors: ['قهوه‌ای تیره', 'مشکی'],
      stock: 10,
      featured: true,
    },
  ]

  for (const product of products) {
    await prisma.product.upsert({
      where: { slug: product.slug },
      update: {},
      create: product,
    })
  }

  console.log('✅ Products seeded:', products.length)

  console.log('🎉 Database seeded successfully!')
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })