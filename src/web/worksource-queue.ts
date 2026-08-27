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

import { existsSync, mkdirSync } from 'node:fs'
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
