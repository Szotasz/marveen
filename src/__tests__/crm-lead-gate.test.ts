/**
 * CRM1LEADKAPU922: a lead-felvétel kapuja, a hat elfogadási feltétel (spec 6.5) plusz a nyom.
 *
 * A FIXTÚRA A SÉMÁT MAGA HOZZA LÉTRE (workspace/CRM-1-UTEM-FELBONTAS.md 2. szakasz), mert a D1 váz
 * még nem létezik. Így a kapu MÉRHETŐ a váz előtt, és a beillesztés után sem a váztól függ.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLead, todayLeads } from '../crm/leads-routes.js'
import { checkLeadInput, startOfLocalDay, NEXT_STEP_TYPES } from '../crm/leads-gate.js'

const DDL = `
CREATE TABLE contacts (id INTEGER PRIMARY KEY, display_name TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, notes TEXT);
CREATE TABLE contact_emails (contact_id INTEGER NOT NULL REFERENCES contacts(id), email TEXT NOT NULL UNIQUE COLLATE NOCASE, is_primary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE contact_phones (contact_id INTEGER NOT NULL REFERENCES contacts(id), phone TEXT NOT NULL, PRIMARY KEY(contact_id, phone));
CREATE TABLE leads (
  id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), title TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('email','telegram','phone','meeting','referral','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','won','lost','parked')),
  owner TEXT NOT NULL,
  next_step_type TEXT NOT NULL CHECK(next_step_type IN ('email','call','meeting','offer')),
  next_step_at INTEGER NOT NULL,
  next_step_text TEXT NOT NULL CHECK(length(trim(next_step_text)) > 0),
  postpone_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, detail TEXT);
`

let dir: string
let db: InstanceType<typeof Database>
const MOST = new Date(2026, 8, 22, 14, 30, 0) // 2026-09-22 14:30 helyi ido

function nap(eltolas: number): string {
  const d = new Date(MOST.getFullYear(), MOST.getMonth(), MOST.getDate() + eltolas)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ALAP = {
  title: 'Péter, Marveen telepítés',
  origin: 'referral',
  next_step_type: 'call',
  next_step_text: 'Visszahívom és egyeztetünk időpontot.',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crm-lead-'))
  db = new Database(join(dir, 'crm.db'))
  db.exec(DDL)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function leadSzam(): number {
  return (db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n
}
function auditSorok(action?: string): Array<Record<string, unknown>> {
  return action
    ? (db.prepare('SELECT * FROM audit_log WHERE action=?').all(action) as Array<Record<string, unknown>>)
    : (db.prepare('SELECT * FROM audit_log').all() as Array<Record<string, unknown>>)
}

describe('CRM lead-felvétel kapuja (CRM1LEADKAPU922, spec 6.5)', () => {
  it('1. mindhárom megvan -> mentés, és a lead a Ma nézetben áll', () => {
    const r = createLead(db, { ...ALAP, next_step_at: nap(0) }, 'geri', MOST)
    expect(r.status).toBe(201)
    expect(leadSzam()).toBe(1)
    const ma = todayLeads(db, MOST).body.leads as Array<Record<string, unknown>>
    expect(ma).toHaveLength(1)
  })

  it('2. bármelyik hiányzik -> megtagadás, és a szöveg MEGNEVEZI, melyik', () => {
    const r = createLead(db, { ...ALAP, next_step_at: undefined }, 'geri', MOST)
    expect(r.status).toBe(422)
    expect(r.body.missing).toEqual(['next_step_at'])
    expect(String(r.body.message)).toContain('dátuma')
    expect(leadSzam()).toBe(0)
  })

  it('3. HARMADIK ÁLLAPOT: megadta, de üresen (csak whitespace) -> ugyanúgy megtagadás', () => {
    const r = createLead(db, { ...ALAP, next_step_text: '   \n\t ', next_step_at: nap(1) }, 'geri', MOST)
    expect(r.status).toBe(422)
    expect(r.body.missing).toEqual(['next_step_text'])
    expect(leadSzam()).toBe(0)
  })

  it('4. NEGATÍV KONTROLL: e-mail-cím NÉLKÜL felvett lead MENTŐDIK', () => {
    const r = createLead(
      db,
      { ...ALAP, origin: 'phone', display_name: 'Kovács Anna', phone: '+36301234567', next_step_at: nap(3) },
      'geri',
      MOST,
    )
    expect(r.status).toBe(201)
    const kontakt = db.prepare('SELECT display_name FROM contacts').get() as { display_name: string }
    expect(kontakt.display_name).toBe('Kovács Anna')
    expect((db.prepare('SELECT count(*) AS n FROM contact_emails').get() as { n: number }).n).toBe(0)
  })

  it('5. a dátum-határ MINDKÉT vége: ma átmegy, ma+15 megtagadva, ma+14 átmegy', () => {
    expect(createLead(db, { ...ALAP, next_step_at: nap(0) }, 'geri', MOST).status).toBe(201)
    expect(createLead(db, { ...ALAP, next_step_at: nap(14) }, 'geri', MOST).status).toBe(201)
    const tul = createLead(db, { ...ALAP, next_step_at: nap(15) }, 'geri', MOST)
    expect(tul.status).toBe(422)
    expect(tul.body.missing).toEqual(['next_step_at'])
    // a tegnapi dátum sem megy: a lejárt lépés nem FELVÉTELKOR keletkezik
    expect(createLead(db, { ...ALAP, next_step_at: nap(-1) }, 'geri', MOST).status).toBe(422)
  })

  it('6. LEAD SOSEM SZINKRONBÓL: szerző nélkül nincs felvétel', () => {
    const r = createLead(db, { ...ALAP, next_step_at: nap(2) }, '   ', MOST)
    expect(r.status).toBe(400)
    expect(String(r.body.message)).toContain('szinkronból')
    expect(leadSzam()).toBe(0)
  })

  it('a NYOM: mentésnél ÉS megtagadásnál is keletkezik audit sor, szerzővel', () => {
    createLead(db, { ...ALAP, next_step_at: nap(1) }, 'geri', MOST)
    createLead(db, { ...ALAP, next_step_at: nap(99) }, 'boni', MOST)
    const ment = auditSorok('create')
    const megtagadva = auditSorok('create_refused')
    expect(ment).toHaveLength(1)
    expect(megtagadva).toHaveLength(1)
    expect(ment[0].actor).toBe('geri')
    expect(megtagadva[0].actor).toBe('boni')
    // a megtagadás nyoma MEGNEVEZI, mi hiányzott -- enélkül nem mérhető, hogy a SZÖVEG rossz-e
    expect(String(megtagadva[0].detail)).toContain('next_step_at')
  })

  it('a Ma nézet: LEJÁRT elöl, aztán a mai, dátum szerint', () => {
    // lejárt tételt csak közvetlenül lehet létrehozni: a kapu felvételkor nem enged múltbeli dátumot
    const tegnap = startOfLocalDay(MOST) - 86400
    db.prepare(
      `INSERT INTO leads (contact_id,title,origin,status,owner,next_step_type,next_step_at,next_step_text,created_at,created_by,updated_at)
       VALUES (NULL,'Lejárt tétel','other','open','geri','call',?,'Rég esedékes',?,?,?)`,
    ).run(tegnap, tegnap, 'geri', tegnap)
    createLead(db, { ...ALAP, title: 'Mai tétel', next_step_at: nap(0) }, 'geri', MOST)
    const sorok = todayLeads(db, MOST).body.leads as Array<Record<string, unknown>>
    expect(sorok.map((s) => s.title)).toEqual(['Lejárt tétel', 'Mai tétel'])
    expect(sorok[0].lejart).toBe(1)
  })

  it('a típus-lista EGY helyen áll, és a séma CHECK-je ugyanezt engedi', () => {
    // Ha a lista és a séma szétcsúszik, a kapu átengedne olyat, amit a tábla elutasít -- és a
    // felhasználó egy CHECK-hibát kapna a magyarázat helyett.
    for (const t of NEXT_STEP_TYPES) {
      const r = createLead(db, { ...ALAP, next_step_type: t, next_step_at: nap(1) }, 'geri', MOST)
      expect(r.status, `tipus: ${t}`).toBe(201)
    }
    const ismeretlen = checkLeadInput({ ...ALAP, next_step_type: 'wakeup', next_step_at: nap(1) }, MOST)
    expect(ismeretlen.ok).toBe(false)
  })
})
