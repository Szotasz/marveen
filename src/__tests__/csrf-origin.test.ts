import { describe, it, expect } from 'vitest'
import { isSafeMethod, originMatchesServedHost, isBlockedCrossOriginWrite, buildAllowedHosts, isAllowedHost } from '../web/csrf-origin.js'

const allow = new Set(['http://localhost:3420', 'http://127.0.0.1:3420'])
const TS = 'proxy-host.example.ts.net'
const TS_ORIGIN = `https://${TS}`

describe('isSafeMethod', () => {
  it('treats GET/HEAD/OPTIONS as safe, others as unsafe', () => {
    expect(isSafeMethod('GET')).toBe(true)
    expect(isSafeMethod('HEAD')).toBe(true)
    expect(isSafeMethod('OPTIONS')).toBe(true)
    expect(isSafeMethod('POST')).toBe(false)
    expect(isSafeMethod('DELETE')).toBe(false)
  })
})

describe('originMatchesServedHost', () => {
  it('matches when Origin host equals the Host header (Tailscale preserves Host)', () => {
    expect(originMatchesServedHost(TS_ORIGIN, TS, undefined)).toBe(true)
  })
  it('matches via X-Forwarded-Host when the proxy rewrites Host', () => {
    expect(originMatchesServedHost(TS_ORIGIN, '127.0.0.1:3420', TS)).toBe(true)
  })
  it('uses the first X-Forwarded-Host hop', () => {
    expect(originMatchesServedHost(TS_ORIGIN, '127.0.0.1:3420', `${TS}, proxy2`)).toBe(true)
  })
  it('does NOT match a foreign origin', () => {
    expect(originMatchesServedHost('https://evil.example.com', TS, TS)).toBe(false)
  })
  it('returns false for a malformed origin', () => {
    expect(originMatchesServedHost('not-a-url', TS, undefined)).toBe(false)
  })
})

describe('isBlockedCrossOriginWrite', () => {
  it('allows safe methods regardless of origin', () => {
    expect(isBlockedCrossOriginWrite('GET', 'https://evil.example.com', 'x', undefined, allow)).toBe(false)
  })
  it('allows writes with no Origin header (same-origin browsers omit it)', () => {
    expect(isBlockedCrossOriginWrite('POST', undefined, '127.0.0.1:3420', undefined, allow)).toBe(false)
  })
  it('allows writes from an allowlisted origin', () => {
    expect(isBlockedCrossOriginWrite('POST', 'http://localhost:3420', 'localhost:3420', undefined, allow)).toBe(false)
  })
  it('allows the Tailscale Serve PWA (same-origin via Host) -- the bug fix', () => {
    expect(isBlockedCrossOriginWrite('POST', TS_ORIGIN, TS, undefined, allow)).toBe(false)
  })
  it('allows the Tailscale Serve PWA (same-origin via X-Forwarded-Host)', () => {
    expect(isBlockedCrossOriginWrite('POST', TS_ORIGIN, '127.0.0.1:3420', TS, allow)).toBe(false)
  })
  it('STILL blocks a genuine cross-site write (CSRF stays defended)', () => {
    expect(isBlockedCrossOriginWrite('POST', 'https://evil.example.com', TS, TS, allow)).toBe(true)
  })
})

describe('buildAllowedHosts', () => {
  const origins = new Set([
    'http://localhost:3420',
    'http://127.0.0.1:3420',
    `https://${TS}`,
  ])
  const hosts = buildAllowedHosts(origins)

  it('includes bare hostname and host:port for each origin', () => {
    expect(hosts.has('localhost')).toBe(true)
    expect(hosts.has('localhost:3420')).toBe(true)
    expect(hosts.has('127.0.0.1')).toBe(true)
    expect(hosts.has('127.0.0.1:3420')).toBe(true)
    expect(hosts.has(TS)).toBe(true)
  })

  it('does not include unrelated hosts', () => {
    expect(hosts.has('evil.example.com')).toBe(false)
  })

  it('skips malformed origin entries without throwing', () => {
    const h = buildAllowedHosts(new Set(['not-a-url', 'http://localhost:3420']))
    expect(h.has('localhost')).toBe(true)
    expect(h.has('localhost:3420')).toBe(true)
  })
})

describe('isAllowedHost', () => {
  const hosts = buildAllowedHosts(new Set([
    'http://localhost:3420',
    'http://127.0.0.1:3420',
    `https://${TS}`,
  ]))

  it('allows localhost with port', () => {
    expect(isAllowedHost('localhost:3420', hosts)).toBe(true)
  })

  it('allows localhost without port (bare hostname match)', () => {
    expect(isAllowedHost('localhost', hosts)).toBe(true)
  })

  it('allows 127.0.0.1 with port', () => {
    expect(isAllowedHost('127.0.0.1:3420', hosts)).toBe(true)
  })

  it('allows 127.0.0.1 without port', () => {
    expect(isAllowedHost('127.0.0.1', hosts)).toBe(true)
  })

  it('allows a configured reverse-proxy host', () => {
    expect(isAllowedHost(TS, hosts)).toBe(true)
  })

  it('blocks a foreign host (DNS-rebinding attempt)', () => {
    expect(isAllowedHost('evil.attacker.com', hosts)).toBe(false)
  })

  it('blocks a foreign host with port', () => {
    expect(isAllowedHost('evil.attacker.com:3420', hosts)).toBe(false)
  })

  it('returns false when host header is absent', () => {
    expect(isAllowedHost(undefined, hosts)).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isAllowedHost('', hosts)).toBe(false)
  })
})

// ── IPv6 edge cases ────────────────────────────────────────────────────────────

describe('buildAllowedHosts with IPv6 origin', () => {
  // http://[::1]:3420 is the correct bracketed form for an IPv6 loopback origin.
  // new URL('http://::1:3420') would throw; the WEB_HOST bracketing in web.ts
  // ensures the origin is always well-formed before reaching here.
  // Node.js URL returns u.hostname = "[::1]" (with brackets) for IPv6.
  const ipv6Hosts = buildAllowedHosts(new Set(['http://[::1]:3420']))

  it('includes bracketed IPv6 hostname from u.hostname', () => {
    expect(ipv6Hosts.has('[::1]')).toBe(true)
  })

  it('extracts host:port in bracket notation', () => {
    expect(ipv6Hosts.has('[::1]:3420')).toBe(true)
  })

  it('does not include malformed bracket-less raw IPv6', () => {
    // http://::1:3420 is malformed and skipped; the set should be empty.
    const bad = buildAllowedHosts(new Set(['http://::1:3420']))
    expect(bad.size).toBe(0)
  })
})

describe('isAllowedHost with IPv6 bracket notation', () => {
  const ipv6Hosts = buildAllowedHosts(new Set(['http://[::1]:3420']))

  it('allows [::1]:3420 (direct match)', () => {
    expect(isAllowedHost('[::1]:3420', ipv6Hosts)).toBe(true)
  })

  it('allows [::1] without port (bare IPv6 fallback)', () => {
    // Clients on port 80/443 omit the port; the bare ::1 must match.
    expect(isAllowedHost('[::1]', ipv6Hosts)).toBe(true)
  })

  it('blocks a foreign host that happens to contain colons', () => {
    // A crafted host like [fe80::1]:3420 must NOT be allowed just because
    // the bare extraction succeeds -- fe80::1 is not ::1.
    const foreign = buildAllowedHosts(new Set(['http://[::1]:3420']))
    expect(isAllowedHost('[fe80::1]:3420', foreign)).toBe(false)
  })
})
