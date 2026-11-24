// Scoped board access: which kanban cards a colleague-facing sub-agent may see.
//
// A sub-agent that serves one or more PEOPLE (e.g. a colleague's chat
// assistant) should not read the whole kanban board. The owner lists those
// agents and the people they serve in store/board-access.json; for such an
// agent's own dashboard token (AGENT_TOKENS, auth.tokenAgent) the whole
// /api/kanban* family is closed and /api/board/* is the only board surface.
// There the server, not the agent, decides which cards are visible:
//
//   role "self" -> cards whose assignee is one of the person's assignee strings
//   role "lead" -> self, plus the cards of everyone in `reports`, recursively
//   role "all"  -> every card
//
// Config shape (owner-edited, not a secret):
//   { "enabled": true,
//     "people": { "<personId>": { "name": "...", "assignees": ["..."], "role": "self|lead|all",
//                                 "reports": ["<personId>"], "senderIds": ["<chat sender id>"] } },
//     "agents": { "<agentId>": { "people": ["<personId>"] } } }
//
// Normalisation is FAIL-CLOSED:
//   - a missing file, or `enabled` anything but literal true -> the feature is off:
//     no agent is scoped and /api/board/* answers 403 for everyone;
//   - a file that EXISTS but cannot be read as a JSON object -> `broken`: every
//     sub-agent token is refused on both /api/kanban* and /api/board/*. A present
//     file means the owner confined someone; a typo must not reopen the whole
//     board to that agent. The main token is never affected;
//   - an unknown role reads as "self"; unknown or malformed person ids are
//     dropped (from `reports` and from an agent's `people`); an agent listed
//     with no valid person stays SCOPED and sees nothing;
//   - cycles in `reports` are harmless (visited set).
//
// Threat model: see docs/board-access.md. All agents run as one Unix user, so
// this stops a confused agent, not a malicious one.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const BOARD_ACCESS_PATH = join(STORE_DIR, 'board-access.json')

export const BOARD_ROLES = ['self', 'lead', 'all'] as const
export type BoardRole = typeof BOARD_ROLES[number]

export interface BoardPerson {
  id: string
  name: string
  /** As written by the owner (trimmed, de-duplicated case-insensitively). */
  assignees: string[]
  role: BoardRole
  reports: string[]
  senderIds: string[]
}

export interface BoardAccessConfig {
  enabled: boolean
  /** The file exists but is not a readable JSON object: sub-agent tokens are locked out of the board. */
  broken: boolean
  people: Map<string, BoardPerson>
  /** agentId -> personIds (only ids present in `people`). */
  agents: Map<string, string[]>
}

const ID_RE = /^[A-Za-z0-9_.@-]{1,64}$/
const TEXT_MAX = 200
const LIST_MAX = 200

export function defaultBoardAccess(): BoardAccessConfig {
  return { enabled: false, broken: false, people: new Map(), agents: new Map() }
}

function brokenBoardAccess(): BoardAccessConfig {
  return { ...defaultBoardAccess(), broken: true }
}

