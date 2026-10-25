import { readBody, json } from '../http-helpers.js'
import {
  readTaskState,
  writeTaskState,
  markConsumed,
  clearTaskState,
  shouldReplayTaskState,
  buildTaskStateInjection,
  sanitizeAgent,
} from '../agent-taskstate.js'
import type { RouteContext } from './types.js'

// Endpoints for the compact task-state re-injection feature (#4).
//  POST   /api/agent-taskstate/:agent          <- PreCompact agent-hook writes the record
//  GET    /api/agent-taskstate/:agent/replay   <- SessionStart hook: returns inject text (does NOT consume)
//  POST   /api/agent-taskstate/:agent/consume  <- SessionStart hook: mark consumed AFTER a successful inject
//  DELETE /api/agent-taskstate/:agent          <- explicit task-done clear
//
// All gated by the dashboard token in web.ts. The read->inject->consume split
// is deliberate (Marveen): if the hook reads but dies before printing, the
// record stays consumed=false so the next start still catches it.
//
// POST, DELETE and consume refuse a token caller whose X-Agent-Id names another
// agent than the record it touches (403 agent_mismatch), and every written
// record stores its writer (see taskStateWriterFromAuth).

// The writer label stored with the record. Self-asserted: the shared
// dashboard token cannot prove who wrote it (docs/agens-azonositas-api.md),
// so the label is provenance for the replay, never authorization.
function cleanName(s: string | undefined): string {
  return String(s ?? '').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 64)
}
export function taskStateWriterFromAuth(auth: RouteContext['auth']): string {
  if (!auth) return 'unknown'
  const named = (kind: string, name: string | undefined) => {
    const n = cleanName(name)
    return n ? `${kind}:${n}` : 'unknown'
  }
  switch (auth.kind) {
    case 'token': return auth.agent ? named('agent', auth.agent) : 'token'
    case 'device': return named('device', auth.device)
    case 'session': return named('session', auth.user)
    case 'federation': return named('federation', auth.peer)
    default: return 'unknown'
  }
}

// A token caller whose OWN X-Agent-Id names a different agent than the
// record it touches is refused. This stops an honest caller writing under
// the wrong name; it does not stop a caller that claims the target's name,
// which the shared token cannot prevent.
function refuseMismatchedClaim(ctx: RouteContext, agent: string): boolean {
  const claimed = ctx.auth?.kind === 'token' ? ctx.auth.agent : undefined
  if (!claimed) return false
  if (claimed.toLowerCase() === sanitizeAgent(agent).toLowerCase()) return false
  json(ctx.res, { error: 'X-Agent-Id names a different agent than this task-state record', code: 'agent_mismatch' }, 403)
  return true
}

export async function tryHandleAgentTaskState(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  const replayMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/replay$/)
  if (replayMatch && method === 'GET') {
    const agent = decodeURIComponent(replayMatch[1])
    const source = url.searchParams.get('source') || ''
    const record = readTaskState(agent)
    const inject = shouldReplayTaskState(record, source, Date.now())
      ? buildTaskStateInjection(record!)
      : null
    json(res, { additionalContext: inject })
    return true
  }

  const consumeMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    const agent = decodeURIComponent(consumeMatch[1])
    if (refuseMismatchedClaim(ctx, agent)) return true
    markConsumed(agent)
    json(res, { ok: true })
    return true
  }

  const baseMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)$/)
  if (baseMatch && method === 'POST') {
    const agent = decodeURIComponent(baseMatch[1])
    if (refuseMismatchedClaim(ctx, agent)) return true
    const body = await readBody(req)
    let fields: Record<string, unknown>
    try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const record = writeTaskState(agent, {
      doneSteps: fields.doneSteps as string[] | undefined,
      alreadyDelegated: fields.alreadyDelegated as string[] | undefined,
      nextAction: fields.nextAction as string | undefined,
      pendingDecision: fields.pendingDecision as string | undefined,
      summary: fields.summary as string | undefined,
    }, Date.now(), taskStateWriterFromAuth(ctx.auth))
    json(res, { ok: true, record })
    return true
  }

  if (baseMatch && method === 'GET') {
    json(res, readTaskState(decodeURIComponent(baseMatch[1])))
    return true
  }

  if (baseMatch && method === 'DELETE') {
    const agent = decodeURIComponent(baseMatch[1])
    if (refuseMismatchedClaim(ctx, agent)) return true
    clearTaskState(agent)
    json(res, { ok: true })
    return true
  }

  return false
}
