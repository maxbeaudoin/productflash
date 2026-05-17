import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { env } from './env'
import { logger } from './logger'

// Server-side fetch wrapper for user-influenced URLs (e.g. RSS autodetect on
// /app/profile addCompetitor). Without this, an authenticated beta user could
// submit a URL like http://10.x.y.z/ or http://169.254.169.254/ and use the
// app as an HTTP probe into Railway's internal network.
//
// Defenses:
//   1. Scheme allow-list (http/https only — kills file://, gopher://, …).
//   2. DNS-resolve the host, reject any address in loopback / link-local /
//      RFC1918 / ULA / multicast / unspecified ranges.
//   3. redirect: 'manual' + a hop counter — every redirect target is
//      re-validated through the same checks, so attacker.tld → 302 →
//      http://10.x.y.z/ is blocked at hop 2.
//
// In dev, `{ allowPrivate: true }` opts out (localhost test feeds, etc.).
// Default is reject. Production never honors the flag.

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

export interface SafeFetchOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  method?: 'GET' | 'HEAD'
  // Dev-only escape hatch for local test fixtures pointing at localhost.
  // Ignored in production.
  allowPrivate?: boolean
}

export class SafeFetchError extends Error {
  readonly code: 'bad_scheme' | 'private_address' | 'dns_failure' | 'too_many_redirects' | 'http_error' | 'timeout'
  readonly url: string
  constructor(code: SafeFetchError['code'], url: string, message: string) {
    super(message)
    this.code = code
    this.url = url
  }
}

export async function safeFetch(
  inputUrl: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let url = inputUrl
    let hops = 0
    while (true) {
      await assertSafeUrl(url, options.allowPrivate ?? false)
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        redirect: 'manual',
        signal: controller.signal,
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) return res
        hops++
        if (hops > MAX_REDIRECTS) {
          throw new SafeFetchError('too_many_redirects', url, `safeFetch: > ${MAX_REDIRECTS} redirects`)
        }
        url = new URL(location, url).toString()
        continue
      }
      return res
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SafeFetchError('timeout', inputUrl, `safeFetch: timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function safeFetchText(
  url: string,
  options: SafeFetchOptions = {},
): Promise<string> {
  const res = await safeFetch(url, options)
  if (!res.ok) {
    throw new SafeFetchError('http_error', url, `safeFetch: HTTP ${res.status} for ${url}`)
  }
  return await res.text()
}

async function assertSafeUrl(url: string, allowPrivate: boolean): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SafeFetchError('bad_scheme', url, `safeFetch: invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SafeFetchError('bad_scheme', url, `safeFetch: scheme ${parsed.protocol} not allowed`)
  }
  const allowPrivateEffective = allowPrivate && env.NODE_ENV !== 'production'

  // If the host is a literal IP, validate it directly — skip the DNS lookup
  // (which would otherwise round-trip and may not behave predictably for
  // numeric input depending on system resolver).
  //
  // WHATWG URL keeps IPv6 hosts wrapped in `[...]` (e.g. `[::1]`), and
  // `isIP` doesn't accept that bracket form. Strip the brackets before the
  // IP check so `http://[::1]/` is recognized as a literal IPv6 — without
  // this, the function falls through to DNS, where lookup happens to fail
  // and the user sees `dns_failure` instead of the correct `private_address`.
  const literal = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  const family = isIP(literal)
  if (family !== 0) {
    if (!allowPrivateEffective && isPrivateAddress(literal, family)) {
      throw new SafeFetchError('private_address', url, `safeFetch: ${literal} is a private address`)
    }
    return
  }

  let addrs: LookupAddress[]
  try {
    addrs = await lookup(parsed.hostname, { all: true })
  } catch (err) {
    logger.debug({ err, host: parsed.hostname }, 'safeFetch: DNS lookup failed')
    throw new SafeFetchError('dns_failure', url, `safeFetch: DNS lookup failed for ${parsed.hostname}`)
  }
  for (const addr of addrs) {
    if (!allowPrivateEffective && isPrivateAddress(addr.address, addr.family)) {
      throw new SafeFetchError(
        'private_address',
        url,
        `safeFetch: ${parsed.hostname} resolves to private address ${addr.address}`,
      )
    }
  }
}

// IPv4: loopback 127.0.0.0/8, RFC1918 10/8, 172.16/12, 192.168/16, link-local
// 169.254/16, CGNAT 100.64/10, multicast 224/4, broadcast 255.255.255.255,
// unspecified 0.0.0.0.
// IPv6: loopback ::1, unspecified ::, link-local fe80::/10, ULA fc00::/7,
// multicast ff00::/8, IPv4-mapped ::ffff:0:0/96 (re-validate the inner v4).
function isPrivateAddress(addr: string, family: number): boolean {
  if (family === 4) {
    const octets = addr.split('.').map((o) => Number(o))
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true
    const [a, b] = octets
    if (a === 0) return true
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const lower = addr.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('ff')) return true
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice('::ffff:'.length)
      // Node's WHATWG URL normalizes the embedded v4 from dotted form
      // (`::ffff:10.0.0.1`) to compact hex (`::ffff:a00:1`), so both forms
      // arrive here. Resolve either back to dotted v4 before delegating
      // to the v4 check.
      const dotted = ipv4MappedToDotted(tail)
      if (dotted) return isPrivateAddress(dotted, 4)
    }
    return false
  }
  return true
}

function ipv4MappedToDotted(tail: string): string | null {
  if (isIP(tail) === 4) return tail
  // Hex form: up to two `:`-separated 16-bit groups encoding the 32-bit v4.
  // Either "a00:1" (full) or "1" (when leading zeros compress). Accept both.
  const groups = tail.split(':')
  if (groups.length > 2) return null
  if (groups.some((g) => g === '' || !/^[0-9a-f]{1,4}$/.test(g))) return null
  const padded = groups.length === 1 ? ['0', groups[0]!] : groups
  const hi = parseInt(padded[0]!, 16)
  const lo = parseInt(padded[1]!, 16)
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.')
}
