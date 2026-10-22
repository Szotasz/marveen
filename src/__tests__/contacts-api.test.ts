// Contacts API (card f90928e3, node C2): AC22-AC24 plus the domain wall, the
// X-Agent-Id gate, FTS/SQL injection in q, the limit cap, the read audit and
// the homoglyph warning. Drives the real handler against an in-memory DB.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

const warnLog = vi.hoisted(() => [] as unknown[][])
vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: (...a: unknown[]) => { warnLog.push(a) }, error: () => {}, debug: () => {} },
}))

import { initDatabase, getDb } from '../db.js'
import { tryHandleContacts } from '../web/routes/contacts.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(
  method: string,
  pathAndQuery: string,
  payload?: unknown,
  agent: string | null = 'brainy', // null = header absent
): Promise<{ handled: boolean; status: number; body: any }> {
  const out = { status: 200, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = payload === undefined ? '' : JSON.stringify(payload)
  const req: any = Readable.from(raw ? [Buffer.from(raw)] : [])
  req.headers = agent === null ? {} : { 'x-agent-id': agent }
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  const handled = await tryHandleContacts({ req, res, path: url.pathname, method, url } as RouteContext)
  return { handled, ...out }
}

const src = { source: 'owner', source_date: '2026-10-22' }
const nameVal = (value: string) => ({ field: 'name', value, ...src })

async function mk(domain: string, display_name: string, values: unknown[] = []): Promise<number> {
  const r = await call('POST', '/api/contacts', { domain, display_name, values })
  expect(r.status).toBe(201)
  return r.body.id
}

beforeEach(() => {
  initDatabase(':memory:')
  warnLog.length = 0
})

describe('AC23: X-Agent-Id gate', () => {
  it('403 for another agent, a missing header and a case/space variant; logs without values', async () => {
    await mk('business', 'Kovacs Bela', [nameVal('Kovacs Bela')])
    for (const agent of ['iroda', null, 'Brainy', ' brainy', 'brainy, iroda']) {
      const r = await call('GET', '/api/contacts?domain=business&q=Kovacs', undefined, agent)
      expect(r.status, String(agent)).toBe(403)
      expect(JSON.stringify(r.body)).not.toMatch(/Kovacs/)
    }
    const w = await call('POST', '/api/contacts', { domain: 'business', display_name: 'Secret Person' }, 'iroda')
    expect(w.status).toBe(403)
    expect(getDb().prepare('SELECT COUNT(*) n FROM contacts').get()).toEqual({ n: 1 })
    expect(warnLog.length).toBeGreaterThanOrEqual(6)
    expect(JSON.stringify(warnLog)).not.toMatch(/Kovacs|Secret/)
  })

  it('does not handle unrelated paths', async () => {
    expect((await call('GET', '/api/memories', undefined, null)).handled).toBe(false)
  })
})

describe('AC22: search needs a domain, FTS over name and org, values with source', () => {
  it('400 without or with a bad domain (no both default)', async () => {
    for (const q of ['', '?q=x', '?domain=both&q=x', '?domain=']) {
      expect((await call('GET', `/api/contacts${q}`)).status, q).toBe(400)
    }
    expect((await call('GET', '/api/contacts/1')).status).toBe(400)
    expect((await call('POST', '/api/contacts', { display_name: 'X' })).status).toBe(400)
  })

  it('finds by name and org, returns values with source and source_date', async () => {
    const id = await mk('business', 'Kovacs Bela', [
      nameVal('Kovacs Bela'),
      { field: 'org', value: 'Acme Kft', source: 'crm:123', source_date: '2026-10-01' },
      { field: 'phone', value: '+36301234567', ...src },
    ])
    const byName = await call('GET', '/api/contacts?domain=business&q=Kovacs')
    expect(byName.body.contacts.map((c: any) => c.id)).toEqual([id])
    const byOrg = await call('GET', '/api/contacts?domain=business&q=Acme')
    expect(byOrg.body.contacts.map((c: any) => c.id)).toEqual([id])
    const phone = byName.body.contacts[0].values.find((v: any) => v.field === 'phone')
    expect(phone).toMatchObject({ value: '+36301234567', source: 'owner', source_date: '2026-10-22' })
    const org = byName.body.contacts[0].values.find((v: any) => v.field === 'org')
    expect(org).toMatchObject({ source: 'crm:123', source_date: '2026-10-01' })
    // phone numbers are not searchable
    expect((await call('GET', '/api/contacts?domain=business&q=36301234567')).body.contacts).toEqual([])
  })
})

describe('domain wall', () => {
  it('business search never returns family rows; GET :id across domains is 404', async () => {
    const biz = await mk('business', 'Szabo Anna', [nameVal('Szabo Anna')])
    const fam = await mk('family', 'Szabo Anna', [nameVal('Szabo Anna'), { field: 'phone', value: '+3611111', ...src }])
    const b = await call('GET', '/api/contacts?domain=business&q=Szabo')
    expect(b.body.contacts.map((c: any) => c.id)).toEqual([biz])
    expect(JSON.stringify(b.body)).not.toMatch(/3611111/)
    const f = await call('GET', '/api/contacts?domain=family&q=Szabo')
    expect(f.body.contacts.map((c: any) => c.id)).toEqual([fam])
    const cross = await call('GET', `/api/contacts/${fam}?domain=business`)
    expect(cross.status).toBe(404)
    expect(JSON.stringify(cross.body)).not.toMatch(/3611111|Szabo/)
    expect((await call('GET', `/api/contacts/${fam}?domain=family`)).body.id).toBe(fam)
  })
})

describe('writes and source validation', () => {
  it('POST /api/contacts: initial value without source or source_date is 400 and nothing is stored', async () => {
    for (const v of [{ field: 'phone', value: '1' }, { field: 'phone', value: '1', source: 'owner' }, { field: 'phone', value: '1', source: 'bogus', source_date: '2026-10-22' }]) {
      const r = await call('POST', '/api/contacts', { domain: 'business', display_name: 'A', values: [v] })
      expect(r.status).toBe(400)
    }
    expect(getDb().prepare('SELECT COUNT(*) n FROM contacts').get()).toEqual({ n: 0 })
  })

  it('POST values: ok, then 400 on missing/invalid source, bad field; 404 on unknown contact', async () => {
    const id = await mk('business', 'A B')
    const ok = await call('POST', `/api/contacts/${id}/values`, { field: 'email', value: 'a@b.hu', ...src })
    expect(ok.status).toBe(201)
    expect((await call('POST', `/api/contacts/${id}/values`, { field: 'email', value: 'a@b.hu', source_date: '2026-10-22' })).status).toBe(400)
    expect((await call('POST', `/api/contacts/${id}/values`, { field: 'email', value: 'a@b.hu', source: 'guess', source_date: '2026-10-22' })).status).toBe(400)
    expect((await call('POST', `/api/contacts/${id}/values`, { field: 'shoe', value: 'x', ...src })).status).toBe(400)
    expect((await call('POST', '/api/contacts/9999/values', { field: 'email', value: 'a@b.hu', ...src })).status).toBe(404)
  })

  it('retract needs a source; a retracted value disappears from reads', async () => {
    const id = await mk('business', 'A B')
    const v = (await call('POST', `/api/contacts/${id}/values`, { field: 'phone', value: '555', ...src })).body.id
    const biz = { domain: 'business' }
    expect((await call('POST', `/api/contacts/values/${v}/retract`, biz)).status).toBe(400)
    expect((await call('POST', `/api/contacts/values/${v}/retract`, { ...biz, source: 'nope', source_date: '2026-10-22' })).status).toBe(400)
    expect((await call('POST', `/api/contacts/values/${v}/retract`, { ...biz, source: 'doc:x', source_date: '2026-10-22' })).status).toBe(201)
    expect((await call('GET', `/api/contacts/${id}?domain=business`)).body.values).toEqual([])
    expect((await call('POST', `/api/contacts/values/${v}/retract`, { ...biz, source: 'doc:x', source_date: '2026-10-22' })).status).toBe(400)
  })

  it('retract needs a domain; another domain or a missing value is the same 404 and writes nothing', async () => {
    const fam = await mk('family', 'F')
    const v = (await call('POST', `/api/contacts/${fam}/values`, { field: 'phone', value: '555', ...src })).body.id
    const ok = { source: 'doc:x', source_date: '2026-10-22' }
    expect((await call('POST', `/api/contacts/values/${v}/retract`, ok)).status).toBe(400)
    expect((await call('POST', `/api/contacts/values/${v}/retract`, { ...ok, domain: 'both' })).status).toBe(400)
    const cross = await call('POST', `/api/contacts/values/${v}/retract`, { ...ok, domain: 'business' })
    const missing = await call('POST', `/api/contacts/values/99999/retract`, { ...ok, domain: 'business' })
    expect(cross.status).toBe(404)
    expect(cross).toEqual(missing)
    expect(getDb().prepare("SELECT COUNT(*) n FROM contact_values WHERE status = 'retracted'").get()).toEqual({ n: 0 })
    expect(getDb().prepare("SELECT COUNT(*) n FROM contact_writes WHERE action = 'retract'").get()).toEqual({ n: 0 })
    expect((await call('POST', `/api/contacts/values/${v}/retract`, { ...ok, domain: 'family' })).status).toBe(201)
  })

  it('malformed JSON is 400 and echoes nothing', async () => {
    const out = { status: 0, body: null as any }
    const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() { return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const req: any = Readable.from([Buffer.from('{"display_name":"Leak Name"')])
    req.headers = { 'x-agent-id': 'brainy' }
    const url = new URL('http://localhost:3420/api/contacts')
    await tryHandleContacts({ req, res, path: url.pathname, method: 'POST', url } as RouteContext)
    expect(out.status).toBe(400)
    expect(JSON.stringify(out.body)).not.toMatch(/Leak/)
  })
})

describe('injection in q', () => {
  it('quotes, FTS operators, NEAR, * and SQL fragments never 500', async () => {
    await mk('business', 'Kovacs Bela', [nameVal('Kovacs Bela')])
    const qs = ['"', '""', "' OR 1=1 --", 'Kovacs OR Bela', 'NEAR(Kovacs Bela)', 'Kov*', '*', 'name:Kovacs', '-Kovacs', '(', ')', 'AND', '; DROP TABLE contacts', 'contacts_fts MATCH']
    for (const q of qs) {
      const r = await call('GET', `/api/contacts?domain=business&q=${encodeURIComponent(q)}`)
      expect(r.status, q).toBe(200)
      expect(r.body.contacts.length, q).toBeLessThanOrEqual(1)
    }
    expect(getDb().prepare('SELECT COUNT(*) n FROM contacts').get()).toEqual({ n: 1 })
    // wildcard and OR must not widen the result
    expect((await call('GET', `/api/contacts?domain=business&q=${encodeURIComponent('Zzz OR Kovacs')}`)).body.contacts).toEqual([])
    expect((await call('GET', `/api/contacts?domain=business&q=${encodeURIComponent('Kov*')}`)).body.contacts).toEqual([])
  })
})

describe('limit', () => {
  it('defaults small, caps hard, flags truncation', async () => {
    for (let i = 0; i < 60; i++) await mk('business', `Person ${i}`, [nameVal(`Person ${i}`)])
    const d = await call('GET', '/api/contacts?domain=business&q=Person')
    expect(d.body.contacts).toHaveLength(10)
    expect(d.body.truncated).toBe(true)
    const big = await call('GET', '/api/contacts?domain=business&q=Person&limit=100000')
    expect(big.body.contacts).toHaveLength(50)
    expect(big.body.limit).toBe(50)
    const two = await call('GET', '/api/contacts?domain=business&q=Person&limit=2')
    expect(two.body.contacts).toHaveLength(2)
    expect((await call('GET', '/api/contacts?domain=business&q=Person&limit=-5')).body.contacts).toHaveLength(10)
  })
})

describe('read audit', () => {
  it('list and get each write a contact_reads row, never a value', async () => {
    const id = await mk('business', 'Audit Target', [nameVal('Audit Target'), { field: 'phone', value: '+3699887766', ...src }])
    await call('GET', '/api/contacts?domain=business&q=Audit')
    await call('GET', `/api/contacts/${id}?domain=business`)
    const rows = getDb().prepare('SELECT * FROM contact_reads ORDER BY id').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ reader: 'brainy', contact_id: id, query: 'Audit' })
    expect(rows[1]).toMatchObject({ reader: 'brainy', contact_id: id, query: null })
    expect(JSON.stringify(rows)).not.toMatch(/3699887766/)
  })

  it('a list read audits every returned contact_id; an empty result leaves one id-less row', async () => {
    const a = await mk('business', 'Listed One', [nameVal('Listed One')])
    const b = await mk('business', 'Listed Two', [nameVal('Listed Two')])
    await mk('family', 'Listed Fam', [nameVal('Listed Fam')])
    await call('GET', '/api/contacts?domain=business&q=Listed')
    let rows = getDb().prepare('SELECT contact_id FROM contact_reads ORDER BY id').all() as any[]
    expect(rows.map((r) => r.contact_id)).toEqual([a, b])
    await call('GET', '/api/contacts?domain=business&q=Nobody')
    rows = getDb().prepare('SELECT contact_id, query FROM contact_reads ORDER BY id').all() as any[]
    expect(rows).toHaveLength(3)
    expect(rows[2]).toEqual({ contact_id: null, query: 'Nobody' })
  })

  it('404 reads (missing id and other-domain id) are audited with the requested id, same response', async () => {
    const fam = await mk('family', 'Hidden', [nameVal('Hidden')])
    const missing = await call('GET', '/api/contacts/9999?domain=business')
    const cross = await call('GET', `/api/contacts/${fam}?domain=business`)
    expect(missing.status).toBe(404)
    expect(cross).toEqual(missing)
    const rows = getDb().prepare('SELECT contact_id, query FROM contact_reads ORDER BY id').all() as any[]
    expect(rows).toEqual([
      { contact_id: 9999, query: 'get:not-found' },
      { contact_id: fam, query: 'get:not-found' },
    ])
  })
})