/** Assignee comparison key: trimmed, case-insensitive. */
export function assigneeKey(s: string): string {
  return s.trim().toLowerCase()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function stringList(v: unknown, opts: { allowNumbers?: boolean } = {}): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v.slice(0, LIST_MAX)) {
    const s = typeof item === 'string' ? item.trim()
      : opts.allowNumbers && typeof item === 'number' && Number.isFinite(item) ? String(item)
        : ''
    if (!s || s.length > TEXT_MAX) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

/** Normalise any parsed value. Never throws. */
export function normaliseBoardAccess(raw: unknown): BoardAccessConfig {
  if (!isPlainObject(raw)) return brokenBoardAccess()
  const out = defaultBoardAccess()
  out.enabled = raw.enabled === true

  const rawPeople = isPlainObject(raw.people) ? raw.people : {}
  for (const [id, p] of Object.entries(rawPeople)) {
    if (!ID_RE.test(id) || !isPlainObject(p)) continue
    const name = typeof p.name === 'string' && p.name.trim() && p.name.trim().length <= TEXT_MAX ? p.name.trim() : id
    const role: BoardRole = (BOARD_ROLES as readonly unknown[]).includes(p.role) ? (p.role as BoardRole) : 'self'
    out.people.set(id, {
      id,
      name,
      assignees: stringList(p.assignees),
      role,
      reports: stringList(p.reports),
      senderIds: stringList(p.senderIds, { allowNumbers: true }),
    })
  }
  // Second pass: references must name a known person (exact id), never itself.
  for (const person of out.people.values()) {
    person.reports = person.reports.filter((r) => r !== person.id && out.people.has(r))
  }

  const rawAgents = isPlainObject(raw.agents) ? raw.agents : {}
  for (const [agentId, a] of Object.entries(rawAgents)) {
    if (!ID_RE.test(agentId)) continue
    // A listed agent is scoped even when its entry is malformed: listing it was the owner's decision.
    const people = isPlainObject(a) ? stringList(a.people).filter((pid) => out.people.has(pid)) : []
    out.agents.set(agentId, people)
  }
  return out
}

export function readBoardAccess(path: string = BOARD_ACCESS_PATH): BoardAccessConfig {
  if (!existsSync(path)) return defaultBoardAccess()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    logger.warn({ path }, 'board-access: unreadable, sub-agent tokens are locked out of the board until it is fixed')
    return brokenBoardAccess()
  }
  const cfg = normaliseBoardAccess(parsed)
  if (cfg.broken) logger.warn({ path }, 'board-access: not a JSON object, sub-agent tokens are locked out of the board until it is fixed')
  return cfg
}

// ---- Visibility ----------------------------------------------------------------

export const ALL_CARDS = 'all' as const
export type VisibleAssignees = Set<string> | typeof ALL_CARDS

/**
 * The assignee keys (assigneeKey) a person may see, or ALL_CARDS. An unknown
 * person sees nothing. A lead's reports are walked recursively with a visited
 * set, so a cycle terminates; the reports' OWN roles do not widen the lead's
 * view (a lead whose report is "all" still sees only the report's tree).
 */
export function visibleAssignees(cfg: BoardAccessConfig, personId: string): VisibleAssignees {
  const person = cfg.people.get(personId)
  if (!person) return new Set()
  if (person.role === 'all') return ALL_CARDS
  const out = new Set<string>()
  const visited = new Set<string>()
  const stack = [person.id]
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const p = cfg.people.get(id)
    if (!p) continue
    for (const a of p.assignees) out.add(assigneeKey(a))
    if (id === person.id ? person.role === 'lead' : true) stack.push(...p.reports)
  }
  return out
}

/** An unassigned card is visible to ALL_CARDS only. */
export function cardVisible(visible: VisibleAssignees, card: { assignee: string | null }): boolean {
  if (visible === ALL_CARDS) return true
  if (typeof card.assignee !== 'string' || !card.assignee.trim()) return false
  return visible.has(assigneeKey(card.assignee))
}

export function assigneeAllowed(visible: VisibleAssignees, assignee: string): boolean {
  if (!assignee.trim()) return false
  return visible === ALL_CARDS || visible.has(assigneeKey(assignee))
}

// ---- Principal and person ---------------------------------------------------------

/** A sub-agent token principal that the board config confines (or locks out, when broken). */
export function isScopedBoardAgent(cfg: BoardAccessConfig, tokenAgent: string | undefined): boolean {
  if (!tokenAgent) return false
  if (cfg.broken) return true
  return cfg.enabled && cfg.agents.has(tokenAgent)
}

export const BOARD_PERSON_HEADER = 'x-board-person'
export const BOARD_SENDER_HEADER = 'x-board-sender'

export type PersonResolution =
  | { ok: true; person: BoardPerson }
  | { ok: false; status: 400 | 403; error: string }

/**
 * Which person a scoped agent's request acts for. One mapped person is implied
 * (a header, if sent, must still name that person). Several need
 * X-Board-Person or X-Board-Sender. A person not mapped to THIS agent is never
 * accepted, whatever the header says.
 */
