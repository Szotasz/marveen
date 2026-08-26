import { randomUUID } from 'node:crypto'
import { getDb, insertBlackboardHistory, listBlackboardHistory } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

interface BlackboardRow {
  id: string
  agent_id: string
  task_ref: string | null
  status: 'active' | 'done' | 'blocked'
  summary: string
  updated_at: number
}

function listBlackboard(limit = 10): BlackboardRow[] {
  return getDb()
    .prepare('SELECT * FROM fleet_blackboard ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as BlackboardRow[]
}

function upsertBlackboard(agent_id: string, data: { task_ref?: string | null; status?: string; summary: string }): BlackboardRow {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM fleet_blackboard WHERE agent_id = ?').get(agent_id) as { id: string } | undefined
  const id = existing?.id ?? randomUUID().replace(/-/g, '').slice(0, 8)
  db.prepare(`
    INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(agent_id) DO UPDATE SET
      task_ref   = excluded.task_ref,
      status     = excluded.status,
      summary    = excluded.summary,
      updated_at = unixepoch()
  `).run(id, agent_id, data.task_ref ?? null, data.status ?? 'active', data.summary)
  const row = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get(id) as BlackboardRow
  insertBlackboardHistory({ agent_id: row.agent_id, task_ref: row.task_ref, status: row.status, summary: row.summary })
  return row
}

function patchBlackboard(id: string, data: { status?: string; summary?: string; task_ref?: string | null }): BlackboardRow | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get(id) as BlackboardRow | undefined
  if (!row) return undefined
  const status = data.status ?? row.status
  const summary = data.summary ?? row.summary
  const task_ref = Object.prototype.hasOwnProperty.call(data, 'task_ref') ? data.task_ref : row.task_ref
  db.prepare(`
    UPDATE fleet_blackboard SET status = ?, summary = ?, task_ref = ?, updated_at = unixepoch() WHERE id = ?
  `).run(status, summary, task_ref, id)
  const updated = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get(id) as BlackboardRow
  insertBlackboardHistory({ agent_id: updated.agent_id, task_ref: updated.task_ref, status: updated.status, summary: updated.summary })
  return updated
}

const VALID_STATUS = new Set(['active', 'done', 'blocked'])

export async function tryHandleBlackboard(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // History endpoint must be matched before the generic /api/blackboard GET.
  if (path === '/api/blackboard/history' && method === 'GET') {
    const { url } = ctx
    const agent_id = url.searchParams.get('agent_id') ?? undefined
    const sinceRaw = url.searchParams.get('since')
    const since = sinceRaw !== null ? parseInt(sinceRaw, 10) : undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw !== null ? Math.min(Math.max(1, parseInt(limitRaw, 10) || 50), 200) : undefined
    json(res, listBlackboardHistory({ agent_id, since, limit }))
    return true
  }

  if (path === '/api/blackboard' && method === 'GET') {
    json(res, listBlackboard(10))
    return true
  }

  if (path === '/api/blackboard' && method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    const agent_id = String(body.agent_id ?? '').trim()
    const summary = String(body.summary ?? '').trim()
    if (!agent_id) { json(res, { error: 'agent_id required' }, 400); return true }
    if (!summary) { json(res, { error: 'summary required' }, 400); return true }
    if (summary.length > 500) { json(res, { error: 'summary max 500 chars' }, 400); return true }
    const status = body.status ? String(body.status) : 'active'
    if (!VALID_STATUS.has(status)) { json(res, { error: 'status must be active|done|blocked' }, 400); return true }
    const task_ref = body.task_ref ? String(body.task_ref) : null
    try {
      const row = upsertBlackboard(agent_id, { task_ref, status, summary })
      json(res, { ok: true, row })
    } catch (err) {
      logger.error({ err }, 'blackboard upsert error')
      json(res, { error: 'internal error' }, 500)
    }
    return true
  }

  const patchMatch = path.match(/^\/api\/blackboard\/([a-zA-Z0-9-]{1,64})$/)
  if (patchMatch && method === 'PATCH') {
    const id = patchMatch[1]
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    if (body.status !== undefined && !VALID_STATUS.has(String(body.status))) {
      json(res, { error: 'status must be active|done|blocked' }, 400)
      return true
    }
    if (body.summary !== undefined && String(body.summary).length > 500) {
      json(res, { error: 'summary max 500 chars' }, 400)
      return true
    }
    const updated = patchBlackboard(id, {
      status: body.status !== undefined ? String(body.status) : undefined,
      summary: body.summary !== undefined ? String(body.summary) : undefined,
      task_ref: Object.prototype.hasOwnProperty.call(body, 'task_ref') ? (body.task_ref as string | null) : undefined,
    })
    if (!updated) { json(res, { error: 'not found' }, 404); return true }
    json(res, { ok: true, row: updated })
    return true
  }

  return false
}
