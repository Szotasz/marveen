// The scoped board: /api/board/* (see src/web/board-access.ts, docs/board-access.md).
//
// Only a sub-agent token that board-access.json lists, or a colleague board
// session (colleague-sessions.ts, acting as its account's person), reaches these routes
// (the gate in web.ts refuses everyone else before any handler runs; the
// check is repeated here so a route never trusts its position in the chain).
// Every read is filtered to the cards the resolved person may see, and every
// write is refused on a card outside that set with the SAME 404 an absent card
// gets, so the answer never says whether an invisible card exists.
//
// Writes go through the db helpers the kanban routes use (createKanbanCard,
// moveKanbanCard, addKanbanComment) plus the move route's side effects
// (dispatch on in_progress, dependents freed on done), so events and
// notifications behave the same as on /api/kanban. The done-gate is kept for
// agents: an agent's move to done without evidence is held at testing. A
// colleague board session is a human writer, so, as a human on /api/kanban, it
// is not held (maintainer decision on #2929, option a).

import { randomUUID } from 'node:crypto'
import {
  listKanbanCards, getKanbanCard, createKanbanCard, moveKanbanCard, addKanbanComment, getKanbanComments,
  getKanbanSeqByIdPrefix, normaliseCardDate, KANBAN_STATUSES, type KanbanCard,
} from '../../db.js'
import { APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { json, readBodyOrRefuse } from '../http-helpers.js'
import {
  readBoardAccess, resolveBoardPerson, visibleAssignees, cardVisible, assigneeAllowed, isScopedBoardAgent,
  BOARD_PERSON_HEADER, BOARD_SENDER_HEADER, type BoardPerson, type VisibleAssignees,
} from '../board-access.js'
import { fireKanbanDispatch, notifyUnblockedCards, statusChangeExtras, KANBAN_EVIDENCE_MAX_CHARS } from './kanban.js'
import type { RouteContext } from './types.js'

const BODY_MAX_BYTES = 64 * 1024
// The kanban_cards insert trigger cuts a title above 300 characters to 300 and moves the
// full text into a comment, silently; refusing up front keeps the person's title whole.
const TITLE_MAX = 300
const DESCRIPTION_MAX = 10_000
const PROJECT_MAX = 200
const COMMENT_MAX = 10_000
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
const NOT_FOUND = 'card not found'

const CREATE_FIELDS = ['title', 'description', 'assignee', 'priority', 'due_date', 'project'] as const
const MOVE_FIELDS = ['status', 'evidence'] as const
const COMMENT_FIELDS = ['content'] as const

function header(ctx: RouteContext, name: string): string | undefined {
  const v = ctx.req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

interface Principal {
  agent: string
  person: BoardPerson
  visible: VisibleAssignees
  /**
   * Set ONLY for a colleague session cookie (auth kind 'colleague'): the account name, the human writer. It exempts
   * the move from the done-gate and is the actor on the status event. Every token path leaves it undefined.
   */
  humanAccount?: string
}

/**
 * Resolves the caller to one person, or writes the refusal and returns null.
 *
 * A colleague board session acts as the person its ACCOUNT names (resolved by
 * the gate from the server-side session); X-Board-Person / X-Board-Sender are
 * ignored for it, so no request can pick another person. A sub-agent token
 * resolves through board-access.json's agent mapping and those headers.
 */
function principal(ctx: RouteContext): Principal | null {
  if (ctx.auth?.kind === 'colleague') {
    const cfg = readBoardAccess()
    const personId = ctx.auth.person
    const person = personId ? cfg.people.get(personId) : undefined
    if (cfg.broken || !cfg.enabled || !ctx.auth.colleague || !person) {
      json(ctx.res, { error: 'the board is not available for this account', rule: 'board-scope' }, 403)
      return null
    }
    return { agent: `colleague:${ctx.auth.colleague}`, person, visible: visibleAssignees(cfg, person.id), humanAccount: ctx.auth.colleague }
  }
  const agent = ctx.auth?.kind === 'token' ? ctx.auth.tokenAgent : undefined
  const cfg = readBoardAccess()
  if (!agent || cfg.broken || !isScopedBoardAgent(cfg, agent)) {
    json(ctx.res, { error: 'the scoped board is only for agents listed in board-access.json', rule: 'board-scope' }, 403)
    return null
  }
  const r = resolveBoardPerson(cfg, agent, { person: header(ctx, BOARD_PERSON_HEADER), sender: header(ctx, BOARD_SENDER_HEADER) })
  if (!r.ok) {
    json(ctx.res, { error: r.error, rule: 'board-person' }, r.status)
    return null
  }
  return { agent, person: r.person, visible: visibleAssignees(cfg, r.person.id) }
}

/** The card when it exists, is not archived and is visible; else undefined (one answer for all three). */
function visibleCard(p: Principal, rawId: string): KanbanCard | undefined {
  let id: string
  try { id = decodeURIComponent(rawId) } catch { return undefined }
  const card = getKanbanCard(id)
  if (!card || card.archived_at != null || !cardVisible(p.visible, card)) return undefined
  return card
}

/**
 * The #hex8 -> #seq lookup for a comment, limited to the cards this caller may see.
 * Resolving against the whole board would answer, in the stored comment, whether an
 * invisible card exists and what its seq is; an invisible card's reference stays as typed.
 */
export function visibleSeqLookup(visible: VisibleAssignees): (prefix: string) => number | null {
  return (prefix) => {
    const card = getKanbanCard(prefix)
    if (!card || card.archived_at != null || !cardVisible(visible, card)) return null
    return getKanbanSeqByIdPrefix(prefix)
  }
}

/** A strict JSON-object body: unknown keys are a 400 naming the accepted ones. null = a response was written. */
async function strictBody(ctx: RouteContext, accepted: readonly string[]): Promise<Record<string, unknown> | null> {
  const buf = await readBodyOrRefuse(ctx.req, ctx.res, { maxBytes: BODY_MAX_BYTES })
  if (buf === null) return null
  let parsed: unknown
  try { parsed = buf.length ? JSON.parse(buf.toString()) : undefined } catch { parsed = undefined }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    json(ctx.res, { error: 'body must be a JSON object', accepted }, 400)
    return null
  }
  const unknown = Object.keys(parsed).filter((k) => !accepted.includes(k))
  if (unknown.length) {
    json(ctx.res, { error: 'unknown field(s)', unknown, accepted }, 400)
    return null
  }
  return parsed as Record<string, unknown>
}

function unknownParams(ctx: RouteContext, known: readonly string[]): boolean {
  const unknown = [...ctx.url.searchParams.keys()].filter((k) => !known.includes(k))
  if (!unknown.length) return false
  json(ctx.res, { error: 'unknown query parameter', unknown, known }, 400)
  return true
}

function nonEmptyString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= max ? s : null
}

