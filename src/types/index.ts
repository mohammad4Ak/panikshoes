export interface Product {
  id: string
  name: string
  slug: string
  description: string
  price: number
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
  image: string
  size: number
  color: string
  quantity: number
}

export interface OrderFormData {
  address: string
  phone: string
}