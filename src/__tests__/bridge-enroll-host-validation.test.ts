// JANKBRIDGE803 -- the pairing target address must be a host, not any string.
//
// A customer typed the email address of his Tailscale ACCOUNT into the field.
// Nothing objected: the bundle was built with it, the Bridge imported it, and
// the failure surfaced only at connect as `getaddrinfo EAI_FAIL <email>`.
// Measured on the shipped Bridge before this fix: parseBundle accepted an
// email, whitespace, a URL, an embedded newline and 400 characters -- only the
// empty string was refused, while the PORT field beside it was fully checked.
//
// The trap this test also exists to hold shut: the codebase ALREADY has a host
// check (agent-config.ts REMOTE_HOST_ALLOWED), and it ACCEPTS this email,
// because it is an ssh DESTINATION charset where `user@host` is legitimate.
// Anyone "reusing the existing validator" ships a change that looks like a fix
// and lets the reported case straight through. The email case is therefore
// asserted by name, not merely as "some invalid input".
import { isIP } from 'node:net'
import { describe, expect, it } from 'vitest'
import { checkEnrollHost } from '../remote-enroll-core.js'

const REPORTED = 'jaequas2605@gmail.com'

describe('checkEnrollHost', () => {
  it('accepts what a real target address looks like', () => {
    // Positive control first. A validator that rejects everything would pass
    // every rejection test below and be worse than no validator at all.
    for (const host of [
      '100.124.123.12', // the tailnet address the customer should have used
      '192.168.0.10',
      'mac-mini',
      'mac-mini.local',
      'host.tail1234.ts.net',
      'fe80::1',
      '::1',
      'my_server', // underscore: not RFC 1123, but real machines carry it
      'example.com.', // trailing dot: a legitimately written FQDN
    ]) {
      expect(checkEnrollHost(host, isIP), `${host} must be accepted`).toEqual({ ok: true, host })
    }
  })

  it('rejects the reported email address, and says why in words that correct the belief', () => {
    const r = checkEnrollHost(REPORTED, isIP)
    expect(r.ok).toBe(false)
    if (r.ok) return
    // "Invalid host" alone would be correct and useless: the customer believed
    // the field wanted his Tailscale identity. The message must fix the belief.
    expect(r.reason).toContain(REPORTED)
    expect(r.reason).toMatch(/email/i)
    expect(r.reason).toMatch(/100/)
    expect(r.reason).toMatch(/Tailscale/)
  })

  it('rejects the other shapes the shipped Bridge waved through', () => {
    for (const host of [
      'my host name',
      'https://example.com/x',
      'example.com; rm -rf /',
      'a.com\nb.com',
      '   ',
      '',
    ]) {
      expect(checkEnrollHost(host, isIP).ok, `${JSON.stringify(host)} must be rejected`).toBe(false)
    }
    expect(checkEnrollHost('a'.repeat(400), isIP).ok).toBe(false)
  })

  it('trims, so a pasted address with stray whitespace still works', () => {
    expect(checkEnrollHost('  100.124.123.12  ', isIP)).toEqual({ ok: true, host: '100.124.123.12' })
  })

  it('is NOT satisfied by the remote-agent host charset', () => {
    // The measurement that justifies a separate validator: agent-config.ts's
    // REMOTE_HOST_ALLOWED accepts the reported email. If someone later swaps
    // checkEnrollHost for that regex, this test is the one that objects.
    const REMOTE_HOST_ALLOWED = /^[A-Za-z0-9_.@-]+$/
    expect(REMOTE_HOST_ALLOWED.test(REPORTED), 'the ssh-destination charset accepts the email').toBe(true)
    expect(checkEnrollHost(REPORTED, isIP).ok, 'ours must not').toBe(false)
  })
})
