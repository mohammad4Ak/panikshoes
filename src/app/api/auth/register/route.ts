import {
  readRegistrationBody, registrationErrorResponse, registrationResponse, verifyRegistrationCode,
} from '@/lib/registration-otp'
import { getRegistrationAvailability, readRegistrationSettings } from '@/lib/registration-settings'

export async function GET() {
  try {
    return registrationResponse(getRegistrationAvailability(await readRegistrationSettings()))
  } catch (error) {
    return registrationErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = await readRegistrationBody(request)
    return registrationResponse(await verifyRegistrationCode(request, body), 201)
  } catch (error) {
    return registrationErrorResponse(error)
  }
}
