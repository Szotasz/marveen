// Resume-time drain of the recipient's pending inter-agent queue (card
// 2e1a5659).
//
// MEASURED 2026-11-08 on a long-turn agent: three pending rows were created
// 03:23-03:29 and delivered only 04:30 -- they outlived TWO full guard restart
// cycles (guard acting 03:41/03:52 and 04:17/04:27). The delivery hold
// (delivery-hold.ts) keeps a restarted agent's rows pending until the fresh
// session has its resume prompt -- but by then that session is already busy
// with its first continuation turn, and the router only delivers to an idle
// pane, so every pending row waits out the whole turn (30-70 min for a
// long-turn agent) while the guard may restart it again. 48h delivery
// latency on three long-turn agents: p90 26-45 min, max 71-140 min.
//
// The fix: when the resume prompt is injected, the drainable part of the
// recipient's pending queue rides in the SAME injection, appended after the
// directive body -- the first turn can no longer starve delivery for its
// whole duration.
//
// SAFETY ARGUMENT (why the router cannot double-send a drained row): both
// callers hold `resumeSending` for the whole duration of sendResumeWithDrain,
// and contextGuardDeliveryHold holds the router off whenever
// `resumeSending.has(name)` (see context-guard-runner.ts), so between the
// getPendingMessages fetch and the delivered-marking the router delivers
// nothing to this recipient. Rows that arrive later than the fetch are NOT
// drained: they wait for the turn to end like today (out of scope here).
import { MAIN_AGENT_ID } from '../config.js'
import { getPendingMessages, markMessageDelivered, countNewerMessagesFromSameSender, type AgentMessage } from '../db.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from './agent-message-wrap.js'
import { isUrgentDelivery } from './message-router-window.js'
import { batchInjectCapFor, composeBatchInjection, type BatchInjectItem } from './batch-inject.js'
import { sendSystemDirective } from './system-directive.js'
import { logger } from '../logger.js'

// The drain owns attachAfterDirective: passing it as a caller is now a compile
// error, and the runtime behavior (a caller-supplied value is overridden by the
// drain's attachment) is pinned by src/__tests__/resume-queue-drain-opts.test.ts.
type SendPromptOpts = Omit<NonNullable<Parameters<typeof sendSystemDirective>[4]>, 'attachAfterDirective'>
type SendOutcome = Awaited<ReturnType<typeof sendSystemDirective>>

/** Cap per resume injection; the remainder stays pending for the router.
 *  Batch mode announces the remainder in its tail. */
export const RESUME_DRAIN_MAX = 8

/**
 * Which pending rows a resume injection may drain, in this exact order of
 * rules: classify, drop unclassifiable, drop channel-inbound/federated, drop
 * urgent/STOP, sort ascending by id. Pure -- no DB access, no marking.
 */
export function selectDrainableRows(rows: AgentMessage[], mainAgentId: string): AgentMessage[] {
  const kept: AgentMessage[] = []
  for (const row of rows) {
    const cls = classifyAgentMessage(row.from_agent, row.to_agent)
    // Unclassifiable sender: the router owns failing/closing such a row, the
    // drain must simply never touch it.
    if (!cls) continue
    // These ride their own delivery paths (channel inbound is pulled, federated
    // goes through federation) -- same rule as the router's multi-envelope
    // batch.
    if (cls.category === 'channel-inbound' || cls.category === 'federated') continue
    // Urgent/STOP rows are never held, so the router delivers them on its own
    // even mid-restart; draining one here would double-send it.
    if (isUrgentDelivery(row, mainAgentId)) continue
    kept.push(row)
  }
  // Ascending id: a correction must never precede the claim it corrects (same
  // rule as composeBatchInjection).
  kept.sort((a, b) => a.id - b.id)
  return kept
}

/**
 * Send the resume prompt and, when the recipient has drainable pending rows,
 * deliver them in the SAME injection: one directive send, one attachment.
 *
 * With nothing to drain this is byte-identical to sendSystemDirective. The
 * directive TEXT argument stays the caller's prompt unchanged -- the drained
 * rows ride in opts.attachAfterDirective, appended after the directive body,
 * so the anchor row (and the recipient's directive-verification rule on its
 * content) never sees them.
 * Rows are marked delivered only after a 'sent' outcome; a non-'sent'
 * outcome leaves them pending, exactly as the router would.
 */
export async function sendResumeWithDrain(
  name: string,
  session: string,
  text: string,
  // host/opts optional to mirror sendSystemDirective exactly (the checkAgent
  // sweep site calls with 3 args, as it did before the rename).
  host: string | null = null,
  opts: SendPromptOpts = {},
): Promise<SendOutcome> {
  const pending = getPendingMessages(name)
  const drainable = selectDrainableRows(pending, MAIN_AGENT_ID)
  const batchCap = batchInjectCapFor(name)
  const mode = batchCap > 0 ? 'batch' : 'single'
  const cap = batchCap > 0 ? Math.min(RESUME_DRAIN_MAX, batchCap) : 1
  const capped = drainable.slice(0, cap)
  const remaining = drainable.length - capped.length
  if (capped.length === 0) {
    return await sendSystemDirective(name, session, text, host, opts)
  }
  const items: BatchInjectItem[] = []
  for (const row of capped) {
    // classifyAgentMessage is pure, so this second call returns exactly the
    // classification selectDrainableRows kept the row by.
    const cls = classifyAgentMessage(row.from_agent, row.to_agent)
    if (!cls) continue
    // Exactly the router's serial-path envelope (message-router.ts): own
    // prefix + wrapped block per row, freshness computed at injection time.
    const { prefix, wrapped } = wrapAgentMessageForDelivery(
      cls.category,
      cls.safeFrom,
      row.from_agent,
      row.content,
      row.id,
      row.origin_note,
      {
        ageMs: Date.now() - row.created_at * 1000,
        newerFromSameSender: countNewerMessagesFromSameSender(row.from_agent, row.to_agent, row.id),
        redelivered: row.redelivered_at != null,
      },
      { urgent: row.urgent === 1 },
    )
    items.push({ prefix, wrapped })
  }
  const attachment = mode === 'batch'
    ? composeBatchInjection(items, remaining)
    : items[0].prefix + items[0].wrapped
  const outcome = await sendSystemDirective(name, session, text, host, { ...opts, attachAfterDirective: attachment })
  if (outcome === 'sent') {
    for (const row of capped) {
      const marked = markMessageDelivered(row.id)
      if (!marked) logger.warn({ id: row.id }, 'resume drain: markMessageDelivered affected 0 rows (deleted concurrently?)')
    }
    logger.info({ agent: name, mode, drained: capped.length, remaining }, 'context-guard: resume drain delivered pending rows in the resume injection')
  } else {
    // Review R1 MINOR fix: the unconditional 'delivered' info line read as a
    // completed delivery even on 'aborted-busy' / 'skipped-locked', where
    // every row stays pending for the router. Nothing was delivered then.
    logger.warn({ agent: name, mode, outcome, pending: capped.length, remaining }, 'resume drain: non-sent outcome, drained rows stay pending for the router')
  }
  return outcome
}
