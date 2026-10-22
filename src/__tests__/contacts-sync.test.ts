// Ledger sync (card f90928e3, node C3): AC25. Every ledger here is a temp file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

import { initDatabase, getDb } from '../db.js'
import { tryHandleContacts } from '../web/routes/contacts.js'
import { setLedgerSyncPath } from '../contacts-ledger-sync.js'
import type { RouteContext } from '../web/routes/types.js'
// @ts-expect-error plain .mjs without types
import { planImport, runImport } from '../../scripts/contacts-import-ledger.mjs'

async function call(method: string, pathAndQuery: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 200, body: null as any }
  const res: any = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  req.headers = { 'x-agent-id': 'brainy' }
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  await tryHandleContacts({ req, res, path: url.pathname, method, url } as RouteContext)
  return out
}

const src = { source: 'mail:abc123', source_date: '2026-10-22' }
let dir: string
let ledger: string

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'c3-'))
  ledger = join(dir, 'verified-recipients.json')
  setLedgerSyncPath(ledger)
})
afterEach(() => setLedgerSyncPath(null))

describe('AC25: contact email -> ledger', () => {
  it('adds the address with the same source and note contact:<id>, version 1 unchanged', async () => {
    const c = await call('POST', '/api/contacts', { domain: 'business', display_name: 'Kovacs Bela' })
    const r = await call('POST', `/api/contacts/${c.body.id}/values`, { field: 'email', value: 'Bela@Example.hu', ...src })
    expect(r.status).toBe(201)
    expect(r.body.ledger).toBe('ok')
    const file = JSON.parse(readFileSync(ledger, 'utf8'))
    expect(file.version).toBe(1)
    expect(Object.keys(file)).toEqual(['version', 'recipients'])
    expect(file.recipients['bela@example.hu']).toMatchObject({ source: 'mail:abc123', note: `contact:${c.body.id}` })
  })

  it('initial values on create sync too; non-email values do not touch the ledger', async () => {
    const r = await call('POST', '/api/contacts', {
      domain: 'business', display_name: 'Szabo Anna',
      values: [{ field: 'phone', value: '+3612345', ...src }, { field: 'email', value: 'anna@example.hu', ...src }],
    })
    expect(r.status).toBe(201)
    expect(r.body.ledger).toBe('ok')
    expect(Object.keys(JSON.parse(readFileSync(ledger, 'utf8')).recipients)).toEqual(['anna@example.hu'])
    const p = await call('POST', `/api/contacts/${r.body.id}/values`, { field: 'phone', value: '+3699', ...src })
    expect(p.body.ledger).toBeUndefined()
  })

  it('an address already in the ledger is not overwritten', async () => {
    writeFileSync(ledger, JSON.stringify({ version: 1, recipients: { 'a@example.hu': { source: 'owner', note: 'orig', added_at: '2026-01-01T00:00:00.000Z' } } }))
    const c = await call('POST', '/api/contacts', { domain: 'business', display_name: 'A' })
    const r = await call('POST', `/api/contacts/${c.body.id}/values`, { field: 'email', value: 'a@example.hu', ...src })
    expect(r.body.ledger).toBe('exists')
    expect(JSON.parse(readFileSync(ledger, 'utf8')).recipients['a@example.hu'].note).toBe('orig')
  })

  it('ledger write failure keeps the contact value and reports it without the address', async () => {
    writeFileSync(ledger, '{ not json')
    const c = await call('POST', '/api/contacts', { domain: 'business', display_name: 'B' })
    const r = await call('POST', `/api/contacts/${c.body.id}/values`, { field: 'email', value: 'secret@example.hu', ...src })
    expect(r.status).toBe(201)
    expect(r.body.ledger).toBe('failed')
    expect(JSON.stringify(r.body)).not.toContain('secret@')
    expect(readFileSync(ledger, 'utf8')).toBe('{ not json')
    const stored = getDb().prepare("SELECT value FROM contact_values WHERE field='email'").all()
    expect(stored).toEqual([{ value: 'secret@example.hu' }])
  })

  it('a rejected contact value (bad source) writes nothing to the ledger', async () => {
    const c = await call('POST', '/api/contacts', { domain: 'business', display_name: 'C' })
    const r = await call('POST', `/api/contacts/${c.body.id}/values`, { field: 'email', value: 'x@example.hu', source: 'trust me', source_date: '2026-10-22' })
    expect(r.status).toBe(400)
    expect(existsSync(ledger)).toBe(false)
  })
})

describe('ledger -> contacts import', () => {
  const entries = {
    'a@example.hu': { source: 'owner', note: '', added_at: '2026-03-04T10:00:00.000Z' },
    'b@example.hu': { source: 'crm:42', note: '', added_at: '2026-05-06T10:00:00.000Z' },
  }
  beforeEach(() => writeFileSync(ledger, JSON.stringify({ version: 1, recipients: entries })))

  it('requires --domain and named addresses', () => {
    expect(() => planImport({ domain: undefined, addresses: ['a@example.hu'], ledgerFile: ledger })).toThrow(/domain/)
    expect(() => planImport({ domain: 'business', addresses: [], ledgerFile: ledger })).toThrow(/address/)
  })

  it('imports only the named addresses with the source mapped 1:1', () => {
    const { plan, missing } = planImport({ domain: 'family', addresses: ['B@Example.hu', 'zzz@example.hu'], ledgerFile: ledger })
    expect(plan).toHaveLength(1)
    expect(plan[0].values[0]).toMatchObject({ field: 'email', value: 'b@example.hu', source: 'crm:42', source_date: '2026-05-06' })
    expect(missing).toEqual(['zzz@example.hu'])
  })

  it('dry run writes nothing and never calls post; apply does', async () => {
    const post = vi.fn(async () => ({ ok: true }))
    const before = readFileSync(ledger, 'utf8')
    const dry = await runImport({ domain: 'business', addresses: ['a@example.hu'], ledgerFile: ledger, post })
    expect(dry).toMatchObject({ dryRun: true, planned: 1, created: 0 })
    expect(post).not.toHaveBeenCalled()
    const real = await runImport({ domain: 'business', addresses: ['a@example.hu'], ledgerFile: ledger, apply: true, post })
    expect(real.created).toBe(1)
    expect(post).toHaveBeenCalledTimes(1)
    expect(readFileSync(ledger, 'utf8')).toBe(before)
  })
})
