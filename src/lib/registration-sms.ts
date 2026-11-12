import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import type { RegistrationSettings } from './registration-settings'

type SmsConfiguration = Pick<RegistrationSettings,
  'smsApiUrl' | 'smsMethod' | 'smsBodyFormat' | 'smsBodyTemplate' | 'smsHeaders' | 'smsSuccessPath' | 'smsSuccessValue'>
interface TemplateValues { phone: string; code: string; template: string; apiKey: string }
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const placeholder = /\{\{(phone|code|template|apiKey)\}\}/g
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const forbiddenHeaders = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'keep-alive',
  'cookie', 'te', 'trailer', 'expect', 'content-encoding', 'accept-encoding', 'forwarded',
])
const maxRequestBytes = 16 * 1024
const maxResponseBytes = 32 * 1024

function invalidConfiguration(): never {
  throw new Error('Invalid SMS configuration')
}

function validateTemplate(value: string) {
  if (value.replace(placeholder, '').includes('{{') || value.replace(placeholder, '').includes('}}')) invalidConfiguration()
}

function substitute(value: string, values: TemplateValues, encode = false) {
  return value.replace(placeholder, (_match, key: keyof TemplateValues) => encode ? encodeURIComponent(values[key]) : values[key])
}

function isPublicAddress(value: string) {
  if (!isIP(value)) return false
  const address = ipaddr.parse(value)
  if (address.range() !== 'unicast') return false
  // Allow only currently assigned IPv6 global unicast space, excluding transition ranges.
  return address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3)
}

function templateUrl(value: string) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\#]/u.test(value)) invalidConfiguration()
  validateTemplate(value)
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority || authority.includes('{{') || authority.includes('}}')) invalidConfiguration()
  const url = new URL(substitute(value, { phone: 'phone', code: 'code', template: 'template', apiKey: 'key' }, true))
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) invalidConfiguration()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname) && !isPublicAddress(hostname)) invalidConfiguration()
  if (!isIP(hostname) && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)\.?$/i.test(hostname))) invalidConfiguration()
  // Query parameter names remain literal. Only parameter values may contain placeholders.
  const query = value.split('?')[1]
  if (query) for (const entry of query.split('&')) if (entry.split('=')[0].includes('{{')) invalidConfiguration()
  return url
}

function parseBody(settings: SmsConfiguration): { [key: string]: JsonValue } {
  if (typeof settings.smsBodyTemplate !== 'string' || settings.smsBodyTemplate.length > maxRequestBytes) invalidConfiguration()
  const body: unknown = JSON.parse(settings.smsBodyTemplate || '{}')
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalidConfiguration()
  let nodes = 0
  function validate(value: unknown, depth: number) {
    if (++nodes > 200 || depth > 8) invalidConfiguration()
    if (typeof value === 'string') {
      if (value.length > 4000) invalidConfiguration()
      validateTemplate(value)
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      invalidConfiguration()
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (forbiddenKeys.has(key) || key.includes('{{') || key.includes('}}')) invalidConfiguration()
        validate(entry, depth + 1)
      }
    }
  }
  validate(body, 0)
  if (settings.smsBodyFormat === 'form' && Object.values(body).some(value => value !== null && typeof value === 'object')) invalidConfiguration()
  return body as { [key: string]: JsonValue }
}

function successRule(settings: SmsConfiguration) {
  const path = settings.smsSuccessPath
  if (typeof path !== 'string' || typeof settings.smsSuccessValue !== 'string' || path.length > 200 || settings.smsSuccessValue.length > 4000) invalidConfiguration()
  if (!path) return null
  const segments = path.split('.')
  if (segments.length > 8 || segments.some(segment => !/^[a-zA-Z0-9_-]+$/.test(segment) || forbiddenKeys.has(segment))) invalidConfiguration()
  const expected: unknown = JSON.parse(settings.smsSuccessValue)
  if ((expected !== null && typeof expected === 'object') || (typeof expected === 'number' && !Number.isFinite(expected))) invalidConfiguration()
  return { segments, expected }
}

