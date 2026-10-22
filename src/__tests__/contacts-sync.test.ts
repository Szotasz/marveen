// Ledger sync (card f90928e3, node C3): AC25. Every ledger here is a temp file.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

import { initDatabase, getDb } from '../db.js'
import { tryHandleContacts } from '../web/routes/contacts.js'
import type { RouteContext } from '../web/routes/types.js'
// @ts-expect-error plain .mjs without types
import { planImport, runImport } from '../../scripts/contacts-import-ledger.mjs'
// @ts-expect-error plain .mjs without types
import { syncContactToLedger } from '../../scripts/contacts-sync-ledger.mjs'

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
})

describe('AC25: the API never writes the ledger; the manual CLI sync does', () => {
  it('an email added through the API (create and add-value) does not reach the ledger', async () => {
    const c = await call('POST', '/api/contacts', {
      domain: 'business', display_name: 'Kovacs Bela',
      values: [{ field: 'email', value: 'first@example.hu', ...src }],
    })
    expect(c.status).toBe(201)
    const r = await call('POST', `/api/contacts/${c.body.id}/values`, { domain: 'business', field: 'email', value: 'Bela@Example.hu', source: 'owner', source_date: '2026-10-22' })
    expect(r.status).toBe(201)
    expect(c.body.ledger).toBeUndefined()
    expect(r.body.ledger).toBeUndefined()
    expect(existsSync(ledger)).toBe(false)
    const stored = getDb().prepare("SELECT value FROM contact_values WHERE field='email' ORDER BY id").all()
    expect(stored).toHaveLength(2)
  })

  it('an existing ledger is left byte-identical by API email writes', async () => {
    const orig = JSON.stringify({ version: 1, recipients: {} })
    writeFileSync(ledger, orig)
    const c = await call('POST', '/api/contacts', { domain: 'business', display_name: 'A' })
    await call('POST', `/api/contacts/${c.body.id}/values`, { domain: 'business', field: 'email', value: 'a@example.hu', ...src })
    expect(readFileSync(ledger, 'utf8')).toBe(orig)
  })

  it('syncContactToLedger adds active emails with source and note contact:<id>, keeps existing entries', () => {
    writeFileSync(ledger, JSON.stringify({ version: 1, recipients: { 'old@example.hu': { source: 'owner', note: 'orig', added_at: '2026-01-01T00:00:00.000Z' } } }))
    const r = syncContactToLedger({ id: 7, values: [
      { field: 'email', value: 'Bela@Example.hu', source: 'mail:abc123', status: 'active' },
      { field: 'email', value: 'old@example.hu', source: 'mail:zzz', status: 'active' },
      { field: 'email', value: 'gone@example.hu', source: 'owner', status: 'retracted' },
      { field: 'phone', value: '+3612345', source: 'owner', status: 'active' },
    ] }, ledger)
    expect(r).toEqual({ added: 1, exists: 1, skipped: 0, failed: 0 })
    const file = JSON.parse(readFileSync(ledger, 'utf8'))
    expect(file.version).toBe(1)
    expect(Object.keys(file)).toEqual(['version', 'recipients'])
    expect(file.recipients['bela@example.hu']).toMatchObject({ source: 'mail:abc123', note: 'contact:7' })
    expect(file.recipients['old@example.hu'].note).toBe('orig')
    expect(file.recipients['gone@example.hu']).toBeUndefined()
  })

  it('a broken ledger is reported as failed and left untouched', () => {
    writeFileSync(ledger, '{ not json')
    const r = syncContactToLedger({ id: 1, values: [{ field: 'email', value: 'x@example.hu', source: 'owner', status: 'active' }] }, ledger)
    expect(r.failed).toBe(1)
    expect(readFileSync(ledger, 'utf8')).toBe('{ not json')
  })

  it('CLI sync-ledger reads the contact over the API and writes the (temp) ledger', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 9, domain: 'business', display_name: 'Z', values: [{ field: 'email', value: 'cli@example.hu', source: 'crm:42', status: 'active' }] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    expect([0, 18800, 18899]).not.toContain(port)
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'tok-test\n')
    try {
      const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn(process.execPath, [join(__dirname, '..', '..', 'scripts', 'contacts.mjs'), 'sync-ledger', '--domain', 'business', '--id', '9', '--ledger', ledger], {
          env: { PATH: process.env.PATH, MARVEEN_BASE_URL: `http://127.0.0.1:${port}`, CONTACTS_TOKEN_FILE: tokenFile },
        })
        let o = ''
        p.stdout.on('data', (c) => { o += c })
        p.on('close', (code) => resolve({ code, out: o }))
      })
      expect(out.code).toBe(0)
      expect(JSON.parse(out.out)).toEqual({ ledger: { added: 1, exists: 0, skipped: 0, failed: 0 } })
      expect(JSON.parse(readFileSync(ledger, 'utf8')).recipients['cli@example.hu']).toMatchObject({ source: 'crm:42', note: 'contact:9' })
    } finally {
      await new Promise((r) => server.close(r))
    }
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
