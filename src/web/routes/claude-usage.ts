import { readUsageCache, scrapeClaudeUsage } from '../claude-usage-scraper.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export async function tryHandleClaudeUsage(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/claude-usage' && method === 'GET') {
    const data = readUsageCache()
    if (!data) {
      json(res, { available: false })
    } else {
      json(res, { available: true, ...data })
    }
    return true
  }

  if (path === '/api/claude-usage/refresh' && method === 'POST') {
    // Trigger a background scrape; respond immediately so the caller isn't blocked
    // on a 10+ second Playwright launch.
    scrapeClaudeUsage().catch(err => logger.warn({ err }, 'claude-usage refresh failed'))
    json(res, { ok: true, message: 'refresh triggered' })
    return true
  }

  return false
}
