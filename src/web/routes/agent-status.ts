import { listAgentStatus, upsertAgentStatus } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Live "who is working on what" board. Agents upsert their own current task in
// human-readable terms (headline + difficulty + ETA + optional blocker); the
// dashboard renders one card per agent. This is narration, not command/log data.
export async function tryHandleAgentStatus(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/agent-status' && method === 'GET') {
    json(res, listAgentStatus())
    return true
  }

  if (path === '/api/agent-status' && method === 'POST') {
    const body = await readBody(req)
    let data: {
      agent_id?: string
      state?: string
      headline?: string | null
      difficulty?: string | null
      eta?: string | null
      blocker?: string | null
    }
    try {
      data = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    // Cap free-text fields so a runaway agent can't bloat the board.
    const clip = (v: string | null | undefined, n: number) =>
      typeof v === 'string' ? v.trim().slice(0, n) : null
    upsertAgentStatus({
      agent_id: data.agent_id.trim().slice(0, 64),
      state: data.state,
      headline: clip(data.headline, 280),
      difficulty: data.difficulty ?? null,
      eta: clip(data.eta, 80),
      blocker: clip(data.blocker, 280),
    })
    json(res, { ok: true })
    return true
  }

  return false
}
