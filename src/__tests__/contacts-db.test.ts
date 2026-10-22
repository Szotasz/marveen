import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureContactsSchema,
  createContact,
  addValue,
  retractValue,
  findContacts,
  getContact,
  recordRead,
  isValidSource,
} from '../contacts-db.js'

const vectors = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'contact-source-vectors.json'), 'utf8'),
) as { valid: string[]; invalid: string[] }

let d: Database.Database
const base = { source: 'owner', source_date: '2026-10-22', added_by: 'brainy' }

beforeEach(() => {
  d = new Database(':memory:')
  ensureContactsSchema(d)
})

describe('source validation parity with recipient-ledger', () => {
  it('agrees with scripts/recipient-ledger.mjs on every shared vector', async () => {
    // @ts-expect-error plain .mjs without types
    const ledger = (await import('../../scripts/recipient-ledger.mjs')) as { isValidSource: (s: unknown) => boolean }
    for (const s of vectors.valid) {
      expect(isValidSource(s), `ts valid: ${s}`).toBe(true)
      expect(ledger.isValidSource(s), `ledger valid: ${s}`).toBe(true)
    }
    for (const s of vectors.invalid) {
      expect(isValidSource(s), `ts invalid: ${s}`).toBe(false)
      expect(ledger.isValidSource(s), `ledger invalid: ${s}`).toBe(false)
    }
  })
})

describe('AC19 contacts table', () => {
  it('requires a domain, rejects unknown ones, stores agent_id brainy', () => {
    expect(() => createContact(d, { domain: undefined, display_name: 'X' })).toThrow(/domain/)
    expect(() => createContact(d, { domain: 'both', display_name: 'X' })).toThrow(/domain/)
    const id = createContact(d, { domain: 'business', display_name: 'Kovacs Bela' })
    expect(getContact(d, id)?.agent_id).toBe('brainy')
  })
  it('DB CHECKs hold even for raw inserts', () => {
    expect(() => d.prepare("INSERT INTO contacts (agent_id, domain, display_name) VALUES ('other','business','x')").run()).toThrow()
    expect(() => d.prepare("INSERT INTO contacts (domain, display_name) VALUES ('x','x')").run()).toThrow()
    expect(() => d.prepare("INSERT INTO contacts (display_name) VALUES ('x')").run()).toThrow()
  })
  it('does not touch the memories table', () => {
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name = 'memories'").get()).toBeUndefined()
  })
})

describe('AC20 per-value source', () => {
  it('rejects a missing or invalid source and a missing source_date', () => {
    const c = createContact(d, { domain: 'business', display_name: 'A' })
    const v = { contact_id: c, field: 'phone' as const, value: '+36 1 111', ...base }
    expect(() => addValue(d, { ...v, source: undefined })).toThrow(/source/)
    expect(() => addValue(d, { ...v, source: '' })).toThrow(/source/)
    expect(() => addValue(d, { ...v, source: 'random text' })).toThrow(/source/)
    expect(() => addValue(d, { ...v, source_date: undefined })).toThrow(/source_date/)
    expect(() => d.prepare("INSERT INTO contact_values (contact_id, field, value, source, source_date, added_by) VALUES (?, 'phone','1','','2026-01-01','x')").run(c)).toThrow()
  })
  it('rejects an unknown field', () => {
    const c = createContact(d, { domain: 'business', display_name: 'A' })
    expect(() => addValue(d, { contact_id: c, field: 'fax' as never, value: '1', ...base })).toThrow(/field/)
  })
})

describe('AC21 append-only', () => {
  it('keeps two conflicting phone numbers, each with its own source', () => {
    const c = createContact(d, { domain: 'business', display_name: 'A' })
    addValue(d, { contact_id: c, field: 'phone', value: '+36 1 111', ...base, source: 'crm:77' })
    addValue(d, { contact_id: c, field: 'phone', value: '+36 1 222', ...base, source: 'mail:abc123' })
    const phones = getContact(d, c)!.values.filter((v) => v.field === 'phone')
    expect(phones.map((p) => [p.value, p.source])).toEqual([['+36 1 111', 'crm:77'], ['+36 1 222', 'mail:abc123']])
  })
  it('aborts UPDATE and DELETE on contact_values', () => {
    const c = createContact(d, { domain: 'family', display_name: 'A' })
    const vid = addValue(d, { contact_id: c, field: 'email', value: 'a@example.com', ...base })
    expect(() => d.prepare('UPDATE contact_values SET value = ? WHERE id = ?').run('b@example.com', vid)).toThrow(/append-only/)
    expect(() => d.prepare("UPDATE contact_values SET source = 'doc:x' WHERE id = ?").run(vid)).toThrow(/append-only/)
    expect(() => d.prepare('DELETE FROM contact_values WHERE id = ?').run(vid)).toThrow(/append-only/)
    expect(() => d.prepare('DELETE FROM contact_values').run()).toThrow(/append-only/)
    expect(getContact(d, c)!.values).toHaveLength(1)
  })
  it('retraction is a new row with its own source; the old row survives', () => {
    const c = createContact(d, { domain: 'business', display_name: 'A' })
    const vid = addValue(d, { contact_id: c, field: 'phone', value: '+36 1 111', ...base })
    expect(() => retractValue(d, { value_id: vid, source: 'nope', source_date: '2026-10-22', added_by: 'brainy' })).toThrow(/source/)
    retractValue(d, { value_id: vid, source: 'mail:retract1', source_date: '2026-10-23', added_by: 'brainy' })
    expect(getContact(d, c)!.values).toHaveLength(0)
    const rows = d.prepare('SELECT status, source FROM contact_values ORDER BY id').all()
    expect(rows).toEqual([{ status: 'active', source: 'owner' }, { status: 'retracted', source: 'mail:retract1' }])
    expect(() => retractValue(d, { value_id: vid, source: 'owner', source_date: '2026-10-23', added_by: 'brainy' })).toThrow(/already/)
  })
})

