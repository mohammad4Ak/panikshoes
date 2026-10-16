import { ApiInputError, booleanField, integerField, optionalText, textField } from './api-input'

const defaultImage = 'https://images.unsplash.com/photo-1560769629-975ec94e6a86?w=600&q=80'

type ProductSale = { price?: number; salePrice?: number | null; saleStartsAt?: Date | null; saleEndsAt?: Date | null }

function saleDateField(value: unknown, label: string): Date | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ApiInputError(`${label} نامعتبر است`)
  const date = new Date(value)
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (!Number.isFinite(date.getTime()) || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) throw new ApiInputError(`${label} نامعتبر است`)
  return date
}

/** Original pricing shown in an admin form, used for an atomic compare-and-set. */
export function productPricingSnapshot(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['price', 'salePrice', 'saleStartsAt', 'saleEndsAt'].every(key => key in value)) {
    throw new ApiInputError('قیمت و تخفیف قبلی معتبر نیست؛ فرم محصول را دوباره باز کنید')
  }
  const snapshot = value as Record<string, unknown>
  return {
    price: integerField(snapshot.price, 'قیمت قبلی', 1),
    salePrice: snapshot.salePrice === null ? null : integerField(snapshot.salePrice, 'قیمت تخفیفی قبلی', 1),
    saleStartsAt: saleDateField(snapshot.saleStartsAt, 'شروع تخفیف قبلی'),
    saleEndsAt: saleDateField(snapshot.saleEndsAt, 'پایان تخفیف قبلی'),
  }
}

export function validateProductSale(changes: ProductSale, existing: ProductSale = {}) {
  const merged = { ...existing, ...changes }
  if (merged.salePrice == null) {
    if (merged.saleStartsAt != null || merged.saleEndsAt != null) throw new ApiInputError('برای زمان‌بندی تخفیف، قیمت بعد از تخفیف را وارد کنید')
    return
  }
  if (!Number.isSafeInteger(merged.salePrice) || merged.salePrice < 1 || merged.price === undefined || merged.salePrice >= merged.price) throw new ApiInputError('قیمت بعد از تخفیف باید بیشتر از صفر و کمتر از قیمت اصلی باشد')
  if (merged.saleStartsAt && merged.saleEndsAt && merged.saleEndsAt.getTime() <= merged.saleStartsAt.getTime()) throw new ApiInputError('پایان تخفیف باید بعد از زمان شروع آن باشد')
}

export function validateStockedSizes(stock: number, sizes: number[]) {
  if (stock > 0 && sizes.length === 0) throw new ApiInputError('برای محصول موجود حداقل یک سایز لازم است')
}

export function imageField(value: unknown): string {
  const image = textField(value, 'آدرس تصویر', 2048)
  if (image.startsWith('/') && !image.startsWith('//')) return image
  try {
    const url = new URL(image)
    if (url.protocol === 'https:' || url.protocol === 'http:') return image
  } catch { /* Invalid URL falls through to the validation error. */ }
  throw new ApiInputError('آدرس تصویر نامعتبر است')
}

export function specificationsField(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value) || value.length > 30) throw new ApiInputError('مشخصات باید حداکثر ۳۰ ردیف داشته باشد')
  const seen = new Set<string>()
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ApiInputError('ردیف مشخصات نامعتبر است')
    const name = textField(row.name, 'نام مشخصه', 80)
    const content = textField(row.value, 'مقدار مشخصه', 500)
    if (name.includes('\u0000') || content.includes('\u0000')) throw new ApiInputError('ردیف مشخصات نامعتبر است')
    const key = name.toLocaleLowerCase('fa-IR').normalize('NFKC')
    if (seen.has(key)) throw new ApiInputError('نام مشخصه تکراری است')
    seen.add(key)
    return { name, value: content }
  })
}

export function productInput(body: Record<string, unknown>, creating = false) {
  const data: {
    name?: string; slug?: string; description?: string; price?: number;
    salePrice?: number | null; saleStartsAt?: Date | null; saleEndsAt?: Date | null;
    images?: string[]; categoryId?: string; sizes?: number[]; colors?: string[];
    stock?: number; featured?: boolean; specifications?: { name: string; value: string }[];
  } = {}
  if (creating || body.specifications !== undefined) data.specifications = specificationsField(body.specifications === undefined ? [] : body.specifications)
  if (creating || body.name !== undefined) data.name = textField(body.name, 'نام محصول', 300)
  if (body.slug !== undefined && body.slug !== '') data.slug = textField(body.slug, 'شناسه محصول', 300)
  else if (creating) data.slug = `${Date.now()}-${data.name!.replace(/\s+/g, '-').slice(0, 30)}`
  if (creating || body.description !== undefined) data.description = optionalText(body.description ?? '', 'توضیحات', 20_000) ?? ''
  if (creating || body.price !== undefined) data.price = integerField(body.price, 'قیمت', 1)
  if (body.salePrice !== undefined) data.salePrice = body.salePrice === null || body.salePrice === '' ? null : integerField(body.salePrice, 'قیمت بعد از تخفیف', 1)
  if (body.saleStartsAt !== undefined) data.saleStartsAt = saleDateField(body.saleStartsAt, 'زمان شروع تخفیف')
  if (body.saleEndsAt !== undefined) data.saleEndsAt = saleDateField(body.saleEndsAt, 'زمان پایان تخفیف')
  // Clearing a sale also clears its schedule, including partial API updates.
  if (data.salePrice === null) { data.saleStartsAt = null; data.saleEndsAt = null }
  if (creating || body.categoryId !== undefined) data.categoryId = textField(body.categoryId, 'دسته‌بندی', 200)
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || (!creating && body.images.length === 0) || body.images.length > 30) {
      throw new ApiInputError('حداقل یک تصویر معتبر برای محصول لازم است')
    }
    data.images = body.images.length ? body.images.map(imageField) : [defaultImage]
  } else if (creating) data.images = [defaultImage]
  if (body.sizes !== undefined) {
    if (!Array.isArray(body.sizes) || body.sizes.length > 100) throw new ApiInputError('سایزها نامعتبر هستند')
    data.sizes = [...new Set(body.sizes.map((size) => integerField(size, 'سایز', 1)))]
  } else if (creating) data.sizes = []
  if (body.colors !== undefined) {
    if (!Array.isArray(body.colors) || body.colors.length > 100) throw new ApiInputError('رنگ‌ها نامعتبر هستند')
    data.colors = [...new Set(body.colors.map((color) => textField(color, 'رنگ', 100)))]
  } else if (creating) data.colors = []
  if (creating || body.stock !== undefined) data.stock = integerField(body.stock === undefined ? 0 : body.stock, 'موجودی')
  if (creating || body.featured !== undefined) data.featured = booleanField(body.featured === undefined ? false : body.featured, 'محصول ویژه')
  if (data.stock !== undefined && data.sizes !== undefined) validateStockedSizes(data.stock, data.sizes)
  if (creating) validateProductSale(data)
  return data
}
