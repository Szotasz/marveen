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

import { getDb, openInboundQuestionMessageId } from '../db.js'
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
