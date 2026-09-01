import {
  createAgentMessage, getPendingMessages, listAgentMessages,
  getAgentConversation, getAgentConversationThreads,
  getKanbanSeqByIdPrefix,
  markMessageDone, markMessageFailed, getAgentMessage,
  closeOtelSpan,
  getPendingBacklogByAgent,
  COMPLETION_REPORT_PREFIX,
  isAuthorizedPartnerSender,
  writeAgentAuditLog,
  findBlackboardRowByAgent,
  upsertBlackboard,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { isKnownAgent } from '../agent-config.js'
import { OWNER_NAME, SYSTEM_SENDER_IDS, parseSystemSenderIds } from '../../config.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { parseQualifiedId, formatQualifiedId } from '../federation/address.js'
import { getFederationConfig } from '../federation/config.js'
import type { RouteContext } from './types.js'

// Should closing a message produce a reverse "[Eredmény]" notification to its sender?
//
// Exported and tested directly, rather than inlined in the PUT handler: the previous
// tests re-implemented this condition inside the test file, so they passed no matter
// what the route actually did.
//
// Three senders get no notification:
//   1. self-messages -- the sender already knows;
//   2. senders that are not addressable agents. `system` posts the [session-stuck] and
//      [handoff-failure] notices but owns no tmux session, so a reply to it can never be
//      delivered: it fails, the retry window expires, and the resulting [handoff-failure]
//      wakes the main agent -- which, once closed, produced the next one. Measured on the
//      Acrobot install 2026-08-17: 44 of the last 200 rows were `-> system`, all failed.
//      `isKnownAgent` is the right test here because it accepts MAIN_AGENT_ID as well as
//      the sub-agent directories; a plain registry lookup would have suppressed every
//      notification back to the MAIN agent, which is the case this feature exists for.
//   3. contents that are themselves completion reports -- breaks ping-pong chains.
export function shouldNotifyDelegator(fromAgent: string, toAgent: string, content: string): boolean {
  if (fromAgent === toAgent) return false
  if (!isKnownAgent(fromAgent)) return false
  if (content.startsWith(COMPLETION_REPORT_PREFIX)) return false
  return true
}

// Frozen at module load, like the config constant it derives from.
const SYSTEM_SENDERS = parseSystemSenderIds(SYSTEM_SENDER_IDS, sanitizeAgentIdent)


export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // Tenant scope: admin role sees/writes all tenants (bypass); scoped callers
  // are restricted to their own tenant_id. 'default' is the fleet's own tenant.
  const isAdmin = ctx.role === 'admin'
  const effectiveTenantId: string = isAdmin ? 'default' : (ctx.tenantId ?? 'default')

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    const { from, to, content, origin_note, assign } = JSON.parse(body.toString()) as
      { from: string; to: string; content: string; origin_note?: string; assign?: boolean }
    if (!from?.trim() || !to?.trim() || !content?.trim()) {
      json(res, { error: 'required', hint: 'from, to, and content are required' }, 400)
      return true
    }
    // Security: the channel-coordinator id grants channel-inbound delivery
    // (verbatim <channel> + reply-expected framing) in the message-router. The
    // ONLY legitimate writer of that id is the in-process coordinator, which
    // inserts directly into the DB -- it never POSTs here. The dashboard token
    // is readable by every sub-agent, so without this guard any sub-agent could
    // forge a reply-expected message addressed at the main agent. Reject it.
    //
    // CRITICAL: normalize with the EXACT function the router matches on
    // (sanitizeAgentIdent), NOT from.trim(). The router does
    // CHANNEL_COORDINATOR_AGENTS.has(sanitizeAgentIdent(from)), and
    // sanitizeAgentIdent STRIPS [^a-zA-Z0-9_-] rather than trimming. A bypass
    // like from="@telegram-coordinator" / "telegram-coordinator." survives
    // .trim() (!= the constant) yet sanitizes to "telegram-coordinator" in the
    // router -> channel-inbound with an attacker-controlled body. Matching the
    // router's normalization here closes that asymmetry.
    if (sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST forging channel-coordinator id')
      json(res, { error: 'forbidden', hint: 'from is reserved for the in-process channel coordinator' }, 403)
      return true
    }
    // Federation spoof guard: a slash-qualified from ("teodor/teodor") is the
    // provenance mark of a REMOTE sender and may only ever be written by the
    // token-authenticated /api/federation/inbox. Accepting it here would let
    // any dashboard-token holder (i.e. every local sub-agent) impersonate a
    // federation peer toward another local agent.
    if (from.includes('/')) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST with qualified from (federation impersonation guard)')
      json(res, { error: 'sender_not_in_allowlist', hint: 'from must be a local agent id without "/"; federated senders are only accepted via /api/federation/inbox' }, 403)
      return true
    }
    // From-authentication: accept messages only from registered fleet agents.
    // The shared Bearer token is readable by any sub-agent, so without this
    // check any process with the token could inject messages as an arbitrary
    // sender ("from": "agent-b" from an external attacker who obtained the token).
    // Server-side validation: the `from` claim must match a known agent on the
    // filesystem (agents/<id>/ directory, or MAIN_AGENT_ID). This is not
    // impersonation-proof between fleet agents (they share the same token) but
    // it closes the "unknown sender" injection path without per-agent secrets.
    //
    // The human OWNER is a legitimate sender too: the dashboard "Messages" page
    // composes with from=OWNER_NAME (resolveOwnerName -> the owner assignee), so
    // without this exemption the operator's own dashboard messages 403 with
    // "unknown agent". The owner is not a fleet agent (no agents/<id>/ dir), so
    // isKnownAgent alone rejects it. Match on the router's normalization to stay
    // symmetric with the other guards above.
    //
    // Neighbouring SYSTEMS are legitimate senders too, on the same reasoning as
    // the owner: they are token-authenticated and only notify an agent, but they
    // have no agents/<id>/ directory. Opt-in via SYSTEM_SENDER_IDS in .env
    // (empty by default). Without this, such a system silently loses its push
    // channel the moment this guard ships -- observed here: an external case
    // manager pushed 4182 messages, then every call 403'd for nine days while
    // its fail-soft caller logged nothing.
    // Partner-tenant path: a scoped (non-default, non-null) tenant token must
    // have its `from` registered in partner_senders for that tenant. Fleet
    // agents and the owner do not reach this branch -- they always use the
    // default/admin path below. Audit both accept and reject for partner sends.
    const isPartnerTenant = ctx.tenantId != null && ctx.tenantId !== 'default'
    if (isPartnerTenant) {
      const cleanFrom = sanitizeAgentIdent(from)
      const allowed = isAuthorizedPartnerSender(cleanFrom, ctx.tenantId!)
      if (!allowed) {
        writeAgentAuditLog({ agent_id: cleanFrom, entity: 'message', action: 'create',
          detail: { from: from.trim(), to: to.trim(), tenant_id: ctx.tenantId, reason: 'sender_not_in_allowlist' } })
        logger.warn({ from: from.trim(), to: to.trim(), tenant_id: ctx.tenantId }, 'Rejected partner /api/messages POST: sender not in allowlist')
        json(res, { error: 'sender_not_in_allowlist', hint: `sender '${from.trim()}' is not in the allowlist for tenant '${ctx.tenantId}'` }, 403)
        return true
      }
    } else {
      const isOwnerSender = sanitizeAgentIdent(from) === sanitizeAgentIdent(OWNER_NAME)
      const isSystemSender = SYSTEM_SENDERS.has(sanitizeAgentIdent(from))
      if (!isOwnerSender && !isSystemSender && !isKnownAgent(sanitizeAgentIdent(from))) {
        logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST from unregistered agent')
        json(res, { error: 'not_found', field: 'from', hint: `unknown agent '${from.trim()}'; from must be a registered fleet agent id` }, 404)
        return true
      }
    }
    // Qualified to ("peer/agent"): validate at creation time so the sender
    // gets an actionable error NOW instead of a silent 1h abandon. Local
    // (slash-free) recipients are untouched.
    let storedTo = to.trim()
    if (storedTo.includes('/')) {
      const target = parseQualifiedId(storedTo)
      if (!target) {
        json(res, { error: 'invalid_value', field: 'federatedAddress', hint: 'expected format: "<system>/<agent>"' }, 400)
        return true
      }
      const cfg = getFederationConfig()
      if (!cfg.enabled) {
        json(res, { error: 'federation_disabled', hint: 'Federation is disabled on this system' }, 400)
        return true
      }
      // System ids are case-insensitive (stored lowercase in the config).
      // Normalize the STORED prefix too: the per-peer purge SQL and the
      // bridge's peer lookup key on it, and thread grouping in the UI should
      // not split 'Teodor/x' from 'teodor/x'. The agent segment is the
      // PEER's namespace -- leave its case alone.
      const targetSystem = target.system.toLowerCase()
      if (targetSystem === cfg.systemId) {
        json(res, { error: 'invalid_value', field: 'peerId', hint: `'${target.system}' is this system; address the agent locally as '${target.agent}'` }, 400)
        return true
      }
      if (!cfg.peers.some((p) => p.id === targetSystem)) {
        json(res, { error: 'not_found', field: 'peerId', hint: `unknown federation peer '${target.system}'` }, 404)
        return true
      }
      storedTo = formatQualifiedId(targetSystem, target.agent)
    } else if (storedTo.includes(':')) {
      // A colon-form 'to' ("federation:teodor:teodor", copied from an
      // <untrusted source> attribute) is NOT a valid address: it has no '/',
      // so it would be treated as a LOCAL recipient, never match a session,
      // and silently sit pending until the 1h abandon window. Reject it now
      // with the correct form. Safe: sanitizeAgentIdent strips ':', so no
      // legitimate local agent id can contain one, and the channel
      // coordinator inserts directly into the DB, bypassing this endpoint.
      json(res, { error: 'invalid_value', field: 'recipient', hint: 'use "<system>/<agent>" (slash) for a federated address, not the "federation:x:y" source form' }, 400)
      return true
    }
    // Code-side enforcement of the kanban-ref convention: rewrite any
    // `#<hex8>` token that maps to a real kanban_cards row into its
    // human-facing `#<seq>` form before persistence, so the dashboard and
    // every downstream consumer sees the canonical reference even when a
    // sub-agent forgets the CLAUDE.md rule (#75 Cuzcoo dispatch).
    const normalizedContent = normalizeKanbanRefs(content.trim(), getKanbanSeqByIdPrefix)
    // Card 06f062e4: optional attributability tag, self-declared like `from`
    // itself -- capped short so it stays a label, not a second content field.
    const trimmedOriginNote = origin_note?.trim().slice(0, 120) || null
    const msg = createAgentMessage(from.trim(), storedTo, normalizedContent, trimmedOriginNote, null, effectiveTenantId)
    if (isPartnerTenant) {
      writeAgentAuditLog({ agent_id: sanitizeAgentIdent(from), entity: 'message', action: 'create', entity_id: msg.id,
        detail: { from: from.trim(), to: storedTo, tenant_id: ctx.tenantId, authorized_by: 'partner_sender_allowlist' } })
    } else if (ctx.auth?.kind === 'session' && ctx.auth.user) {
      try {
        writeAgentAuditLog({ agent_id: ctx.auth.user, entity: 'message', action: 'create', entity_id: msg.id })
      } catch { /* audit failure must not abort message creation */ }
    }
    logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, originNote: msg.origin_note }, 'Agent message created')
    // Delivery hook: open an 'assigned' blackboard row only when the sender explicitly
    // sets assign:true (deliberate task delegation). Replies, acknowledgements, and
    // notifications are sent without assign:true and produce no row.
    // Federated recipients are skipped (no local row).
    if (assign === true && !storedTo.includes('/')) {
      const existing = findBlackboardRowByAgent(storedTo)
      if (!existing || (existing.status !== 'active' && existing.status !== 'blocked')) {
        upsertBlackboard(storedTo, {
          status: 'assigned',
          summary: normalizedContent.slice(0, 100),
          task_ref: null,
        })
      }
    }
    json(res, msg)
    return true
  }

  // Sidebar threads: one row per conversation peer (system agents excluded),
  // each with its count + most-recent message, recency computed per-peer.
  // Admin may pass ?tenant= to narrow to a specific tenant.
  if (path === '/api/messages/threads' && method === 'GET') {
    const adminTenantFilter = isAdmin ? (url.searchParams.get('tenant') || undefined) : undefined
    json(res, getAgentConversationThreads(isAdmin ? adminTenantFilter : effectiveTenantId))
    return true
  }

  // Backlog per agent: count + how long the oldest has been waiting. Cheap
  // enough to curl on a schedule; the point is that a growing queue behind a
  // busy agent becomes visible BEFORE someone mistakes it for lost messages.
  if (path === '/api/messages/backlog' && method === 'GET') {
    json(res, getPendingBacklogByAgent())
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    // An UNKNOWN filter param used to fall through to the global list: a typo,
    // or the plausible-but-wrong `agent_id`, silently returned the fleet's last
    // N messages instead of one agent's mailbox. Not an error, not an empty
    // list -- MORE than asked for, which is the expensive direction to be wrong
    // in: a caller acting in good faith on that answer reads other agents'
    // traffic as its own. Fail loudly instead.
    const KNOWN_PARAMS = new Set(['agent', 'status', 'limit', 'before', 'tenant'])
    const unknown = [...url.searchParams.keys()].filter((k) => !KNOWN_PARAMS.has(k))
    if (unknown.length) {
      json(res, {
        error: 'unknown_query_parameter',
        field: unknown[0],
        hint: `unknown parameter(s): ${unknown.join(', ')}; accepted: ${[...KNOWN_PARAMS].join(', ')}; the mailbox filter is "agent" — "agent_id" and "to" are not read`,
      }, 400)
      return true
    }
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : undefined

    // Tenant isolation pushed into SQL before LIMIT: a post-LIMIT JS filter would
    // starve tenant-scoped callers when other tenants occupy the LIMIT slots.
    // Admin may pass ?tenant= to narrow to a specific tenant (omit for global view).
    const adminTenantParam = isAdmin ? (url.searchParams.get('tenant') || undefined) : undefined
    const msgTenantId = isAdmin ? adminTenantParam : effectiveTenantId

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent, msgTenantId)
    } else if (status === 'pending') {
      messages = getPendingMessages(undefined, msgTenantId)
    } else if (agent) {
      // SQL-filtered to THIS agent's last N (+ before-cursor pagination), not
      // global-last-N-then-JS-filter which starved rarely-active threads.
      messages = getAgentConversation(agent, limit, Number.isFinite(before as number) ? before : undefined, msgTenantId)
    } else {
      messages = listAgentMessages(limit, msgTenantId)
    }

    jsonMaybeGzip(req, res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const { status: newStatus, result } = JSON.parse(body.toString()) as { status: string; result?: string }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) {
      const done = getAgentMessage(id)
      // Close the OTel span now that the message has a terminal status.
      if (done?.trace_id && done?.span_id) {
        closeOtelSpan(done.trace_id, done.span_id, Date.now(), newStatus === 'done' ? 'ok' : 'error')
      }
      // Notify the delegator: create a reverse message from executor → delegator so
      // they learn the result without polling. Use a sentinel prefix to break
      // ping-pong chains (the delegator might write back, which would trigger
      // markMessageDone on this notification; we skip creating ANOTHER notification
      // when the original content is already a completion report).
      if (done && done.from_agent !== done.to_agent && !done.content.startsWith('[Eredmény]')) {
        const summary = result ? result.slice(0, 500) : '(nincs eredmény)'
        createAgentMessage(
          done.to_agent,
          done.from_agent,
          `[Eredmény] msg_id:${id} status:${newStatus}\n\n${summary}`,
        )
      }
      json(res, { ok: true }); return true
    }
    json(res, { error: 'not_found', field: 'messageId', hint: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
