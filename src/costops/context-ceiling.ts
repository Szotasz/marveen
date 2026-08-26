// CostOps -- context ceiling watch for agents whose whole point is a small context.
//
// The eco-worker is only cheaper while its context stays small. Measured against
// the fleet's scheduled work, an eco-worker beats the status quo until its
// context reaches roughly 433k tokens; above that the arithmetic inverts and it
// is no better than running the task inside the main session. For comparison,
// the main session's average context at those runs was ~461k -- so a neglected
// worker can absolutely get there.
//
// That makes context hygiene a requirement rather than a nicety, and a
// requirement nobody checks is a wish. This watches it and says so early.
//
// It only reports. It does not compact, restart, or reconfigure anything: the
// worker is the one that must keep itself tidy, and deciding what to do about a
// bloated session is an operator call.

import type Database from 'better-sqlite3'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { createAgentMessage } from '../db.js'

export const CEILING_STATE_PATH = join(PROJECT_ROOT, 'store', 'context-ceiling.json')

/**
 * Where the eco-worker's advantage disappears entirely, from the R1-A model:
 * beyond this its per-call cost matches running the task in the fat main
 * session. Not a threshold to alert on -- the point of alerting earlier is to
 * have room to act before reaching it.
 */
export const BREAK_EVEN_TOKENS = 433_000

/** Alert here, with room to act before BREAK_EVEN_TOKENS. */
export const DEFAULT_CEILING_TOKENS = 250_000

/**
 * Which agents are watched, and at what ceiling.
 *
 * Deliberately an allow-list rather than every agent. The main agent routinely
 * carries a large context by design; alerting on that would be a daily false
 * alarm, and a channel that cries wolf is how a real warning gets ignored.
 */
export const WATCHED_AGENTS: Readonly<Record<string, number>> = Object.freeze({
  vesta: DEFAULT_CEILING_TOKENS,
})

/** Don't repeat the same agent's warning more often than this. */
export const ALERT_COOLDOWN_SECONDS = 6 * 3600

export type CeilingLevel = 'ok' | 'over_ceiling' | 'past_break_even'

export interface AgentContextReading {
  agent: string
  /** Most recent call's cache_read, the best available proxy for context size. */
  context_tokens: number
  ceiling: number
  level: CeilingLevel
  measured_at: number
}

export interface CeilingState {
  /** Per agent: when we last spoke about it, so a steady 260k is not a daily drum. */
  last_alert_at: Record<string, number>
}

export const EMPTY_CEILING_STATE: CeilingState = { last_alert_at: {} }

export function classifyContext(tokens: number, ceiling: number): CeilingLevel {
  if (tokens >= BREAK_EVEN_TOKENS) return 'past_break_even'
  if (tokens >= ceiling) return 'over_ceiling'
  return 'ok'
}

/**
 * Current context size of an agent, read as the cache_read of its most recent
 * call.
 *
 * cache_read is what the model re-read on that call, which is the context it
 * was carrying -- the same quantity every cost figure in CostOps is driven by.
 * Returns null when the agent has no usage rows rather than 0: an agent that
 * has never run has no context, and reporting that as a comfortable zero would
 * make an unstarted worker look healthy.
 */
export function readAgentContext(
  db: Database.Database,
  agent: string,
  sinceSeconds = 24 * 3600,
  now = Math.floor(Date.now() / 1000),
): number | null {
  const row = db.prepare(`
    SELECT cache_read_tokens AS ctx
    FROM token_usage
    WHERE agent = ? AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(agent, now - sinceSeconds) as { ctx: number } | undefined
  return row ? row.ctx : null
}

export interface CeilingCheckResult {
  readings: AgentContextReading[]
  alerted: string[]
  /** Watched agents with no recent usage, reported rather than assumed fine. */
  not_seen: string[]
}

export interface CeilingDeps {
  now?: number
  readState?: () => CeilingState
  writeState?: (s: CeilingState) => void
  notify?: (text: string) => void
  watched?: Readonly<Record<string, number>>
}

/**
 * One check over the watched agents. Never throws: it runs on a timer.
 */
export function checkContextCeilings(db: Database.Database, deps: CeilingDeps = {}): CeilingCheckResult {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const watched = deps.watched ?? WATCHED_AGENTS
  const state: CeilingState = (deps.readState ?? (() => ({ ...EMPTY_CEILING_STATE, last_alert_at: {} })))()
  const notify = deps.notify ?? defaultNotify

  const readings: AgentContextReading[] = []
  const alerted: string[] = []
  const notSeen: string[] = []

  for (const [agent, ceiling] of Object.entries(watched)) {
    const ctx = readAgentContext(db, agent, 24 * 3600, now)
    if (ctx === null) { notSeen.push(agent); continue }
    const level = classifyContext(ctx, ceiling)
    readings.push({ agent, context_tokens: ctx, ceiling, level, measured_at: now })
    if (level === 'ok') continue

    const last = state.last_alert_at[agent]
    if (last !== undefined && now - last < ALERT_COOLDOWN_SECONDS) continue

    const k = (n: number) => `${Math.round(n / 1000)}k`
    const head = level === 'past_break_even'
      ? `${agent} context is ${k(ctx)} tokens, past the ${k(BREAK_EVEN_TOKENS)} break-even: running its tasks here is no cheaper than running them in the main session.`
      : `${agent} context is ${k(ctx)} tokens, over its ${k(ceiling)} ceiling (break-even is ${k(BREAK_EVEN_TOKENS)}).`
    notify(`${head} The worker is expected to compact between runs; this watch only reports and changes nothing.`)
    alerted.push(agent)
    state.last_alert_at[agent] = now
  }

  if (alerted.length) (deps.writeState ?? (() => {}))(state)
  return { readings, alerted, not_seen: notSeen }
}

function defaultNotify(text: string): void {
  logger.warn({ context: { action: 'context_ceiling_exceeded' } }, text)
  try {
    createAgentMessage('costops', MAIN_AGENT_ID, `[context-ceiling] ${text}`)
  } catch (err) {
    logger.error(
      { context: { action: 'context_ceiling_undeliverable' }, err: err instanceof Error ? err.message : 'unknown' },
      'Context ceiling: alert could not be queued for the main agent',
    )
  }
}

export function readCeilingState(path = CEILING_STATE_PATH): CeilingState {
  try {
    if (!existsSync(path)) return { last_alert_at: {} }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CeilingState>
    return { last_alert_at: (raw.last_alert_at && typeof raw.last_alert_at === 'object') ? raw.last_alert_at : {} }
  } catch {
    return { last_alert_at: {} }
  }
}

export function writeCeilingState(state: CeilingState, path = CEILING_STATE_PATH): void {
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    logger.warn(
      { context: { action: 'ceiling_state_write_failed' }, err: err instanceof Error ? err.message : 'unknown' },
      'Context ceiling: could not persist alert state (it will re-alert next cycle)',
    )
  }
}
