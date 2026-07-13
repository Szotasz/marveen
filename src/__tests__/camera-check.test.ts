import { describe, it, expect } from 'vitest'
import {
  validatePrivateIPv4,
  probeCamera,
  type ProbeTransport,
  type TcpProbeResult,
} from '../web/routes/camera-check.js'

describe('validatePrivateIPv4', () => {
  describe('accepted private addresses', () => {
    const ok = ['192.168.1.64', '172.16.0.1', '172.31.255.254', '10.0.0.1']
    for (const ip of ok) {
      it(`accepts ${ip}`, () => {
        const r = validatePrivateIPv4(ip)
        expect(r).toEqual({ ok: true, ip })
      })
    }
  })

  describe('172.16/12 boundaries', () => {
    it('rejects 172.15.1.1 as not-private (below range)', () => {
      expect(validatePrivateIPv4('172.15.1.1')).toEqual({ ok: false, reason: 'not-private' })
    })
    it('rejects 172.32.1.1 as not-private (above range)', () => {
      expect(validatePrivateIPv4('172.32.1.1')).toEqual({ ok: false, reason: 'not-private' })
    })
    it('accepts the exact edges of 172.16/12', () => {
      expect(validatePrivateIPv4('172.16.0.0').ok).toBe(true)
      expect(validatePrivateIPv4('172.31.255.255').ok).toBe(true)
    })
  })

  describe('malformed input -> invalid-ip', () => {
    const bad = [
      '256.1.1.1', // octet out of range
      '10.0.0', // too few octets
      '10.0.0.0.1', // too many octets
      '010.1.1.1', // leading zero / octal trick
      '00.1.1.1', // leading zero on a zero octet
    ]
    for (const ip of bad) {
      it(`rejects ${JSON.stringify(ip)}`, () => {
        expect(validatePrivateIPv4(ip)).toEqual({ ok: false, reason: 'invalid-ip' })
      })
    }
  })

  describe('whitespace handling (trim)', () => {
    it('accepts a private IP with surrounding whitespace after trim', () => {
      expect(validatePrivateIPv4(' 10.1.1.1 ')).toEqual({ ok: true, ip: '10.1.1.1' })
    })
    it('rejects an internal-whitespace variant', () => {
      expect(validatePrivateIPv4('10. 1.1.1')).toEqual({ ok: false, reason: 'invalid-ip' })
    })
  })

  describe('non-private / external -> not-private', () => {
    const notPrivate = ['8.8.8.8', '127.0.0.1', '169.254.1.1', '0.0.0.0']
    for (const ip of notPrivate) {
      it(`rejects ${ip} as not-private`, () => {
        expect(validatePrivateIPv4(ip)).toEqual({ ok: false, reason: 'not-private' })
      })
    }
  })

  describe('alternative-notation evasion (GPT-crosscheck cases) -> invalid-ip', () => {
    const evasions = [
      'kamera.local', // hostname
      '192.168.1.1:80', // port suffix
      'http://192.168.1.1', // URL
      '3232235777', // decimal integer notation
      '0xc0a80101', // hex integer notation
      '192.168.1.1/24', // CIDR notation
      '::ffff:192.168.1.1', // IPv4-mapped IPv6
    ]
    for (const ip of evasions) {
      it(`rejects ${JSON.stringify(ip)}`, () => {
        expect(validatePrivateIPv4(ip)).toEqual({ ok: false, reason: 'invalid-ip' })
      })
    }
  })
})

// Deterministic fake transport + monotonic clock so the classification logic
// is testable without any real socket.
function makeTransport(
  tcp: Record<number, TcpProbeResult>,
  httpStatus: number | null = null,
): ProbeTransport {
  return {
    tcpConnect: async (_ip, port) => tcp[port] ?? 'refused',
    httpGet: async () => httpStatus,
  }
}

function fakeClock(step = 5): () => number {
  let t = 1000
  return () => {
    const now = t
    t += step
    return now
  }
}

describe('probeCamera classification', () => {
  it('port 80 open + ISAPI 200 -> isapi, online', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'open' }, 200), fakeClock())
    expect(r.online).toBe(true)
    expect(r.reason).toBe('isapi')
    expect(typeof r.latencyMs).toBe('number')
  })

  it('port 80 open + 401 -> isapi (auth-gated but online)', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'open' }, 401), fakeClock())
    expect(r).toMatchObject({ online: true, reason: 'isapi' })
  })

  it('port 80 open + 403 -> isapi', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'open' }, 403), fakeClock())
    expect(r).toMatchObject({ online: true, reason: 'isapi' })
  })

  it('port 80 open + other HTTP status -> http', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'open' }, 500), fakeClock())
    expect(r).toMatchObject({ online: true, reason: 'http' })
  })

  it('port 80 open + HTTP error (null) -> http (something is listening)', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'open' }, null), fakeClock())
    expect(r).toMatchObject({ online: true, reason: 'http' })
  })

  it('port 80 closed, port 8000 open -> tcp-8000, online', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'refused', 8000: 'open' }), fakeClock())
    expect(r).toMatchObject({ online: true, reason: 'tcp-8000' })
    expect(typeof r.latencyMs).toBe('number')
  })

  it('both ports refused -> offline, refused', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'refused', 8000: 'refused' }), fakeClock())
    expect(r).toEqual({ online: false, reason: 'refused' })
  })

  it('both ports time out -> offline, timeout', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'timeout', 8000: 'timeout' }), fakeClock())
    expect(r).toEqual({ online: false, reason: 'timeout' })
  })

  it('any timeout among the failed attempts -> timeout wins over refused', async () => {
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'timeout', 8000: 'refused' }), fakeClock())
    expect(r).toEqual({ online: false, reason: 'timeout' })
  })

  it('does not read the HTTP body / only surfaces status classification', async () => {
    // httpGet resolves a status code only; probeCamera must never expose a body.
    const r = await probeCamera('10.0.0.1', makeTransport({ 80: 'open' }, 200), fakeClock())
    expect(Object.keys(r).sort()).toEqual(['latencyMs', 'online', 'reason'])
  })
})
