import { getDb } from '../../db.js'
import { logger } from '../../logger.js'
import { json, readBody } from '../http-helpers.js'
import {
  CONTACT_DOMAINS,
  CONTACT_FIELDS,
  addValue,
  createContact,
  findContacts,
  getContact,
  recordRead,
  retractValue,
  type ContactDomain,
  type ContactField,
} from '../../contacts-db.js'
import { syncEmailToLedger, type LedgerSyncResult } from '../../contacts-ledger-sync.js'
import type { RouteContext } from './types.js'

// Contacts API (card f90928e3, node C2). Bearer-gated like every /api/* route;
// on top of that only the self-asserted X-Agent-Id "brainy" may call (AC23).
// That header is NOT authentication (one shared token), it keeps accidents out.
// Reads always name a domain; there is no "both". Nothing here logs or echoes
// a contact value: log lines carry route and ids only.

const LIST_DEFAULT_LIMIT = 10
const LIST_MAX_LIMIT = 50
const BODY_MAX_BYTES = 64 * 1024
const AUDIT_QUERY_MAX = 100

function callerIsBrainy(ctx: RouteContext): boolean {
  const raw = ctx.req.headers['x-agent-id']
  return typeof raw === 'string' && raw === 'brainy'
}

function domainParam(url: URL): ContactDomain | null {
  const d = url.searchParams.get('domain')
  return CONTACT_DOMAINS.includes(d as ContactDomain) ? (d as ContactDomain) : null
}

// Cyrillic/Greek letters that render like Latin ones. Used only to build a
// comparison skeleton; the stored text is never rewritten.
const LOOKALIKES: Record<string, string> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'і': 'i', 'ј': 'j', 'ѕ': 's',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
}