// ---- Report -------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

export function localDate(ms: number, tz: string): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz })
}

/**
 * The calendar day a card is due. A date-only due date (what the dashboard's
 * date picker and a 'YYYY-MM-DD' body store) is UTC midnight of that day, and
 * the dashboard shows it as that UTC date, so it is read the same way here; a
 * due date with a time of day is read in the server's zone.
 */
export function cardDueDay(dueDate: number | null, tz: string): string | null {
  if (typeof dueDate !== 'number' || !Number.isFinite(dueDate)) return null
  return dueDate % 86400 === 0 ? new Date(dueDate * 1000).toISOString().slice(0, 10) : localDate(dueDate * 1000, tz)
}

export const REPORT_GROUPS = ['due_today', 'overdue', 'in_progress', 'waiting', 'planned'] as const
export type ReportGroup = typeof REPORT_GROUPS[number]

const GROUP_LABELS: Record<ReportGroup, string> = {
  due_today: 'Due today',
  overdue: 'Overdue',
  in_progress: 'In progress',
  waiting: 'Waiting',
  planned: 'Planned',
}
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const TEXT_ITEMS_PER_GROUP = 10
const TEXT_TITLE_MAX = 80

export interface ReportCard {
  id: string
  seq?: number
  title: string
  status: KanbanCard['status']
  assignee: string | null
  priority: KanbanCard['priority']
  project: string | null
  due: string | null
}

