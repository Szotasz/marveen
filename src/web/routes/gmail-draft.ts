// GMAILDRAFT1116: the owner's Gmail draft endpoint. It writes a draft into the owner's mailbox and never sends.
//
//   POST   /api/gmail/draft               write one draft (owner, main agent, sub-agents listed in GMAIL_DRAFT_AGENTS)
//   GET    /api/gmail/draft/status        { configured, agents } -- never a credential value
//   PUT    /api/gmail/draft/credentials   owner only: store the OAuth client + gmail.compose refresh token
//   DELETE /api/gmail/draft/credentials   owner only: remove them
//
// THREAT MODEL (the full text is at the top of src/web/gmail-draft.ts). The credential is a reserved vault entry
// (vault-reserved.ts): no vault route, binding, listing or generic getSecret() hands it out, for any principal, so an
// agent holding the shared dashboard token can no longer read the send-capable grant through the API (PR #2824 review
// B1). This is NOT an OS boundary: every agent runs as the same OS user, store/vault.json is readable by it and the
// master key is in the login Keychain stored with `-A` (keychain.ts), so an agent that decrypts the vault itself still
// gets the token. The full fix is the OS-user split (vault-acl.ts F3). The endpoint itself reaches only the OAuth token
// endpoint, users.drafts.create and users.drafts.get (gmail-draft.ts ALLOWED_GMAIL_REQUESTS): it cannot send.
import { readBodyOrRefuse, json } from '../http-helpers.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { notifySecurityEvent } from '../../notify.js'
import { mayActAsOwner, refuseOwner } from './auth.js'
import {
  DraftError, checkDraftInput, draftCallerOf, gmailDraftAgents, gmailDraftConfigured, ownerCcMissing,
  setGmailDraftCredentials, clearGmailDraftCredentials, subjectHash, unverifiedRecipients, writeGmailDraft,
} from '../gmail-draft.js'
import type { RouteContext } from './types.js'

// text (2 MB) + html (5 MB) as JSON, multi-byte characters escaped or not: 16 MB is the ceiling.
const DRAFT_BODY_MAX_BYTES = 16 * 1024 * 1024

function fail(res: RouteContext['res'], err: DraftError): void {
  json(res, { error: err.message, code: err.code }, err.status)
}

