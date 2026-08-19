import { describe, it, expect } from 'vitest'
import { checkRenderBuildMinutes } from '../costops/render-live-checks.js'

const NOW = Math.floor(Date.UTC(2026, 6, 7, 17, 0, 0) / 1000) // 2026-07-07 17:00 UTC

describe('checkRenderBuildMinutes', () => {
  it('returns nothing when no key is configured (render.ts sync already flags that gap)', async () => {
    const w = await checkRenderBuildMinutes(NOW, { apiKey: null })
    expect(w).toEqual([])
  })

  it('returns nothing when no service has a recent pipeline_minutes_exhausted event', async () => {
    const httpGetJson = async (url: string) => {
      if (url.includes('/services?')) return [{ service: { id: 'srv-1', name: 'suite-api' } }]
      return [] // no events of that type
    }
    const w = await checkRenderBuildMinutes(NOW, { apiKey: 'k', httpGetJson })
    expect(w).toEqual([])
  })

  it('emits a high-severity quota warning when a service was exhausted within the lookback window', async () => {
    const recentIso = new Date((NOW - 3600) * 1000).toISOString() // 1h ago
    const httpGetJson = async (url: string) => {
      if (url.includes('/services?')) return [{ service: { id: 'srv-1', name: 'suite-api-08wb' } }]
      return [{ event: { id: 'evt-1', serviceId: 'srv-1', timestamp: recentIso, type: 'pipeline_minutes_exhausted' } }]
    }
    const w = await checkRenderBuildMinutes(NOW, { apiKey: 'k', httpGetJson })
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('render_build_minutes_exhausted')
    expect(w[0].severity).toBe('high')
    expect(w[0].current_value).toBe(100)
    expect(w[0].message).toContain('suite-api-08wb')
  })

  it('ignores a stale exhausted event outside the lookback window (pool likely reset since)', async () => {
    const staleIso = new Date((NOW - 10 * 24 * 3600) * 1000).toISOString() // 10 days ago
    const httpGetJson = async (url: string) => {
      if (url.includes('/services?')) return [{ service: { id: 'srv-1', name: 'suite-api' } }]
      return [{ event: { id: 'evt-1', serviceId: 'srv-1', timestamp: staleIso, type: 'pipeline_minutes_exhausted' } }]
    }
    const w = await checkRenderBuildMinutes(NOW, { apiKey: 'k', httpGetJson })
    expect(w).toEqual([])
  })

  it('reports a check-failed warning (not silence) when the services list fetch throws', async () => {
    const httpGetJson = async () => { throw new Error('network down') }
    const w = await checkRenderBuildMinutes(NOW, { apiKey: 'k', httpGetJson })
    expect(w).toHaveLength(1)
    expect(w[0].code).toBe('render_build_minutes_check_failed')
    expect(w[0].confidence).toBe('no_api_or_no_access')
  })

  it("one service's event-query failure doesn't hide a finding from another service", async () => {
    const recentIso = new Date((NOW - 3600) * 1000).toISOString()
    const httpGetJson = async (url: string) => {
      if (url.includes('/services?')) return [{ service: { id: 'srv-bad', name: 'bad' } }, { service: { id: 'srv-good', name: 'good' } }]
      if (url.includes('srv-bad')) throw new Error('transient')
      return [{ event: { id: 'evt-1', serviceId: 'srv-good', timestamp: recentIso, type: 'pipeline_minutes_exhausted' } }]
    }
    const w = await checkRenderBuildMinutes(NOW, { apiKey: 'k', httpGetJson })
    expect(w).toHaveLength(1)
    expect(w[0].message).toContain('good')
  })
})