export interface BoardReport {
  person: { id: string; name: string }
  date: string
  timezone: string
  groups: Record<ReportGroup, ReportCard[]>
  text: string
}

/**
 * Groups the person's open cards for one day. Each card lands in the FIRST
 * group it fits, in REPORT_GROUPS order, so it is listed once. Done cards are
 * left out. `planned` is ordered by due day (undated last), then priority.
 */
export function buildBoardReport(person: { id: string; name: string }, cards: readonly KanbanCard[], date: string, tz: string): BoardReport {
  const groups = Object.fromEntries(REPORT_GROUPS.map((g) => [g, [] as ReportCard[]])) as Record<ReportGroup, ReportCard[]>
  for (const c of cards) {
    if (c.status === 'done' || c.archived_at != null) continue
    const due = cardDueDay(c.due_date, tz)
    const rc: ReportCard = {
      id: c.id, ...(c.seq !== undefined ? { seq: c.seq } : {}), title: c.title, status: c.status,
      assignee: c.assignee, priority: c.priority, project: c.project, due,
    }
    const group: ReportGroup =
      due === date ? 'due_today'
        : due !== null && due < date ? 'overdue'
          : c.status === 'in_progress' || c.status === 'testing' ? 'in_progress'
            : c.status === 'waiting' ? 'waiting'
              : 'planned'
    groups[group].push(rc)
  }
  const byDueThenPriority = (a: ReportCard, b: ReportCard): number => {
    if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1
    return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
  }
  for (const g of REPORT_GROUPS) groups[g].sort(byDueThenPriority)

  const lines: string[] = [`Board report for ${person.name}, ${date}`]
  let total = 0
  for (const g of REPORT_GROUPS) {
    const list = groups[g]
    if (!list.length) continue
    total += list.length
    lines.push('', `${GROUP_LABELS[g]} (${list.length}):`)
    for (const c of list.slice(0, TEXT_ITEMS_PER_GROUP)) {
      const title = c.title.length > TEXT_TITLE_MAX ? `${c.title.slice(0, TEXT_TITLE_MAX - 1)}…` : c.title
      const meta = [c.seq !== undefined ? `#${c.seq}` : c.id, c.status, c.priority !== 'normal' ? c.priority : '', c.due && g !== 'due_today' ? `due ${c.due}` : '']
        .filter(Boolean).join(', ')
      lines.push(`- ${title} (${meta})`)
    }
    if (list.length > TEXT_ITEMS_PER_GROUP) lines.push(`... and ${list.length - TEXT_ITEMS_PER_GROUP} more`)
  }
  if (total === 0) lines.push('', 'No open cards.')
  return { person: { id: person.id, name: person.name }, date, timezone: tz, groups, text: lines.join('\n') }
}

// ---- Routes -------------------------------------------------------------------------

