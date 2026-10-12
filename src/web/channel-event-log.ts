/**
 * A dated, countable record of channel-plugin events.
 *
 * Card 0390aa37 asks how often the channel plugin drops. It could not be
 * answered, and the reason matters more than the answer:
 *   - store/channels-failures.log looked like the right instrument and is not.
 *     It holds the daily restart's config line (channel-watchdog.sh redirects
 *     stderr there), not plugin drops -- a near-order-of-magnitude improvement
 *     was nearly reported from it.
 *   - dashboard.log does hold the evidence, but its lines carry a TIME and no
 *     DATE (`[17:30:25.451]`), in one 332 MB file. Two days' events are
 *     indistinguishable, so there is no denominator and no rate.
 *
 * So this file is built to be counted rather than read: one JSON line per
 * event, a full ISO timestamp on every line, one file per UTC day (a day's
 * count is a `wc -l`), and a retention window so it cannot grow into the thing
 * it replaces. It does not replace dashboard.log's narrative -- it answers
 * "how often", which the narrative cannot.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'

const DAY_MS = 24 * 60 * 60 * 1000

// Long enough to see a weekly pattern and to compare "before the fix" with
// "after", short enough that the directory stays small.
export const CHANNEL_EVENT_RETENTION_DAYS = 30

const FILE_RX = /^channel-events-(\d{4})-(\d{2})-(\d{2})\.log$/

export type ChannelEventKind = 'down' | 'restart' | 'recovered' | 'gave-up'

export interface ChannelEvent {
  at: number
  agent: string
  provider: string
  event: ChannelEventKind
  detail?: Record<string, unknown>
}

/** One file per UTC day, so the same instant lands in the same file everywhere. */
export function eventLogFileName(atMs: number): string {
  return `channel-events-${new Date(atMs).toISOString().slice(0, 10)}.log`
}

/** The UTC midnight a file name names, or null if the name is not one of ours. */
export function parseEventLogDate(fileName: string): number | null {
  const m = FILE_RX.exec(fileName)
  if (!m) return null
  const parsed = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  if (!Number.isFinite(parsed)) return null
  // Date.parse accepts 2026-13-40 on some engines by rolling over; reject any
  // name that does not survive the round trip.
  return new Date(parsed).toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? parsed : null
}

/**
 * Is this file older than the retention window?
 *
 * A name we cannot date is never expired: deletion is irreversible, and an
 * unreadable name is not evidence of age. The boundary day counts as inside.
 */
export function isEventLogExpired(fileName: string, nowMs: number, retentionDays: number): boolean {
  const day = parseEventLogDate(fileName)
  if (day == null) return false
  return nowMs - day > retentionDays * DAY_MS
}

/**
 * One event, one line, JSON.
 *
 * The identity fields are written LAST so a detail key can never overwrite
 * them: a record whose own timestamp came from arbitrary call-site data would
 * be worse than no record, because it would still look countable.
 */
export function formatChannelEvent(event: ChannelEvent): string {
  const row = {
    ...(event.detail ?? {}),
    ts: new Date(event.at).toISOString(),
    agent: event.agent,
    provider: event.provider,
    event: event.event,
  }
  return `${JSON.stringify(row)}\n`
}

/** Counts per UTC day and event kind: the denominator the card was missing. */
export function summarizeByDay(contents: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    let row: { ts?: unknown, event?: unknown }
    try {
      row = JSON.parse(line) as { ts?: unknown, event?: unknown }
    } catch {
      // A truncated last line (a crash mid-append) must not cost the day.
      continue
    }
    if (typeof row.ts !== 'string' || typeof row.event !== 'string') continue
    const day = row.ts.slice(0, 10)
    const bucket = out[day] ?? (out[day] = {})
    bucket[row.event] = (bucket[row.event] ?? 0) + 1
  }
  return out
}

function eventLogDir(): string {
  return join(PROJECT_ROOT, 'store', 'channel-events')
}

let lastPruneDay = ''

function pruneExpired(nowMs: number): void {
  const today = new Date(nowMs).toISOString().slice(0, 10)
  if (lastPruneDay === today) return
  lastPruneDay = today
  try {
    for (const name of readdirSync(eventLogDir())) {
      if (!isEventLogExpired(name, nowMs, CHANNEL_EVENT_RETENTION_DAYS)) continue
      try {
        unlinkSync(join(eventLogDir(), name))
        logger.info({ file: name }, 'channel-event-log: pruned an expired day')
      } catch { /* best effort */ }
    }
  } catch { /* directory missing -- nothing to prune */ }
}

/**
 * Append one event. Never throws: a monitor that dies because its own
 * bookkeeping failed would be a worse bug than the one being measured.
 */
export function recordChannelEvent(event: ChannelEvent): void {
  try {
    const dir = eventLogDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    pruneExpired(event.at)
    appendFileSync(join(dir, eventLogFileName(event.at)), formatChannelEvent(event))
  } catch (err) {
    logger.debug({ err, agent: event.agent, event: event.event }, 'channel-event-log: append failed (non-fatal)')
  }
}

/** Test seam: forget which day was last pruned. */
export function resetPruneState(): void {
  lastPruneDay = ''
}
