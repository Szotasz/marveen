import { describe, it, expect, vi, beforeEach } from 'vitest'

// Card fa041036: /api/costs/warnings and /api/costs/limits both needed the same 3 live checks
// (Render build-minutes, SSL expiry, domain expiry) -- previously each independently re-ran them
// (once concurrently inside getLimitStatus, once again sequentially in the /warnings route),
// which was the real cost behind the reported 20-35s. getLiveCheckWarnings() now shares one
// TTL-cached result between both call sites.

vi.mock('../costops/render-live-checks.js', () => ({
  checkRenderBuildMinutes: vi.fn(async () => []),
}))
vi.mock('../costops/expiry-checks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../costops/expiry-checks.js')>()
  return { ...actual, checkSslExpiry: vi.fn(async () => []), checkDomainExpiry: vi.fn(async () => []) }
})

describe('costops limits: getLiveCheckWarnings TTL cache (card fa041036)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('a second call with the same hosts/domains within the TTL window reuses the in-flight/cached result instead of re-fetching', async () => {
    const { getLiveCheckWarnings } = await import('../costops/limits.js')
    const { checkRenderBuildMinutes } = await import('../costops/render-live-checks.js')
    const { checkSslExpiry, checkDomainExpiry } = await import('../costops/expiry-checks.js')

    const now = 1783500000
    await getLiveCheckWarnings(now, ['a.example.com'], ['example.com'])
    await getLiveCheckWarnings(now + 10, ['a.example.com'], ['example.com']) // 10s later, same key -- still warm

    expect(checkRenderBuildMinutes).toHaveBeenCalledTimes(1)
    expect(checkSslExpiry).toHaveBeenCalledTimes(1)
    expect(checkDomainExpiry).toHaveBeenCalledTimes(1)
  })

  it('a call with a different host/domain set does not reuse a stale cache entry from a different key', async () => {
    const { getLiveCheckWarnings } = await import('../costops/limits.js')
    const { checkRenderBuildMinutes } = await import('../costops/render-live-checks.js')

    const now = 1783500000
    await getLiveCheckWarnings(now, ['a.example.com'], ['example.com'])
    await getLiveCheckWarnings(now, ['b.example.com'], ['example.com']) // different ssl_hosts -- must re-fetch

    expect(checkRenderBuildMinutes).toHaveBeenCalledTimes(2)
  })

  it('a call after the TTL window has elapsed re-fetches instead of returning a stale result', async () => {
    const { getLiveCheckWarnings } = await import('../costops/limits.js')
    const { checkRenderBuildMinutes } = await import('../costops/render-live-checks.js')

    const now = 1783500000
    await getLiveCheckWarnings(now, ['a.example.com'], ['example.com'])
    await getLiveCheckWarnings(now + 6 * 60, ['a.example.com'], ['example.com']) // 6 min later -- past the 5 min TTL

    expect(checkRenderBuildMinutes).toHaveBeenCalledTimes(2)
  })
})
