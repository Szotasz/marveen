import { describe, it, expect } from 'vitest'
import { checkSslExpiry, checkDomainExpiry } from '../costops/expiry-checks.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 0, 0, 0) / 1000) // 2026-07-15

function daysFromNow(days: number): string {
  return new Date((NOW + days * 86400) * 1000).toISOString()
}

describe('checkSslExpiry', () => {
  it('is silent for a healthy cert (no noise)', async () => {
    const w = await checkSslExpiry(['ok.example.com'], NOW, { connect: async () => ({ validTo: daysFromNow(90) }) })
    expect(w).toEqual([])
  })

  it('emits low severity at 30d, medium at 14d, high at 7d', async () => {
    const w30 = await checkSslExpiry(['a'], NOW, { connect: async () => ({ validTo: daysFromNow(30) }) })
    const w14 = await checkSslExpiry(['b'], NOW, { connect: async () => ({ validTo: daysFromNow(14) }) })
    const w7 = await checkSslExpiry(['c'], NOW, { connect: async () => ({ validTo: daysFromNow(7) }) })
    expect(w30[0].severity).toBe('low')
    expect(w14[0].severity).toBe('medium')
    expect(w7[0].severity).toBe('high')
    expect(w30[0].warning_type).toBe('expiry')
    expect(w30[0].category).toBe('domains')
  })

  it('reports a check-failed (not silence) when the TLS connection fails, never a fabricated date', async () => {
    const w = await checkSslExpiry(['down.example.com'], NOW, { connect: async () => null })
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('ssl_check_failed')
    expect(w[0].confidence).toBe('no_api_or_no_access')
  })

  it('checks multiple hosts independently', async () => {
    const w = await checkSslExpiry(['healthy', 'expiring'], NOW, {
      connect: async (host) => ({ validTo: host === 'expiring' ? daysFromNow(5) : daysFromNow(365) }),
    })
    expect(w).toHaveLength(1)
    expect((w[0].detail as { host: string }).host).toBe('expiring')
  })
})

describe('checkDomainExpiry', () => {
  it('is silent for a healthy domain (no noise)', async () => {
    const w = await checkDomainExpiry(['zstradio.com'], NOW, {
      fetchJson: async () => ({ events: [{ eventAction: 'expiration', eventDate: daysFromNow(200) }] }),
    })
    expect(w).toEqual([])
  })

  it('emits an expiry warning inside the threshold', async () => {
    const w = await checkDomainExpiry(['zstradio.com'], NOW, {
      fetchJson: async () => ({ events: [{ eventAction: 'expiration', eventDate: daysFromNow(10) }] }),
    })
    expect(w).toHaveLength(1)
    expect(w[0].severity).toBe('medium')
    expect(w[0].code).toBe('domain_expiry_soon')
  })

  it('marks an unsupported TLD as no_api_or_no_access, never guesses an expiry', async () => {
    const w = await checkDomainExpiry(['example.hu'], NOW)
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('domain_expiry_check_unsupported')
    expect(w[0].confidence).toBe('no_api_or_no_access')
  })

  it('reports a check-failed warning when the RDAP call throws', async () => {
    const w = await checkDomainExpiry(['zstradio.com'], NOW, { fetchJson: async () => { throw new Error('network') } })
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('domain_expiry_check_failed')
  })

  it('never fabricates an expiry when the RDAP response has no expiration event', async () => {
    const w = await checkDomainExpiry(['zstradio.com'], NOW, { fetchJson: async () => ({ events: [] }) })
    expect(w).toEqual([])
  })
})
