import {
  collectTokenUsage,
  getTokenSummary,
  getTokenTimeline,
  getTokenDetails,
  getModelDistribution,
  getModelSourceBreakdown,
  getToolStats,
} from '../token-usage.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export async function tryHandleTokenUsage(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/token-usage/collect' && method === 'POST') {
    try {
      const result = await collectTokenUsage()
      // DBSIZE1111: no card correlation here. The overview page calls this route every 5 minutes, and the
      // correlation (one UPDATE per card window over every NULL-titled row) grew the DB from 704 to 1364 MB
      // and held the event loop for 6.8 s on 2026-11-11 15:34. Until the read-side attribution replaces it,
      // new rows keep task_title empty.
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
    jsonMaybeGzip(req, res, summary)
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

  if (path === '/api/token-usage/model-dist' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    const model = url.searchParams.get('model') || undefined
    // APRO920 (c)(1): ?model=<id> switches this endpoint from "how many rows
    // per model" to "which agent/session/task drove THIS model's rows" --
    // API only (spec D-3), no UI in this PR.
    if (model) {
      json(res, getModelSourceBreakdown(
        model,
        from ? parseInt(from) : undefined,
        to ? parseInt(to) : undefined,
      ))
      return true
    }
    json(res, getModelDistribution(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    ))
    return true
  }

  if (path === '/api/token-usage/tool-stats' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    json(res, getToolStats(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    ))
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