describe('homoglyph warning', () => {
  const cyr = 'Kov\u0430cs B\u0435la' // Cyrillic a and e inside a Latin name

  it('the fixture really carries Cyrillic letters', () => {
    expect(cyr).toMatch(/[\u0400-\u04ff]/)
    expect(cyr).not.toBe('Kovacs Bela')
  })

  it('201 + warning for a confusable display_name, still stored', async () => {
    await mk('business', 'Kovacs Bela')
    const r = await call('POST', '/api/contacts', { domain: 'business', display_name: cyr })
    expect(r.status).toBe(201)
    expect(r.body.warning).toMatch(/look-alike/)
    expect(getDb().prepare('SELECT COUNT(*) n FROM contacts').get()).toEqual({ n: 2 })
  })

  it('warns on a confusable org value but not across domains or for plain new text', async () => {
    const a = await mk('business', 'A', [{ field: 'org', value: 'Acme Kft', ...src }])
    const b = await mk('business', 'B')
    const fam = await mk('family', 'C')
    const org = 'Acm\u0435 Kft'
    expect((await call('POST', `/api/contacts/${b}/values`, { field: 'org', value: org, ...src })).body.warning).toMatch(/look-alike/)
    expect((await call('POST', `/api/contacts/${fam}/values`, { field: 'org', value: org, ...src })).body.warning).toBeUndefined()
    const plain = await call('POST', `/api/contacts/${a}/values`, { field: 'org', value: 'Other Kft', ...src })
    expect(plain.status).toBe(201)
    expect(plain.body.warning).toBeUndefined()
  })
})

