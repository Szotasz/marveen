// The owner's open inbound question, minus the owner's registry commands.
//
// The ledger (ledger-capture.py, a UserPromptSubmit hook running alongside
// the command hook) logs the owner's "/new" as an inbound question BEFORE the
// command hook has answered it. Read raw, that made the command its own
// blocker (measured on the test bot, 2026-09-23): /queue listed itself as the
// open question, and /new, /clear, /context clear were ALWAYS refused on the
// first try by the /clear gate's "open-question-in-ledger" guard, then ran
// from the sweep minutes later. A registry command is answered by the hook,
// never a question waiting for the model.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, openInboundQuestionMessageId } from '../db.js'
import { PROJECT_ROOT } from '../config.js'
import { parseCommand, resolveCommand } from './commands.js'

export function isRegistryCommand(text: string | null): boolean {
  if (!text) return false
  const p = parseCommand(text.trim())
  return p !== null && resolveCommand(p.name, p.args) !== null
}

/** Same contract as openInboundQuestionMessageId: null = nothing open, '' = open but unidentifiable. */
export function openQuestionIgnoringCommands(agentId: string): string | null {
  const id = openInboundQuestionMessageId(agentId)
  if (id === null || id === '') return id
  const row = getDb().prepare(
    `SELECT text FROM conversation_log WHERE agent_id = ? AND direction = 'in' AND message_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(agentId, id) as { text: string | null } | undefined
  return isRegistryCommand(row?.text ?? null) ? null : id
}

/**
 * The last inbound message the ledger drain surfaced for this agent, or null.
 * The drain (scripts/hooks/ledger-live-drain.py) writes the id into
 * store/.ledger-drain-<agent> when it puts a lost inbound in front of the
 * agent; the sanitisation here mirrors its _statefile().
 */
export function drainSurfacedMessageId(ledgerAgentId: string, storeDir: string = join(PROJECT_ROOT, 'store')): string | null {
  const safe = String(ledgerAgentId).replace(/[^A-Za-z0-9_-]/g, '_')
  try {
    const raw = readFileSync(join(storeDir, `.ledger-drain-${safe}`), 'utf-8').trim()
    return raw || null
  } catch { return null }
}

/**
 * Does an unanswered inbound still justify holding the gate shut?
 *
 * Only until the agent has actually been SHOWN it. Before that, a /clear could
 * lose a question nobody has read; after it, the agent knows and the decision
 * to answer is its own -- and some messages rightly get no answer. Laszlo's
 * "ok" on 2026-09-04 22:24 held the gate for eight hours at 630% of the
 * threshold, and the only way out would have been to wake him at midnight with
 * a reply nobody needed (LEDGERACK905, his call: block until surfaced, no
 * arbitrary timer).
 *
 * Pure so the rule is testable without a database or a statefile.
 */
export function openQuestionBlocks(
  openMessageId: string | null,
  surfacedMessageId: string | null,
): boolean {
  if (openMessageId === null) return false      // nothing open
  if (openMessageId === '') return true         // open, but unidentifiable: hold
  return openMessageId !== surfacedMessageId    // held until the drain showed it
}

/**
 * Does the owner's open question still hold back a restart of this agent?
 * The /clear gate's rule (openQuestionBlocks, drain-aware), as one call shared
 * by the gate and the context-guard's daily tier, so both read the same signal.
 */
export function ownerQuestionHolds(ledgerAgentId: string, storeDir?: string): boolean {
  return openQuestionBlocks(openQuestionIgnoringCommands(ledgerAgentId), drainSurfacedMessageId(ledgerAgentId, storeDir))
}
