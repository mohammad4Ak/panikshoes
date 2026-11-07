import {
  readRegistrationBody, registrationErrorResponse, registrationResponse, requestRegistrationCode,
} from '@/lib/registration-otp'

export async function POST(request: Request) {
  try {
    const body = await readRegistrationBody(request)
    return registrationResponse(await requestRegistrationCode(request, body))
  } catch (error) {
    return registrationErrorResponse(error)
  }
}
