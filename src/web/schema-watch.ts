/**
 * Schema watcher: the fleet-side half of the VoiceMailAI schema preflight.
 *
 * On 2026-09-06 two migrations had never been run against production. Nothing
 * said so, and the sign-in failed earlier on another branch, so the missing
 * column and the missing table stayed invisible for a day. The backend now
 * checks its own schema at boot and publishes the verdict at
 * `GET /health/schema` -- but a verdict nobody polls is the same silence in a
 * new place, which is what this closes.
 *
 * WHY A POLL AND NOT A PUSH
 * The original request was for the backend to send an inter-agent message when
 * the check fails. It cannot: the backend runs on Railway, the dashboard runs
 * on the owner's machine at localhost:3420, and the container can neither
 * reach it nor hold a token for it. Writing that call anyway would have put a
 * never-succeeding HTTP request on the startup path -- exactly the kind of
 * quiet lie the whole card exists to prevent. So the backend answers, and this
 * asks.
 *
 * THREE STATES, AND THE THIRD IS THE DANGEROUS ONE
 * `ok`, `missing`, `unknown`. `unknown` is never an alert on its own: the
 * endpoint may be mid-deploy, the network may be down, and paging on that
 * would train the owner to ignore this. But an endpoint that stays unreachable
 * for DAYS must alert, because otherwise a permanently silent check reads
 * exactly like a permanently healthy one -- the same failure shape one level
 * up. So staleness is measured, not assumed, and the clock runs from the last
 * MEANINGFUL answer (ok or missing), not from the last request.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not interpret a non-`ok` payload. The `ok` shape was measured
 * against production on 2026-09-07; the `missing` and `unknown` shapes were
 * not -- they exist only in the backend's own tests. So anything that is not a
 * recognised `ok` is carried through verbatim into the alert, and a human
 * reads the actual body. A watcher that recognises only the healthy shape and
 * flattens everything else would be at its least precise exactly where it
 * matters.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { createAgentMessage } from '../db.js'
import { decideRoutineAlert, routineAlertSuffix, type RoutineAlertState } from './routine-alert.js'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Where the verdict is published. Unauthenticated by design; carries no data. */
export const SCHEMA_HEALTH_URL =
  process.env['VOICEMAILAI_SCHEMA_HEALTH_URL']
  ?? 'https://voicemailai-production.up.railway.app/health/schema'

/** Who hears about it. */
export const SCHEMA_WATCH_SENDER = 'schema-watch'
export const SCHEMA_WATCH_RECIPIENT = 'jarvis'

/**
 * How long `unknown` may persist before it becomes the finding.
 *
 * Two days rather than one: a single day of silence is still explainable by a
 * deploy or a maintenance window, and an alert the owner can dismiss with "it
 * was deploying" is an alert they will dismiss next time too.
 */
export const SCHEMA_UNKNOWN_STALE_MS = 2 * DAY_MS

/** Once a day. The schema does not change within an hour. */
export const SCHEMA_CHECK_INTERVAL_MS = DAY_MS

/** Matches the fleet's re-alert cadence for standing conditions. */
export const SCHEMA_ALERT_COOLDOWN_MS = 3 * HOUR_MS

const PROBE_TIMEOUT_MS = 10_000
const INITIAL_DELAY_MS = 4 * MINUTE_MS

export type SchemaState = 'ok' | 'missing' | 'unknown'

export interface SchemaProbe {
  state: SchemaState
  /** The endpoint's own words, or ours when it never answered. */
  summary: string
  missingTables: string[]
  missingColumns: string[]
  /**
   * The body as received, kept for anything that is not a recognised `ok`.
   * Null when there was no body to keep. This is what makes the alert
   * readable without this file having to guess the payload's shape.
   */
  raw: string | null
}

export type SchemaVerdict = 'ok' | 'missing' | 'unknown-recent' | 'unknown-stale'

export interface SchemaDecision {
  verdict: SchemaVerdict
  alert: boolean
  /** How long we have been without a meaningful answer; null while we have one. */
  unknownForMs: number | null
}

