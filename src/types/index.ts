export interface Product {
  id: string
  name: string
  slug: string
  description: string
  price: number
  salePrice?: number | null
  saleStartsAt?: string | null
  saleEndsAt?: string | null
  images: string[]
  categoryId: string
  type: 'SNEAKER' | 'FORMAL'
  sizes: number[]
  colors: string[]
  stock: number
  featured: boolean
}

export interface CartItem {
  productId: string
  name: string
  price: number
  originalPrice?: number
  image: string
  size: number
  color: string
  quantity: number
}

export interface OrderFormData {
  address: string
  phone: string
}