describe('search', () => {
  it('requires a domain and scopes by it', () => {
    const b = createContact(d, { domain: 'business', display_name: 'Szabo Kft' })
    addValue(d, { contact_id: b, field: 'org', value: 'Szabo Kft', ...base })
    const f = createContact(d, { domain: 'family', display_name: 'Szabo Anna' })
    addValue(d, { contact_id: f, field: 'name', value: 'Szabo Anna', ...base })
    expect(() => findContacts(d, { domain: undefined, q: 'Szabo' })).toThrow(/domain/)
    expect(findContacts(d, { domain: 'business', q: 'Szabo' }).map((c) => c.id)).toEqual([b])
    expect(findContacts(d, { domain: 'family', q: 'Szabo' }).map((c) => c.id)).toEqual([f])
  })
  it('does not match email, phone or address', () => {
    const c = createContact(d, { domain: 'business', display_name: 'Nagy Pal' })
    addValue(d, { contact_id: c, field: 'name', value: 'Nagy Pal', ...base })
    addValue(d, { contact_id: c, field: 'email', value: 'secretmail@example.com', ...base })
    addValue(d, { contact_id: c, field: 'phone', value: '5551234', ...base })
    addValue(d, { contact_id: c, field: 'address', value: 'Mezo utca', ...base })
    expect(findContacts(d, { domain: 'business', q: 'secretmail' })).toHaveLength(0)
    expect(findContacts(d, { domain: 'business', q: '5551234' })).toHaveLength(0)
    expect(findContacts(d, { domain: 'business', q: 'Mezo' })).toHaveLength(0)
    expect(findContacts(d, { domain: 'business', q: 'Nagy' })).toHaveLength(1)
  })
  it('a retracted name no longer matches; FTS operators in input are inert', () => {
    const c = createContact(d, { domain: 'business', display_name: 'Old' })
    const vid = addValue(d, { contact_id: c, field: 'name', value: 'Oldname', ...base })
    retractValue(d, { value_id: vid, source: 'owner', source_date: '2026-10-23', added_by: 'brainy' })
    expect(findContacts(d, { domain: 'business', q: 'Oldname' })).toHaveLength(0)
    expect(() => findContacts(d, { domain: 'business', q: 'a" OR "b*' })).not.toThrow()
  })
})

describe('read audit', () => {
  it('records who, when, which contact and query, and has no value column', () => {
    const c = createContact(d, { domain: 'business', display_name: 'A' })
    recordRead(d, { reader: 'brainy', contact_id: c, query: 'A' })
    const row = d.prepare('SELECT * FROM contact_reads').get() as Record<string, unknown>
    expect(row.reader).toBe('brainy')
    expect(row.contact_id).toBe(c)
    expect(row.query).toBe('A')
    expect(typeof row.read_at).toBe('number')
    expect(Object.keys(row).sort()).toEqual(['contact_id', 'id', 'query', 'read_at', 'reader'])
  })
})

describe('display_name is searchable', () => {
  it('a contact with ONLY a display_name is found by it, inside its domain only; email/phone stay unindexed', () => {
    const biz = createContact(d, { domain: 'business', display_name: 'Zoltan Fenyes' })
    createContact(d, { domain: 'family', display_name: 'Zoltan Fenyes' })
    addValue(d, { contact_id: biz, field: 'email', value: 'unindexed.mail@example.com', ...base })
    addValue(d, { contact_id: biz, field: 'phone', value: '+3699887766', ...base })
    expect(findContacts(d, { domain: 'business', q: 'Fenyes' }).map((c) => c.id)).toEqual([biz])
    expect(findContacts(d, { domain: 'family', q: 'Fenyes' })).toHaveLength(1)
    expect(findContacts(d, { domain: 'business', q: 'unindexed' })).toEqual([])
    expect(findContacts(d, { domain: 'business', q: '3699887766' })).toEqual([])
  })
})
