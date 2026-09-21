import { appendDailyLog, getDailyLog, getDailyLogDates } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../../homoglyph.js'
import { agentTokenIdentityViolation } from '../agent-token-scope.js'
import type { RouteContext } from './types.js'

export async function tryHandleDailyLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/daily-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string }
    if (!data.content?.trim()) { json(res, { error: 'Content required' }, 400); return true }
    // Identity binding for scoped agent tokens -- same rule as /api/memories:
    // a remote agent writes into its OWN log, never the main agent's.
    const logViolation = agentTokenIdentityViolation(ctx.auth, data.agent_id, 'agent_id')
    if (logViolation) {
      logger.warn({ claimed: data.agent_id, agent: ctx.auth?.agent }, 'agent token: rejected /api/daily-log POST with foreign agent_id')
      json(res, { error: logViolation }, 403)
      return true
    }
    appendDailyLog(data.agent_id || (ctx.auth?.kind === 'agent' ? ctx.auth.agent! : MAIN_AGENT_ID), data.content.trim())
    // Warn-only homoglyph check (GATEHOMOGLIFSWEEP816) -- see memories.ts.
    const homoglyphs = detectHomoglyphs(data.content)
    if (homoglyphs.length > 0) {
      const warning = formatHomoglyphWarning(homoglyphs)
      logger.warn({ agent: data.agent_id }, `daily-log entry saved with ${warning}`)
      json(res, { ok: true, homoglyph_warning: warning })
      return true
    }
    json(res, { ok: true })
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
