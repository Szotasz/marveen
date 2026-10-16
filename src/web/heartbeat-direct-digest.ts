// HBFABRIC1003: the hourly heartbeat digest is SENT by the runner itself, and
// a missing digest is REPORTED by the server -- neither depends on an LLM round.
//
// WHY. Since HBMETRICSWIRE910 the runner already measures and renders the final
// report body (collectHeartbeatMetricsBlock). The round's only remaining job was
// to put a header on it and POST it, and that was measured failing on
// 2026-10-03: at 17:00 the agent typed the Kanban lines into a heredoc before
// reading the block (a card id that never existed, counts off by one), at 18:00
// and 19:00 it wrote the POST out as text and never ran it -- while reporting
// "sent". 4 sends, 1 reached the server.
//
// (A) sendDigestDirect: for a heartbeat task with injectMetrics AND
//     sendDigestDirect, the runner builds the digest from the block and writes
//     it to the main agent's queue in-process. No session, no prompt, no
//     skipIfBusy: it has to go out exactly while the main agent is busy.
// (B) the gap guard: for EVERY heartbeat task with injectMetrics (the digest
//     family, direct or not), a scheduled slot with no digest from that task's
//     agent within HEARTBEAT_DIGEST_GRACE_MS gets ONE system note to the main
//     agent. The absence is the finding, not the route: the old LLM route's
//     silent loss is reported the same way.

import { HB_METRICS_BLOCK_MARKER } from './heartbeat-metrics-inject.js'

export const HEARTBEAT_DIGEST_GRACE_MS = 10 * 60 * 1000
/** How far back the gap guard looks for the latest slot (one hourly slot + grace). */
export const HEARTBEAT_GAP_LOOKBACK_MS = 70 * 60 * 1000
export const HEARTBEAT_GAP_CHECK_INTERVAL_MS = 5 * 60 * 1000
/** Task status for a digest the runner sent itself: terminal, nothing to wait for. */
export const DIRECT_DIGEST_RUN_STATUS = 'sent-direct'

const MARKER_TS_RE = /\bts=(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\b/

/**
 * The digest the round used to compose: "## Heartbeat <ts> (<tz>)", a
 * "merve: <ts>" freshness line, then the block's sections VERBATIM. The block's
 * own marker line and its copy-instructions (meant for an LLM) are dropped; the
 * ts is the block's, i.e. the moment the worker measured.
 */
export function buildHeartbeatDigestFromBlock(block: string, tz: string, fallbackTs: string): string {
  const lines = block.split('\n')
  const markerLine = lines.find((l) => l.startsWith(HB_METRICS_BLOCK_MARKER)) ?? ''
  const ts = MARKER_TS_RE.exec(markerLine)?.[1] ?? fallbackTs
  const firstSection = lines.findIndex((l) => l.startsWith('### '))
  const sections = firstSection >= 0
    ? lines.slice(firstSection).join('\n').trimEnd()
    : '### Kanban\n- muszer-hiba: a metrika-blokk nem tartalmazott szekciot (direkt kuldes)'
  return `## Heartbeat ${ts} (${tz})\nmerve: ${ts}\n\n${sections}`
}

export interface DirectDigestDeps {
  collectBlock: () => Promise<string>
  /** Self-check against the live board; a mismatch is logged, the digest still goes out. */
  verify: (digest: string) => { ok: true } | { ok: false; problems: string[] }
  send: (from: string, to: string, content: string) => void
  appendRun: (task: string, agent: string, status: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
  tz: string
  nowLabel: () => string
  mainAgentId: string
}

/**
 * Measure, build and send one digest. Never throws: a send failure is recorded
 * as an 'error' run, and the gap guard then reports the missing digest.
 */
export async function sendHeartbeatDigestDirect(taskName: string, agent: string, deps: DirectDigestDeps): Promise<boolean> {
  try {
    const block = await deps.collectBlock()
    const digest = buildHeartbeatDigestFromBlock(block, deps.tz, deps.nowLabel())
    const check = deps.verify(digest)
    if (!check.ok) {
      // The block is the board measured seconds ago; a mismatch here is an
      // instrument finding, not a reason to withhold the report.
      deps.warn({ task: taskName, problems: check.problems }, 'HBFABRIC1003: direct digest differs from the live board (instrument drift)')
    }
    deps.send(agent, deps.mainAgentId, digest)
    deps.appendRun(taskName, agent, DIRECT_DIGEST_RUN_STATUS)
    return true
  } catch (err) {
    deps.warn({ task: taskName, err: String(err) }, 'HBFABRIC1003: direct heartbeat digest could not be sent')
    try { deps.appendRun(taskName, agent, 'error') } catch { /* the gap guard still reports it */ }
    return false
  }
}

export interface DigestTaskRef {
  name: string
  agent: string
  schedule: string
}

export interface GapGuardDeps {
  /** Latest scheduled occurrence in (fromMs, toMs], or null. */
  prevOccurrence: (schedule: string, fromMs: number, toMs: number) => number | null
  /** Is there a digest from `agent` to the main agent created at or after `sinceMs`? */
  digestSince: (agent: string, sinceMs: number) => boolean
  /** Has a gap note for this task + slot already been queued (survives a restart)? */
  noteExists: (marker: string) => boolean
  sendNote: (content: string) => void
  slotLabel: (ms: number) => string
}

export function gapNoteMarker(task: string, slotMs: number): string {
  return `[HB-HIANY] task=${task} slot=${new Date(slotMs).toISOString()}`
}

/**
 * One pass of the gap guard. For each digest task, take its latest slot that
 * is at least the grace period old; if no digest arrived since that slot and no
 * note was sent for it yet, send exactly one. Returns the markers it sent.
 */
export function checkHeartbeatDigestGaps(tasks: DigestTaskRef[], nowMs: number, deps: GapGuardDeps): string[] {
  const sent: string[] = []
  for (const t of tasks) {
    const slot = deps.prevOccurrence(t.schedule, nowMs - HEARTBEAT_GAP_LOOKBACK_MS, nowMs - HEARTBEAT_DIGEST_GRACE_MS)
    if (slot == null) continue
    if (deps.digestSince(t.agent, slot)) continue
    const marker = gapNoteMarker(t.name, slot)
    if (deps.noteExists(marker)) continue
    deps.sendNote(
      `${marker} A ${deps.slotLabel(slot)}-s heartbeat-digest ${Math.round(HEARTBEAT_DIGEST_GRACE_MS / 60000)} perc után sem érkezett meg ` +
      `(a "${t.agent}" ágenstől). Tájékoztatás, teendőt nem kér; az élő számokat a GET /api/kanban/heartbeat-summary adja.`,
    )
    sent.push(marker)
  }
  return sent
}
