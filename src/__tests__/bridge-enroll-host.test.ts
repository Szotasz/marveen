// BRIDGEHOST1 -- enroll host selection. The Bridge exists for REMOTE access,
// so the default host must prefer the tailnet (CGNAT 100.64.0.0/10) address
// over interface-order luck. The live failure this guards: the fleet host's
// en0 (192.168.0.246, LAN) preceded utun4 (100.115.9.11, Tailscale) in
// interface order, the bundle shipped the LAN address, and the Bridge died
// with a handshake timeout the moment the laptop left the home network.
import { describe, it, expect } from 'vitest'
import { isTailnetIPv4, isZeroTierIfaceName, selectEnrollHost } from '../web/bridge-enroll.js'

type Iface = { address: string; family: string | number; internal: boolean }
const v4 = (address: string, internal = false): Iface => ({ address, family: 'IPv4', internal })
const v6 = (address: string): Iface => ({ address, family: 'IPv6', internal: false })

describe('isTailnetIPv4 (CGNAT 100.64.0.0/10 boundaries)', () => {
  it('accepts the range, including both edges', () => {
    expect(isTailnetIPv4('100.64.0.0')).toBe(true)
    expect(isTailnetIPv4('100.115.9.11')).toBe(true)
    expect(isTailnetIPv4('100.127.255.255')).toBe(true)
  })
  it('rejects 100.x addresses OUTSIDE the /10', () => {
    expect(isTailnetIPv4('100.63.255.255')).toBe(false)
    expect(isTailnetIPv4('100.128.0.0')).toBe(false)
  })
  it('rejects non-100 and non-IPv4 shapes', () => {
    expect(isTailnetIPv4('192.168.0.246')).toBe(false)
    expect(isTailnetIPv4('10.64.0.1')).toBe(false)
    expect(isTailnetIPv4('fd7a:115c::1')).toBe(false)
    expect(isTailnetIPv4('')).toBe(false)
  })
})

describe('isZeroTierIfaceName (Linux "zt" + id interface naming)', () => {
  it('accepts the live case (elvis-marveen network, measured 2026-11-03)', () => {
    expect(isZeroTierIfaceName('ztdiyqolon')).toBe(true)
  })
  it('is case-insensitive and accepts short-ish ids', () => {
    expect(isZeroTierIfaceName('ZTabc123')).toBe(true)
  })
  it('rejects non-ZeroTier interface names, including similar prefixes', () => {
    expect(isZeroTierIfaceName('tailscale0')).toBe(false)
    expect(isZeroTierIfaceName('utun4')).toBe(false)
    expect(isZeroTierIfaceName('en0')).toBe(false)
    expect(isZeroTierIfaceName('zt')).toBe(false)
    expect(isZeroTierIfaceName('ztab')).toBe(false)
    expect(isZeroTierIfaceName('')).toBe(false)
  })
})

describe('selectEnrollHost', () => {
  it('ZEROTIER LIVE CASE: a zt-named interface wins even when it is NOT first, with an ordinary RFC1918 address', () => {
    const host = selectEnrollHost({
      wlo1: [v4('10.0.2.237')],
      ztdiyqolon: [v4('10.76.163.150')],
    })
    expect(host).toBe('10.76.163.150')
  })

  it('ZeroTier and Tailscale both present: the tailnet wins even when the zt interface is listed FIRST', () => {
    // Interface order follows device creation and can flip between reboots;
    // a host with Tailscale must keep its tailnet default either way.
    const host = selectEnrollHost({
      ztdiyqolon: [v4('10.76.163.150')],
      tailscale0: [v4('100.66.169.66')],
    })
    expect(host).toBe('100.66.169.66')
  })

  it('ZeroTier and Tailscale both present, tailnet listed first: the tailnet wins', () => {
    const host = selectEnrollHost({
      tailscale0: [v4('100.66.169.66')],
      ztdiyqolon: [v4('10.76.163.150')],
    })
    expect(host).toBe('100.66.169.66')
  })

  it('ZeroTier ahead of the LAN, with the LAN listed first and an IPv6 FIRST on the zt interface: the zt IPv4 wins', () => {
    // Guards the family check: an address test moved ahead of it would
    // return the IPv6 address.
    const host = selectEnrollHost({
      wlo1: [v4('10.0.2.237')],
      ztdiyqolon: [v6('fd80:56c2:e21c::1'), v4('10.76.163.150')],
    })
    expect(host).toBe('10.76.163.150')
  })

  it('a name with "zt" in the middle is NOT ZeroTier: the first IPv4 wins', () => {
    // Guards the ^ anchor of the name pattern.
    expect(isZeroTierIfaceName('fooztabcdef')).toBe(false)
    const host = selectEnrollHost({
      wlo1: [v4('10.0.2.237')],
      fooztabcdef: [v4('10.76.163.150')],
    })
    expect(host).toBe('10.0.2.237')
  })

  it('THE LIVE CASE: tailnet wins even when it is NOT the first interface', () => {
    // Mirror of the fleet host's real interface order on 2026-07-29.
    const host = selectEnrollHost({
      en0: [v4('192.168.0.246')],
      en1: [v4('192.168.0.101')],
      utun4: [v4('100.115.9.11')],
    })
    expect(host).toBe('100.115.9.11')
  })

  it('no tailnet present: first non-loopback IPv4 wins (pre-PR behavior unchanged)', () => {
    const host = selectEnrollHost({
      en0: [v4('192.168.0.246')],
      en1: [v4('10.0.0.5')],
    })
    expect(host).toBe('192.168.0.246')
  })

  it('multiple tailnet-like addresses: the first tailnet in order, deterministically', () => {
    const host = selectEnrollHost({
      utun3: [v4('100.99.1.1')],
      utun4: [v4('100.115.9.11')],
    })
    expect(host).toBe('100.99.1.1')
  })

  it('internal and IPv6 entries never win', () => {
    const host = selectEnrollHost({
      lo0: [v4('127.0.0.1', true)],
      en0: [v6('fe80::1'), v4('192.168.1.2')],
    })
    expect(host).toBe('192.168.1.2')
  })

  it('numeric family (Node >=18 shape) is honored the same way', () => {
    const host = selectEnrollHost({
      en0: [{ address: '192.168.1.2', family: 4, internal: false }],
      utun0: [{ address: '100.70.1.1', family: 4, internal: false }],
    })
    expect(host).toBe('100.70.1.1')
  })

  it('returns null when nothing usable exists', () => {
    expect(selectEnrollHost({ lo0: [v4('127.0.0.1', true)] })).toBe(null)
    expect(selectEnrollHost({})).toBe(null)
  })

  // Backward compatibility is structural: the selector runs ONLY at enroll
  // time inside bridgeEnroll (host = input.host ?? primaryIPv4() ?? hostname),
  // an existing bundle is never re-derived, and an explicit input.host always
  // wins before the selector is even consulted. The explicit-host precedence
  // is covered end-to-end in bridge-enroll.test.ts; this file pins the
  // source-level ordering so a refactor cannot silently demote it.
  it('explicit input.host stays ahead of the selector in the enroll path', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/bridge-enroll.ts'), 'utf-8')
    expect(src).toMatch(/input\.host \?\? primaryIPv4\(\) \?\? hostname\(\)/)
  })
})
