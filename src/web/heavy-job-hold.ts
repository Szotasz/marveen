// The context-guard's restart hold for heavy-job gate jobs
// (scripts/heavy-job-gate.sh), built on ONE invariant:
//
//   A hold EPISODE is exactly one unbroken run of consecutive sweeps in which
//   the guard is restarting the agent (continuesHoldEpisode): a restart
//   decision, or the guard waiting inside the same restart sequence for a
//   busy turn to end (request-handoff / await-handoff, the hard tier's busy
//   path). It opens at the first restart decision that finds a live gated
//   job of the agent, and it closes at
//     - the first sweep whose decision for that agent is anything else (the
//       context dropped, guard disabled, agent stopped, cooldown, or no
//       decision at all): the sweep closes it for EVERY agent it did not see
//       such a decision for, whatever path checkAgent took;
//     - the restart actually happening (settleRestart with ok);
//     - the agent's session being replaced (none of its pane pids is left).
//   Within one episode a restart is held only while the episode is younger
//   than the cap, so the total hold is at most the cap (plus the sweep that
//   notices it), whatever jobs come and go. A new episode starts fresh.
//
// The per-job records live INSIDE the episode and only decide which jobs are
// live, which got their one alert, and what the restart did to each (read
// from liveness facts right before and after the restart call). They are
// dropped with the episode, so nothing outlives it to be misreported later.
//
// Pure: the runner does the probing, the restart and the I/O.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import type { GatedJob } from './heavy-job-owner.js'

export interface HoldEntry {
  pid: number
  start: string
  /** Display only (the gate writes it raw into the ticket, sanitized into the lock record). */
  label: string
  state: GatedJob['state']
  /** First sighting inside this episode. */
  firstSeenMs: number
  /** The pre-restart alert for this job went out (once per episode). */
  alerted: boolean
  /** What happened to it inside this episode, once known. */
  outcome?: 'ended' | 'killed'
  outcomeAtMs?: number
}
export type AgentHolds = Record<string, HoldEntry>

export interface Episode {
  /** The first restart decision of the episode that found a live gated job. */
  startMs: number
  /** The agent's pane pids then; none of them left = the session was replaced. */
  panes: number[]
  jobs: AgentHolds
}

export type HoldStore = Record<string, Episode>

/** What the fresh session and the supervisor are told. */
export interface HeavyJobNote {
  /** How long the restart was held for the jobs it stopped, minutes (<= cap). */
  heldMinutes: number
  ended: string[]
  killed: Array<{ label: string; state: GatedJob['state'] }>
}

export type Alive = (pid: number, start: string) => boolean

/**
 * The one rule that keeps an episode open from one sweep to the next: this
 * sweep's decision is a restart, or it keeps the guard inside the restart
 * sequence (waiting for a handoff / for a busy turn to end). Everything else
 * ends the restart need, and with it the episode. A busy turn does not close
 * it on purpose: busy and idle sweeps alternating would otherwise open a fresh
 * episode on every idle sweep and hold the restart for as long as the
 * alternation lasts.
 */
export function continuesHoldEpisode(decision: { action: string; nextState: { phase: string } }): boolean {
  return decision.action === 'restart' || decision.nextState.phase === 'await-handoff'
}

/** pid + process start time identify the job (a reused pid is a new job). */
export function jobKey(j: { pid: number; start: string }): string {
  return `${j.pid}:${j.start}`
}

export function holdStorePath(projectRoot: string): string {
  return join(projectRoot, 'store', 'context-guard-heavy-holds.json')
}

function isEntry(v: unknown): v is HoldEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return Number.isInteger(e.pid) && typeof e.start === 'string' && typeof e.label === 'string' &&
    (e.state === 'running' || e.state === 'queued') && typeof e.firstSeenMs === 'number' &&
    Number.isFinite(e.firstSeenMs) && typeof e.alerted === 'boolean' &&
    (e.outcome === undefined || e.outcome === 'ended' || e.outcome === 'killed')
}

/** Malformed episodes/entries are dropped, never thrown. Anything that is not
 *  an episode (e.g. a store written by an earlier build) reads as no episode. */
export function parseHoldStore(raw: unknown): HoldStore {
  const out: HoldStore = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [agent, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const ep = v as Record<string, unknown>
    if (typeof ep.startMs !== 'number' || !Number.isFinite(ep.startMs)) continue
    if (!Array.isArray(ep.panes) || !ep.panes.every((p) => Number.isInteger(p))) continue
    if (!ep.jobs || typeof ep.jobs !== 'object' || Array.isArray(ep.jobs)) continue
    const jobs: AgentHolds = {}
    for (const e of Object.values(ep.jobs as Record<string, unknown>)) {
      if (isEntry(e) && !(jobKey(e) in jobs)) jobs[jobKey(e)] = e
    }
    out[agent] = { startMs: ep.startMs, panes: ep.panes as number[], jobs }
  }
  return out
}

/** A missing file is an empty store. Any other failure (unreadable, corrupt)
 *  THROWS: the caller must say so, because an empty store forgets the open
 *  episodes (a second full hold, a second alert). */
export function readHoldStore(path: string): HoldStore {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {}
    throw err
  }
  return parseHoldStore(JSON.parse(text))
}

export function writeHoldStore(path: string, store: HoldStore): void {
  atomicWriteFileSync(path, JSON.stringify(store, null, 2))
}

/** The session was replaced iff none of the episode's pane pids is left (a
 *  newly opened tmux window adds a pane; it does not replace the session). */
