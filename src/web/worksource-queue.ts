/**
 * worksource queue -- the WRITER side of the worksource channel.
 *
 * The channel server (plugins/worksource/server.mjs) is the reader: it watches
 * a directory, hands each item to its agent as a real turn, and takes an
 * explicit acknowledgment back. This module is everything that puts work IN.
 *
 * WHY A DIRECTORY AND NOT A FUNCTION CALL
 *
 * The reader runs inside the agent's own process tree, started by Claude Code
 * as a stdio MCP server. The dashboard cannot call into it. A directory is the
 * one interface both sides can hold at once, and it survives a restart of
 * either -- which is the entire point: the failure this channel exists to
 * remove is "we pressed some keys and the text went nowhere".
 *
 * The layout below MUST stay in step with server.mjs; it is duplicated there in
 * prose because the two live in different languages and neither can import the
 * other.
 *
 *   <root>/pending/<id>.json   queued, not yet handed over
 *   <root>/active/<id>.json    handed over, not yet acknowledged
 *   <root>/done/<id>.json      acknowledged, with the agent's result attached
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync } from './atomic-write.js'

/**
 * Queue root for one agent. Mirrors the reader's default
 * (WORKSOURCE_DIR ?? ~/.claude/channels/worksource/<agent>) -- the launcher
 * exports exactly this path, so the two sides agree even if the default moves.
 */
export function worksourceRootFor(agent: string): string {
  return join(homedir(), '.claude', 'channels', 'worksource', agent)
}

/**
 * Item id for an inter-agent message.
 *
 * DERIVED from the message row id, not random: the id is the dedupe key, and a
 * random one would let a retried tick enqueue the same message twice. It also
 * has to survive the round trip through the model -- the reader refuses any id
 * outside /^[A-Za-z0-9._-]{1,128}$/ rather than sanitising it, because a
 * rewritten id would acknowledge the WRONG item.
 */
export function worksourceItemId(messageId: number | string): string {
  return `msg-${String(messageId).replace(/[^A-Za-z0-9._-]/g, '')}`
}

/**
 * An item's stage in the queue: which of the three directories below holds it.
 * The reader moves an item pending -> active -> done as it hands the work over
 * and takes the acknowledgment back.
 */
export type WorksourceItemStage = 'pending' | 'active' | 'done'

/**
 * True when this id is already queued, in flight, or finished.
 *
 * All THREE directories are checked, not just pending/. An item the agent is
 * still working on lives in active/, and one it has acknowledged lives in
 * done/; treating either as "not present" would re-queue work that is already
 * under way or already finished.
 */
export function worksourceItemExistsAt(root: string, id: string): boolean {
  return (
    existsSync(join(root, 'pending', `${id}.json`)) ||
    existsSync(join(root, 'active', `${id}.json`)) ||
    existsSync(join(root, 'done', `${id}.json`))
  )
}

/**
 * Put one item in the queue. Returns false when the id is already present --
 * NOT an error: the router retries a tick whose delivery it could not confirm,
 * and re-queueing there would hand the agent the same work twice.
 *
 * Writes atomically (tmp + rename) because the reader POLLS this directory; a
 * half-written file would be parsed, found malformed, and dropped -- silently
 * losing the item rather than delaying it.
 *
 * Takes an explicit root so the behaviour is testable without a real home
 * directory; enqueueWorksourceItem below is the agent-keyed wrapper.
 */
export function enqueueWorksourceItemAt(
  root: string,
  id: string,
  content: string,
  meta?: Record<string, unknown>,
): boolean {
  for (const dir of ['pending', 'active', 'done']) mkdirSync(join(root, dir), { recursive: true })
  if (worksourceItemExistsAt(root, id)) return false
  atomicWriteFileSync(
    join(root, 'pending', `${id}.json`),
    JSON.stringify({ content, meta: meta ?? {} }, null, 2),
  )
  return true
}

/** Agent-keyed wrapper over enqueueWorksourceItemAt. */
export function enqueueWorksourceItem(
  agent: string,
  id: string,
  content: string,
  meta?: Record<string, unknown>,
): boolean {
  return enqueueWorksourceItemAt(worksourceRootFor(agent), id, content, meta)
}

/**
 * Which of the three directories an item is in right now -- its stage in the
 * reader's hand-over protocol: pending/ queued but never handed to the agent,
 * active/ handed over and awaiting the acknowledgment, done/ acknowledged.
 *
 * A PROBE, not a mutation: the scheduler's watchdog asks this to tell "never
 * picked up" (pending) from "handed over or finished" (active/done) when a
 * queued prompt sits unconsumed, so it must never write to the queue while
 * deciding. The directories are tried in the item's life order, so an id
 * present in more than one reports the earliest stage. Pure reads, never
 * throws: an unreadable queue directory is null (no signal), the same as an
 * unknown id -- a probe that threw would take the caller's sweep down with it.
 */
export function worksourceItemStageAt(root: string, id: string): WorksourceItemStage | null {
  try {
    for (const stage of ['pending', 'active', 'done'] as const) {
      if (existsSync(join(root, stage, `${id}.json`))) return stage
    }
  } catch {
    return null
  }
  return null
}

/** Agent-keyed wrapper over worksourceItemStageAt. */
export function worksourceItemStage(agent: string, id: string): WorksourceItemStage | null {
  return worksourceItemStageAt(worksourceRootFor(agent), id)
}

/**
 * The id of the item the reader hands over next: the lexically smallest file
 * ending in '.json' in pending/. The reader's deliverOne (server.mjs) picks
 * exactly that item on every poll, so the head MOVING between two sweeps (it
 * is now in active/ or done/) is proof the queue is being consumed -- even
 * though items behind the head, ours among them, have not moved at all. That
 * is what tells a healthy reader working through a backlog from a dead one.
 *
 * Like worksourceItemStageAt, a PROBE, not a mutation: pure reads, never
 * throws. null when pending/ is empty, missing or unreadable -- the same
 * no-signal answer as an unknown id there, because a probe that threw would
 * take the caller's sweep down with it.
 */
export function worksourcePendingHeadAt(root: string): string | null {
  try {
    const names = readdirSync(join(root, 'pending')).filter(n => n.endsWith('.json')).sort()
    const first = names[0]
    return first != null ? first.slice(0, -'.json'.length) : null
  } catch {
    return null
  }
}

/** Agent-keyed wrapper over worksourcePendingHeadAt. */
export function worksourcePendingHead(agent: string): string | null {
  return worksourcePendingHeadAt(worksourceRootFor(agent))
}
