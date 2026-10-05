import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The subscription quota the whole fleet draws from, as the statusLine command
// last saw it. scripts/statusline-ratelimit.sh writes the block to
// store/.claude-rate-limits.json on every render, costing no tokens; this is
// the read side, so the dashboard shows the same numbers the monitor alerts on.
//
// Reading it has one rule, and it is why this module exists instead of a few
// lines in the route: a quota reading is only worth showing while it is fresh.
// A number from six hours ago looks exactly like a number from six seconds ago
// and reassures just as much, so age travels with the data and the caller is
// made to deal with it. Same for a window whose reset time has passed: the
// block only changes when an API response brings new numbers, so after a
// rollover the old percentage sits there describing a window that no longer
// exists (measured at the 2026-08-18 22:00 rollover, and the reason
// scripts/lib/quota-check.py skips those too).

/** Same default as QUOTA_MAX_AGE_SEC in scripts/limit-monitor.sh. */
export const DEFAULT_MAX_AGE_SEC = 21600

// The Fable/Opus weekly window is not part of the statusLine block above --
// it only shows up there while a session is actively using Fable, which is
// rarely true. scripts/usage-collect.py is the authoritative source instead,
// writing store/usage-latest.json on its own schedule (a heartbeat task,
// every 15 minutes). Its freshness bar has to be much tighter than the
// statusLine's 6h: a missed run here means the collector itself is down, not
// just "no session lately". ~3x the collection interval, the same margin
// usage-collect.py's own alert refire windows use.
export const DEFAULT_FABLE_MAX_AGE_SEC = 2700

export interface QuotaWindow {
  /** Percentage of the window already spent, 0-100. */
  usedPercentage: number
  /** Unix seconds when the window rolls over, null when the payload had none. */
  resetsAt: number | null
  /** The reset time has passed: this reading describes a window that is gone. */
  expired: boolean
  /** The agent whose session this window's reading came from (mod source only). */
  sourceAgent?: string
}

export interface QuotaSnapshot {
  /** ok: fresh reading. stale: too old to trust. missing: no reading at all. */
  status: 'ok' | 'stale' | 'missing'
  /** Seconds since the statusLine wrote the file, null when there is no file. */
  ageSec: number | null
  maxAgeSec: number
  fiveHour: QuotaWindow | null
  sevenDay: QuotaWindow | null
  /** Why there is nothing to show; only set when status is 'missing'. */
  reason?: 'no-file' | 'unreadable' | 'no-rate-limits' | 'no-source'
  /** Where the numbers come from (QUOTAMOD1005); absent on the plain statusLine read. */
  source?: 'statusline' | 'mod'
  /** The agents whose sessions the mod readings came from, one per window (source 'mod' only). */
  sourceAgents?: string[]
}

function readWindow(raw: unknown, nowSec: number): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { used_percentage?: unknown; resets_at?: unknown }
  if (typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null
  return {
    usedPercentage: w.used_percentage,
    resetsAt,
    expired: resetsAt !== null && resetsAt <= nowSec,
  }
}

/**
 * Read the quota snapshot the statusLine last wrote.
 *
 * Never throws: a missing or corrupt file is an answer ('missing'), not an
 * error, because the dashboard must still render. The caller is expected to
 * say WHY the strip is absent rather than drop it silently.
 */
export function readQuotaSnapshot(
  file: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  maxAgeSec: number = DEFAULT_MAX_AGE_SEC,
): QuotaSnapshot {
  const empty = { ageSec: null, maxAgeSec, fiveHour: null, sevenDay: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { status: 'missing', reason: code === 'ENOENT' ? 'no-file' : 'unreadable', ...empty }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'missing', reason: 'unreadable', ...empty }
  }

  const d = parsed as { written_at?: unknown; rate_limits?: unknown }
  const fiveHour = readWindow((d.rate_limits as Record<string, unknown>)?.five_hour, nowSec)
  const sevenDay = readWindow((d.rate_limits as Record<string, unknown>)?.seven_day, nowSec)
  if (!fiveHour && !sevenDay) {
    // An API-key account never gets a rate_limits block, and neither does a
    // subscription session before its first API response.
    return { status: 'missing', reason: 'no-rate-limits', ...empty }
  }

  const writtenAt = typeof d.written_at === 'number' && Number.isFinite(d.written_at) ? d.written_at : 0
  const ageSec = Math.max(0, nowSec - writtenAt)
  return {
    status: ageSec > maxAgeSec ? 'stale' : 'ok',
    ageSec,
    maxAgeSec,
    fiveHour,
    sevenDay,
  }
}

