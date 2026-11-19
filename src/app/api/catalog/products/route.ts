import { ApiInputError } from '@/lib/api-input'
import { toAsciiDigits } from '@/lib/localized-input'
import { expireUnpaidOrders } from '@/lib/payments'
import { readPublicCatalog } from '@/lib/public-catalog'

const headers = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
  try {
    // Release expired reservations before taking the first stock snapshot,
    // as the original catalog endpoint does on each visit.
    const params = new URL(request.url).searchParams
    if (toAsciiDigits(params.get('page') ?? '1') === '1') await expireUnpaidOrders()
    return Response.json(await readPublicCatalog(params), { headers })
  } catch (error) {
    const message = error instanceof ApiInputError ? error.message : 'دریافت ویترین انجام نشد. دوباره تلاش کن.'
    return Response.json({ error: message }, { status: error instanceof ApiInputError ? error.status : 500, headers })
  }
}