interface SchemaHealthBody {
  state?: unknown
  summary?: unknown
  missing_tables?: unknown
  missing_columns?: unknown
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Turn one `GET /health/schema` response into a probe reading.
 *
 * `status === 0` is the caller's marker for "the HTTP call never completed".
 * That is `unknown`, never `missing`: our own network being down says nothing
 * about the database.
 *
 * Only the exact `state: "ok"` payload is treated as healthy. Every other
 * answer -- a different state, a missing field, a proxy's HTML error page --
 * comes back as `missing` when the endpoint says so, and `unknown` otherwise,
 * with the body preserved in `raw` either way.
 */
export function parseSchemaProbe(status: number, body: unknown, rawText: string | null = null): SchemaProbe {
  if (status === 0) {
    return { state: 'unknown', summary: 'a végpont nem válaszolt', missingTables: [], missingColumns: [], raw: rawText }
  }
  if (status !== 200) {
    return {
      state: 'unknown',
      summary: `a végpont ${status} státusszal válaszolt`,
      missingTables: [],
      missingColumns: [],
      raw: rawText,
    }
  }

  const parsed = (body ?? {}) as SchemaHealthBody
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''

  if (parsed.state === 'ok') {
    return { state: 'ok', summary: summary || 'schema complete', missingTables: [], missingColumns: [], raw: null }
  }
  if (parsed.state === 'missing') {
    return {
      state: 'missing',
      summary: summary || 'a séma hiányos',
      missingTables: stringList(parsed.missing_tables),
      missingColumns: stringList(parsed.missing_columns),
      raw: rawText,
    }
  }
  return {
    state: 'unknown',
    summary: summary || 'a válasz nem az ismert alakban jött',
    missingTables: stringList(parsed.missing_tables),
    missingColumns: stringList(parsed.missing_columns),
    raw: rawText,
  }
}

/**
 * Pure verdict for one reading.
 *
 * `lastMeaningfulAt` is when the endpoint last answered `ok` or `missing`.
 * While it is null the clock runs from `watchingSince` instead, so an endpoint
 * that has NEVER answered since this watcher started still ages into an alert
 * rather than sitting quiet for ever.
 */
export function decideSchemaVerdict(opts: {
  probe: SchemaProbe
  lastMeaningfulAt: number | null
  watchingSince: number | null
  now: number
  staleAfterMs: number
}): SchemaDecision {
  const { probe, lastMeaningfulAt, watchingSince, now, staleAfterMs } = opts

  if (probe.state === 'ok') return { verdict: 'ok', alert: false, unknownForMs: null }
  if (probe.state === 'missing') return { verdict: 'missing', alert: true, unknownForMs: null }

  const since = lastMeaningfulAt ?? watchingSince
  // Nothing to measure against yet: this is the first reading of all, and one
  // reading is not a duration.
  if (since == null) return { verdict: 'unknown-recent', alert: false, unknownForMs: null }

  const unknownForMs = Math.max(0, now - since)
  if (unknownForMs >= staleAfterMs) return { verdict: 'unknown-stale', alert: true, unknownForMs }
  return { verdict: 'unknown-recent', alert: false, unknownForMs }
}

export function formatSchemaAlert(decision: SchemaDecision, probe: SchemaProbe): string {
  if (decision.verdict === 'missing') {
    const tables = probe.missingTables.length ? `\nHiányzó táblák: ${probe.missingTables.join(', ')}` : ''
    const columns = probe.missingColumns.length ? `\nHiányzó oszlopok: ${probe.missingColumns.join(', ')}` : ''
    // The summary is the backend's own sentence, not ours.
    return `❌ VoiceMailAI séma: a backend HIÁNYT jelez.\n${probe.summary}${tables}${columns}\n\nEz azt jelenti, hogy egy migráció nem futott le élesben. Ugyanaz az alakzat, ami 2026-09-06-án egy napig láthatatlan maradt.`
  }
  const days = decision.unknownForMs == null ? '?' : Math.floor(decision.unknownForMs / DAY_MS)
  const raw = probe.raw ? `\n\nA kapott válasz: ${probe.raw.slice(0, 400)}` : ''
  return `⚠️ VoiceMailAI séma: ${days} napja NEM tudjuk ellenőrizni (${probe.summary}).\n\nEz nem azt jelenti, hogy baj van, hanem hogy nem tudjuk megmondani. Egy tartósan néma ellenőrzés pontosan úgy néz ki, mint egy tartósan egészséges.${raw}`
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export interface SchemaWatchState {
  /** Last `ok` or `missing` answer. Null until the endpoint answers once. */
  lastMeaningfulAt: number | null
  /** First time this watcher ran at all, so "never answered" still ages. */
  watchingSince: number
  lastState: SchemaState | null
  alert: RoutineAlertState | null
}

export function schemaWatchStatePath(storeDir: string = STORE_DIR): string {
  return join(storeDir, '.schema-watch.json')
}

export function readSchemaWatchState(path: string): SchemaWatchState | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SchemaWatchState>
    if (typeof parsed.watchingSince !== 'number') return null
    return {
      lastMeaningfulAt: typeof parsed.lastMeaningfulAt === 'number' ? parsed.lastMeaningfulAt : null,
      watchingSince: parsed.watchingSince,
      lastState:
        parsed.lastState === 'ok' || parsed.lastState === 'missing' || parsed.lastState === 'unknown'
          ? parsed.lastState
          : null,
      alert:
        parsed.alert && typeof parsed.alert.lastSentAt === 'number'
          ? { lastSentAt: parsed.alert.lastSentAt, suppressed: Number(parsed.alert.suppressed) || 0 }
          : null,
    }
  } catch {
    // A corrupt state file must not silence the watcher; losing the timestamps
    // costs one staleness window, keeping the watcher dead costs everything.
    return null
  }
}

