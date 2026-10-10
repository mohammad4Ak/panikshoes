export const MAX_SHIPPING_AMOUNT = 2_147_483_647

export interface ShippingMethodInput {
  name: string
  description: string | null
  baseCost: number
  additionalItemCost: number
  freeShippingThreshold: number | null
  isActive: boolean
  sortOrder: number
}

export interface ShippingMethodOption extends ShippingMethodInput {
  id: string
}

export class ShippingValidationError extends Error {}

function validAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SHIPPING_AMOUNT
}

/** Prices are in toman. Count pairs across all cart lines, including repeated quantities. */
export function calculateShippingCost(
  method: Pick<ShippingMethodInput, 'baseCost' | 'additionalItemCost' | 'freeShippingThreshold'>,
  subtotal: number,
  itemCount: number,
): number {
  if (!validAmount(subtotal) || !Number.isSafeInteger(itemCount) || itemCount < 1 || itemCount > MAX_SHIPPING_AMOUNT) {
    throw new ShippingValidationError('مبلغ یا تعداد محصولات معتبر نیست')
  }
  if (!validAmount(method.baseCost) || !validAmount(method.additionalItemCost) ||
    (method.freeShippingThreshold !== null && !validAmount(method.freeShippingThreshold))) {
    throw new ShippingValidationError('تعرفهٔ ارسال معتبر نیست')
  }
  if (method.freeShippingThreshold !== null && subtotal >= method.freeShippingThreshold) return 0

  const cost = method.baseCost + method.additionalItemCost * (itemCount - 1)
  if (!validAmount(cost)) throw new ShippingValidationError('هزینهٔ ارسال از سقف مجاز بیشتر است')
  return cost
}

/** Full create/update payload; numeric strings, fractions and negative rates are rejected. */
export function parseShippingMethodInput(input: unknown): ShippingMethodInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ShippingValidationError('اطلاعات روش ارسال معتبر نیست')
  }
  const value = input as Record<string, unknown>
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80) {
    throw new ShippingValidationError('نام روش ارسال را وارد کنید (حداکثر ۸۰ نویسه)')
  }
  if (!validAmount(value.baseCost) || !validAmount(value.additionalItemCost)) {
    throw new ShippingValidationError('هزینه‌ها باید مبلغ صحیح و نامنفی به تومان باشند')
  }
  const threshold = value.freeShippingThreshold ?? null
  if (threshold !== null && !validAmount(threshold)) {
    throw new ShippingValidationError('حد ارسال رایگان باید مبلغ صحیح و نامنفی باشد')
  }
  if (typeof value.isActive !== 'boolean') {
    throw new ShippingValidationError('وضعیت فعال بودن روش ارسال معتبر نیست')
  }
  const sortOrder = value.sortOrder ?? 0
  if (typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    throw new ShippingValidationError('ترتیب نمایش باید عدد صحیح بین صفر تا یک میلیون باشد')
  }
  if (value.description != null && (typeof value.description !== 'string' || value.description.trim().length > 500)) {
    throw new ShippingValidationError('توضیح روش ارسال باید متن کوتاه حداکثر ۵۰۰ نویسه باشد')
  }
  return {
    name: value.name.trim(),
    description: typeof value.description === 'string' ? value.description.trim() || null : null,
    baseCost: value.baseCost,
    additionalItemCost: value.additionalItemCost,
    freeShippingThreshold: threshold,
    isActive: value.isActive,
    sortOrder,
  }
}