export function sessionReplaced(episodePanes: number[], panes: number[]): boolean {
  if (episodePanes.length === 0) return false
  return !episodePanes.some((p) => panes.includes(p))
}

export interface HoldPlan {
  hold: boolean
  /** The episode after this decision (null: none open). */
  episode: Episode | null
  /** Live jobs this restart will stop that were not alerted yet (only when !hold). */
  toAlert: HoldEntry[]
  /** Jobs seen for the first time in this episode (for the log). */
  firstSeen: HoldEntry[]
  /** Not held because the episode already used the whole cap (for the log). */
  capReached: boolean
}

/**
 * A restart decision was made for the agent. `owned` = its live gated jobs
 * now, or null when ownership could not be measured (then nothing is held and
 * only facts about the already-recorded jobs are updated); `panes` = its pane
 * pids now (null when unknown).
 */
export function planRestart(
  episode: Episode | null,
  owned: GatedJob[] | null,
  panes: number[] | null,
  nowMs: number,
  capMinutes: number,
  alive: Alive,
): HoldPlan {
  let ep: Episode | null = episode && panes && sessionReplaced(episode.panes, panes) ? null : episode
  const jobs: AgentHolds = {}
  for (const [k, e] of Object.entries(ep?.jobs ?? {})) jobs[k] = { ...e }
  const firstSeen: HoldEntry[] = []
  const ownedKeys = new Set<string>()
  for (const j of owned ?? []) {
    const k = jobKey(j)
    ownedKeys.add(k)
    const prior = jobs[k]
    if (prior && !prior.outcome) {
      prior.state = j.state
      prior.label = j.label
    } else {
      jobs[k] = { pid: j.pid, start: j.start, label: j.label, state: j.state, firstSeenMs: nowMs, alerted: false }
      firstSeen.push(jobs[k]!)
    }
  }
  for (const [k, e] of Object.entries(jobs)) {
    if (e.outcome || ownedKeys.has(k)) continue
    if (!alive(e.pid, e.start)) {
      // seen in this unbroken run of restart decisions, gone now: it ended
      // while the restart was being held
      e.outcome = 'ended'
      e.outcomeAtMs = nowMs
    } else if (owned !== null) {
      // alive, but no longer in the agent's tree: not ours to hold or report
      delete jobs[k]
    }
  }
  const liveOwned = (owned ?? []).map((j) => jobs[jobKey(j)]!)
  if (ep === null && Object.keys(jobs).length > 0) ep = { startMs: nowMs, panes: panes ?? [], jobs }
  else if (ep !== null) ep = { ...ep, jobs }
  const withinCap = ep !== null && nowMs - ep.startMs < capMinutes * 60_000
  const hold = capMinutes > 0 && liveOwned.length > 0 && withinCap
  // Unmeasured ownership: the recorded live jobs are the ones this restart may stop.
  const atRisk = owned !== null ? liveOwned : Object.values(jobs).filter((e) => !e.outcome && alive(e.pid, e.start))
  return {
    hold,
    episode: ep,
    toAlert: hold ? [] : atRisk.filter((e) => !e.alerted),
    firstSeen,
    capReached: capMinutes > 0 && liveOwned.length > 0 && !withinCap,
  }
}

/** Keys of the recorded jobs alive right before the restart call. */
export function aliveBeforeRestart(episode: Episode | null, alive: Alive): Set<string> {
  const out = new Set<string>()
  for (const [k, e] of Object.entries(episode?.jobs ?? {})) if (!e.outcome && alive(e.pid, e.start)) out.add(k)
  return out
}

/**
 * After the restart call. A job alive before it and gone now was killed by it
 * (a job that happened to end on its own inside the restart call, ~seconds,
 * is counted the same way). A successful restart closes the episode and
 * reports every outcome; a failed one keeps the episode and its facts for the
 * next restart decision of the same run.
 */
export function settleRestart(
  episode: Episode | null,
  aliveBefore: Set<string>,
  alive: Alive,
  ok: boolean,
  nowMs: number,
  capMinutes: number,
): { episode: Episode | null; note: HeavyJobNote | null } {
  if (!episode) return { episode: null, note: null }
  const jobs: AgentHolds = {}
  for (const [k, e] of Object.entries(episode.jobs)) {
    jobs[k] = { ...e }
    if (aliveBefore.has(k) && !e.outcome && !alive(e.pid, e.start)) {
      jobs[k]!.outcome = 'killed'
      jobs[k]!.outcomeAtMs = nowMs
    }
  }
  if (!ok) return { episode: { ...episode, jobs }, note: null }
  const reported = Object.values(jobs).filter((e) => e.outcome)
  if (reported.length === 0) return { episode: null, note: null }
  const killed = reported.filter((e) => e.outcome === 'killed')
  return {
    episode: null,
    note: {
      heldMinutes: Math.max(0, ...killed.map((e) => heldMinutesOf(e, episode, nowMs, capMinutes))),
      ended: reported.filter((e) => e.outcome === 'ended').map((e) => e.label),
      killed: killed.map((e) => ({ label: e.label, state: e.state })),
    },
  }
}

/** How long the restart was held for one job: from its first sighting in the
 *  episode to its outcome, never more than the cap and never outside the
 *  episode. */
export function heldMinutesOf(e: HoldEntry, episode: Episode, nowMs: number, capMinutes: number): number {
  const from = Math.max(e.firstSeenMs, episode.startMs)
  const to = Math.min(e.outcomeAtMs ?? nowMs, episode.startMs + Math.max(0, capMinutes) * 60_000)
  return Math.round(Math.max(0, to - from) / 60_000)
}