export async function tryHandleBoard(ctx: RouteContext): Promise<boolean> {
  const { path, method, res } = ctx
  if (path !== '/api/board' && !path.startsWith('/api/board/')) return false

  if (path === '/api/board/cards' && method === 'GET') {
    if (unknownParams(ctx, ['status'])) return true
    const rawStatus = ctx.url.searchParams.get('status')
    let statuses: string[] | undefined
    if (rawStatus !== null) {
      statuses = rawStatus.split(',').map((s) => s.trim()).filter(Boolean)
      const invalid = statuses.filter((s) => !(KANBAN_STATUSES as readonly string[]).includes(s))
      if (!statuses.length || invalid.length) {
        json(res, { error: statuses.length ? 'unknown status' : 'empty status', invalid, accepted: [...KANBAN_STATUSES] }, 400)
        return true
      }
    }
    const p = principal(ctx)
    if (!p) return true
    const cards = listKanbanCards({ includeArchived: false, ...(statuses ? { statuses } : {}) }).filter((c) => cardVisible(p.visible, c))
    json(res, { person: { id: p.person.id, name: p.person.name }, cards })
    return true
  }

  if (path === '/api/board/cards' && method === 'POST') {
    const p = principal(ctx)
    if (!p) return true
    const body = await strictBody(ctx, CREATE_FIELDS)
    if (!body) return true
    const title = nonEmptyString(body.title, TITLE_MAX)
    if (!title) { json(res, { error: `title is required (a non-empty string, at most ${TITLE_MAX} characters)` }, 400); return true }
    let description: string | undefined
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > DESCRIPTION_MAX) {
        json(res, { error: `description must be a string of at most ${DESCRIPTION_MAX} characters` }, 400); return true
      }
      description = body.description
    }
    let assignee: string | undefined
    if (body.assignee === undefined || body.assignee === null) {
      assignee = p.person.assignees[0]
      if (!assignee) { json(res, { error: 'assignee is required: this person has no assignee name configured' }, 400); return true }
    } else {
      const a = nonEmptyString(body.assignee, PROJECT_MAX)
      if (!a) { json(res, { error: 'assignee must be a non-empty string' }, 400); return true }
      assignee = a
    }
    if (!assigneeAllowed(p.visible, assignee)) {
      json(res, { error: 'assignee is outside this person\'s board', rule: 'board-scope' }, 403)
      return true
    }
    let priority: KanbanCard['priority'] = 'normal'
    if (body.priority !== undefined && body.priority !== null) {
      if (!(PRIORITIES as readonly unknown[]).includes(body.priority)) { json(res, { error: 'unknown priority', accepted: [...PRIORITIES] }, 400); return true }
      priority = body.priority as KanbanCard['priority']
    }
    let dueDate: string | undefined
    if (body.due_date !== undefined && body.due_date !== null) {
      if (typeof body.due_date !== 'string' || !isCalendarDate(body.due_date) || normaliseCardDate(body.due_date) === null) {
        json(res, { error: 'due_date must be a date in YYYY-MM-DD format (or null)' }, 400); return true
      }
      dueDate = body.due_date
    }
    let project: string | undefined
    if (body.project !== undefined && body.project !== null) {
      const pr = nonEmptyString(body.project, PROJECT_MAX)
      if (!pr) { json(res, { error: `project must be a non-empty string of at most ${PROJECT_MAX} characters` }, 400); return true }
      project = pr
    }
    const id = randomUUID().slice(0, 8)
    createKanbanCard({
      id, title, assignee, priority,
      ...(description !== undefined ? { description } : {}),
      ...(dueDate !== undefined ? { due_date: dueDate } : {}),
      ...(project !== undefined ? { project } : {}),
    })
    logger.info({ id, agent: p.agent, person: p.person.id }, 'board: card created')
    json(res, { ok: true, id, card: getKanbanCard(id) })
    return true
  }

  if (path === '/api/board/report' && method === 'GET') {
    if (unknownParams(ctx, ['date'])) return true
    const rawDate = ctx.url.searchParams.get('date')
    if (rawDate !== null && !isCalendarDate(rawDate)) {
      json(res, { error: 'date must be YYYY-MM-DD' }, 400)
      return true
    }
    const p = principal(ctx)
    if (!p) return true
    const date = rawDate ?? localDate(Date.now(), APP_TZ)
    const cards = listKanbanCards({ includeArchived: false }).filter((c) => cardVisible(p.visible, c))
    json(res, buildBoardReport(p.person, cards, date, APP_TZ))
    return true
  }

  const cardMatch = path.match(/^\/api\/board\/cards\/([^/]+)$/)
  if (cardMatch && method === 'GET') {
    if (unknownParams(ctx, [])) return true
    const p = principal(ctx)
    if (!p) return true
    const card = visibleCard(p, cardMatch[1]!)
    if (!card) { json(res, { error: NOT_FOUND }, 404); return true }
    json(res, { ...card, comments: getKanbanComments(card.id) })
    return true
  }

  const commentMatch = path.match(/^\/api\/board\/cards\/([^/]+)\/comments$/)
  if (commentMatch && method === 'POST') {
    const p = principal(ctx)
    if (!p) return true
    const card = visibleCard(p, commentMatch[1]!)
    if (!card) { json(res, { error: NOT_FOUND }, 404); return true }
    const body = await strictBody(ctx, COMMENT_FIELDS)
    if (!body) return true
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > COMMENT_MAX) {
      json(res, { error: `content is required (a non-empty string, at most ${COMMENT_MAX} characters)` }, 400)
      return true
    }
    const comment = addKanbanComment(card.id, p.person.name, normalizeKanbanRefs(body.content, visibleSeqLookup(p.visible)))
    logger.info({ id: card.id, agent: p.agent, person: p.person.id }, 'board: comment added')
    json(res, comment)
    return true
  }

  const moveMatch = path.match(/^\/api\/board\/cards\/([^/]+)\/move$/)
  if (moveMatch && method === 'POST') {
    const p = principal(ctx)
    if (!p) return true
    const card = visibleCard(p, moveMatch[1]!)
    if (!card) { json(res, { error: NOT_FOUND }, 404); return true }
    const body = await strictBody(ctx, MOVE_FIELDS)
    if (!body) return true
    if (!(KANBAN_STATUSES as readonly unknown[]).includes(body.status)) {
      json(res, { error: 'unknown status', accepted: [...KANBAN_STATUSES] }, 400)
      return true
    }
    const status = body.status as KanbanCard['status']
    if (body.evidence !== undefined && body.evidence !== null
        && (typeof body.evidence !== 'string' || body.evidence.length > KANBAN_EVIDENCE_MAX_CHARS)) {
      json(res, { error: `evidence must be a string of at most ${KANBAN_EVIDENCE_MAX_CHARS} characters` }, 400)
      return true
    }
    const evidence = typeof body.evidence === 'string' && body.evidence.trim() ? body.evidence : undefined
    // A colleague session is the human writer: the actor on the status event is colleague:<account> (the form
    // principal() builds), so the card's history shows which colleague moved it, and a colleague account can never
    // read as an agent or the owner there. An agent token keeps the person's name as the actor.
    const actor = p.humanAccount !== undefined ? `colleague:${p.humanAccount}` : p.person.name
    // The done-gate of /api/kanban/:id/move, for agents only: an agent's close without evidence is held at testing.
    // A colleague session is a human, and a human on /api/kanban is not held (isAgentActor); neither is it here.
    const needsEvidence = status === 'done' && !evidence && p.humanAccount === undefined
    const effectiveStatus: KanbanCard['status'] = needsEvidence ? 'testing' : status
    // Compare-and-set on the status this request saw: a concurrent change answers 409, never a blind overwrite.
    if (!moveKanbanCard(card.id, effectiveStatus, 0, actor, { expectedStatus: card.status, ...(evidence ? { evidence } : {}) })) {
      const now = getKanbanCard(card.id)
      if (!now || now.archived_at != null || !cardVisible(p.visible, now)) { json(res, { error: NOT_FOUND }, 404); return true }
      json(res, { error: 'status_conflict', current_status: now.status }, 409)
      return true
    }
    logger.info({ id: card.id, agent: p.agent, person: p.person.id, status: effectiveStatus }, 'board: card moved')
    if (effectiveStatus === 'in_progress') fireKanbanDispatch(card.id, actor)
    const moved = getKanbanCard(card.id)
    if (card.status !== 'done' && moved?.status === 'done') notifyUnblockedCards(card.id, actor)
    json(res, {
      // ok is false when the close was held: a client that reads only ok must not report a closed card.
      ok: !needsEvidence,
      id: card.id,
      status: moved?.status ?? effectiveStatus,
      ...(needsEvidence ? {
        evidence_required: true,
        note: 'A card is closed only with "evidence" (what was checked: the person\'s confirmation, a document, a photo, a measured number). Without it the card was moved to testing, not done. Move it to done again with "evidence" set.',
      } : {}),
      ...statusChangeExtras(card.id, card, effectiveStatus, actor, { evidenceGiven: !!evidence }),
    })
    return true
  }

  json(res, { error: 'not found' }, 404)
  return true
}
