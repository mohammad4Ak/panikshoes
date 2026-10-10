import type { Prisma } from '@prisma/client'
import { serializableTransaction } from './serializable-transaction'

// Default-address selection reads and writes the entire address set. Serializable
// transactions prevent two simultaneous requests from both becoming the default.
export async function addressTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return serializableTransaction(operation)
}

export async function ensureDefaultAddress(tx: Prisma.TransactionClient, userId: string, preferredId?: string) {
  const current = await tx.address.findFirst({ where: { userId, isDefault: true } })
  if (current) return
  const remaining = await tx.address.findFirst({
    where: { userId, ...(preferredId && { id: { not: preferredId } }) }, orderBy: { createdAt: 'desc' },
  }) ?? (preferredId ? await tx.address.findFirst({ where: { id: preferredId, userId } }) : null)
  if (remaining) await tx.address.update({ where: { id: remaining.id }, data: { isDefault: true } })
}
