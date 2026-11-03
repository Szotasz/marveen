import { appendDailyLog, getDailyLog, getDailyLogDates } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../../homoglyph.js'
import { containsSuspiciousContent } from './memories.js'
import type { RouteContext } from './types.js'

export async function tryHandleDailyLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/daily-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string }
    if (!data.content?.trim()) { json(res, { error: 'Content required' }, 400); return true }
    const agentId = data.agent_id || MAIN_AGENT_ID
    // The memory content filter decides whether the entry is ALSO mirrored into
    // the searchable memories table. A refusal never loses the log row (the
    // diary has always accepted this text): it only skips the mirror, and the
    // response says so.
    const filtered = containsSuspiciousContent(data.content)
    if (filtered) logger.warn({ agent: agentId }, 'daily-log entry saved without a memory mirror: suspicious pattern')
    // A DB error rolls the log row and the mirror back together and throws.
    const { memoryId } = appendDailyLog(agentId, data.content.trim(), { mirror: !filtered })
    const memory_mirror = memoryId !== null ? memoryId : 'skipped:content-filter'
    // Warn-only homoglyph check (GATEHOMOGLIFSWEEP816) -- see memories.ts.
    const homoglyphs = detectHomoglyphs(data.content)
    if (homoglyphs.length > 0) {
      const warning = formatHomoglyphWarning(homoglyphs)
      logger.warn({ agent: data.agent_id }, `daily-log entry saved with ${warning}`)
      json(res, { ok: true, memory_mirror, homoglyph_warning: warning })
      return true
    }
    json(res, { ok: true, memory_mirror })
    return true
  }

  if (path === '/api/daily-log' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]
    json(res, getDailyLog(agent, date))
    return true
  }

  if (path === '/api/daily-log/dates' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    json(res, getDailyLogDates(agent))
    return true
  }

  return false
}
