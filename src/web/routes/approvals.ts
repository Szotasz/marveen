import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage, decideApproval, rejectDecision, listCardDecisions,
  parseDecisionOptions, getKanbanCard,
  type Approval, type DecisionOption,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const AUTONOMY_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')

interface AutonomyCategory {
  key: string
  timeout_minutes?: number | null
}

interface AutonomyConfig {
  categories: AutonomyCategory[]
}

function getTimeoutAt(category: string): number | null {
  try {
    if (!existsSync(AUTONOMY_CONFIG_PATH)) return null
    const config = JSON.parse(readFileSync(AUTONOMY_CONFIG_PATH, 'utf-8')) as AutonomyConfig
    const cat = config.categories.find(c => c.key === category)
    if (!cat || cat.timeout_minutes == null) return null
    return Math.floor(Date.now() / 1000) + cat.timeout_minutes * 60
  } catch {
    return null
  }
}

function notifyMainAgent(approval: Approval): void {
  try {
    const options = parseDecisionOptions(approval.options)
    // A decision (options present) is a different ask than a binary approval,
    // so it gets its own marker -- the main agent must nudge the owner to the
    // board rather than try to resolve it itself. The options are inlined so
    // the nudge can name them without a second round-trip.
    const content = options.length
      ? [
          `[DECISION_REQUEST]`,
          `id=${approval.id}`,
          `agent=${approval.agent_id}`,
          `card=${approval.card_id ?? 'none'}`,
          `question=${approval.action_description}`,
          `options=${options.map(o => `${o.key}:${o.label}`).join(' | ')}`,
        ].join(' ')
      : [
          `[APPROVAL_REQUEST]`,
          `id=${approval.id}`,
          `agent=${approval.agent_id}`,
          `category=${approval.category}`,
          `action=${approval.action_description}`,
          `timeout_at=${approval.timeout_at ?? 'null'}`,
        ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

// Tell the main agent that a decision was answered. Without this the answer sits
// in the database and whoever asked keeps waiting -- the owner clicks, nothing
// happens, and they have to come back and say "I decided". The whole point of
// moving decisions onto the board is that the click IS the message.
function notifyDecisionAnswered(approval: Approval): void {
  try {
    const options = parseDecisionOptions(approval.options)
    const chosen = options.find(o => o.key === approval.chosen_key)
    const outcome = approval.status === 'rejected'
      ? 'NONE_OF_THE_ABOVE'
      : `${approval.chosen_key} (${chosen?.label ?? '?'})`
    const content = [
      `[DECISION_ANSWERED]`,
      `id=${approval.id}`,
      `card=${approval.card_id ?? 'none'}`,
      `question=${approval.action_description}`,
      `answer=${outcome}`,
      `by=${approval.resolved_by ?? 'owner'}`,
      approval.chosen_note ? `note=${approval.chosen_note}` : '',
    ].filter(Boolean).join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the answer is recorded regardless. Logged loudly, because a
    // silently undelivered answer is exactly what this function prevents.
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent that a decision was answered')
  }
}

// Validate a caller-supplied options array. Returns the cleaned list, or a
// string describing why it is unusable. Rejecting a bad menu at creation time
// matters: a decision the owner cannot answer is worse than no decision at
// all, because it silently blocks whatever asked for it.
function validateOptions(raw: unknown): DecisionOption[] | string {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return 'options must be an array'
  if (raw.length === 0) return []
  if (raw.length < 2) return 'options needs at least 2 choices (a 1-option menu is not a decision)'
  if (raw.length > 6) return 'options is capped at 6 choices'
  const cleaned: DecisionOption[] = []
  const seen = new Set<string>()
  for (const o of raw) {
    if (!o || typeof o !== 'object') return 'each option must be an object'
    const { key, label, detail } = o as Record<string, unknown>
    if (typeof key !== 'string' || !key.trim()) return 'each option needs a non-empty key'
    if (typeof label !== 'string' || !label.trim()) return 'each option needs a non-empty label'
    if (detail !== undefined && typeof detail !== 'string') return 'option detail must be a string'
    if (seen.has(key.trim())) return `duplicate option key: ${key.trim()}`
    seen.add(key.trim())
    cleaned.push({
      key: key.trim(),
      label: label.trim(),
      ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim() } : {}),
    })
  }
  return cleaned
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: {
      agent_id?: unknown; category?: unknown; action_description?: unknown
      action_payload?: unknown; card_id?: unknown; options?: unknown
    }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, card_id } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'category is required' }, 400)
      return true
    }
    if (typeof action_description !== 'string' || !action_description.trim()) {
      json(res, { error: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }

    const options = validateOptions(body.options)
    if (typeof options === 'string') {
      json(res, { error: options }, 400)
      return true
    }
    // An unknown card_id would produce a decision that renders on no card and
    // is therefore invisible -- exactly the "lost in the thread" failure this
    // feature exists to prevent. Reject it instead of storing a dangling ref.
    let cardId: string | null = null
    if (card_id !== undefined && card_id !== null) {
      if (typeof card_id !== 'string' || !card_id.trim()) {
        json(res, { error: 'card_id must be a non-empty string if provided' }, 400)
        return true
      }
      if (!getKanbanCard(card_id.trim())) {
        json(res, { error: `card_id not found: ${card_id.trim()}` }, 404)
        return true
      }
      cardId = card_id.trim()
    }

    const id = randomUUID()
    // A decision waits for the owner, not for an autonomy clock: timing it out
    // would silently discard a question nobody answered yet.
    const timeout_at = options.length ? null : getTimeoutAt(category)
    const approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
      card_id: cardId,
      options,
    })

    notifyMainAgent(approval)
    logger.info({ id, agent_id, category, cardId, optionCount: options.length }, 'Approval request created')
    json(res, approval, 201)
    return true
  }

  // GET /api/kanban/:cardId/decisions -- decisions attached to one card.
  // This is what makes the board the decision log: the card carries its own
  // open questions and the answers already given.
  const cardDecisionsMatch = path.match(/^\/api\/kanban\/([^/]+)\/decisions$/)
  if (cardDecisionsMatch && method === 'GET') {
    const pendingOnly = url.searchParams.get('pending') === '1'
    const items = listCardDecisions(decodeURIComponent(cardDecisionsMatch[1]), { pendingOnly })
    json(res, items.map(a => ({ ...a, options: parseDecisionOptions(a.options) })))
    return true
  }

  // POST /api/approvals/:id/decide -- the owner picks one of the offered
  // options (or rejects them all). Separate from PATCH so a click cannot be
  // confused with the binary approve/reject path.
  const decideMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/)
  if (decideMatch && method === 'POST') {
    let body: { chosen_key?: unknown; decided_by?: unknown; note?: unknown; reject?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const id = decodeURIComponent(decideMatch[1])
    const decidedBy = typeof body.decided_by === 'string' && body.decided_by.trim()
      ? body.decided_by.trim()
      : 'owner'
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null

    const target = getApproval(id)
    if (!target) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    if (target.status !== 'pending') {
      json(res, { error: `Already resolved as ${target.status}` }, 409)
      return true
    }
    if (!parseDecisionOptions(target.options).length) {
      json(res, { error: 'This request has no options -- use PATCH to approve or reject it' }, 400)
      return true
    }

    if (body.reject === true) {
      rejectDecision(id, decidedBy, note)
      logger.info({ id, decidedBy }, 'Decision rejected (none of the offered options)')
      const rejected = getApproval(id)
      if (rejected) notifyDecisionAnswered(rejected)
      json(res, rejected)
      return true
    }

    if (typeof body.chosen_key !== 'string' || !body.chosen_key.trim()) {
      json(res, { error: 'chosen_key is required (or pass reject: true)' }, 400)
      return true
    }
    if (!decideApproval(id, body.chosen_key.trim(), decidedBy, note)) {
      json(res, { error: `chosen_key is not one of the offered options: ${body.chosen_key}` }, 400)
      return true
    }
    logger.info({ id, chosen: body.chosen_key, decidedBy }, 'Decision recorded')
    const answered = getApproval(id)
    if (answered) notifyDecisionAnswered(answered)
    json(res, answered)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100

    const items = listApprovals({ agent_id, category, status, limit })
    json(res, items)
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    json(res, approval)
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }
    if (typeof resolved_by !== 'string' || !resolved_by.trim()) {
      json(res, { error: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null

    // Self-approval guard: the requesting agent cannot approve its own request.
    // This is a best-effort check on the self-declared resolved_by value (all fleet
    // agents share the same bearer token, so server-side identity is not enforceable).
    // It catches naive/accidental self-approvals; the real control lives on the
    // main-agent side (approval-request-handling skill).
    const target = getApproval(idMatch[1])
    if (target && resolved_by.trim() === target.agent_id) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    const updated = resolveApproval(idMatch[1], status, resolved_by.trim(), msgId)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'Not found' }, 404)
      } else {
        json(res, { error: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    logger.info({ id: idMatch[1], status, resolved_by }, 'Approval resolved')
    json(res, approval)
    return true
  }

  return false
}
