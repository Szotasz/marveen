import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// Compact task-state re-injection (Adam stability-fix #4, scoped 2026-06-03).
//
// When a sub-agent auto-compacts mid-task, Claude Code's own summary can lose
// the specific in-flight task-state and the agent "continues amnesically" --
// worst case RE-DELEGATING work already in flight. The PreCompact agent-hook
// (type:agent, already context-aware) writes a STRUCTURED record here; a
// SessionStart hook re-injects it on source=compact|resume.
//
// Fail-safe by design: if the PreCompact extraction fails (AUP/#209) no record
// is written -> re-injection no-ops -> Claude's own compact summary is used ->
// ZERO regression. The feature can only help, never harm.

const STORE_DIR = join(PROJECT_ROOT, 'store', 'agent-taskstate')

// Orphan hygiene only: the consumed flag is the PRIMARY single-replay guard, so
// the TTL can be generous -- a legitimate task may run many hours. 12h sweeps a
// truly abandoned record without risking dropping a real long-running task.
export const TASKSTATE_TTL_MS = 12 * 60 * 60 * 1000

// SessionStart sources we replay on. NOT 'startup' (a cold start has no
// in-flight task to resume) -- only an in-place compact or a resume/respawn.
const REPLAY_SOURCES = new Set(['compact', 'resume'])

export interface AgentTaskState {
  agent: string
  doneSteps: string[]        // completed -- do NOT repeat
  alreadyDelegated: string[] // already handed to another agent -- do NOT re-send
  nextAction: string         // where to resume
  pendingDecision: string    // open decision/blocker, if any
  summary: string            // one-line what-am-I-doing
  ts: number                 // epoch ms, written at PreCompact
  consumed: boolean          // set true AFTER a successful replay injection
}

function sanitizeAgent(agent: string): string {
  // Defense: the agent name becomes a filename. Allow only the safe charset.
  return agent.replace(/[^a-zA-Z0-9_-]/g, '')
}

function recordPath(agent: string): string {
  return join(STORE_DIR, `${sanitizeAgent(agent)}.json`)
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50)
}

/** True when the record carries no actual in-flight task (so nothing to replay). */
export function isEmptyTaskState(r: Pick<AgentTaskState, 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision'>): boolean {
  return (
    r.doneSteps.length === 0 &&
    r.alreadyDelegated.length === 0 &&
    !r.nextAction.trim() &&
    !r.pendingDecision.trim()
  )
}

/**
 * Pure decision: should this record be re-injected at SessionStart?
 * Replays ONLY when: record exists, not yet consumed, source is compact|resume
 * (never cold startup), within TTL, and the record actually holds a task.
 */
export function shouldReplayTaskState(
  record: AgentTaskState | null,
  source: string,
  nowMs: number,
  ttlMs: number = TASKSTATE_TTL_MS,
): boolean {
  if (!record) return false
  if (record.consumed) return false
  if (!REPLAY_SOURCES.has(source)) return false
  if (nowMs - record.ts > ttlMs) return false
  if (isEmptyTaskState(record)) return false
  return true
}

const SENTINEL = '=== TASK-FOLYTATAS (NEM uj feladat) ==='

/**
 * Build the additionalContext string. The structured do-not-resend lists are
 * the concrete defense against re-execution / re-delegation -- not the soft
 * framing alone (review hardening, Marveen 2026-06-03).
 */
export function buildTaskStateInjection(r: AgentTaskState): string {
  const lines: string[] = [
    SENTINEL,
    'A kontextusod tomoritodott egy FOLYAMATBAN LEVO feladat kozben. Ez NEM uj feladat -- FOLYTASD onnan ahol abbamaradt. NE INDITSD ujra a mar kesz lepeseket, es NE delegald ujra amit mar atadtal.',
  ]
  if (r.summary.trim()) lines.push(`FELADAT: ${r.summary.trim()}`)
  if (r.doneSteps.length) lines.push('MAR KESZ (NE ismeteld meg):\n' + r.doneSteps.map((s) => `  - ${s}`).join('\n'))
  if (r.alreadyDelegated.length) lines.push('MAR DELEGALVA (NE kuldd ujra):\n' + r.alreadyDelegated.map((s) => `  - ${s}`).join('\n'))
  if (r.nextAction.trim()) lines.push(`KOVETKEZO AKCIO (innen folytasd): ${r.nextAction.trim()}`)
  if (r.pendingDecision.trim()) lines.push(`NYITOTT DONTES / BLOKKOLO: ${r.pendingDecision.trim()}`)
  return lines.join('\n\n')
}

export function readTaskState(agent: string): AgentTaskState | null {
  const path = recordPath(agent)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentTaskState>
    return {
      agent: sanitizeAgent(agent),
      doneSteps: asStringArray(raw.doneSteps),
      alreadyDelegated: asStringArray(raw.alreadyDelegated),
      nextAction: String(raw.nextAction ?? '').trim(),
      pendingDecision: String(raw.pendingDecision ?? '').trim(),
      summary: String(raw.summary ?? '').trim(),
      ts: typeof raw.ts === 'number' ? raw.ts : 0,
      consumed: raw.consumed === true,
    }
  } catch (err) {
    logger.warn({ err, agent }, 'agent-taskstate: unreadable record')
    return null
  }
}

// Written by the PreCompact agent-hook. Always consumed:false + fresh ts, so a
// new compact's record supersedes (and re-arms) any prior one.
export function writeTaskState(
  agent: string,
  fields: Partial<Pick<AgentTaskState, 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision' | 'summary'>>,
  nowMs: number,
): AgentTaskState {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  const record: AgentTaskState = {
    agent: sanitizeAgent(agent),
    doneSteps: asStringArray(fields.doneSteps),
    alreadyDelegated: asStringArray(fields.alreadyDelegated),
    nextAction: String(fields.nextAction ?? '').trim(),
    pendingDecision: String(fields.pendingDecision ?? '').trim(),
    summary: String(fields.summary ?? '').trim(),
    ts: nowMs,
    consumed: false,
  }
  atomicWriteFileSync(recordPath(agent), JSON.stringify(record, null, 2))
  return record
}

export function markConsumed(agent: string): void {
  const r = readTaskState(agent)
  if (!r) return
  r.consumed = true
  atomicWriteFileSync(recordPath(agent), JSON.stringify(r, null, 2))
}

// Explicit done-clear (secondary to the consumed flag). Best-effort.
export function clearTaskState(agent: string): void {
  const path = recordPath(agent)
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

// Orphan sweep: drop records older than the TTL. Cheap, opportunistic.
export function sweepOrphanTaskStates(nowMs: number, ttlMs: number = TASKSTATE_TTL_MS): number {
  if (!existsSync(STORE_DIR)) return 0
  let swept = 0
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(STORE_DIR, f), 'utf-8')) as Partial<AgentTaskState>
      if (typeof raw.ts !== 'number' || nowMs - raw.ts > ttlMs) {
        unlinkSync(join(STORE_DIR, f))
        swept++
      }
    } catch {
      try { unlinkSync(join(STORE_DIR, f)) ; swept++ } catch { /* ignore */ }
    }
  }
  return swept
}
