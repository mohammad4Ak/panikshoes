import { after } from 'next/server'
import { passwordResetErrorResponse, passwordResetResponse, readPasswordResetBody, requestPasswordResetCode } from '@/lib/password-reset'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request) {
  try {
    const issued = await requestPasswordResetCode(request, await readPasswordResetBody(request))
    after(issued.deliver)
    return passwordResetResponse(issued.result)
  } catch (error) { return passwordResetErrorResponse(error) }
}
