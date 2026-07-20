// CostOps v0.7/v2 -- Render LIVE checks beyond plan-cost (card bea78483).
//
// READ-ONLY (GET only, official Render events API). Render's account-wide
// build-minutes pool only exposes a discrete `pipeline_minutes_exhausted`
// event per-service when the pool is FULLY drained -- there is no API for the
// 70/90% intermediate tiers (confirmed against api-docs.render.com), so this
// check can only ever report "blocked" (100%) or nothing, never a percentage.

import { getRenderApiKey } from './collectors/render.js'
import type { HttpGetJson } from './collectors/types.js'
import type { CostWarning } from './warnings.js'
import { categoryForProvider } from './warnings.js'

const SERVICES_URL = 'https://api.render.com/v1/services?limit=100'
const LOOKBACK_SECS = 48 * 3600 // a build-minutes-exhausted event older than this is stale, not "currently blocked"

interface RenderEvent {
  event?: { id?: string; serviceId?: string; timestamp?: string; type?: string }
}
interface RenderServiceItem {
  service?: { id?: string; name?: string }
}

/**
 * Scans every service's recent events for `pipeline_minutes_exhausted`. Emits
 * ONE consolidated warning if any service hit it within LOOKBACK_SECS, never a
 * fabricated percentage (the API only tells us "exhausted or not"). Never
 * throws -- a fetch failure surfaces as its own low-severity access warning
 * instead of silently hiding a real condition.
 */
export async function checkRenderBuildMinutes(
  now: number,
  deps: { httpGetJson?: HttpGetJson; apiKey?: string | null } = {},
): Promise<CostWarning[]> {
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : getRenderApiKey()
  if (!apiKey) return [] // no key configured -- render.ts's own sync already surfaces this gap
  const httpGetJson = deps.httpGetJson || (async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { method: 'GET', headers })
    if (!r.ok) throw new Error(`render api ${r.status}`)
    return r.json()
  })
  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' }

  let services: RenderServiceItem[]
  try {
    const raw = await httpGetJson(SERVICES_URL, headers)
    services = Array.isArray(raw) ? raw as RenderServiceItem[] : []
  } catch {
    return [{
      code: 'render_build_minutes_check_failed', severity: 'low', provider: 'render',
      message: 'Render build-minutes állapot nem lekérdezhető (API hiba).',
      warning_type: 'access', category: 'hosting', source: 'render_api', confidence: 'no_api_or_no_access',
    }]
  }

  let mostRecent: { serviceName: string; timestamp: string } | null = null
  for (const item of services) {
    const svcId = item.service?.id
    if (!svcId) continue
    try {
      const raw = await httpGetJson(`https://api.render.com/v1/services/${svcId}/events?type=pipeline_minutes_exhausted&limit=1`, headers)
      const events = Array.isArray(raw) ? raw as RenderEvent[] : []
      const ev = events[0]?.event
      if (ev?.timestamp) {
        if (!mostRecent || ev.timestamp > mostRecent.timestamp) {
          mostRecent = { serviceName: item.service?.name || svcId, timestamp: ev.timestamp }
        }
      }
    } catch { /* one service's event query failing shouldn't hide findings from the others */ }
  }
  if (!mostRecent) return []

  const ageSecs = now - Math.floor(Date.parse(mostRecent.timestamp) / 1000)
  if (ageSecs > LOOKBACK_SECS) return [] // stale event, pool has very likely reset since

  return [{
    code: 'render_build_minutes_exhausted', severity: 'high', provider: 'render',
    message: `Render build-percek elfogytak (${mostRecent.serviceName}, ${Math.round(ageSecs / 3600)} órája) -- új deploy blokkolva lehet.`,
    detail: { service_name: mostRecent.serviceName, event_timestamp: mostRecent.timestamp },
    warning_type: 'quota', category: categoryForProvider('render'), source: 'render_api', confidence: 'measured',
    threshold: 100, current_value: 100, unit: '%',
    action: 'Várj a havi build-percek resetjére, vagy válts magasabb Render csomagra.',
  }]
}
