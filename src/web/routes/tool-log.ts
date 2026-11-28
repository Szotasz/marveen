import {
  logToolCall,
  analyzeWorkflowCandidates,
  getRecentToolCalls,
  pruneToolCallLog,
  pruneToolCallLogRetention,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleToolLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/tool-log -- log a tool call (from PostToolUse hook)
  if (path === '/api/tool-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      session_id: string
      tool_name: string
      input_summary?: string
      success?: boolean
      agent_id?: string
      trace_id?: string
      duration_ms?: number
    }
    if (!data.session_id || !data.tool_name) { json(res, { error: 'session_id and tool_name required' }, 400); return true }
    logToolCall(data.session_id, data.tool_name, data.input_summary ?? null, data.success !== false, data.agent_id ?? null, data.trace_id ?? null, data.duration_ms ?? null)
    json(res, { ok: true })
    return true
  }

  // GET /api/tool-log -- recent tool calls
  if (path === '/api/tool-log' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '3600')
    json(res, getRecentToolCalls(since))
    return true
  }

  // GET /api/tool-log/analyze -- workflow candidates
  if (path === '/api/tool-log/analyze' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '3600')
    const minCalls = parseInt(url.searchParams.get('min_calls') || '5')
    const gapSecs = parseInt(url.searchParams.get('gap') || '300')
    const candidates = analyzeWorkflowCandidates(since, minCalls, gapSecs)
    // Return summarized form (without full tool_calls array to keep response small)
    const summary = candidates.map(c => ({
      session_id: c.session_id,
      tool_count: c.tool_calls.length,
      duration_minutes: c.duration_minutes,
      start_ts: c.start_ts,
      end_ts: c.end_ts,
      tools: [...new Set(c.tool_calls.map(t => t.tool_name))],
      steps_preview: c.tool_calls.slice(0, 10).map(t => ({
        tool: t.tool_name,
        description: t.input_summary || t.tool_name,
      })),
    }))
    json(res, summary)
    return true
  }

  // POST /api/tool-log/prune -- cleanup old entries
  if (path === '/api/tool-log/prune' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { older_than_secs?: number }
    // No explicit window -> the CONFIGURED retention governs (opt-in,
    // 0 = keep forever), not a 24h call-site default. The capture hook
    // (scripts/hooks/tool-log-capture.py) posts an EMPTY body on ~1% of tool
    // calls, so a hard-coded 86400 here silently capped tool_call_log at 24
    // hours and made TOOL_CALL_LOG_RETENTION_DAYS ineffective: measured 24.06h
    // of history with the key unset, i.e. with "keep forever" configured
    // (TOOLLOGPRUNE24H1106). An explicit older_than_secs still purges exactly
    // that window, so a manual narrow purge keeps working -- it just has to say so.
    if (data.older_than_secs === undefined) pruneToolCallLogRetention()
    else pruneToolCallLog(data.older_than_secs)
    json(res, { ok: true })
    return true
  }

  return false
}
