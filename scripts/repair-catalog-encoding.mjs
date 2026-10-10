import { PrismaClient } from '@prisma/client'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Reverse UTF-8 bytes mistakenly decoded as IBM CP437. Never guess missing bytes.
const highChars = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
const codePage = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).concat([...highChars])
const bytesByChar = new Map(codePage.map((char, i) => [char, i]))
const utf8 = new TextDecoder('utf-8', { fatal: true })

export function recoverText(value) {
  if (!/[╪┌┘█]/u.test(value)) return value
  const bytes = [...value].map((char) => bytesByChar.get(char))
  if (bytes.some((byte) => byte === undefined)) throw new Error('Mixed or unsupported encoding; manual review required')
  const repaired = utf8.decode(Uint8Array.from(bytes))
  if (!/[\u0600-\u06ff]/u.test(repaired)) throw new Error('Decoded text is not Persian; manual review required')
  const roundTrip = [...Buffer.from(repaired, 'utf8')].map((byte) => codePage[byte]).join('')
  if (roundTrip !== value) throw new Error('Encoding round-trip failed')
  return repaired
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const [products, categories] = await Promise.all([
      prisma.product.findMany({ select: { id: true, name: true, description: true, colors: true, updatedAt: true } }),
      prisma.category.findMany({ select: { id: true, name: true } }),
    ])
    const changes = []
    for (const [model, records, fields] of [
      ['product', products, ['name', 'description', 'colors']],
      ['category', categories, ['name']],
    ]) {
      for (const record of records) {
        const before = {}, after = {}
        for (const field of fields) {
          const original = record[field]
          const repaired = Array.isArray(original) ? original.map(recoverText) : recoverText(original)
          if (JSON.stringify(original) !== JSON.stringify(repaired)) {
            before[field] = original
            after[field] = repaired
          }
        }
        if (Object.keys(after).length) changes.push({ model, id: record.id, before, after, updatedAt: record.updatedAt })
      }
    }
    console.log(JSON.stringify(changes.map(({ model, after }) => ({ model, ...after })), null, 2))
    console.log(`${changes.length} catalog records need repair.`)
    if (!process.argv.includes('--apply') || !changes.length) return

    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local-backups')
    await mkdir(directory, { recursive: true })
    const backupPath = path.join(directory, `catalog-encoding-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify(changes, null, 2), { flag: 'wx' })
    console.log(`Backup: ${backupPath}`)
    await prisma.$transaction(async (tx) => {
      for (const { model, id, before, after, updatedAt } of changes) {
        const where = { id, ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {}), ...before }
        if (Array.isArray(where.colors)) where.colors = { equals: where.colors }
        const result = await tx[model].updateMany({ where, data: after })
        if (result.count !== 1) throw new Error(`Record changed during repair: ${model} ${id}. Rolled back.`)
      }
    })
    console.log(`Repaired ${changes.length} records atomically.`)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
