import {
  collectTokenUsage,
  getTokenSummary,
  getTokenTimeline,
  getTokenDetails,
  correlateWithKanban,
} from '../token-usage.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export async function tryHandleTokenUsage(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/token-usage/collect' && method === 'POST') {
    try {
      const result = await collectTokenUsage()
      correlateWithKanban()
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'Token usage collection failed')
      json(res, { error: 'Collection failed' }, 500)
    }
    return true
  }

  if (path === '/api/token-usage/summary' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const summary = getTokenSummary(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
    )
    json(res, summary)
    return true
  }

  if (path === '/api/token-usage/timeline' && method === 'GET') {
    const bucketMinutes = parseInt(url.searchParams.get('bucket') || '60')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    const timeline = getTokenTimeline(
      bucketMinutes,
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    )
    json(res, timeline)
    return true
  }

  if (path === '/api/token-usage' && method === 'GET') {
    const agent = url.searchParams.get('agent') || undefined
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const offset = parseInt(url.searchParams.get('offset') || '0')
    const minTokens = url.searchParams.get('min_tokens')
    const q = url.searchParams.get('q') || undefined
    const details = getTokenDetails({
      agent,
      from: from ? parseInt(from) : undefined,
      to: to ? parseInt(to) : undefined,
      limit: Math.min(limit, 500),
      offset,
      minTokens: minTokens ? parseInt(minTokens) : undefined,
      q,
    })
    json(res, details)
    return true
  }

  return false
}
