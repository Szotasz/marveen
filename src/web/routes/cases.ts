import { openCase, listCases, getCase, appendCaseNote, closeCase, claimOwnerFlag, listOwnerFlagClaims, releaseOwnerFlag, listOwnerFlagReleases } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../../homoglyph.js'
import type { RouteContext } from './types.js'
import { containsSuspiciousContent } from './memories.js'

// Reserved author ids (review follow-up): agents read case notes as trusted
// context, and supervisor directives are authenticated by from='system', which
// /api/messages refuses with 403. The same id must not be writable here.
const RESERVED_AUTHORS = new Set(['system'])
function reservedAuthor(a: string | undefined): boolean {
  return RESERVED_AUTHORS.has(String(a ?? '').trim().toLowerCase())
}
function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s) } catch { return null }
}

// Case files: one place per multi-agent finding, instead of N-to-N messaging.
// See the schema comment in db.ts for the measurement that motivated it.
//
// Notes are append-only, so two agents writing at the same moment cannot
// overwrite each other -- which is the whole point, since concurrent work is
// the situation this exists for. A correction is a new note, never an edit.

const KINDS = new Set(['finding', 'measurement', 'decision', 'correction', 'question', 'note'])
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

export async function tryHandleCases(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/cases' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString()) as {
      id?: string; title?: string; agent?: string
    }
    const id = (data.id || '').trim()
    if (!SLUG_RE.test(id)) {
      json(res, { error: 'id must be a slug: lowercase letters, digits and dashes, 2-64 chars' }, 400)
      return true
    }
    if (!data.title?.trim()) { json(res, { error: 'title required' }, 400); return true }
    if (reservedAuthor(data.agent)) { json(res, { error: 'reserved agent id' }, 403); return true }
    if (containsSuspiciousContent(data.title)) { json(res, { error: 'Content rejected by security filter' }, 400); return true }
    const row = openCase(id, data.title.trim(), data.agent || MAIN_AGENT_ID)
    json(res, { ok: true, case: row })
    return true
  }

  if (path === '/api/cases' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined
    json(res, listCases(status ?? undefined))
    return true
  }

  const noteMatch = /^\/api\/cases\/([^/]+)\/notes$/.exec(path)
  if (noteMatch && method === 'POST') {
    const caseId = safeDecode(noteMatch[1] as string)
    if (caseId === null) { json(res, { error: 'malformed case id' }, 400); return true }
    const existing = getCase(caseId)
    if (!existing) { json(res, { error: 'no such case' }, 404); return true }
    // A closed case is a settled record; a later finding opens a new case.
    if (existing.case.status !== 'open') { json(res, { error: 'case is closed', case: existing.case }, 409); return true }
    const data = JSON.parse((await readBody(req)).toString()) as {
      agent?: string; kind?: string; content?: string
    }
    if (!data.content?.trim()) { json(res, { error: 'content required' }, 400); return true }
    if (reservedAuthor(data.agent)) { json(res, { error: 'reserved agent id' }, 403); return true }
    if (containsSuspiciousContent(data.content)) { json(res, { error: 'Content rejected by security filter' }, 400); return true }
    const kind = (data.kind || 'note').trim()
    if (!KINDS.has(kind)) {
      json(res, { error: `kind must be one of: ${[...KINDS].join(', ')}` }, 400)
      return true
    }
    const note = appendCaseNote(caseId, data.agent || MAIN_AGENT_ID, kind, data.content.trim())
    // Warn-only homoglyph check, same contract as memories/daily-log: the text
    // is saved unchanged and the caller is told, because silently rewriting
    // someone's evidence would be worse than a searchable-but-odd word.
    const homoglyphs = detectHomoglyphs(data.content)
    if (homoglyphs.length > 0) {
      const warning = formatHomoglyphWarning(homoglyphs)
      logger.warn({ agent: data.agent, case: caseId }, `case note saved with ${warning}`)
      json(res, { ok: true, note, homoglyph_warning: warning })
      return true
    }
    json(res, { ok: true, note })
    return true
  }

  const closeMatch = /^\/api\/cases\/([^/]+)\/close$/.exec(path)
  if (closeMatch && method === 'POST') {
    const caseId = safeDecode(closeMatch[1] as string)
    if (caseId === null) { json(res, { error: 'malformed case id' }, 400); return true }
    if (!getCase(caseId)) { json(res, { error: 'no such case' }, 404); return true }
    const data = JSON.parse((await readBody(req)).toString()) as { agent?: string }
    if (reservedAuthor(data.agent)) { json(res, { error: 'reserved agent id' }, 403); return true }
    const r = closeCase(caseId, data.agent || MAIN_AGENT_ID)
    if (!r.closed) { json(res, { error: 'case already closed', case: r.case }, 409); return true }
    json(res, { ok: true, case: r.case })
    return true
  }

  const getMatch = /^\/api\/cases\/([^/]+)$/.exec(path)
  if (getMatch && method === 'GET') {
    const gid = safeDecode(getMatch[1] as string)
    if (gid === null) { json(res, { error: 'malformed case id' }, 400); return true }
    const found = getCase(gid)
    if (!found) { json(res, { error: 'no such case' }, 404); return true }
    json(res, found)
    return true
  }

  // --- send-once ledger for owner-facing flags ---------------------------
  // See the schema comment in db.ts: the point is to make "tell the owner once"
  // a property of the send itself, rather than something six other mechanisms
  // have to agree about.

  if (path === '/api/owner-flags/claim' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString()) as {
      agent?: string; source_ref?: string; chat_id?: string; note?: string
    }
    const agent = (data.agent || MAIN_AGENT_ID).trim()
    const ref = (data.source_ref || '').trim()
    if (!ref) { json(res, { error: 'source_ref required (e.g. the Gmail message id)' }, 400); return true }
    const { claimed, existing } = claimOwnerFlag(agent, ref, data.chat_id, data.note)
    json(res, { ok: true, claimed, first_claim: existing })
    return true
  }

  if (path === '/api/owner-flags/release' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString()) as { agent?: string; source_ref?: string; released_by?: string }
    const agent = (data.agent || MAIN_AGENT_ID).trim()
    const ref = (data.source_ref || '').trim()
    if (!ref) { json(res, { error: 'source_ref required' }, 400); return true }
    const by = (data.released_by || agent).trim()
    if (reservedAuthor(by)) { json(res, { error: 'reserved agent id' }, 403); return true }
    const released = releaseOwnerFlag(agent, ref, by)
    if (released) logger.info({ agent, source_ref: ref, released_by: by }, 'owner flag claim released')
    json(res, { ok: true, released })
    return true
  }

  if (path === '/api/owner-flags/releases' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    const ref = (url.searchParams.get('source_ref') || '').trim()
    if (!ref) { json(res, { error: 'source_ref required' }, 400); return true }
    json(res, listOwnerFlagReleases(agent, ref))
    return true
  }

  if (path === '/api/owner-flags' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    const limit = Number(url.searchParams.get('limit') || 50)
    json(res, listOwnerFlagClaims(agent, Number.isFinite(limit) && limit > 0 ? limit : 50))
    return true
  }

  return false
}
