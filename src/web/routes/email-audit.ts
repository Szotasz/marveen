import { recordEmailIntent, recordEmailOutcome, getEmailAuditRows, EMAIL_AUDIT_OUTCOMES, type EmailAuditOutcome } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Outgoing-email audit trail (EMAILAUDIT1109, card 7df70b2e).
//
// One row per outgoing-letter attempt, written in two halves by
// scripts/hooks/email-audit-capture.py: `intent` from PreToolUse (where the
// envelope is still readable) and `outcome` from PostToolUse (where the result
// is). The halves meet on Claude Code's tool_use_id.
//
// The endpoint is deliberately dumb: it validates and forwards. Every decision
// about WHAT a letter is -- whether a tool name is a send at all, and how to
// recover to/cc/bcc/subject from its input -- stays in
// scripts/hooks/email_extract.py, which the two mail gates already use. A
// second classifier here would drift from the gates without anyone noticing,
// and then the trail and the gate would disagree about what was sent.
export async function tryHandleEmailAudit(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/email-audit -- one half of a row (from the capture hook)
  if (path === '/api/email-audit' && method === 'POST') {
    const body = await readBody(req)
    let data: {
      phase?: string
      trace_id?: string
      tool_name?: string
      mail_kind?: string
      agent_id?: string
      session_id?: string
      to?: string[]
      cc?: string[]
      bcc?: string[]
      subject?: string
      body_sha256?: string
      envelope_hash?: string
      attachments?: unknown
      approval_id?: string
      unreadable_reason?: string
      outcome?: string
      provider_message_id?: string
      error_text?: string
    }
    try {
      data = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    if (!data.trace_id) { json(res, { error: 'trace_id required' }, 400); return true }

    if (data.phase === 'outcome') {
      // The outcome vocabulary is closed on purpose: an unknown value would
      // otherwise land in the column and quietly become a fourth meaning,
      // next to the NULL that already means "nothing was recorded".
      if (!EMAIL_AUDIT_OUTCOMES.includes(data.outcome as EmailAuditOutcome)) {
        json(res, { error: `outcome must be one of ${EMAIL_AUDIT_OUTCOMES.join(', ')}` }, 400)
        return true
      }
      recordEmailOutcome(data.trace_id, data.outcome as EmailAuditOutcome, {
        providerMessageId: data.provider_message_id ?? null,
        errorText: data.error_text ?? null,
        toolName: data.tool_name,
        mailKind: data.mail_kind,
        agentId: data.agent_id ?? null,
        sessionId: data.session_id ?? null,
      })
      json(res, { ok: true })
      return true
    }

    if (data.phase && data.phase !== 'intent') {
      json(res, { error: "phase must be 'intent' or 'outcome'" }, 400)
      return true
    }
    if (!data.tool_name || !data.mail_kind) {
      json(res, { error: 'tool_name and mail_kind required for an intent row' }, 400)
      return true
    }
    recordEmailIntent({
      trace_id: data.trace_id,
      tool_name: data.tool_name,
      mail_kind: data.mail_kind,
      agent_id: data.agent_id ?? null,
      session_id: data.session_id ?? null,
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      subject: data.subject ?? null,
      body_sha256: data.body_sha256 ?? null,
      envelope_hash: data.envelope_hash ?? null,
      attachments: data.attachments ?? null,
      approval_id: data.approval_id ?? null,
      unreadable_reason: data.unreadable_reason ?? null,
    })
    json(res, { ok: true })
    return true
  }

  // GET /api/email-audit?since=<secs>&agent=<id> -- read the trail
  if (path === '/api/email-audit' && method === 'GET') {
    const sinceRaw = parseInt(url.searchParams.get('since') || '86400', 10)
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 86400
    const agent = url.searchParams.get('agent')
    const rows = getEmailAuditRows(since, agent)
    // The caller gets the parsed recipient lists, not the raw JSON strings, so
    // a reader cannot mistake '[]' for a missing field.
    const parsed = rows.map(r => ({
      ...r,
      recipients_to: safeParse(r.recipients_to),
      recipients_cc: safeParse(r.recipients_cc),
      recipients_bcc: safeParse(r.recipients_bcc),
      // Spelled out so a NULL outcome is never read as a success by a client
      // that only looks for an error field.
      outcome_recorded: r.outcome !== null,
    }))
    json(res, parsed)
    return true
  }

  return false
}

function safeParse(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
