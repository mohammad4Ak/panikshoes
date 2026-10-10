const HOST_AUTHORITY = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?(?::[0-9]{1,5})?$|^\[[0-9a-f:.]+\](?::[0-9]{1,5})?$/i

export function getRequestOrigin(request: Request): string {
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Invalid request protocol')
  }
  const host = request.headers.get('host')
  if (host === null) return url.origin
  if (!HOST_AUTHORITY.test(host)) throw new TypeError('Invalid request host')

  // Next's internal request URL can use localhost or its listening address.
  // Host is the authority the browser reached; forwarded headers are untrusted.
  const publicUrl = new URL(`${url.protocol}//${host}`)
  if (publicUrl.hostname.length > 254) throw new TypeError('Invalid request host')
  return publicUrl.origin
}

export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site === 'cross-site' || site === 'same-site') return false
  try {
    const requestOrigin = getRequestOrigin(request)
    const origin = request.headers.get('origin')
    return origin === null || origin === requestOrigin
  } catch {
    return false
  }
}
