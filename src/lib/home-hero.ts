export interface HomeHeroProduct {
  id: string
  slug: string
  name: string
  images: string[]
  category?: { name: string }
}

export interface HomeHeroSlide {
  id: string
  slug: string
  name: string
  image: string
  eyebrow: string
}

// Editorial selections may include sold-out products. Availability stays visible
// on their detail page; stock is never changed by featuring a product.
export function resolveHomeHeroSlides(productIds: string[], candidates: HomeHeroProduct[], fallback: HomeHeroProduct | null | undefined, storeName: string): HomeHeroSlide[] {
  const byId = new Map(candidates.map((product) => [product.id, product]))
  const chosen = [...new Set(productIds)].map((id) => byId.get(id)).filter((product): product is HomeHeroProduct => !!product?.images[0]?.trim())
  const products = chosen.length ? chosen : fallback?.images[0]?.trim() ? [fallback] : []
  return products.map((product) => ({
    id: product.id, slug: product.slug, name: product.name, image: product.images[0],
    eyebrow: product.category?.name ? 'از مجموعهٔ ' + product.category.name : 'از ویترین ' + storeName,
  }))
}
