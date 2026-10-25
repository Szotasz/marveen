// Project threads: one shared conversation per kanban project between three
// parties -- the owner (dashboard UI, stored author 'owner'), the project's
// responsible agent, and the main agent (supervisor, MAIN_AGENT_ID).
//
// Before this, an agent's question for the owner went to the main agent over
// the inter-agent queue and the main agent copy-pasted it to Telegram, then
// pasted the answer back. The thread removes that relay: everything is stored
// in project_thread_messages, and the parties that must ACT on a post get it
// through the existing inter-agent queue (createAgentMessage -> the message
// router's idle-gated, send-locked session delivery). This module never types
// into a tmux session itself, so a busy agent never gets parked input: the row
// waits in agent_messages exactly like any other queued message.
//
// Addressing: every post has an addressee ROLE (to_party):
//   'owner' | 'agent' | 'main' | 'both'  ('both' = the two non-author parties)
// Delivery rules (planDeliveries):
//   - an addressed agent party gets an actionable message
//       "[Projekt-szál: <project> @<author> -> <recipient>]: <text>"
//   - the main agent, when it is neither the author nor addressed, gets a
//     lightweight FYI notice (supervision), so the owner's replies and the
//     agents' posts are visible to it without being orders
//   - the responsible agent, when not addressed, gets nothing (it can read the
//     thread); this is what keeps "Marveen, ..." posts off the agent
//   - nobody is ever notified of their own post (no loops)
//   - the owner is never a queue recipient: they read the UI, and a post with
//     needs_owner=true pings them on the owner channel (sendOwnerMessage),
//     toggleable via PROJECT_THREAD_OWNER_PING (default on).

import { getDb, createAgentMessage } from '../db.js'
import { MAIN_AGENT_ID, OWNER_NAME, DASHBOARD_PUBLIC_URL, WEB_PORT, PROJECT_ROOT, currentOwnerName, currentBotName } from '../config.js'
import { isKnownAgent } from './agent-config.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isSettingOn } from '../setting-flag.js'
import { sendOwnerMessage, type ChannelSendResult } from '../notify.js'
import { logger } from '../logger.js'

export type ToParty = 'owner' | 'agent' | 'main' | 'both'
export type AuthorRole = 'owner' | 'agent' | 'main'

export const OWNER_AUTHOR = 'owner'
export const PROJECT_THREAD_PING_SETTING = 'PROJECT_THREAD_OWNER_PING'
export const PROJECT_THREAD_MAX_CONTENT = 20000
const FYI_PREVIEW_CHARS = 500
const PING_PREVIEW_CHARS = 200

export interface ProjectThreadMessage {
  id: number
  project: string
  author: string
  to_party: ToParty
  responsible_agent: string | null
  content: string
  needs_owner: boolean
  created_at: number
  owner_read_at: number | null
}

interface Row {
  id: number; project: string; author: string; to_party: string; responsible_agent: string | null
  content: string; needs_owner: number; created_at: number; owner_read_at: number | null
}

function toMessage(r: Row): ProjectThreadMessage {
  return {
    id: r.id,
    project: r.project,
    author: r.author,
    to_party: r.to_party as ToParty,
    responsible_agent: r.responsible_agent,
    content: r.content,
    needs_owner: r.needs_owner === 1,
    created_at: r.created_at,
    owner_read_at: r.owner_read_at,
  }
}

// ---- storage ---------------------------------------------------------------

/** A project is known when any kanban card (archived too) or a kanban_projects row names it. */
export function projectExists(project: string): boolean {
  const db = getDb()
  if (db.prepare('SELECT 1 FROM kanban_cards WHERE project = ? LIMIT 1').get(project)) return true
  return !!db.prepare('SELECT 1 FROM kanban_projects WHERE project = ? LIMIT 1').get(project)
}

export function listProjectThread(project: string): ProjectThreadMessage[] {
  const rows = getDb().prepare(
    `SELECT id, project, author, to_party, responsible_agent, content, needs_owner, created_at, owner_read_at
     FROM project_thread_messages WHERE project = ? ORDER BY id ASC`,
  ).all(project) as Row[]
  return rows.map(toMessage)
}

/** Marks every unread non-owner message of the project as read by the owner. Returns how many changed. */
export function markProjectThreadRead(project: string, now = Math.floor(Date.now() / 1000)): number {
  return getDb().prepare(
    `UPDATE project_thread_messages SET owner_read_at = ?
     WHERE project = ? AND owner_read_at IS NULL AND author != ?`,
  ).run(now, project, OWNER_AUTHOR).changes
}

export interface ProjectThreadSummary {
  project: string
  messageCount: number
  /** Non-owner messages the owner has not opened yet. */
  unreadForOwner: number
  /** A needs_owner message newer than the owner's last post: someone waits on the owner. */
  waitingOnOwner: boolean
  lastMessageAt: number | null
  lastAuthor: string | null
}

