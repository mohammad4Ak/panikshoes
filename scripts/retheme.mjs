import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

function walk(dir) {
  let out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out = out.concat(walk(p))
    else if (/\.(tsx?|css)$/.test(name)) out.push(p)
  }
  return out
}

// ترتیب مهم: طولانیترین اول
const classRenames = [
  [/leather-dark/g, 'night'],
  [/leather-light/g, 'mist'],
  [/terracotta-dark/g, 'brand-strong'],
  [/terracotta/g, 'brand'],
  [/cream/g, 'fog'],
  [/\bsand\b/g, 'line'],
]

// رنگهای هاردکد داخل استایلها/نمودارها
const hexRenames = [
  [/#C75B39/g, '#4F46E5'],
  [/#4338CA/g, '#4338CA'], // no-op، برای صراحت
  [/#8B6F47/g, '#64748B'],
  [/#2C1810/g, '#0F172A'],
  [/#D4C5A9/g, '#E4E7EC'],
  [/rgba\(212,\s*197,\s*169,/g, 'rgba(228,231,236,'],
  [/rgba\(199,\s*91,\s*57,/g, 'rgba(79,70,229,'],
]

const files = walk('src')
let changed = 0
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  let after = before
  for (const [pattern, replacement] of [...classRenames, ...hexRenames]) {
    after = after.replace(pattern, replacement)
  }
  // اصلاح دوبارهی brand-strong که از terracotta-dark میآمد -> brand.strong معادل کلاسش وجود ندارد؛ به brand برگردانده میشود اگر بود
  after = after.replace(/brand-strong/g, 'brand')
  if (after !== before) {
    writeFileSync(file, after, 'utf8')
    changed++
    console.log('re-themed:', file)
  }
}
console.log(`done - ${changed} files`)
