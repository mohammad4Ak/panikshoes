import type { Prisma, PrismaClient } from '@prisma/client'
import { customerContactComplete } from './customer-contact'

export class CheckoutProfileError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message) }
}

function checkContact(user: { phone: string | null; postalCode: string | null; isActive: boolean } | null | undefined) {
  if (!user || !user.isActive) throw new CheckoutProfileError('این حساب غیرفعال است؛ با پشتیبانی تماس بگیرید.', 403, 'ACCOUNT_INACTIVE')
  if (!customerContactComplete(user.phone, user.postalCode)) {
    throw new CheckoutProfileError('پیش از ثبت سفارش، شماره تلفن و کدپستی معتبر را در حساب کاربری ثبت کنید.', 409, 'PROFILE_INCOMPLETE')
  }
  return user
}

export async function readCheckoutProfile(client: Pick<PrismaClient, 'user'>, userId: string) {
  return checkContact(await client.user.findUnique({ where: { id: userId }, select: { phone: true, postalCode: true, isActive: true } }))
}

/** Keep contact edits/blocking serialized with the purchase that uses the account. */
export async function requireCheckoutProfile(tx: Prisma.TransactionClient, userId: string) {
  const users = await tx.$queryRaw<{ phone: string | null; postalCode: string | null; isActive: boolean }[]>`
    SELECT "phone", "postalCode", "isActive" FROM "User" WHERE "id" = ${userId} FOR SHARE
  `
  return checkContact(users[0])
}