export async function tryHandleGmailDraft(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/gmail/draft' && !path.startsWith('/api/gmail/draft/')) return false

  if (path === '/api/gmail/draft/credentials' && (method === 'PUT' || method === 'DELETE')) {
    if (!mayActAsOwner(ctx.auth, req)) {
      logger.warn({ event: 'gmail-draft-credentials-refused', kind: ctx.auth?.kind ?? 'none', agent: ctx.auth?.tokenAgent ?? ctx.auth?.agent }, 'gmail-draft: credential change refused (not the owner)')
      refuseOwner(res, 'Setting or removing the Gmail draft credential needs the dashboard login (an owner session).')
      return true
    }
    if (method === 'DELETE') {
      const removed = clearGmailDraftCredentials()
      logger.info({ event: 'gmail-draft-credentials', action: 'delete', removed }, 'gmail-draft: credential removed by the owner')
      if (removed) void notifySecurityEvent('[Biztonság] A Gmail-piszkozat végpont hitelesítője törölve lett (dashboard-belépéssel).')
      json(res, { ok: true, removed })
      return true
    }
    const buf = await readBodyOrRefuse(req, res, { maxBytes: 64 * 1024 })
    if (!buf) return true
    let body: { client?: unknown; refreshToken?: unknown }
    try { body = JSON.parse(buf.toString('utf8')) } catch { json(res, { error: 'Invalid JSON body' }, 400); return true }
    try {
      setGmailDraftCredentials(body?.client, body?.refreshToken)
    } catch (err) {
      if (err instanceof DraftError) { fail(res, err); return true }
      throw err
    }
    logger.info({ event: 'gmail-draft-credentials', action: 'set' }, 'gmail-draft: credential stored by the owner')
    void notifySecurityEvent('[Biztonság] A Gmail-piszkozat végpont hitelesítője be lett állítva (dashboard-belépéssel). Az ügynökök ezzel csak piszkozatot írhatnak, a kulcsot nem kapják meg.')
    // Nothing about the values comes back, not even a prefix.
    json(res, { ok: true, configured: true })
    return true
  }

  const owner = mayActAsOwner(ctx.auth, req)
  const caller = draftCallerOf(ctx.auth as Parameters<typeof draftCallerOf>[0], owner, MAIN_AGENT_ID)

  if (path === '/api/gmail/draft/status' && method === 'GET') {
    if (caller instanceof DraftError) { fail(res, caller); return true }
    json(res, { configured: gmailDraftConfigured(), agents: [...gmailDraftAgents()] })
    return true
  }

  if (path !== '/api/gmail/draft' || method !== 'POST') {
    json(res, { error: 'Not found' }, 404)
    return true
  }

  const audit = (fields: Record<string, unknown>, msg: string, level: 'info' | 'warn' = 'info') =>
    logger[level]({ event: 'gmail-draft', kind: caller instanceof DraftError ? (ctx.auth?.kind ?? 'none') : caller.kind,
      principal: caller instanceof DraftError ? (ctx.auth?.tokenAgent ?? ctx.auth?.agent ?? ctx.auth?.user ?? 'none') : caller.principal, ...fields }, msg)

  if (caller instanceof DraftError) {
    audit({ outcome: 'refused', code: caller.code }, 'gmail-draft: caller refused', 'warn')
    fail(res, caller)
    return true
  }
  const buf = await readBodyOrRefuse(req, res, { maxBytes: DRAFT_BODY_MAX_BYTES })
  if (!buf) return true
  let raw: unknown
  try { raw = JSON.parse(buf.toString('utf8')) } catch { json(res, { error: 'Invalid JSON body', code: 'bad-json' }, 400); return true }
  let d
  try {
    d = checkDraftInput(raw)
    if (caller.ownerCc) {
      const owner = ownerCcMissing(d)
      if (owner) throw new DraftError(400, 'owner-cc-missing', `the owner's copy is missing: ${owner} is in none of to, cc, bcc (MAIL_OWNER_CC)`)
    }
    if (caller.ledger) {
      const bad = await unverifiedRecipients(d)
      if (bad.length) throw new DraftError(400, 'recipient-not-verified', `not a verified recipient: ${bad.join(', ')} (add it with a source: node scripts/recipient-ledger.mjs add <address> --source <source> --note "<where from>")`)
    }
  } catch (err) {
    if (!(err instanceof DraftError)) throw err
    audit({ outcome: 'refused', code: err.code }, 'gmail-draft: request refused', 'warn')
    fail(res, err)
    return true
  }
  const counts = { to_count: d.to.length, cc_count: d.cc.length, bcc_count: d.bcc.length, files: d.attachments.length + d.inline.length, subject_sha256: subjectHash(d.subject) }
  try {
    const result = await writeGmailDraft(d)
    // ONE audit line per draft: who, how many recipients, the subject's hash, the draft id. Never the body, the
    // subject, an address or a credential.
    audit({ outcome: 'written', ...counts, draft_id: result.draftId, readback_ok: result.readback.ok }, 'gmail-draft: draft written')
    json(res, { ok: true, ...result })
  } catch (err) {
    if (!(err instanceof DraftError)) {
      audit({ outcome: 'error', ...counts }, 'gmail-draft: unexpected error', 'warn')
      json(res, { error: 'The draft could not be written', code: 'internal' }, 500)
      return true
    }
    audit({ outcome: 'failed', code: err.code, ...counts }, 'gmail-draft: draft not written', 'warn')
    fail(res, err)
  }
  return true
}