export function listProjectThreadSummaries(): ProjectThreadSummary[] {
  const rows = getDb().prepare(`
    SELECT
      t.project AS project,
      COUNT(*) AS messageCount,
      SUM(CASE WHEN t.author != @owner AND t.owner_read_at IS NULL THEN 1 ELSE 0 END) AS unreadForOwner,
      MAX(t.created_at) AS lastMessageAt,
      MAX(CASE WHEN t.author = @owner THEN t.id END) AS lastOwnerId,
      MAX(CASE WHEN t.needs_owner = 1 THEN t.id END) AS lastNeedsOwnerId,
      (SELECT author FROM project_thread_messages l WHERE l.project = t.project ORDER BY l.id DESC LIMIT 1) AS lastAuthor
    FROM project_thread_messages t
    GROUP BY t.project
    ORDER BY t.project
  `).all({ owner: OWNER_AUTHOR }) as Array<{
    project: string; messageCount: number; unreadForOwner: number; lastMessageAt: number | null
    lastOwnerId: number | null; lastNeedsOwnerId: number | null; lastAuthor: string | null
  }>
  return rows.map((r) => ({
    project: r.project,
    messageCount: r.messageCount,
    unreadForOwner: r.unreadForOwner ?? 0,
    waitingOnOwner: r.lastNeedsOwnerId != null && (r.lastOwnerId == null || r.lastNeedsOwnerId > r.lastOwnerId),
    lastMessageAt: r.lastMessageAt,
    lastAuthor: r.lastAuthor,
  }))
}

export function getThreadAgentOverride(project: string): string | null {
  const row = getDb().prepare('SELECT thread_agent FROM kanban_projects WHERE project = ?').get(project) as
    | { thread_agent: string | null } | undefined
  return row?.thread_agent ?? null
}

/** Sets (or with null clears) the explicit responsible agent of a project's thread. */
export function setThreadAgentOverride(project: string, agent: string | null): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO kanban_projects (project, thread_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET thread_agent = excluded.thread_agent, updated_at = excluded.updated_at
  `).run(project, agent, now, now)
}

// ---- responsible agent -----------------------------------------------------

export interface ThreadDeps {
  isKnownAgent: (name: string) => boolean
  mainAgentId: string
  /** The from_agent the owner's queued messages carry (the router ranks this id as the owner). */
  ownerSenderId: string
  ownerLabel: () => string
  mainLabel: () => string
  pingEnabled: () => boolean
  sendOwnerMessage: (text: string) => Promise<ChannelSendResult>
  dashboardOrigin: () => string
  createAgentMessage: (from: string, to: string, content: string) => { id: number }
  helperPath: string
}

export const defaultThreadDeps: ThreadDeps = {
  isKnownAgent,
  mainAgentId: MAIN_AGENT_ID,
  ownerSenderId: OWNER_NAME,
  ownerLabel: currentOwnerName,
  mainLabel: currentBotName,
  pingEnabled: () => isSettingOn(PROJECT_THREAD_PING_SETTING),
  sendOwnerMessage,
  dashboardOrigin: () => (DASHBOARD_PUBLIC_URL || `http://localhost:${WEB_PORT}`).replace(/\/$/, ''),
  createAgentMessage: (from, to, content) => createAgentMessage(from, to, content),
  helperPath: `${PROJECT_ROOT}/scripts/marveen-api.sh`,
}

/** The agent id an assignee string names, or null when it is not a fleet agent (e.g. the owner). */
function asAgentId(raw: string, deps: Pick<ThreadDeps, 'isKnownAgent'>): string | null {
  const s = sanitizeAgentIdent(raw)
  if (!s) return null
  if (deps.isKnownAgent(s)) return s
  const lower = s.toLowerCase()
  return lower !== s && deps.isKnownAgent(lower) ? lower : null
}

export interface ResponsibleAgent {
  agent: string
  source: 'override' | 'open-cards' | 'cards' | 'fallback-main'
}

/**
 * Who answers for a project in its thread:
 *   1. the explicit override (kanban_projects.thread_agent), when it is still a known agent;
 *   2. the most common fleet-agent assignee of the project's OPEN (not done, not archived) cards;
 *   3. the most common fleet-agent assignee of any non-archived card;
 *   4. the main agent.
 * Ties go to the assignee whose card moved most recently. Assignees that are not
 * fleet agents (the owner, a stale name) are skipped.
 */
