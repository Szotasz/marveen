import { describe, it, expect } from 'vitest'
import { pickLanIp, isPrivateIpv4 } from '../web/network-info.js'

// Minimal shape matching os.NetworkInterfaceInfo for the fields pickLanIp reads.
function v4(address: string, internal = false) {
  return { address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null } as any
}
function v6(address: string, internal = false) {
  return { address, family: 'IPv6', internal, netmask: '', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 } as any
}

describe('isPrivateIpv4', () => {
  it('accepts the three private ranges', () => {
    expect(isPrivateIpv4('10.0.0.5')).toBe(true)
    expect(isPrivateIpv4('192.168.1.50')).toBe(true)
    expect(isPrivateIpv4('172.16.4.4')).toBe(true)
    expect(isPrivateIpv4('172.31.255.1')).toBe(true)
  })
  it('rejects public, link-local, and 172.x outside 16-31', () => {
    expect(isPrivateIpv4('8.8.8.8')).toBe(false)
    expect(isPrivateIpv4('169.254.1.2')).toBe(false) // link-local
    expect(isPrivateIpv4('172.15.0.1')).toBe(false)
    expect(isPrivateIpv4('172.32.0.1')).toBe(false)
  })
})

describe('pickLanIp', () => {
  it('picks the WiFi private IP on a typical macOS host (skips loopback/VPN/awdl)', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true), v6('::1', true)],
      en0: [v4('192.168.1.50'), v6('fe80::1')],
      utun3: [v4('10.99.0.2')], // VPN tunnel -- must be skipped despite private range
      awdl0: [v6('fe80::2')],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.50')
  })

  it('picks the eth0 private IP on Linux and skips the docker bridge', () => {
    const ifaces = {
      lo: [v4('127.0.0.1', true)],
      eth0: [v4('10.0.0.5')],
      docker0: [v4('172.17.0.1')], // skipped by name
    }
    expect(pickLanIp(ifaces)).toBe('10.0.0.5')
  })

  it('prefers en0 over en1 when both qualify', () => {
    const ifaces = {
      en1: [v4('192.168.1.99')],
      en0: [v4('192.168.1.50')],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.50')
  })

  it('returns null when only loopback exists (localhost-only / no LAN)', () => {
    expect(pickLanIp({ lo0: [v4('127.0.0.1', true)] })).toBeNull()
  })

  it('returns null when the only non-internal IPv4 is public (no private LAN addr)', () => {
    expect(pickLanIp({ en0: [v4('203.0.113.7')] })).toBeNull()
  })

  it('ignores IPv6 and internal addresses', () => {
    const ifaces = {
      en0: [v6('2001:db8::1'), v4('192.168.0.10')],
      lo0: [v4('127.0.0.1', true)],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.0.10')
  })
})