/**
 * The Fable/Opus weekly window, read separately because it comes from a
 * different writer (scripts/usage-collect.py -> store/usage-latest.json)
 * with its own shape and its own freshness rule. Missing/stale/unreadable
 * all degrade to 'missing' or 'stale' rather than throwing, same rule as
 * readQuotaSnapshot: the dashboard must still render.
 */
export interface FableSnapshot {
  status: 'ok' | 'stale' | 'missing'
  ageSec: number | null
  window: QuotaWindow | null
}

/** usage-collect.py's window shape: `used_percent`, not the statusLine's `used_percentage`. */
function readOpusWindow(raw: unknown, nowSec: number): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { used_percent?: unknown; resets_at?: unknown }
  if (typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null
  return {
    usedPercentage: w.used_percent,
    resetsAt,
    expired: resetsAt !== null && resetsAt <= nowSec,
  }
}

export function readFableSnapshot(
  file: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  maxAgeSec: number = DEFAULT_FABLE_MAX_AGE_SEC,
): FableSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return { status: 'missing', ageSec: null, window: null }
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'missing', ageSec: null, window: null }

  const d = parsed as { generated_at?: unknown; claude?: unknown }
  const claude = d.claude && typeof d.claude === 'object' ? (d.claude as Record<string, unknown>) : null
  const windows = claude?.windows && typeof claude.windows === 'object' ? (claude.windows as Record<string, unknown>) : null
  // Non-tiered accounts report this window as null forever, same as the
  // collector's own "skip gracefully" handling -- that's a permanent
  // "nothing to show", not a freshness problem, so it stays 'missing'.
  // NOTE: usage-collect.py's field is `used_percent`, not the statusLine's
  // `used_percentage` -- readWindow() above is the wrong shape for this source.
  const window = windows ? readOpusWindow(windows.seven_day_opus, nowSec) : null
  if (!window) return { status: 'missing', ageSec: null, window: null }

  // A missing generated_at counts as maximally old, matching how
  // readQuotaSnapshot treats a missing written_at above.
  let generatedAtSec = 0
  if (typeof d.generated_at === 'string') {
    const ms = Date.parse(d.generated_at)
    if (!Number.isNaN(ms)) generatedAtSec = Math.floor(ms / 1000)
  }
  const ageSec = Math.max(0, nowSec - generatedAtSec)
  return { status: ageSec > maxAgeSec ? 'stale' : 'ok', ageSec, window }
}

/**
 * QUOTAMOD1005 -- the same windows read from the agent-state-observer mod's
 * state files (<dir>/<agent>.json, see src/web/state-observer.ts). This is the
 * source that works on a setup-token install, where the statusLine block never
 * arrives.
 *
 * Each file's rateLimits come from THAT session's last API response, so an
 * idle agent's numbers age while the others burn the window. The rule, per
 * kind: drop a reading whose window has already reset, take the LATEST window
 * still open, and within it the HIGHEST percentage (the same rule as
 * scripts/usage-alert/usage_alert.py). A missing five_hour means "no window
 * open" (it disappears at its reset and returns with the next API response).
 * Freshness travels with the data, and it is the age of the NUMBERS, not of
 * the file: alive_at ticks every minute on an idle agent while its readings
 * stay those of its last API answer (measured 2026-10-05). So a source's data
 * time is now while it is working or awaiting approval, else the time of its
 * last turn.complete in the mod's history; with neither (e.g. right after a
 * restart) its age is unknown and the snapshot is stale. ageSec is the OLDEST
 * data time among the chosen windows.
 */
