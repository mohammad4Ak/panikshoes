import { passwordResetCapabilities, passwordResetErrorResponse, passwordResetResponse, readPasswordResetBody, completePasswordReset } from '@/lib/password-reset'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET() {
  try { return passwordResetResponse(await passwordResetCapabilities()) }
  catch (error) { return passwordResetErrorResponse(error) }
}

export async function POST(request: Request) {
  try { return passwordResetResponse(await completePasswordReset(request, await readPasswordResetBody(request))) }
  catch (error) { return passwordResetErrorResponse(error) }
}
