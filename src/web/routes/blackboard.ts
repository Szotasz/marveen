import { getDb, insertBlackboardHistory, listBlackboardHistory, upsertBlackboard, type BlackboardRow } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import type { RouteContext } from './types.js'

// Signal values attached to each blackboard row in the GET response.
// 'a' = agent was active in messages but blackboard row is stale (forgot to update).
// 'b' = active row has not changed for a long time (completion signal likely lost).
// 'ab' = both signals apply simultaneously.
export type BlackboardSignal = 'a' | 'b' | 'ab' | null

export interface BlackboardRowWithSignal extends BlackboardRow {
  signal: BlackboardSignal
}

// Pure function: compute the stale signal for one blackboard row.
// Exported for unit testing without DB access.
export function computeBlackboardSignal(
  row: BlackboardRow,
  lastMsgAt: number | null,
  nowSec: number,
  thresholds: { msgHours: number; bbHours: number; activeHours: number },
): BlackboardSignal {
  const { msgHours, bbHours, activeHours } = thresholds

  // Signal A: agent sent a message recently, but blackboard row is older than bbHours.
  const signalA =
    lastMsgAt !== null &&
    lastMsgAt > nowSec - msgHours * 3600 &&
    row.updated_at < nowSec - bbHours * 3600

  // Signal B: active row unchanged for longer than activeHours.
  const signalB =
    row.status === 'active' &&
    row.updated_at < nowSec - activeHours * 3600

  if (signalA && signalB) return 'ab'
  if (signalA) return 'a'
  if (signalB) return 'b'
  return null
}

function listBlackboardWithSignals(limit = 10): BlackboardRowWithSignal[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM fleet_blackboard ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as BlackboardRow[]

  if (!rows.length) return []

  const msgHours = Number(getEffectiveSettingValue('BB_SIGNAL_A_MSG_HOURS'))
  const bbHours = Number(getEffectiveSettingValue('BB_SIGNAL_A_BB_HOURS'))
  const activeHours = Number(getEffectiveSettingValue('BB_SIGNAL_B_ACTIVE_HOURS'))
  const thresholds = { msgHours, bbHours, activeHours }

  // Fetch the most recent outbound message timestamp for each agent in one query.
  // agent_messages.from_agent may contain a slash-prefixed sub-path; we match on
  // the exact agent_id as stored in fleet_blackboard (lower-cased base name).
  const agentIds = rows.map((r) => r.agent_id)
  const placeholders = agentIds.map(() => '?').join(',')
  const msgRows = db
    .prepare(
      `SELECT from_agent AS agent_id, MAX(created_at) AS last_msg_at
         FROM agent_messages
        WHERE from_agent IN (${placeholders})
          AND created_at > ?
        GROUP BY from_agent`,
    )
    .all(...agentIds, Math.floor(Date.now() / 1000) - msgHours * 3600) as { agent_id: string; last_msg_at: number }[]

  const lastMsgMap = new Map(msgRows.map((r) => [r.agent_id, r.last_msg_at]))
  const nowSec = Math.floor(Date.now() / 1000)

  return rows.map((row) => ({
    ...row,
    signal: computeBlackboardSignal(row, lastMsgMap.get(row.agent_id) ?? null, nowSec, thresholds),
  }))
}

function listBlackboard(limit = 10): BlackboardRow[] {
  return getDb()
    .prepare('SELECT * FROM fleet_blackboard ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as BlackboardRow[]
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
  // Only record history when the patch actually changed something.
  const changed =
    updated.status !== row.status ||
    updated.summary !== row.summary ||
    (updated.task_ref ?? null) !== (row.task_ref ?? null)
  if (changed) {
    insertBlackboardHistory({ agent_id: updated.agent_id, task_ref: updated.task_ref, status: updated.status, summary: updated.summary })
  }
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
    let since: number | undefined
    if (sinceRaw !== null) {
      const sinceVal = parseInt(sinceRaw, 10)
      if (isNaN(sinceVal)) { json(res, { error: 'since must be an integer' }, 400); return true }
      since = sinceVal
    }
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw !== null ? Math.min(Math.max(1, parseInt(limitRaw, 10) || 50), 200) : undefined
    json(res, listBlackboardHistory({ agent_id, since, limit }))
    return true
  }

  if (path === '/api/blackboard' && method === 'GET') {
    json(res, listBlackboardWithSignals(10))
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
