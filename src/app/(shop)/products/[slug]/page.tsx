import ProductDetail from '@/components/shop/ProductDetail'

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  // در این نسخه Next.js سگمنت داینامیک انکودشده میآید - یک بار دیکد میکنیم
  let decodedSlug = slug
  try {
    decodedSlug = decodeURIComponent(slug)
  } catch {
    // اگر انکود نبود، همون استفاده میشه
  }

  return <ProductDetail key={decodedSlug} slug={decodedSlug} />
}