describe('write audit', () => {
  const SECRET_EMAIL = 'audit.leak.check@example.com'
  const SECRET_PHONE = '+36 99 555 0101'

  it('one contact_writes row per create / add / retract, actor from X-Agent-Id, no value anywhere in either audit table', async () => {
    const id = await mk('business', 'Audit Person', [{ field: 'email', value: SECRET_EMAIL, ...src }])
    const add = await call('POST', `/api/contacts/${id}/values`, { field: 'phone', value: SECRET_PHONE, ...src })
    const ret = await call('POST', `/api/contacts/values/${add.body.id}/retract`, { domain: 'business', ...src })
    expect(ret.status).toBe(201)
    await call('GET', `/api/contacts/${id}?domain=business`)
    const rows = getDb().prepare('SELECT * FROM contact_writes ORDER BY id').all() as any[]
    expect(rows.map((r) => r.action)).toEqual(['create', 'add', 'add', 'retract'])
    expect(rows.every((r) => r.actor === 'brainy' && r.contact_id === id && typeof r.at === 'number')).toBe(true)
    expect(rows[0].value_id).toBeNull()
    expect(rows[2].value_id).toBe(add.body.id)
    expect(rows[3].value_id).toBe(ret.body.id)
    expect(Object.keys(rows[0]).sort()).toEqual(['action', 'actor', 'at', 'contact_id', 'id', 'value_id'])
    const dump = JSON.stringify([
      ...getDb().prepare('SELECT * FROM contact_writes').all(),
      ...getDb().prepare('SELECT * FROM contact_reads').all(),
    ])
    expect(dump).not.toContain(SECRET_EMAIL)
    expect(dump).not.toContain(SECRET_PHONE)
  })

  it('failed writes leave no audit row; audit tables are append-only', async () => {
    const bad = await call('POST', '/api/contacts', { domain: 'business', display_name: 'X', values: [{ field: 'email', value: 'a@example.com' }] })
    expect(bad.status).toBe(400)
    expect(getDb().prepare('SELECT COUNT(*) n FROM contact_writes').get()).toEqual({ n: 0 })
    const id = await mk('business', 'Y')
    await call('GET', `/api/contacts/${id}?domain=business`)
    for (const sql of [
      'UPDATE contact_writes SET actor = 1', 'DELETE FROM contact_writes',
      'UPDATE contact_reads SET reader = 1', 'DELETE FROM contact_reads',
    ]) expect(() => getDb().prepare(sql).run(), sql).toThrow(/append-only/)
  })
})
