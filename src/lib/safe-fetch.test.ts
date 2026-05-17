import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// `env` is imported by safe-fetch at module load to decide whether
// allowPrivate is honored. Hoist the mock so safe-fetch sees it on its
// own first import, and expose the object back to tests so the
// production-mode case below can flip NODE_ENV.
// The env object also feeds logger.ts (via the transitive ./env import), so
// supply the fields pino reads at module construction. Only NODE_ENV is
// load-bearing for safe-fetch's allowPrivate gate.
const envMock = vi.hoisted(() => ({
  env: { NODE_ENV: 'test' as string, LOG_LEVEL: 'silent' as string },
}))
vi.mock('./env', () => envMock)

// Mock the DNS resolver before safe-fetch imports it. Tests reach into
// this to seed responses per-test.
const dnsMock = vi.hoisted(() => ({
  lookup: vi.fn(),
}))
vi.mock('node:dns/promises', () => dnsMock)

const { safeFetch, SafeFetchError } = await import('./safe-fetch')

beforeEach(() => {
  envMock.env.NODE_ENV = 'test'
  dnsMock.lookup.mockReset()
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function fetchMock() {
  return globalThis.fetch as ReturnType<typeof vi.fn>
}

function okResponse(): Response {
  return new Response('ok', { status: 200 })
}

describe('safeFetch — scheme allow-list', () => {
  test.each([
    ['file:///etc/passwd'],
    ['gopher://example.com/'],
    ['ftp://example.com/'],
    ['javascript:alert(1)'],
  ])('rejects scheme %s with bad_scheme', async (url) => {
    await expect(safeFetch(url)).rejects.toMatchObject({
      code: 'bad_scheme',
    })
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  test('rejects invalid URL syntax with bad_scheme', async () => {
    await expect(safeFetch('not a url')).rejects.toBeInstanceOf(SafeFetchError)
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})

describe('safeFetch — literal IP rejection (no DNS round-trip)', () => {
  test.each([
    ['http://10.0.0.1/', 'RFC1918 10/8'],
    ['http://172.16.5.5/', 'RFC1918 172.16/12'],
    ['http://192.168.1.1/', 'RFC1918 192.168/16'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://169.254.169.254/', 'link-local / cloud metadata'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://224.0.0.1/', 'multicast'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fc00::1]/', 'IPv6 ULA'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[ff00::1]/', 'IPv6 multicast'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped IPv6 of private v4'],
  ])('rejects %s (%s) with private_address', async (url) => {
    await expect(safeFetch(url)).rejects.toMatchObject({
      code: 'private_address',
    })
    expect(dnsMock.lookup).not.toHaveBeenCalled()
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  test('public IPv4 literal is allowed', async () => {
    fetchMock().mockResolvedValueOnce(okResponse())
    await expect(safeFetch('http://8.8.8.8/')).resolves.toBeInstanceOf(Response)
    expect(dnsMock.lookup).not.toHaveBeenCalled()
    expect(fetchMock()).toHaveBeenCalledOnce()
  })

  test('public IPv6 literal is allowed (bracket-form host)', async () => {
    fetchMock().mockResolvedValueOnce(okResponse())
    // 2001:4860:4860::8888 is Google DNS — globally routable, not private.
    await expect(safeFetch('http://[2001:4860:4860::8888]/')).resolves.toBeInstanceOf(Response)
    expect(dnsMock.lookup).not.toHaveBeenCalled()
  })
})

describe('safeFetch — hostname resolution', () => {
  test('hostname that resolves to a public address is allowed', async () => {
    dnsMock.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    fetchMock().mockResolvedValueOnce(okResponse())

    await expect(safeFetch('http://example.com/')).resolves.toBeInstanceOf(Response)
    expect(dnsMock.lookup).toHaveBeenCalledWith('example.com', { all: true })
  })

  test('hostname that resolves to a private address is rejected', async () => {
    dnsMock.lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])

    await expect(safeFetch('http://internal-rebind.example/')).rejects.toMatchObject({
      code: 'private_address',
    })
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  test('hostname with one public + one private answer is rejected (DNS rebinding defense)', async () => {
    // The defense must reject if *any* resolved address is private, not just
    // the first one — otherwise an attacker controlling DNS could return a
    // public IP first and a private one second to bypass.
    dnsMock.lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])

    await expect(safeFetch('http://mixed.example/')).rejects.toMatchObject({
      code: 'private_address',
    })
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  test('DNS failure surfaces as dns_failure', async () => {
    dnsMock.lookup.mockRejectedValueOnce(new Error('ENOTFOUND'))

    await expect(safeFetch('http://nx.example/')).rejects.toMatchObject({
      code: 'dns_failure',
    })
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})

describe('safeFetch — redirects are re-validated', () => {
  test('redirect to a private address is blocked at hop 2', async () => {
    dnsMock.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    fetchMock().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.1/secrets' },
      }),
    )

    await expect(safeFetch('http://attacker.example/')).rejects.toMatchObject({
      code: 'private_address',
    })
    // First hop did fetch; the second hop's URL was rejected before fetch.
    expect(fetchMock()).toHaveBeenCalledOnce()
  })

  test('more than MAX_REDIRECTS hops throws too_many_redirects', async () => {
    dnsMock.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const redirect = (n: number) =>
      new Response(null, {
        status: 302,
        headers: { location: `http://hop${n}.example/` },
      })
    fetchMock()
      .mockResolvedValueOnce(redirect(1))
      .mockResolvedValueOnce(redirect(2))
      .mockResolvedValueOnce(redirect(3))
      .mockResolvedValueOnce(redirect(4))

    await expect(safeFetch('http://start.example/')).rejects.toMatchObject({
      code: 'too_many_redirects',
    })
  })

  test('redirect without a Location header returns the 3xx response as-is', async () => {
    dnsMock.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 304 }))

    const res = await safeFetch('http://cached.example/')
    expect(res.status).toBe(304)
  })
})

describe('safeFetch — allowPrivate flag', () => {
  test('allowPrivate=true permits localhost when NODE_ENV is not production', async () => {
    fetchMock().mockResolvedValueOnce(okResponse())
    await expect(
      safeFetch('http://127.0.0.1/', { allowPrivate: true }),
    ).resolves.toBeInstanceOf(Response)
  })

  test('allowPrivate=true is IGNORED in production', async () => {
    envMock.env.NODE_ENV = 'production'
    await expect(
      safeFetch('http://127.0.0.1/', { allowPrivate: true }),
    ).rejects.toMatchObject({
      code: 'private_address',
    })
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  test('allowPrivate=false (default) rejects localhost even outside production', async () => {
    await expect(safeFetch('http://127.0.0.1/')).rejects.toMatchObject({
      code: 'private_address',
    })
  })
})
