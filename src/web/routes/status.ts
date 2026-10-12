import { logger } from '../../logger.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import { getSystemStatus, type SystemStatus } from '../system-status.js'
import type { RouteContext } from './types.js'

export interface AnthropicStatus {
  overall: string
  components: Array<{ name: string; status: string }>
  incidents: any[]
  fetchedAt: number
  error?: string
}

// The Anthropic status (status.claude.com) exactly as /api/status has always
// returned it: the dashboard's contract (web/app.js) depends on these four
// fields and on the error shape, so they stay byte-for-byte the same.
export async function fetchAnthropicStatus(): Promise<AnthropicStatus> {
  try {
    const rssResponse = await fetch('https://status.claude.com/history.rss', { signal: AbortSignal.timeout(10000) })
    const rssText = await rssResponse.text()

    const items: any[] = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    let match
    while ((match = itemRegex.exec(rssText)) !== null) {
      const itemXml = match[1]
      const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || ''
      const description = itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() || ''
      const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || ''
      const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || ''

      const cleanDesc = description
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'")
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

      let status = 'investigating'
      if (cleanDesc.toLowerCase().includes('resolved')) status = 'resolved'
      else if (cleanDesc.toLowerCase().includes('monitoring')) status = 'monitoring'
      else if (cleanDesc.toLowerCase().includes('identified')) status = 'identified'

      items.push({ title, description: cleanDesc, pubDate, link, status })
    }

    let overall = 'operational'
    const activeIncidents = items.filter(i => i.status !== 'resolved')
    if (activeIncidents.length > 0) overall = 'degraded'

    // Real per-service status from the Statuspage components API. The RSS feed
    // only carries incident history (no per-service state), so the dashboard
    // used to invent a hardcoded service list and substring-match incident
    // titles -- which left every tile permanently "operational". Fetch the
    // actual components so the grid reflects reality; on failure we return an
    // empty array and the UI shows an honest "no per-service data" note rather
    // than a fake green grid.
    let components: Array<{ name: string; status: string }> = []
    try {
      const compResp = await fetch('https://status.claude.com/api/v2/components.json', { signal: AbortSignal.timeout(10000) })
      if (compResp.ok) {
        const compData = await compResp.json() as { components?: Array<{ name: string; status: string; group?: boolean }> }
        components = (compData.components || [])
          .filter(c => !c.group) // drop group containers, keep leaf services
          .map(c => ({ name: c.name, status: c.status }))
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Claude status components')
    }

    return { overall, components, incidents: items.slice(0, 15), fetchedAt: Date.now() }
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Claude status')
    return { overall: 'unknown', components: [], incidents: [], fetchedAt: Date.now(), error: 'Failed to fetch status' }
  }
}

// The local part never fails the response: a collector crash becomes an
// `error` field, not a 500 that would also take the Anthropic fields down.
export async function systemOrError(): Promise<SystemStatus | { error: string }> {
  try {
    return await getSystemStatus()
  } catch (err) {
    logger.warn({ err }, 'system status collection failed')
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function tryHandleStatus(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/status' && method === 'GET') {
    const only = url.searchParams.get('only')
    if (only !== null && only !== 'system' && only !== 'anthropic') {
      json(res, { error: 'only must be "system" or "anthropic"' }, 400)
      return true
    }
    if (only === 'system') {
      // No network: the local rows only.
      jsonMaybeGzip(req, res, { system: await systemOrError() })
      return true
    }
    // The external fetch and the local rows run in parallel; neither waits
    // for, or breaks, the other. The legacy fields come first, unchanged.
    const [anthropic, system] = await Promise.all([
      fetchAnthropicStatus(),
      only === 'anthropic' ? Promise.resolve(null) : systemOrError(),
    ])
    const body: Record<string, unknown> = { ...anthropic }
    if (system !== null) body.system = system
    if (anthropic.error) json(res, body)
    else jsonMaybeGzip(req, res, body)
    return true
  }

  return false
}
