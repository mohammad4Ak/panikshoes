import { Prisma } from '@prisma/client'
import { ApiInputError } from './api-input'
import { toAsciiDigits } from './localized-input'

export const CATALOG_SEARCH_MAX_LENGTH = 200

/** Product queries use the same literal substring matching in the shop and header. */
export function catalogSearchCondition(value: string): Prisma.Sql {
  if (value.length > CATALOG_SEARCH_MAX_LENGTH || value.includes('\0')) {
    throw new ApiInputError('عبارت جست‌وجو نامعتبر یا بیش از حد طولانی است.')
  }
  const query = toAsciiDigits(value.trim()).replace(/ك/g, 'ک').replace(/ي/g, 'ی')
  if (!query) return Prisma.sql`TRUE`

  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
  const source = '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩كي'
  const target = '01234567890123456789کی'
  return Prisma.sql`(
    translate(p."code", ${source}, ${target}) ILIKE ${pattern}
    OR translate(p."name", ${source}, ${target}) ILIKE ${pattern}
    OR translate(p."slug", ${source}, ${target}) ILIKE ${pattern}
    OR translate(p."description", ${source}, ${target}) ILIKE ${pattern}
  )`
}
