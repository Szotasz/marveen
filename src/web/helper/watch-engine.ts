// Deterministic watch engine (docs/superpowers/specs/2026-10-26-local-helper-task-routing-design.md 4.1/1). Plain
// code decides; the model is asked only about an item the matcher cannot
// classify, and only for a watch with `needsJudgement`. Per the Q1
// measurement the matcher is the PRIMARY detector: a matcher hit is escalated
// without a model call, so a model "skip" can never suppress it.
//
// Pure: every read and every side effect is a dependency. The caller
// (dispatch.ts) persists the returned state, sends the one escalation
// message and switches a finished watch off.
import type { HelperFallback } from './types.js'
import type { WatchSpec } from './types.js'

export interface WatchItem {
  id: number
  author: string
  content: string
  /** Unix seconds. */
  createdAt: number
}

export interface WatchState {
  /** Highest item id already considered; null before the first evaluation. */
  cursor: number | null
  /** Items the model could not judge yet (endpoint down, fallback skip): retried next tick. */
  pending: number[]
}

export type JudgeOutcome =
  | { kind: 'escalate'; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'unavailable' }

export interface WatchEvalDeps {
  nowMs: number
  /**
   * The items the watch looks at: for kanban-comment every comment of the
   * card, for message the messages after `afterId` (or since `sinceSec` on the
   * first evaluation). Ordered by id ascending.
   */
  listItems: (spec: WatchSpec, afterId: number | null, sinceSec: number) => WatchItem[]
  /** Asked only for a counted item the matcher did not hit, on a needsJudgement watch. */
  judge: (question: string, item: WatchItem) => Promise<JudgeOutcome>
  /** What an item the model could not judge becomes: kept pending (skip) or escalated unclassified (opus). */
  fallback: HelperFallback
}

export interface EscalatedItem {
  item: WatchItem
  via: 'matcher' | 'model' | 'fallback'
  reason?: string
}

export interface WatchEvalResult {
  nextState: WatchState
  /** null = nothing to send this tick. */
  event: 'match' | 'time' | 'expired' | null
  escalated: EscalatedItem[]
  /** True when the watch is finished and its task should be switched off. */
  done: boolean
  /** How many model calls this evaluation made (0 for every matcher-only tick). */
  modelCalls: number
  skippedByModel: number
}

const MAX_PENDING = 50
const MAX_ITEM_CHARS = 4000

export function initialWatchState(): WatchState {
  return { cursor: null, pending: [] }
}

/** Does this item belong to the watch at all (author / sender / recipient)? */
export function itemCounts(spec: WatchSpec, item: WatchItem): boolean {
  // The helper's own escalations never feed a watch (a "*" message watch would loop).
  if (item.author === 'helper') return false
  if (spec.kind === 'kanban-comment') return !spec.authorPrefix || item.author.startsWith(spec.authorPrefix)
  return true
}

export function matcherHit(spec: WatchSpec, item: WatchItem): boolean {
  if (!spec.match) return false
  try {
    return new RegExp(spec.match, 'i').test(item.content.slice(0, MAX_ITEM_CHARS))
  } catch {
    return false
  }
}

export function judgementQuestion(taskPrompt: string, spec: WatchSpec): string {
  const parts = [spec.note, taskPrompt].filter((s): s is string => !!s && !!s.trim())
  return parts.join('\n').slice(0, 2000) || 'Is this item an event the watching agent must act on now?'
}