export function resolveBoardPerson(
  cfg: BoardAccessConfig,
  agent: string,
  hdr: { person?: string; sender?: string },
): PersonResolution {
  const mapped = cfg.agents.get(agent) ?? []
  if (mapped.length === 0) return { ok: false, status: 403, error: 'this agent serves no person on the board' }
  const personHdr = hdr.person?.trim() || undefined
  const senderHdr = hdr.sender?.trim() || undefined

  let byPerson: string | undefined
  if (personHdr !== undefined) {
    if (!mapped.includes(personHdr)) return { ok: false, status: 403, error: 'X-Board-Person is not a person this agent serves' }
    byPerson = personHdr
  }
  let bySender: string | undefined
  if (senderHdr !== undefined) {
    const hits = mapped.filter((pid) => cfg.people.get(pid)?.senderIds.includes(senderHdr))
    if (hits.length !== 1) return { ok: false, status: 403, error: 'X-Board-Sender does not identify exactly one person this agent serves' }
    bySender = hits[0]
  }
  if (byPerson && bySender && byPerson !== bySender) {
    return { ok: false, status: 400, error: 'X-Board-Person and X-Board-Sender name different people' }
  }
  const chosen = byPerson ?? bySender ?? (mapped.length === 1 ? mapped[0] : undefined)
  if (!chosen) {
    return { ok: false, status: 400, error: 'this agent serves several people: send X-Board-Person or X-Board-Sender' }
  }
  return { ok: true, person: cfg.people.get(chosen)! }
}

// ---- Gate -------------------------------------------------------------------------

export const BOARD_API_PREFIX = '/api/board'

/** Decoded, lower-cased, slash-collapsed: no spelling variant of a path slips past a prefix test. */
function canonicalPath(path: string): string {
  let p = path
  try { p = decodeURIComponent(path) } catch { /* keep raw */ }
  return p.toLowerCase().replace(/\/{2,}/g, '/')
}

/** The whole kanban family: /api/kanban, /api/kanban/..., /api/kanban-projects..., and any future /api/kanban<anything>. */
export function isKanbanFamilyPath(path: string): boolean {
  return canonicalPath(path).startsWith('/api/kanban')
}

export function isBoardPath(path: string): boolean {
  const p = canonicalPath(path)
  return p === BOARD_API_PREFIX || p.startsWith(`${BOARD_API_PREFIX}/`)
}

export interface BoardGateAuth {
  kind: string
  tokenAgent?: string
}

/**
 * null = let it through; otherwise the reason for a 403 (rule 'board-scope').
 * Two principals may reach /api/board: a sub-agent token board-access.json
 * lists, and a colleague board session (kind 'colleague').
 * Decided before any route runs, for gated paths. Prefix-based on purpose: a
 * kanban route added later is closed to a scoped agent without editing a list.
 * The config is read only for a kanban-family request by a sub-agent token or
 * for a /api/board request, so every other request costs nothing here.
 */
export function boardGateDecision(auth: BoardGateAuth, path: string, getConfig: () => BoardAccessConfig): string | null {
  const board = isBoardPath(path)
  // A colleague board login (colleague-sessions.ts). The colleague gate already keeps it off every other path; here
  // the board itself must be on and readable. Which person it acts as is the session's, checked by the route.
  if (auth.kind === 'colleague') {
    // Off the board this gate has nothing to say: the colleague gate decided every other path already.
    if (!board) return null
    const cfg = getConfig()
    if (cfg.broken) return 'board-access.json is unreadable; the board is closed until the owner fixes it'
    if (!cfg.enabled) return 'the scoped board is turned off'
    return null
  }
  const tokenAgent = auth.kind === 'token' ? auth.tokenAgent : undefined
  if (!board && !(tokenAgent && isKanbanFamilyPath(path))) return null
  const cfg = getConfig()
  const scoped = isScopedBoardAgent(cfg, tokenAgent)
  if (!scoped) return board ? 'the scoped board is only for agents listed in board-access.json; use /api/kanban' : null
  if (cfg.broken) return 'board-access.json is unreadable; the board is closed to sub-agent tokens until the owner fixes it'
  if (!board) return 'this agent has a scoped board: use /api/board/*, not /api/kanban'
  return null
}
