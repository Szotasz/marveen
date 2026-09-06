// GUARDHITELES903 -- the authenticated system-directive primitive.
//
// Measured problem (2026-09-03): five delivery paths typed ACTION-REQUESTING
// instructions straight into agent tmux panes with no envelope and nothing an
// agent could verify -- our own context-guard "[CONTEXT-GUARD] ... ALLJ MEG"
// was indistinguishable from a prompt injection, and Boni (correctly) refused
// one until a human vouched for it. A "this is real" sentence inside the text
// is decoration, not authentication: an injection can write it too.
//
// The primitive extends the fleet's EXISTING gold pattern (the inter-agent
// router delivers with a queue-backed msg_id): every system directive is
// written to the system_directives table FIRST, and the injected prompt
// carries the row id. The receiving agent verifies the id against
// GET /api/system-directives/:id (bearer-gated) -- an injection can copy the
// WRAPPER, but it cannot place the ROW. The row also carries the directive's
// measured CLAIM (e.g. the context percentage), so the claim rides the same
// authenticated channel as the origin (review condition 4 on the card).
import { createSystemDirective } from '../db.js'
import { sendPromptToSession } from './agent-process.js'
import type { SendLockMode } from './session-send-lock.js'
import { WEB_PORT } from '../config.js'
import { logger } from '../logger.js'

export function directiveHeader(id: number, kind: string): string {
  return `[SYSTEM-DIREKTIVA id=${id} kind=${kind} verify=http://localhost:${WEB_PORT}/api/system-directives/${id}]`
}

/**
 * Record + inject a system directive. The row is written BEFORE the send, so
 * by the time the text can reach any agent the receipt already exists; a send
 * failure leaves a dangling row, which is harmless (rows expire from
 * relevance by their timestamp and are never executed by themselves).
 */
export async function sendSystemDirective(
  session: string,
  host: string | null,
  agentName: string,
  kind: string,
  payload: Record<string, unknown> | null,
  promptBody: string,
  opts: { waitForIdle?: boolean; onBusyTimeout?: 'send' | 'abort'; idleTimeoutMs?: number; lockMode?: SendLockMode } = {},
): Promise<'sent' | 'aborted-busy' | 'skipped-locked'> {
  const id = createSystemDirective({
    agent: agentName,
    kind,
    payload,
    prompt_excerpt: promptBody.slice(0, 200),
  })
  logger.info({ id, agentName, kind }, 'system-directive recorded, injecting')
  return await sendPromptToSession(session, `${directiveHeader(id, kind)} ${promptBody}`, host, opts)
}