export function readModQuotaSnapshot(
  dir: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  maxAgeSec: number = DEFAULT_MAX_AGE_SEC,
): QuotaSnapshot {
  const empty = { ageSec: null, maxAgeSec, fiveHour: null, sevenDay: null, source: 'mod' as const, sourceAgents: [] }
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return { status: 'missing', reason: 'no-file', ...empty }
  }
  type Pick = { pct: number; resetsAt: number; agent: string; dataSec: number | null }
  const best: Record<'five_hour' | 'seven_day', Pick | null> = { five_hour: null, seven_day: null }
  let sources = 0
  for (const name of names) {
    let d: {
      agent?: unknown; alive_at?: unknown; state?: unknown
      history?: Array<{ ts?: unknown; reason?: unknown }>; usage?: { rateLimits?: unknown }
    }
    try {
      d = JSON.parse(readFileSync(join(dir, name), 'utf-8'))
    } catch {
      continue // a half-written file: the next render reads it whole
    }
    if (!d || typeof d !== 'object' || typeof d.alive_at !== 'number') continue
    sources++
    const agent = typeof d.agent === 'string' && d.agent ? d.agent : name.slice(0, -'.json'.length)
    const dataSec = sourceDataSec(d)
    const limits = Array.isArray(d.usage?.rateLimits) ? d.usage!.rateLimits as unknown[] : []
    for (const raw of limits) {
      const r = raw as { kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }
      if (r.kind !== 'five_hour' && r.kind !== 'seven_day') continue
      if (typeof r.percentUsed !== 'number' || !Number.isFinite(r.percentUsed) || typeof r.resetsAt !== 'string') continue
      const resetsAt = Math.floor(Date.parse(r.resetsAt) / 1000)
      if (!Number.isFinite(resetsAt) || resetsAt <= nowSec) continue
      const cur = best[r.kind]
      if (!cur || resetsAt > cur.resetsAt || (resetsAt === cur.resetsAt && r.percentUsed > cur.pct)) {
        best[r.kind] = { pct: r.percentUsed, resetsAt, agent, dataSec }
      }
    }
  }
  if (sources === 0) return { status: 'missing', reason: 'no-file', ...empty }
  const picks = [best.five_hour, best.seven_day].filter((p): p is Pick => p !== null)
  if (picks.length === 0) return { status: 'missing', reason: 'no-rate-limits', ...empty }
  const known = picks.every((p) => p.dataSec !== null)
  const ageSec = known ? Math.max(0, nowSec - Math.min(...picks.map((p) => p.dataSec as number))) : null
  const window = (p: Pick | null): QuotaWindow | null =>
    p ? { usedPercentage: p.pct, resetsAt: p.resetsAt, expired: false, sourceAgent: p.agent } : null
  return {
    status: ageSec === null || ageSec > maxAgeSec ? 'stale' : 'ok',
    ageSec,
    maxAgeSec,
    fiveHour: window(best.five_hour),
    sevenDay: window(best.seven_day),
    source: 'mod',
    sourceAgents: [...new Set(picks.map((p) => p.agent))],
  }
}

/** When a mod source's numbers were last current (unix seconds), or null when unknown. */
function sourceDataSec(d: { alive_at?: unknown; state?: unknown; history?: Array<{ ts?: unknown; reason?: unknown }> }): number | null {
  if ((d.state === 'working' || d.state === 'awaiting_approval') && typeof d.alive_at === 'number') {
    return Math.floor(d.alive_at / 1000)
  }
  const history = Array.isArray(d.history) ? d.history : []
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h && typeof h.ts === 'number' && typeof h.reason === 'string' && h.reason.startsWith('turn.complete')) {
      return Math.floor(h.ts / 1000)
    }
  }
  return null
}

/**
 * Which of the two readings the strip shows: a fresh one over a stale one over
 * none, and between two of the same standing the younger. When neither has a
 * reading, the answer says so as 'no-source': the strip then tells the operator
 * that on a setup-token install the numbers need the observer mod on an agent.
 */
export function chooseQuotaSnapshot(statusLine: QuotaSnapshot, mod: QuotaSnapshot): QuotaSnapshot {
  const tagged: QuotaSnapshot = { ...statusLine, source: 'statusline' }
  const rank = (q: QuotaSnapshot) => (q.status === 'ok' ? 2 : q.status === 'stale' ? 1 : 0)
  if (rank(tagged) === 0 && rank(mod) === 0) {
    // An API-key account has no windows at all: keep that answer when either source gave it.
    const noLimits = tagged.reason === 'no-rate-limits' || mod.reason === 'no-rate-limits'
    return { ...tagged, reason: noLimits ? 'no-rate-limits' : 'no-source' }
  }
  if (rank(mod) !== rank(tagged)) return rank(mod) > rank(tagged) ? mod : tagged
  return (mod.ageSec ?? Infinity) < (tagged.ageSec ?? Infinity) ? mod : tagged
}
