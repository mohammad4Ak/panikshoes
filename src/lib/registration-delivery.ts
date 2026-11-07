import {
  getRegistrationDeliveryReadiness,
  type RegistrationSettings,
} from './registration-settings'

interface RegistrationCodeMessage {
  channel: 'email' | 'sms'
  destination: string
  code: string
  expiresInMinutes: number
}

export async function sendRegistrationCode(settings: RegistrationSettings, message: RegistrationCodeMessage): Promise<void> {
  const { emailConfigured, smsConfigured } = getRegistrationDeliveryReadiness(settings)
  const emailKey = process.env.REGISTRATION_EMAIL_API_KEY?.trim()
  const smsKey = process.env.REGISTRATION_KAVENEGAR_API_KEY?.trim()

  try {
    if (message.channel === 'email' && emailConfigured && emailKey) {
      const response = await fetch('https://api.panikshoes.com/v1/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${emailKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: message.destination,
          from: settings.emailSender,
          subject: 'کد تأیید ثبت‌نام کفش پانیک',
          text: `کد تأیید ثبت‌نام شما: ${message.code}\n\nاین کد تا ${message.expiresInMinutes.toLocaleString('fa-IR')} دقیقه معتبر است. آن را در اختیار کسی نگذارید. اگر درخواست ثبت‌نام نداده‌اید، این پیام را نادیده بگیرید.`,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) return
    }

    if (message.channel === 'sms' && smsConfigured && smsKey) {
      const response = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(smsKey)}/verify/lookup.json`, {
        method: 'POST',
        body: new URLSearchParams({ receptor: message.destination, token: message.code, template: settings.smsTemplate, type: 'sms' }),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok && (await response.json())?.return?.status === 200) return
    }
  } catch {
    // Provider errors can include request URLs, credentials, or recipients.
  }

  throw new Error('Registration delivery failed')
}
