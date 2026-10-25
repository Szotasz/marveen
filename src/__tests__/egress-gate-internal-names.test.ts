// The quarantine reader's internal-host check (isQuarantineDenied) against three spellings of an
// internal target the URL parser or the resolver turns into one: an IPv4-mapped IPv6 literal (the
// parser writes it in hex), a name with one trailing dot, and a dotless name. Each case has a public
// control, so a check that denies everything cannot pass.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { isQuarantineDenied } from '../../scripts/hooks/egress-gate.mjs'

describe('isQuarantineDenied: internal spellings', () => {
  it('denies an IPv4-mapped IPv6 loopback, which the URL parser writes in hex', () => {
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]')
    expect(isQuarantineDenied('http://[::ffff:127.0.0.1]/')).toBe(true)
    expect(isQuarantineDenied('http://[::ffff:10.1.2.3]/x')).toBe(true)
    expect(isQuarantineDenied('http://[::ffff:169.254.169.254]/latest/meta-data')).toBe(true)
  })

  it('lets a mapped PUBLIC address through (control)', () => {
    expect(isQuarantineDenied('https://[::ffff:93.184.216.34]/')).toBe(false)
  })

  it('denies a trailing-dot internal name the same as without the dot', () => {
    expect(isQuarantineDenied('http://localhost./')).toBe(true)
    expect(isQuarantineDenied('http://printer.local./')).toBe(true)
  })

  it('denies the other IPv4-embedding IPv6 prefixes: translated, compatible and NAT64', () => {
    expect(isQuarantineDenied('http://[::ffff:0:7f00:1]/')).toBe(true)
    expect(isQuarantineDenied('http://[::7f00:1]/')).toBe(true)
    expect(isQuarantineDenied('http://[::127.0.0.1]/')).toBe(true)
    expect(isQuarantineDenied('http://[64:ff9b::7f00:1]/')).toBe(true)
    expect(isQuarantineDenied('http://[64:ff9b::a9fe:a9fe]/latest/meta-data')).toBe(true)
  })

  it('lets those prefixes through when the embedded IPv4 is public (control)', () => {
    expect(isQuarantineDenied('https://[64:ff9b::5db8:d822]/')).toBe(false)
    expect(isQuarantineDenied('https://[::ffff:0:5db8:d822]/')).toBe(false)
  })

  it('denies an internal name with several trailing dots', () => {
    expect(isQuarantineDenied('http://localhost../')).toBe(true)
  })

  it('lets a trailing-dot public name through (control)', () => {
    expect(isQuarantineDenied('https://example.com./')).toBe(false)
  })

  it('denies a dotless name: a bare machine name and the metadata short name', () => {
    expect(isQuarantineDenied('http://buildbox/')).toBe(true)
    expect(isQuarantineDenied('http://metadata/computeMetadata/v1/')).toBe(true)
  })

  it('keeps the IPv6 literal rule for dotless literals: loopback denied, a public literal not', () => {
    expect(isQuarantineDenied('http://[::1]/')).toBe(true)
    expect(isQuarantineDenied('https://[2606:4700:4700::1111]/')).toBe(false)
  })
})