export function validateCustomSmsConfiguration(settings: SmsConfiguration): void {
  templateUrl(settings.smsApiUrl)
  if (settings.smsMethod !== 'GET' && settings.smsMethod !== 'POST') invalidConfiguration()
  if (settings.smsBodyFormat !== 'json' && settings.smsBodyFormat !== 'form') invalidConfiguration()
  const body = parseBody(settings)
  if (!Array.isArray(settings.smsHeaders) || settings.smsHeaders.length > 20) invalidConfiguration()
  const names = new Set<string>()
  let headerBytes = 0
  for (const header of settings.smsHeaders) {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/i.test(header.name) || header.value.length > 4000) invalidConfiguration()
    const name = header.name.toLowerCase()
    if (names.has(name) || forbiddenKeys.has(name) || forbiddenHeaders.has(name) || name.startsWith('x-forwarded-') ||
        name.startsWith('proxy-') || /[^\x20-\x7e]/.test(header.value)) invalidConfiguration()
    names.add(name)
    validateTemplate(header.value)
    headerBytes += Buffer.byteLength(header.name + header.value) + 4
  }
  if (headerBytes > maxRequestBytes) invalidConfiguration()
  const used = settings.smsApiUrl + settings.smsHeaders.map(header => header.value).join('') + (settings.smsMethod === 'POST' ? JSON.stringify(body) : '')
  if (!used.includes('{{phone}}') || !used.includes('{{code}}')) invalidConfiguration()
  successRule(settings)
}

function substituteBody(value: JsonValue, values: TemplateValues): JsonValue {
  if (typeof value === 'string') return substitute(value, values)
  if (Array.isArray(value)) return value.map(entry => substituteBody(entry, values))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteBody(entry, values)]))
  return value
}

async function resolvePublicAddress(hostname: string) {
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, order: 'ipv4first' }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 2000) }),
    ])
    if (!addresses.length || addresses.length > 32 || addresses.some(entry => !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) invalidConfiguration()
    return addresses[0]
  } finally {
    clearTimeout(timer)
  }
}

async function pinnedRequest(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body: string) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const address = await resolvePublicAddress(hostname)
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [address])
    else callback(null, address.address, address.family)
  }
  return new Promise<string>((resolve, reject) => {
    const outgoing = request(url, {
      method, headers, lookup: pinnedLookup, agent: false, family: address.family,
      rejectUnauthorized: true, maxHeaderSize: 16 * 1024, signal: AbortSignal.timeout(6000),
    }, incoming => {
      if (!incoming.statusCode || incoming.statusCode < 200 || incoming.statusCode >= 300) {
        incoming.destroy()
        reject(new Error('SMS response rejected'))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxResponseBytes) {
          incoming.destroy()
          outgoing.destroy()
          reject(new Error('SMS response too large'))
          return
        }
        chunks.push(chunk)
      })
      incoming.on('error', reject)
      incoming.on('aborted', () => reject(new Error('SMS response interrupted')))
      incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    outgoing.on('error', reject)
    outgoing.end(body || undefined)
  })
}

export async function sendCustomRegistrationSms(settings: SmsConfiguration, values: TemplateValues): Promise<void> {
  validateCustomSmsConfiguration(settings)
  const url = new URL(substitute(settings.smsApiUrl, values, true))
  const headers: Record<string, string> = { accept: 'application/json' }
  let headerBytes = 0
  for (const header of settings.smsHeaders) {
    const value = substitute(header.value, values)
    if (value.length > 4000 || /[^\x20-\x7e]/.test(value)) invalidConfiguration()
    headerBytes += Buffer.byteLength(header.name + value) + 4
    headers[header.name.toLowerCase()] = value
  }
  if (headerBytes > maxRequestBytes) invalidConfiguration()
  let body = ''
  if (settings.smsMethod === 'POST') {
    const object = substituteBody(parseBody(settings), values) as { [key: string]: JsonValue }
    body = settings.smsBodyFormat === 'json' ? JSON.stringify(object)
      : new URLSearchParams(Object.entries(object).map(([key, value]) => [key, value === null ? '' : String(value)])).toString()
    headers['content-type'] ??= settings.smsBodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded'
  }
  if (Buffer.byteLength(body) > maxRequestBytes || url.href.length > 8192) invalidConfiguration()
  const response = await pinnedRequest(url, settings.smsMethod, headers, body)
  const rule = successRule(settings)
  if (rule) {
    let result: unknown = JSON.parse(response)
    for (const segment of rule.segments) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, segment)) throw new Error('SMS response rejected')
      result = (result as Record<string, unknown>)[segment]
    }
    if (!Object.is(result, rule.expected)) throw new Error('SMS response rejected')
  }
}
