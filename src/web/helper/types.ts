// Task-side data model of the local helper (docs/superpowers/specs/2026-10-26-local-helper-task-routing-design.md
// 4.3). Pure parsing only: scheduled-tasks-io.ts imports this module, so it
// must not import anything (a test that mocks ../config.js for the task
// reader must not have to know about the helper).

// The six task types the owner can tick per provider (SPEC.md section 2).
export const HELPER_TASK_TYPES = ['watch', 'wake', 'quietHeartbeat', 'rotationDecision', 'triage', 'summary'] as const
export type HelperTaskType = typeof HELPER_TASK_TYPES[number]
export type HelperFallback = 'skip' | 'opus'

export type WatchKind = 'kanban-comment' | 'message' | 'time'
const WATCH_KINDS: readonly WatchKind[] = ['kanban-comment', 'message', 'time']

/**
 * One deterministic watch. The matcher is code; the model is consulted only
 * for an item the matcher cannot classify, and only when `needsJudgement`.
 *
 * - kanban-comment: `target` = card id. A comment counts when its author
 *   starts with `authorPrefix` (any author when unset). A comment matching
 *   `match` is a HIT (escalated without asking the model); a counted comment
 *   that does not match goes to the model when `needsJudgement`, else ignored.
 * - message: `target` = sender agent id ("*" = anyone), `to` optionally narrows
 *   the recipient. Same hit / judgement rule on the message content.
 * - time: `target` = ISO time; fires once when it has passed (one-shot wake).
 */
export interface WatchSpec {
  kind: WatchKind
  target: string
  authorPrefix?: string
  to?: string
  match?: string
  needsJudgement?: boolean
  /** ISO deadline: past it, the watch sends one "expired" note and switches off. */
  until?: string
  /** Agent the escalation goes to (default: the task's own agent). */
  escalateTo?: string
  /** Keep watching after the first escalation (default: switch off). */
  repeat?: boolean
  /** Short context line copied into the escalation (max 300 chars). */
  note?: string
}

export const MAX_WATCH_REGEX_LEN = 300
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function parseHelperType(raw: unknown): HelperTaskType | undefined {
  return typeof raw === 'string' && (HELPER_TASK_TYPES as readonly string[]).includes(raw) ? raw as HelperTaskType : undefined
}

function isIsoTime(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
}

/**
 * Validates a watch spec. Returns the normalized spec, or an error string.
 * Used both by the API (400 on error) and by the task reader (an invalid
 * spec on disk reads as no watch at all, so the task runs as it did before).
 */
export function validateWatchSpec(raw: unknown): WatchSpec | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'watch must be an object'
  const r = raw as Record<string, unknown>
  const kind = r.kind as WatchKind
  if (!WATCH_KINDS.includes(kind)) return `watch.kind must be one of ${WATCH_KINDS.join(', ')}`
  const target = typeof r.target === 'string' ? r.target.trim() : ''
  if (!target) return 'watch.target is required'
  if (kind === 'time') {
    if (!isIsoTime(target)) return 'watch.target must be an ISO time for kind=time'
  } else if (kind === 'kanban-comment') {
    if (!ID_RE.test(target)) return 'watch.target must be a card id'
  } else if (target !== '*' && !AGENT_RE.test(target)) {
    return 'watch.target must be an agent id or "*"'
  }
  const spec: WatchSpec = { kind, target }
  if (r.authorPrefix !== undefined) {
    if (typeof r.authorPrefix !== 'string' || r.authorPrefix.length > 64) return 'watch.authorPrefix must be a string (max 64)'
    if (r.authorPrefix) spec.authorPrefix = r.authorPrefix
  }
  if (r.to !== undefined) {
    if (typeof r.to !== 'string' || !AGENT_RE.test(r.to)) return 'watch.to must be an agent id'
    spec.to = r.to
  }
  if (r.match !== undefined) {
    if (typeof r.match !== 'string' || !r.match || r.match.length > MAX_WATCH_REGEX_LEN) return `watch.match must be a regex string (max ${MAX_WATCH_REGEX_LEN})`
    try { new RegExp(r.match, 'i') } catch { return 'watch.match is not a valid regex' }
    spec.match = r.match
  }
  if (r.needsJudgement !== undefined) {
    if (typeof r.needsJudgement !== 'boolean') return 'watch.needsJudgement must be a JSON boolean'
    if (r.needsJudgement) spec.needsJudgement = true
  }
  if (r.until !== undefined) {
    if (!isIsoTime(r.until)) return 'watch.until must be an ISO time'
    spec.until = r.until
  }
  if (r.escalateTo !== undefined) {
    if (typeof r.escalateTo !== 'string' || !AGENT_RE.test(r.escalateTo) || r.escalateTo === 'system') return 'watch.escalateTo must be an agent id (not "system")'
    spec.escalateTo = r.escalateTo
  }
  if (r.repeat !== undefined) {
    if (typeof r.repeat !== 'boolean') return 'watch.repeat must be a JSON boolean'
    if (r.repeat) spec.repeat = true
  }
  if (r.note !== undefined) {
    if (typeof r.note !== 'string' || r.note.length > 300) return 'watch.note must be a string (max 300)'
    if (r.note) spec.note = r.note
  }
  if (kind !== 'time' && !spec.match && !spec.needsJudgement) return 'watch needs a match regex, needsJudgement, or both'
  return spec
}

export function parseWatchSpec(raw: unknown): WatchSpec | undefined {
  if (raw === undefined || raw === null) return undefined
  const v = validateWatchSpec(raw)
  return typeof v === 'string' ? undefined : v
}

/** The task type a watch belongs to: a time watch is a one-shot wake. */
export function helperTypeForWatch(spec: WatchSpec): HelperTaskType {
  return spec.kind === 'time' ? 'wake' : 'watch'
}
