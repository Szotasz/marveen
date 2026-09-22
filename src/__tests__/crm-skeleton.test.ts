// CRM 1. utem skeleton (CRM1SKEL922): the service starts on a port, creates
// its own schema, reads the fleet store READ-ONLY (a write must fail: that is
// the negative control), /health is public, /api/* is gated by the dashboard
// token, the static UI serves exactly its allowlisted files, and the lead
// endpoint is absent by design (CRM1LEADKAPU922).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { CRM_TABLES, CRM_SCHEMA_DDL, initCrmDatabase, openClaudeclawReadOnly, listTables } from '../crm/db.js'
import { createCrmServer, LEADS_ENDPOINT_CARD } from '../crm/server.js'
import { resolveCrmPort, CRM_DEFAULT_PORT } from '../crm/index.js'

const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..')
const TOKEN = 'crm-test-token-not-a-real-one'

let tmp: string
let crmDb: Database.Database
let readDb: Database.Database
let port = 0
let server: ReturnType<typeof createCrmServer>

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'crm-skel-'))
  crmDb = initCrmDatabase(join(tmp, 'crm.db'))
  // A stand-in for store/claudeclaw.db with the one table the status probe reads.
  const w = new Database(join(tmp, 'claudeclaw.db'))
  w.exec(`CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, archived_at INTEGER); INSERT INTO kanban_cards VALUES ('A', NULL), ('B', NULL), ('C', 1)`)
  w.close()
  readDb = openClaudeclawReadOnly(join(tmp, 'claudeclaw.db'))
  server = createCrmServer({ token: TOKEN, webDir: join(REPO, 'web-crm'), crmDb, readDb })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  crmDb.close(); readDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

const url = (p: string) => `http://127.0.0.1:${port}${p}`