export function writeSchemaWatchState(path: string, state: SchemaWatchState): void {
  atomicWriteFileSync(path, JSON.stringify(state, null, 2))
}

/**
 * Fold one reading into the stored state.
 *
 * Pure, so the "unknown for days" case is producible by moving a timestamp
 * rather than by waiting two days.
 */
export function nextSchemaWatchState(
  prev: SchemaWatchState | null,
  probe: SchemaProbe,
  now: number,
  sent: boolean,
): SchemaWatchState {
  const base: SchemaWatchState = prev ?? {
    lastMeaningfulAt: null,
    watchingSince: now,
    lastState: null,
    alert: null,
  }
  const meaningful = probe.state === 'ok' || probe.state === 'missing'
  const alert: RoutineAlertState | null = sent
    ? { lastSentAt: now, suppressed: 0 }
    : base.alert
      ? { ...base.alert, suppressed: base.alert.suppressed + (probe.state === 'ok' ? 0 : 1) }
      : null
  return {
    lastMeaningfulAt: meaningful ? now : base.lastMeaningfulAt,
    watchingSince: base.watchingSince,
    lastState: probe.state,
    alert,
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

async function probeSchemaHealth(url: string): Promise<SchemaProbe> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      // A proxy or an error page. parseSchemaProbe keeps the text in `raw`.
    }
    return parseSchemaProbe(res.status, body, text.slice(0, 1000))
  } catch (err) {
    return parseSchemaProbe(0, null, err instanceof Error ? err.message : null)
  }
}

export async function checkSchemaOnce(opts: {
  url?: string
  statePath?: string
  now?: number
} = {}): Promise<SchemaDecision> {
  const url = opts.url ?? SCHEMA_HEALTH_URL
  const statePath = opts.statePath ?? schemaWatchStatePath()
  const now = opts.now ?? Date.now()

  const probe = await probeSchemaHealth(url)
  const prev = readSchemaWatchState(statePath)
  const decision = decideSchemaVerdict({
    probe,
    lastMeaningfulAt: prev?.lastMeaningfulAt ?? null,
    watchingSince: prev?.watchingSince ?? null,
    now,
    staleAfterMs: SCHEMA_UNKNOWN_STALE_MS,
  })

  let sent = false
  if (decision.alert) {
    const throttle = decideRoutineAlert(prev?.alert ?? undefined, now, SCHEMA_ALERT_COOLDOWN_MS)
    if (throttle.send) {
      const text = formatSchemaAlert(decision, probe) + routineAlertSuffix(throttle.repeats, SCHEMA_ALERT_COOLDOWN_MS)
      try {
        createAgentMessage(SCHEMA_WATCH_SENDER, SCHEMA_WATCH_RECIPIENT, text)
        sent = true
      } catch (err) {
        logger.error({ err }, 'schema-watch: could not queue the alert')
      }
    }
  }

  writeSchemaWatchState(statePath, nextSchemaWatchState(prev, probe, now, sent))
  logger.info(
    { verdict: decision.verdict, state: probe.state, unknownForMs: decision.unknownForMs, alerted: sent },
    'schema-watch: probe',
  )
  return decision
}

/** Daily poll. Returns the interval so the caller can clear it on shutdown. */
export function startSchemaWatch(): NodeJS.Timeout {
  setTimeout(() => {
    void checkSchemaOnce().catch((err) => logger.error({ err }, 'schema-watch: check failed'))
  }, INITIAL_DELAY_MS).unref?.()

  const interval = setInterval(() => {
    void checkSchemaOnce().catch((err) => logger.error({ err }, 'schema-watch: check failed'))
  }, SCHEMA_CHECK_INTERVAL_MS)
  interval.unref?.()
  return interval
}
