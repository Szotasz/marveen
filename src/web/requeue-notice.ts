// The requeue's follow-up notices. The router told the sender and the main
// agent the handoff failed; when the target session later starts and the row
// goes back in the queue, the same two parties need the correction, or they
// act on the failure (re-send, re-delegate) and the work lands twice.
//
// Kept in its own module on purpose: message-router imports it for
// shouldNotifySenderOfFailure, so importing agent-process or message-router
// back from here would be a cycle. Only db/config/logger and the two address
// helpers are allowed below.
import { createAgentMessage, getAgentMessage, requeueAbandonedForAgent, type AgentMessage } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { isQualifiedId } from './federation/address.js'
import { isChannelInboundSender } from './agent-message-wrap.js'

/**
 * Card 71263d15 (A), 01603e03: may the SENDER of a failed message get a notice?
 *
 * The sender got an id back when it posted, so on its side the send looks done;
 * until now only the main agent heard about the failure. The exceptions keep the
 * notice from looping or doubling: 'system' rows get no receipt (a failed notice
 * cannot beget another), the main agent already gets the orchestrator notice, a
 * channel-inbound sender is a person on a channel rather than an agent inbox, and a
 * federated sender is notifyDelegationFailed's job.
 */
export function shouldNotifySenderOfFailure(fromAgent: string, mainAgentId: string): boolean {
  if (!fromAgent || fromAgent === 'system' || fromAgent === mainAgentId) return false
  if (isQualifiedId(fromAgent) || fromAgent.includes('/')) return false
  return !isChannelInboundSender(fromAgent)
}

/** The tag every requeue notice line starts with, so a recipient can tell the
 *  correction apart from the [handoff-failure] notice it corrects. */
export const REQUEUE_NOTICE_TAG = '[ÚJRAKÉZBESÍTVE]'

// Tell the parties the router already warned that a revived row is coming back.
// One message per recipient, one line per row: a start that revives a whole
// backlog must not fan out into a notice per row. Never throws -- a failed
// notice must not take the session start down with it.
export function notifyRequeuedHandoffs(ids: number[], mainAgentId: string = MAIN_AGENT_ID): void {
  if (!ids.length) return
  try {
    const rows: AgentMessage[] = []
    for (const id of ids) {
      const m = getAgentMessage(id)
      if (m) rows.push(m)
    }
    // The main agent gets one digest of the revived rows addressed to someone
    // else: a row addressed to the main agent reaches it as the revived message.
    const notOwn = rows.filter(m => m.to_agent !== mainAgentId)
    if (notOwn.length) {
      createAgentMessage(
        'system',
        mainAgentId,
        notOwn.map(m =>
          `${REQUEUE_NOTICE_TAG} msg_id:${m.id} ${m.from_agent} -> ${m.to_agent}: requeued after the target session started (it was reported as a handoff-failure before; if it was re-sent or re-delegated meanwhile, close one copy).`
        ).join('\n'),
      )
    }
    // Each notified sender gets one digest of its own rows, in ids order.
    const bySender = new Map<string, AgentMessage[]>()
    for (const m of rows) {
      if (!shouldNotifySenderOfFailure(m.from_agent, mainAgentId)) continue
      const list = bySender.get(m.from_agent)
      if (list) list.push(m)
      else bySender.set(m.from_agent, [m])
    }
    for (const [sender, list] of bySender) {
      createAgentMessage(
        'system',
        sender,
        list.map(m =>
          `${REQUEUE_NOTICE_TAG} msg_id:${m.id} -> ${m.to_agent}: a korábban NEM kézbesültként jelzett üzeneted mégis kézbesül, mert a címzett munkamenete elindult. Ha közben újraküldted vagy másnak adtad ki, az egyik példányt zárd le (PUT /api/messages/${m.id}).`
        ).join('\n'),
      )
    }
  } catch (err) {
    logger.warn({ err, ids }, 'could not enqueue the requeue notices')
  }
}

// The door both agent starts call: revive what the router abandoned while the
// session was down, then tell the sender and the main agent what came back.
// The requeue itself never throws here in practice, but a start must not fail
// over bookkeeping -- an exception is logged and swallowed.
export function requeueAbandonedAndNotify(name: string, host?: string): number[] {
  let ids: number[]
  try {
    ids = requeueAbandonedForAgent(name)
  } catch (err) {
    logger.warn({ err, name, host }, 'could not requeue messages abandoned while the session was down')
    return []
  }
  if (ids.length) {
    // host is omitted when the caller did not pass one (the local start), so
    // the log line stays what it was on each path.
    if (host === undefined) logger.info({ name, ids }, 'requeued messages abandoned while the session was down')
    else logger.info({ name, host, ids }, 'requeued messages abandoned while the session was down')
    notifyRequeuedHandoffs(ids)
  }
  return ids
}