export async function evaluateWatch(
  taskPrompt: string,
  taskCreatedAtSec: number,
  spec: WatchSpec,
  prev: WatchState | undefined,
  deps: WatchEvalDeps,
): Promise<WatchEvalResult> {
  const state = prev ?? initialWatchState()
  const nowMs = deps.nowMs
  const base = { escalated: [] as EscalatedItem[], modelCalls: 0, skippedByModel: 0 }

  if (spec.kind === 'time') {
    const at = Date.parse(spec.target)
    if (Number.isFinite(at) && nowMs >= at) return { ...base, nextState: state, event: 'time', done: true }
    return { ...base, nextState: state, event: null, done: false }
  }

  // Pending items sit at or below the cursor, so the query reaches back to them.
  const queryAfter = state.cursor !== null && state.pending.length
    ? Math.min(state.cursor, Math.min(...state.pending) - 1)
    : state.cursor
  const items = deps.listItems(spec, queryAfter, taskCreatedAtSec)
  const pendingSet = new Set(state.pending)
  // First evaluation: only items written after the watch was created count,
  // so a card's history does not fire a brand-new watch.
  const fresh = items.filter((it) => state.cursor === null ? it.createdAt >= taskCreatedAtSec : it.id > state.cursor)
  const retry = items.filter((it) => pendingSet.has(it.id) && !fresh.includes(it))
  const toConsider = [...retry, ...fresh]

  const escalated: EscalatedItem[] = []
  const stillPending: number[] = []
  let modelCalls = 0
  let skippedByModel = 0
  const question = judgementQuestion(taskPrompt, spec)

  for (const item of toConsider) {
    if (!itemCounts(spec, item)) continue
    // Matcher first, and its hit is final: the model is never asked about it.
    if (matcherHit(spec, item)) {
      escalated.push({ item, via: 'matcher' })
      continue
    }
    if (!spec.needsJudgement) continue
    modelCalls++
    const outcome = await deps.judge(question, item)
    if (outcome.kind === 'escalate') escalated.push({ item, via: 'model', reason: outcome.reason })
    else if (outcome.kind === 'skip') skippedByModel++
    else if (deps.fallback === 'opus') escalated.push({ item, via: 'fallback' })
    else stillPending.push(item.id)
  }

  // The cursor stays null until an item has been seen, so the first-evaluation
  // rule (created after the watch) keeps applying; 0 would mean "every item".
  const maxId = items.reduce((m, it) => Math.max(m, it.id), state.cursor ?? 0)
  const nextState: WatchState = {
    cursor: items.length ? maxId : state.cursor,
    pending: stillPending.slice(-MAX_PENDING),
  }

  if (escalated.length > 0) {
    return { nextState, event: 'match', escalated, done: !spec.repeat, modelCalls, skippedByModel }
  }
  if (spec.until && nowMs > Date.parse(spec.until)) {
    return { nextState, event: 'expired', escalated, done: true, modelCalls, skippedByModel }
  }
  return { nextState, event: null, escalated, done: false, modelCalls, skippedByModel }
}

function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export const MAX_ESCALATION_CHARS = 1200

/**
 * The ONE inter-agent message an evaluation sends (SPEC.md section 5): a
 * single-line header, the note, and at most 3 evidence lines. Model text is
 * marked as such and length-capped; the receiving agent treats the whole
 * message as data from a lower-trust sender.
 */
export function buildEscalationMessage(opts: {
  taskName: string
  helperType: string
  spec: WatchSpec
  event: 'match' | 'time' | 'expired'
  escalated: EscalatedItem[]
}): string {
  const { taskName, helperType, spec, event, escalated } = opts
  const ref = spec.kind === 'time' ? spec.target : `${spec.kind === 'kanban-comment' ? 'card' : 'from'}:${spec.target}`
  const header = `[HELPER-ESCALATE task=${taskName} type=${helperType} event=${event === 'match' ? spec.kind : event} ref=${ref}]`
  const lines: string[] = [header]
  if (spec.note) lines.push(clean(spec.note, 300))
  if (event === 'time') lines.push('Időzített ébresztés: a megadott időpont elérkezett.')
  if (event === 'expired') lines.push(`A figyelés lejárt (${spec.until}) találat nélkül; kikapcsoltam.`)
  if (event === 'match') {
    if (escalated.length > 3) lines.push(`${escalated.length} találat, az első 3:`)
    for (const e of escalated.slice(0, 3)) {
      const tag = e.via === 'matcher' ? 'minta' : e.via === 'model' ? `modell: ${clean(e.reason ?? '', 160)}` : 'nem osztályozott, a helper nem elérhető'
      lines.push(`- #${e.item.id} ${clean(e.item.author, 64)} (${tag}): ${clean(e.item.content, 200)}`)
    }
  }
  return lines.join('\n').slice(0, MAX_ESCALATION_CHARS)
}