function normalized(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function skeleton(s: string): string {
  return Array.from(normalized(s), (ch) => LOOKALIKES[ch] ?? ch).join('')
}

/** True when `candidate` looks like an existing name/org but is not the same text. */
function confusableWithExisting(domain: ContactDomain, candidate: string, field: 'name' | 'org' | 'display_name'): boolean {
  const norm = normalized(candidate)
  const skel = skeleton(candidate)
  if (norm === skel) return false // pure Latin text cannot be a disguised copy of anything new
  const d = getDb()
  const existing: string[] = []
  if (field === 'org') {
    const rows = d.prepare(
      `SELECT v.value FROM contact_values v JOIN contacts c ON c.id = v.contact_id
       WHERE c.domain = ? AND v.field = 'org' AND v.status = 'active'`,
    ).all(domain) as { value: string }[]
    for (const r of rows) existing.push(r.value)
  } else {
    const rows = d.prepare(
      `SELECT display_name AS value FROM contacts WHERE domain = ?
       UNION SELECT v.value FROM contact_values v JOIN contacts c ON c.id = v.contact_id
       WHERE c.domain = ? AND v.field = 'name' AND v.status = 'active'`,
    ).all(domain, domain) as { value: string }[]
    for (const r of rows) existing.push(r.value)
  }
  return existing.some((e) => skeleton(e) === skel && normalized(e) !== norm)
}

async function parseBody(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(ctx.req, { maxBytes: BODY_MAX_BYTES })).toString('utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function fail(ctx: RouteContext, err: unknown, route: string): void {
  // contacts-db validation errors carry no values; anything else is a 500
  // with a fixed message.
  const msg = err instanceof Error ? err.message : ''
  const validation = /is required|must be|invalid or missing|not found|only an active|already retracted/.test(msg)
  if (validation) {
    json(ctx.res, { error: msg }, 400)
    return
  }
  logger.error({ route }, 'contacts route failed')
  json(ctx.res, { error: 'internal error' }, 500)
}

export async function tryHandleContacts(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/contacts' && !path.startsWith('/api/contacts/')) return false

  if (!callerIsBrainy(ctx)) {
    logger.warn({ route: 'contacts', method }, 'contacts API denied: X-Agent-Id is not brainy')
    json(res, { error: 'forbidden' }, 403)
    return true
  }

  const d = getDb()

  if (path === '/api/contacts' && method === 'GET') {
    const domain = domainParam(url)
    if (!domain) {
      json(res, { error: `domain is required and must be one of: ${CONTACT_DOMAINS.join(', ')}` }, 400)
      return true
    }
    const q = (url.searchParams.get('q') ?? '').slice(0, 200)
    const reqLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
    const limit = Number.isFinite(reqLimit) && reqLimit > 0 ? Math.min(reqLimit, LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT
    try {
      const all = findContacts(d, { domain, q })
      const contacts = all.slice(0, limit)
      recordRead(d, { reader: 'brainy', query: q ? q.slice(0, AUDIT_QUERY_MAX) : null })
      json(res, { domain, limit, truncated: all.length > contacts.length, contacts })
    } catch (err) {
      fail(ctx, err, 'list')
    }
    return true
  }

  if (path === '/api/contacts' && method === 'POST') {
    const body = await parseBody(ctx)
    if (!body) { json(res, { error: 'invalid JSON body' }, 400); return true }
    const domain = CONTACT_DOMAINS.includes(body.domain as ContactDomain) ? (body.domain as ContactDomain) : null
    if (!domain) {
      json(res, { error: `domain is required and must be one of: ${CONTACT_DOMAINS.join(', ')}` }, 400)
      return true
    }
    const name = typeof body.display_name === 'string' ? body.display_name.trim() : ''
    if (!name) { json(res, { error: 'display_name is required' }, 400); return true }
    const initial = body.values === undefined ? [] : body.values
    if (!Array.isArray(initial)) { json(res, { error: 'values must be an array' }, 400); return true }

    try {
      const warnings: string[] = []
      if (confusableWithExisting(domain, name, 'display_name')) warnings.push('display_name')
      for (const v of initial as Record<string, unknown>[]) {
        if (v && (v.field === 'name' || v.field === 'org') && typeof v.value === 'string'
          && confusableWithExisting(domain, v.value, v.field)) warnings.push(String(v.field))
      }
      const tx = d.transaction(() => {
        const id = createContact(d, { domain, display_name: name })
        for (const v of initial as Record<string, unknown>[]) {
          if (!v || typeof v !== 'object') throw new Error('value is required')
          addValue(d, {
            contact_id: id,
            field: v.field as ContactField,
            value: v.value as string,
            source: v.source,
            source_date: v.source_date,
            added_by: 'brainy',
          })
        }
        return id
      })
      const id = tx()
      const out: Record<string, unknown> = { ok: true, id }
      // Contact committed above; the ledger sync runs after and may only fail alone.
      const syncs: LedgerSyncResult[] = []
      for (const v of initial as Record<string, unknown>[]) {
        if (v.field === 'email' && typeof v.value === 'string') {
          syncs.push(await syncEmailToLedger({ contactId: id, value: v.value.trim(), source: String(v.source).trim() }))
        }
      }
      if (syncs.length) out.ledger = syncs.includes('failed') ? 'failed' : syncs.includes('ok') ? 'ok' : 'exists'
      if (warnings.length) out.warning = `possible look-alike of an existing ${[...new Set(warnings)].join('/')} (Cyrillic/Greek letters); saved unchanged, please check`
      json(res, out, 201)
    } catch (err) {
      fail(ctx, err, 'create')
    }
    return true
  }

  const retractMatch = path.match(/^\/api\/contacts\/values\/(\d+)\/retract$/)
  if (retractMatch && method === 'POST') {
    const body = await parseBody(ctx)
    if (!body) { json(res, { error: 'invalid JSON body' }, 400); return true }
    try {
      const id = retractValue(d, {
        value_id: Number(retractMatch[1]),
        source: body.source,
        source_date: body.source_date,
        added_by: 'brainy',
      })
      json(res, { ok: true, id }, 201)
    } catch (err) {
      fail(ctx, err, 'retract')
    }
    return true
  }

  const valuesMatch = path.match(/^\/api\/contacts\/(\d+)\/values$/)
  if (valuesMatch && method === 'POST') {
    const body = await parseBody(ctx)
    if (!body) { json(res, { error: 'invalid JSON body' }, 400); return true }
    const contact = getContact(d, Number(valuesMatch[1]))
    if (!contact) { json(res, { error: 'not found' }, 404); return true }
    if (!CONTACT_FIELDS.includes(body.field as ContactField)) {
      json(res, { error: `field must be one of: ${CONTACT_FIELDS.join(', ')}` }, 400)
      return true
    }
    try {
      const warn = (body.field === 'name' || body.field === 'org') && typeof body.value === 'string'
        && confusableWithExisting(contact.domain, body.value, body.field)
      const id = addValue(d, {
        contact_id: contact.id,
        field: body.field as ContactField,
        value: body.value as string,
        source: body.source,
        source_date: body.source_date,
        added_by: 'brainy',
      })
      const out: Record<string, unknown> = { ok: true, id }
      if (body.field === 'email' && typeof body.value === 'string') {
        out.ledger = await syncEmailToLedger({ contactId: contact.id, value: body.value.trim(), source: String(body.source).trim() })
      }
      if (warn) out.warning = `possible look-alike of an existing ${body.field} (Cyrillic/Greek letters); saved unchanged, please check`
      json(res, out, 201)
    } catch (err) {
      fail(ctx, err, 'add-value')
    }
    return true
  }

  const getMatch = path.match(/^\/api\/contacts\/(\d+)$/)
  if (getMatch && method === 'GET') {
    const domain = domainParam(url)
    if (!domain) {
      json(res, { error: `domain is required and must be one of: ${CONTACT_DOMAINS.join(', ')}` }, 400)
      return true
    }
    try {
      const id = Number(getMatch[1])
      const c = getContact(d, id)
      // Other domain looks exactly like a missing row.
      if (!c || c.domain !== domain) { json(res, { error: 'not found' }, 404); return true }
      recordRead(d, { reader: 'brainy', contact_id: id })
      json(res, c)
    } catch (err) {
      fail(ctx, err, 'get')
    }
    return true
  }

  json(res, { error: 'not found' }, 404)
  return true
}