describe('schema', () => {
  it('creates exactly the section-2 tables, idempotently', () => {
    expect(listTables(crmDb)).toEqual([...CRM_TABLES].sort())
    for (const ddl of CRM_SCHEMA_DDL) crmDb.exec(ddl) // second run: IF NOT EXISTS, no throw
    expect(listTables(crmDb)).toEqual([...CRM_TABLES].sort())
    expect(crmDb.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('the DDL is the section-2 DDL verbatim apart from IF NOT EXISTS', () => {
    const doc = readFileSync(join(REPO, 'docs', 'crm', 'CRM-1-UTEM-FELBONTAS.md'), 'utf-8')
    const fromDoc = doc.slice(doc.indexOf('```sql') + 6, doc.indexOf('```', doc.indexOf('```sql') + 6))
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim()
    const fromCode = CRM_SCHEMA_DDL.map((s) => s.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE') + ';').join(' ').replace(/\s+/g, ' ').trim()
    expect(fromCode).toBe(fromDoc)
  })

  it('the CHECK constraints are live (second witness, not the first)', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => crmDb.prepare(`INSERT INTO leads (title, origin, owner, next_step_type, next_step_at, next_step_text, created_at, created_by, updated_at) VALUES ('x','carrier-pigeon','dani','call',?, 'hivas', ?, 'dani', ?)`).run(now, now, now)).toThrow(/CHECK/)
    expect(() => crmDb.prepare(`INSERT INTO leads (title, origin, owner, next_step_type, next_step_at, next_step_text, created_at, created_by, updated_at) VALUES ('x','email','dani','call',?, '   ', ?, 'dani', ?)`).run(now, now, now)).toThrow(/CHECK/)
    expect((crmDb.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n).toBe(0)
  })
})

describe('fleet store is read-only', () => {
  it('reads work (positive control)', () => {
    expect((readDb.prepare('SELECT count(*) AS n FROM kanban_cards').get() as { n: number }).n).toBe(3)
  })
  it('a write fails (negative control), and the file did not change', () => {
    expect(() => readDb.exec(`INSERT INTO kanban_cards VALUES ('Z', NULL)`)).toThrow(/readonly|read-only|SQLITE_READONLY/i)
    expect(() => readDb.exec(`CREATE TABLE smuggled (x)`)).toThrow(/readonly|read-only|SQLITE_READONLY/i)
    const check = new Database(join(tmp, 'claudeclaw.db'), { readonly: true })
    expect((check.prepare('SELECT count(*) AS n FROM kanban_cards').get() as { n: number }).n).toBe(3)
    check.close()
  })
  it('refuses to create a missing fleet store under the fleet name', () => {
    expect(() => openClaudeclawReadOnly(join(tmp, 'does-not-exist.db'))).toThrow()
  })
})

describe('http skeleton', () => {
  it('/health is public and names both stores', async () => {
    const r = await fetch(url('/health'))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, service: 'crm', crmDb: true, claudeclawReadOnly: true })
  })
  it('/api/* is gated by the dashboard token, same check as the dashboard', async () => {
    expect((await fetch(url('/api/status'))).status).toBe(401)
    expect((await fetch(url('/api/status'), { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    const ok = await fetch(url('/api/status'), { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(ok.status).toBe(200)
    const body = await ok.json() as { tables: Record<string, number>; claudeclaw: { readonly: boolean; kanbanCards: number } }
    expect(Object.keys(body.tables).sort()).toEqual([...CRM_TABLES].sort())
    expect(body.claudeclaw).toEqual({ readonly: true, kanbanCards: 2 })
  })
  // A PLACEHOLDER HELYEN ALL, ES SZANDEKOSAN CSEREL (CRM1LEADKAPU922). A vaz eredeti allitasa
  // az volt, hogy a vegpont "absent by design ... until it lands"; most leszallt, tehat ugyanaz az
  // allitas mar a HIANYT rogzitene keszkent. A csere ELO merest tesz a helyere: a kapu a HTTP-uton
  // at is er, nem csak a fuggvenyhivason. A kapu reszletes esetei a crm-lead-gate.test.ts-ben
  // allnak; itt a BEILLESZTES a merendo.
  it('the lead endpoint is live, and the gate reaches over HTTP too', async () => {
    const ma = Math.floor(Date.now() / 1000)
    const torzs = {
      actor: 'geri',
      title: 'HTTP-uton felvett lead',
      origin: 'referral',
      next_step_type: 'call',
      next_step_at: ma,
      next_step_text: 'Visszahivom ma.',
    }

    // szerzo nelkul MEGTAGADVA, es NEM keletkezik sor
    const nevtelen = await fetch(url('/api/leads'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...torzs, actor: '' }),
    })
    expect(nevtelen.status).toBe(400)
    expect((crmDb.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n).toBe(0)

    const ok = await fetch(url('/api/leads'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(torzs),
    })
    expect(ok.status).toBe(201)
    expect((crmDb.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n).toBe(1)
    // a NYOMBAN a keres torzsebol jott nev all, nem konstans
    expect((crmDb.prepare('SELECT created_by FROM leads').get() as { created_by: string }).created_by).toBe('geri')

    // egy holnapi tetel ATMEGY a kapun, de a Ma nezetbe NEM kerul bele
    const holnapi = await fetch(url('/api/leads'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...torzs, title: 'Holnapi tetel', next_step_at: ma + 86400 }),
    })
    expect(holnapi.status).toBe(201)

    // a Ma nezet ugyanezen a tokenen at olvashato
    const maNezet = await fetch(url('/api/leads/today'), { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(maNezet.status).toBe(200)
    const maBody = await maNezet.json() as { leads: Array<{ title: string }>; sleeping: { count: number } }
    expect(maBody.leads.map((l) => l.title)).toEqual(['HTTP-uton felvett lead'])
    expect(maBody.sleeping.count).toBe(0)

    // ami NEM szallt le, tovabbra is 404, es megnevezi a kartyat.
    // (Korabban a `/postpone` allt itt; az a 2. utemben LESZALLT -- CRM2SENDSTATE922 --, tehat ez
    // az allitas mostantol a HIANYT rogzitene keszkent. Egy olyan lead-utvonal all a helyen, ami
    // tovabbra sincs: a felelos-atallitas.)
    const ismeretlen = await fetch(url('/api/leads/9999/assign'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(ismeretlen.status).toBe(404)
    expect((await ismeretlen.json() as { error: string }).error).toContain(LEADS_ENDPOINT_CARD)
  })
  it('serves the four screens and states what the thread view cannot show', async () => {
    const r = await fetch(url('/'))
    expect(r.status).toBe(200)
    const html = await r.text()
    for (const s of ['data-screen="ma"', 'data-screen="leadek"', 'data-screen="felvetel"', 'data-screen="szal"']) expect(html).toContain(s)
    expect(html).toContain('A személyes Gmail-fiók küldöttjei és a Resend-en kimenő aiam-levelek most nem látszanak.')
    expect(html).not.toContain(String.fromCharCode(0x2014))
    expect((await fetch(url('/app.js'))).status).toBe(200)
    expect((await fetch(url('/style.css'))).status).toBe(200)
  })
  it('serves nothing outside the allowlist (no traversal, no repo files)', async () => {
    for (const p of ['/../package.json', '/package.json', '/index.js', '/web-crm/app.js', '/%2e%2e/package.json', '/store/crm.db']) {
      expect((await fetch(url(p))).status, p).toBe(404)
    }
  })
})

describe('actor field (decision 2026-09-22, section 4 of the breakdown)', () => {
  it('the served UI carries the "Ki vagy" field and a submit button that starts disabled', async () => {
    const html = await (await fetch(url('/'))).text()
    expect(html).toContain('data-testid="actor"')
    expect(html).toMatch(/id="lead-submit"[^>]*disabled/)
  })
  it('the served app.js sends the author IN THE BODY (actor:) and the bearer token on /api/ calls', async () => {
    const js = await (await fetch(url('/app.js'))).text()
    expect(js).toContain('actor: a')
    expect(js).toContain("'/api/leads'")
    expect(js).toContain("'/api/leads/today'")
    expect(js).toContain("'Bearer ' + sessionToken")
    // never a config/constant author: no env, no 'system'
    expect(js).not.toMatch(/actor:\s*['"]system['"]/)
    expect(js).not.toContain('CRM_ACTOR')
  })
  it('the Leadek tab carries its notice and the served app.js ships no demo lead titles (Samu review on #1473)', async () => {
    const html = await (await fetch(url('/'))).text()
    expect(html).toContain('id="leadek-notice"')
    expect(html).toContain('nem példaadat')
    const js = await (await fetch(url('/app.js'))).text()
    expect(js).not.toContain('Comline: voice-agent')
    expect(js).not.toContain('Solymár')
    expect(js).not.toMatch(/DEMO\.leads/)
  })
  it('the Szal view is live: the page carries the search box, the list and the unthreaded section; app.js calls the thread endpoints and ships no demo data at all', async () => {
    const html = await (await fetch(url('/'))).text()
    for (const id of ['szal-q', 'szal-list', 'szal-timeline', 'szal-unthreaded', 'leadek-notice']) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('élő adat (GET /api/threads)')
    expect(html).not.toContain('ez a nézet még példaadat')
    expect(html).toContain('A személyes Gmail-fiók küldöttjei és a Resend-en kimenő aiam-levelek most nem látszanak')
    expect((html.match(/class="table-wrap"/g) || []).length).toBe(2)
    const js = await (await fetch(url('/app.js'))).text()
    expect(js).toContain("'/api/threads?q='")
    expect(js).toContain("'/api/threads/' + id")
    expect(js).toContain("'/api/messages/unthreaded'")
    expect(js).not.toMatch(/\bDEMO\b/)
    expect(js).not.toContain('pelda@example.com')
    const css = await (await fetch(url('/style.css'))).text()
    expect(css).toMatch(/\.table-wrap \{[^}]*overflow-x: auto/)
  })
})

describe('port resolution', () => {
  it('defaults to 3421 and honours CRM_PORT', () => {
    expect(CRM_DEFAULT_PORT).toBe(3421)
    expect(resolveCrmPort(undefined)).toBe(3421)
    expect(resolveCrmPort('3429')).toBe(3429)
    expect(resolveCrmPort('nope')).toBe(3421)
    expect(resolveCrmPort('0')).toBe(3421)
  })
})