export function resolveResponsibleAgent(project: string, deps: Pick<ThreadDeps, 'isKnownAgent' | 'mainAgentId'> = defaultThreadDeps): ResponsibleAgent {
  const override = getThreadAgentOverride(project)
  if (override) {
    const id = asAgentId(override, deps)
    if (id) return { agent: id, source: 'override' }
  }
  const db = getDb()
  const pick = (openOnly: boolean): string | null => {
    const rows = db.prepare(`
      SELECT assignee, COUNT(*) AS c, MAX(updated_at) AS last
      FROM kanban_cards
      WHERE project = ? AND archived_at IS NULL AND assignee IS NOT NULL AND assignee != ''
        ${openOnly ? "AND status != 'done'" : ''}
      GROUP BY assignee
      ORDER BY c DESC, last DESC
    `).all(project) as Array<{ assignee: string }>
    for (const r of rows) {
      const id = asAgentId(r.assignee, deps)
      if (id) return id
    }
    return null
  }
  const open = pick(true)
  if (open) return { agent: open, source: 'open-cards' }
  const any = pick(false)
  if (any) return { agent: any, source: 'cards' }
  return { agent: deps.mainAgentId, source: 'fallback-main' }
}

// ---- addressing ------------------------------------------------------------

/** True when the text opens by addressing the main agent: "Marveen, ...", "@Marveen ...". */
export function addressesMain(text: string, names: string[]): boolean {
  const trimmed = text.trimStart()
  for (const name of names) {
    const n = name.trim()
    if (!n) continue
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`^@?${esc}(?![\\p{L}\\p{N}_-])`, 'iu').test(trimmed)) return true
  }
  return false
}

/** Parses an API `to` value. Accepts the role names plus the main agent's id / 'marveen' for 'main'. */
export function parseToParty(raw: unknown, mainAgentId: string): ToParty | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') return 'invalid'
  const v = raw.trim().toLowerCase()
  if (v === 'owner' || v === 'agent' || v === 'both') return v
  if (v === 'main' || v === 'marveen' || v === mainAgentId.toLowerCase()) return 'main'
  return 'invalid'
}

export function authorRole(author: string, mainAgentId: string): AuthorRole {
  if (author === OWNER_AUTHOR) return 'owner'
  if (author === mainAgentId) return 'main'
  return 'agent'
}

/** The default addressee: the owner talks to the agent, every agent talks to the owner. */
export function defaultToParty(role: AuthorRole): ToParty {
  return role === 'owner' ? 'agent' : 'owner'
}

// ---- delivery plan ---------------------------------------------------------

export interface PlannedDelivery {
  to: string
  kind: 'action' | 'fyi'
  content: string
}

export interface DeliveryInput {
  project: string
  author: string
  toParty: ToParty
  responsibleAgent: string
  content: string
  needsOwner: boolean
}

/** POSIX single-quoting, so a project name pasted into a reply command can never run anything. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function preview(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)} [... +${t.length - max} karakter]` : t
}

/** The roles a post is addressed to ('both' = the two non-author parties). */
export function addressedRoles(author: AuthorRole, to: ToParty): AuthorRole[] {
  if (to !== 'both') return [to]
  return (['owner', 'agent', 'main'] as AuthorRole[]).filter((r) => r !== author)
}

/** Pure: which agents get what for one post. See the module header for the rules. */
export function planDeliveries(input: DeliveryInput, deps: Pick<ThreadDeps, 'mainAgentId' | 'ownerLabel' | 'mainLabel' | 'helperPath'>): PlannedDelivery[] {
  const main = deps.mainAgentId
  const role = authorRole(input.author, main)
  const roles = addressedRoles(role, input.toParty)
  const authorLabel = role === 'owner' ? deps.ownerLabel() : input.author
  const partyLabel = (r: AuthorRole): string =>
    r === 'owner' ? deps.ownerLabel() : r === 'main' ? deps.mainLabel() : input.responsibleAgent
  const toLabel = roles.map(partyLabel).join(' + ')
  const needs = input.needsOwner ? ` [${deps.ownerLabel()} válaszát várja]` : ''
  const replyHint = (you: string) =>
    `\n\n(Válasz a projekt-szálba, ne inter-agent üzenetben: írd a szöveget egy fájlba, majd ` +
    `bash ${deps.helperPath} project-thread-post ${you} ${shellQuote(input.project)} <fájl> [--to owner|agent|main|both] [--needs-owner]. ` +
    `A teljes szál: bash ${deps.helperPath} project-thread-read ${shellQuote(input.project)}. Ezt az üzenetet notify:false-szal zárd le.)`

  const out = new Map<string, PlannedDelivery>()
  const add = (d: PlannedDelivery) => {
    if (d.to === input.author) return // never notify the author of their own post
    const prev = out.get(d.to)
    if (prev && prev.kind === 'action') return // action beats fyi
    out.set(d.to, d)
  }

  for (const r of roles) {
    if (r === 'owner') continue // the owner reads the UI (and gets the needs_owner ping)
    const to = r === 'main' ? main : input.responsibleAgent
    add({
      to,
      kind: 'action',
      content: `[Projekt-szál: ${input.project} @${authorLabel} -> ${to}]${needs}: ${input.content.trim()}${replyHint(to)}`,
    })
  }
  // Supervision: the main agent sees every post it is not part of, as a notice, not an order.
  if (role !== 'main' && !roles.includes('main')) {
    add({
      to: main,
      kind: 'fyi',
      content:
        `[Projekt-szál FYI: ${input.project} @${authorLabel} -> ${toLabel}]${needs}: ${preview(input.content, FYI_PREVIEW_CHARS)}` +
        `\n\n(Tájékoztató másolat, nem neked szól, nem kell rá válaszolni. Lezárás notify:false-szal. ` +
        `A teljes szál: bash ${deps.helperPath} project-thread-read ${shellQuote(input.project)}.)`,
    })
  }
  return [...out.values()]
}

