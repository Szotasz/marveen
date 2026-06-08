import { describe, it, expect } from 'vitest'
import { buildPtyWsUrl, buildResizeMsg, ptyCloseCodeMsg } from '../pty-render-utils.js'

describe('buildPtyWsUrl', () => {
  it('uses ws: for http protocol', () => {
    const url = buildPtyWsUrl('http:', 'localhost:8080', 'abc123ticket', 120, 30)
    expect(url).toBe('ws://localhost:8080/ws/agent-pty?ticket=abc123ticket&cols=120&rows=30')
  })

  it('uses wss: for https protocol', () => {
    const url = buildPtyWsUrl('https:', 'example.com:443', 'xyz', 80, 24)
    expect(url).toBe('wss://example.com:443/ws/agent-pty?ticket=xyz&cols=80&rows=24')
  })

  it('encodes ticket in query string', () => {
    const url = buildPtyWsUrl('http:', 'host:3000', 'tick et+val', 80, 24)
    expect(url).toContain('ticket=tick%20et%2Bval')
  })

  it('accepts location.host-style combined hostPort', () => {
    const url = buildPtyWsUrl('http:', '127.0.0.1:3420', 't', 120, 30)
    expect(url).toContain('//127.0.0.1:3420/')
  })
})

describe('buildResizeMsg', () => {
  it('returns JSON with type resize and given cols/rows', () => {
    const msg = buildResizeMsg(120, 40)
    const parsed = JSON.parse(msg)
    expect(parsed).toEqual({ type: 'resize', cols: 120, rows: 40 })
  })

  it('round-trips through JSON.parse', () => {
    const msg = buildResizeMsg(80, 24)
    expect(typeof msg).toBe('string')
    expect(JSON.parse(msg).type).toBe('resize')
  })
})

describe('ptyCloseCodeMsg', () => {
  it('returns friendly message for 4401', () => {
    expect(ptyCloseCodeMsg(4401)).toContain('invalid ticket')
  })

  it('returns friendly message for 4404', () => {
    expect(ptyCloseCodeMsg(4404)).toContain('not running')
  })

  it('returns friendly message for 4429', () => {
    expect(ptyCloseCodeMsg(4429)).toContain('concurrent viewers')
  })

  it('returns generic message for unknown codes', () => {
    const msg = ptyCloseCodeMsg(1006)
    expect(msg).toContain('1006')
  })
})