// ---- post ------------------------------------------------------------------

export interface PostInput {
  project: string
  author: string
  content: string
  to?: ToParty | null
  needsOwner?: boolean
}

export interface PostResult {
  message: ProjectThreadMessage
  responsible: ResponsibleAgent
  deliveries: Array<{ to: string; kind: 'action' | 'fyi'; messageId: number }>
  ping: { attempted: boolean; sent?: boolean; reason?: string }
}

export class ThreadPostError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function ownerPingText(project: string, author: string, content: string, origin: string): string {
  return `[Projekt-szál] ${author} választ vár tőled a(z) "${project}" projektben:\n` +
    `${preview(content, PING_PREVIEW_CHARS)}\n` +
    `${origin}/?thread=${encodeURIComponent(project)}#projects`
}

/**
 * Stores one post, queues its deliveries and (needs_owner) pings the owner.
 * The caller validated author/project; this validates the addressee and content.
 */
export async function postProjectThreadMessage(input: PostInput, deps: ThreadDeps = defaultThreadDeps): Promise<PostResult> {
  const content = input.content.trim()
  if (!content) throw new ThreadPostError('content is required', 400)
  if (content.length > PROJECT_THREAD_MAX_CONTENT) throw new ThreadPostError(`content is longer than ${PROJECT_THREAD_MAX_CONTENT} characters`, 400)
  const role = authorRole(input.author, deps.mainAgentId)
  let to: ToParty = input.to ?? defaultToParty(role)
  // "Marveen, ..." / "@Marveen ..." at the start addresses the main agent when no explicit addressee was given.
  if (!input.to && role !== 'main' && addressesMain(content, [deps.mainAgentId, deps.mainLabel()])) to = 'main'
  if (to === role) throw new ThreadPostError(`to '${to}' is the author's own party`, 400)
  // The owner cannot raise needs_owner on their own post; it would wait on themselves.
  const needsOwner = role !== 'owner' && input.needsOwner === true

  const responsible = resolveResponsibleAgent(input.project, deps)
  const now = Math.floor(Date.now() / 1000)
  const db = getDb()
  const plan = planDeliveries({
    project: input.project, author: input.author, toParty: to,
    responsibleAgent: responsible.agent, content, needsOwner,
  }, deps)

  const deliveries: PostResult['deliveries'] = []
  const message = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO project_thread_messages (project, author, to_party, responsible_agent, content, needs_owner, created_at, owner_read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.project, input.author, to, responsible.agent, content, needsOwner ? 1 : 0, now, role === 'owner' ? now : null)
    const id = Number(info.lastInsertRowid)
    // The owner replying has seen the thread: everything before it counts as read.
    if (role === 'owner') markProjectThreadRead(input.project, now)
    const from = role === 'owner' ? deps.ownerSenderId : input.author
    for (const d of plan) {
      const m = deps.createAgentMessage(from, d.to, d.content)
      deliveries.push({ to: d.to, kind: d.kind, messageId: m.id })
    }
    db.prepare('UPDATE project_thread_messages SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries), id)
    return toMessage(db.prepare(
      `SELECT id, project, author, to_party, responsible_agent, content, needs_owner, created_at, owner_read_at
       FROM project_thread_messages WHERE id = ?`,
    ).get(id) as Row)
  })()

  const ping: PostResult['ping'] = { attempted: false }
  if (needsOwner && deps.pingEnabled()) {
    ping.attempted = true
    try {
      const r = await deps.sendOwnerMessage(ownerPingText(input.project, input.author, content, deps.dashboardOrigin()))
      ping.sent = r.sent
      if (!r.sent) ping.reason = r.reason
    } catch (err) {
      ping.sent = false
      ping.reason = 'send-failed'
      logger.warn({ err, project: input.project }, 'project thread owner ping failed')
    }
  }
  logger.info({ id: message.id, project: input.project, author: input.author, to, deliveries: deliveries.length, ping }, 'Project thread message posted')
  return { message, responsible, deliveries, ping }
}
