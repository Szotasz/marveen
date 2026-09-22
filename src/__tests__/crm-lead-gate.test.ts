/**
 * CRM1LEADKAPU922: a lead-felvétel kapuja, a hat elfogadási feltétel (spec 6.5) plusz a nyom.
 *
 * A FIXTÚRA A VÁZ SAJÁT SÉMÁJÁT HASZNÁLJA (`initCrmDatabase`, CRM1SKEL922, mergelve 84aea701).
 * Korábban kézzel másolt DDL állt itt, mert a váz még nem létezett; a másolat azóta drift-kockázat
 * lett volna: ha a séma elmozdul, a kapu tesztje a RÉGI táblán maradna zöld.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLead, todayLeads } from '../crm/leads-routes.js'
import { checkLeadInput, startOfLocalDay, NEXT_STEP_TYPES, ACTOR_MAX_LENGTH } from '../crm/leads-gate.js'
import { initCrmDatabase } from '../crm/db.js'


let dir: string
let db: Database.Database
/**
 * A PROBA IDOPONTJA ABSZOLUT PILLANAT, nem a futtato zonajaban ertett ora.
 *
 * MERVE 2026-09-22-en: korabban `new Date(2026, 8, 22, 14, 30)` allt itt, es a varakozasokat is
 * futtato-lokalis `Date`-ekbol epitettem. `TZ=Pacific/Kiritimati` (UTC+14) alatt EGY allitas
 * elbukott, pontosan 86400 masodperc elteressel -- es a hiba a MUSZERBEN volt, nem a kapuban:
 * a varakozas futtato-lokalis pillanaton at szamolt budapesti napot. Ez pont az a fuggoseg,
 * amiert a nap hatara nevesitett zonaban dol el, tehat a fixtura sem fugghet tole.
 * 2026-09-22 14:30 Budapesten = 12:30 UTC.
 */
const MOST = new Date(Date.UTC(2026, 8, 22, 12, 30, 0))

/** A proba napjatol szamitott n-edik naptari nap, `YYYY-MM-DD` alakban (bevitelnek). */
function nap(eltolas: number): string {
  return new Date(Date.UTC(2026, 8, 22 + eltolas)).toISOString().slice(0, 10)
}

/**
 * Ugyanannak a napnak egy PILLANATA, delben UTC-ben. Varakozas epitesere valo: dellel a naptari
 * nap minden futtato-zonaban ugyanaz, tehat a `startOfLocalDay` ugyanazt a budapesti nap-kezdetet
 * adja vissza rea, futtato-fuggetlenul.
 */
function napDelben(eltolas: number): Date {
  return new Date(Date.UTC(2026, 8, 22 + eltolas, 12, 0, 0))
}

const ALAP = {
  title: 'Péter, Marveen telepítés',
  origin: 'referral',
  next_step_type: 'call',
  next_step_text: 'Visszahívom és egyeztetünk időpontot.',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crm-lead-'))
  db = initCrmDatabase(join(dir, 'crm.db'))
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

  it('7. a szerző neve legfeljebb 64 karakter: a 64 MENTŐDIK', () => {
    // A FELSO HATAR SAMU STRUKTURALIS DONTESE (spec 4. szakasz): trim utan 1..64 karakter.
    // A HATARON LEVO ERTEK A POZITIV KONTROLL: e nelkul egy "63 karakternel vagj" hiba is zold
    // maradna, mert a tul hosszu eset ugyanugy megtagadas lenne.
    const nev = 'Á'.repeat(ACTOR_MAX_LENGTH)
    expect(Array.from(nev)).toHaveLength(64)
    const r = createLead(db, { ...ALAP, next_step_at: nap(1) }, nev, MOST)
    expect(r.status).toBe(201)
    // a nyomba a TELJES nev kerul, csonkitas nelkul
    expect((auditSorok('create')[0] as { actor: string }).actor).toBe(nev)
    expect((db.prepare('SELECT created_by FROM leads').get() as { created_by: string }).created_by).toBe(nev)
  })

  it('7b. 65 karakter -> MEGTAGADÁS, és a szöveg megmondja, mi a határ', () => {
    const r = createLead(db, { ...ALAP, next_step_at: nap(1) }, 'x'.repeat(ACTOR_MAX_LENGTH + 1), MOST)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('tul hosszu szerzo')
    expect(String(r.body.message)).toContain('64')
    expect(leadSzam()).toBe(0)
  })

  it('7c. a hossz KARAKTERBEN dől el, nem bájtban: 64 ékezetes név átmegy', () => {
    // Ez nem elmeleti: az "Á" UTF-8-ban ket bajt, tehat egy bajt-alapu hatar 32 karakternel
    // vagna el egy magyar nevet -- es a hiba pont a mi feluletunkon jelenne meg eloszor.
    const nev = 'Ő'.repeat(ACTOR_MAX_LENGTH)
    expect(Buffer.byteLength(nev, 'utf8')).toBeGreaterThan(ACTOR_MAX_LENGTH)
    expect(createLead(db, { ...ALAP, next_step_at: nap(1) }, nev, MOST).status).toBe(201)
  })

  it('a szerző a HÍVÁS paramétere, nem a törzs egy mezője (a szerződés kimondva)', () => {
    // Dani döntése (28285): a kérés TÖRZSE hordozza az actor mezőt, és a szerver azt adja át
    // ennek a függvénynek. A kettő nem keverhető össze: ha a kezelő CSENDBEN visszaesne a törzs
    // actor mezőjére, akkor egy later hívó elfelejthetné átadni, és a nyom névtelenül keletkezne,
    // miközben minden zöld. Ezért a törzsbeli actor ÖNMAGÁBAN nem elég.
    const r = createLead(db, { ...ALAP, actor: 'geri', next_step_at: nap(1) } as never, '', MOST)
    expect(r.status).toBe(400)
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
    const ismeretlen = checkLeadInput({ ...ALAP, next_step_type: 'nincs-ilyen', next_step_at: nap(1) }, MOST)
    expect(ismeretlen.ok).toBe(false)
  })
})

describe('a nap határa NEVESÍTETT zónában (Samu kikötése, 28263)', () => {
  // MIÉRT KELL: ha a nap határát a futtató környezet zónája döntené el, a CI (UTC) és a gazda gépe
  // (CEST) este 22 után MÁS napot látna -- ugyanaz a bevitel az egyik helyen átmegy, a másikon nem,
  // és a különbség semmiből nem látszik. Ezek az állítások ezért NEM a futtató zónájától függenek.
  it('22:30 UTC szeptemberben már a KÖVETKEZŐ budapesti nap (CEST = UTC+2)', () => {
    const este = new Date(Date.UTC(2026, 8, 22, 22, 30, 0)) // 2026-09-23 00:30 Budapesten
    const napKezdet = startOfLocalDay(este)
    // a budapesti 09-23 nap kezdete = 2026-09-22 22:00 UTC
    expect(napKezdet).toBe(Math.floor(Date.UTC(2026, 8, 22, 22, 0, 0) / 1000))
  })

  it('ugyanaz a pillanat UTC-ben MÁS napot adna: ezt a kapu NEM követi', () => {
    const este = new Date(Date.UTC(2026, 8, 22, 22, 30, 0))
    const utcNapKezdet = Math.floor(Date.UTC(2026, 8, 22, 0, 0, 0) / 1000)
    expect(startOfLocalDay(este)).not.toBe(utcNapKezdet)
  })

  it('a dátum-sztring is a nevesített zónában értendő, nem a futtatóéban', () => {
    // 2026-09-23 Budapesten = 2026-09-22 22:00 UTC
    const r = checkLeadInput(
      { ...ALAP, next_step_at: '2026-09-23' },
      new Date(Date.UTC(2026, 8, 22, 22, 30, 0)),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.next_step_at).toBe(Math.floor(Date.UTC(2026, 8, 22, 22, 0, 0) / 1000))
  })

  it('téli időszámításban az eltolás 1 óra, és a határ ezt követi (nem fix offset)', () => {
    const telen = new Date(Date.UTC(2026, 11, 15, 23, 30, 0)) // 2026-12-16 00:30 Budapesten (CET)
    expect(startOfLocalDay(telen)).toBe(Math.floor(Date.UTC(2026, 11, 15, 23, 0, 0) / 1000))
  })
})

describe('ébresztés-típus: az "ügyfél későbbre kérte" eset (döntés 2026-09-22)', () => {
  it('a wakeup típus 12 hónapon belüli dátumot ENGED, a többi típus nem', () => {
    const ebresztes = createLead(db, { ...ALAP, next_step_type: 'wakeup', next_step_at: nap(60) }, 'geri', MOST)
    expect(ebresztes.status).toBe(201)
    const hivas = createLead(db, { ...ALAP, next_step_type: 'call', next_step_at: nap(60) }, 'geri', MOST)
    expect(hivas.status).toBe(422)
    expect(hivas.body.missing).toEqual(['next_step_at'])
  })

  it('a wakeup horizontjának is van felső határa: ma+366 megtagadva', () => {
    expect(createLead(db, { ...ALAP, next_step_type: 'wakeup', next_step_at: nap(365) }, 'geri', MOST).status).toBe(201)
    expect(createLead(db, { ...ALAP, next_step_type: 'wakeup', next_step_at: nap(366) }, 'geri', MOST).status).toBe(422)
  })

  // SAMU KERTE EZT A KET PONTOS ESETET a review-receptjebe (28257). A 365/366-os hataresetem a
  // felso elt meri, ezek pedig a VARHATO hasznalatot: fel ev igen, tizenharom honap nem.
  it('Samu esete: wakeup + 6 hónap -> mentés', () => {
    expect(createLead(db, { ...ALAP, next_step_type: 'wakeup', next_step_at: nap(182) }, 'geri', MOST).status).toBe(201)
  })

  it('Samu esete: wakeup + 13 hónap -> megtagadás (a felső határ itt is zárt)', () => {
    const r = createLead(db, { ...ALAP, next_step_type: 'wakeup', next_step_at: nap(395) }, 'geri', MOST)
    expect(r.status).toBe(422)
    expect(r.body.missing).toEqual(['next_step_at'])
  })

  it('az alvó tétel NEM jelenik meg a Ma nézet listájában', () => {
    createLead(db, { ...ALAP, title: 'Novemberi', next_step_type: 'wakeup', next_step_at: nap(60) }, 'geri', MOST)
    createLead(db, { ...ALAP, title: 'Mai', next_step_at: nap(0) }, 'geri', MOST)
    const sorok = todayLeads(db, MOST).body.leads as Array<Record<string, unknown>>
    expect(sorok.map((s) => s.title)).toEqual(['Mai'])
  })

  it('DE a SZÁMA ott van a fő nézeten, a legközelebbi ébredéssel (Marveen kikötése)', () => {
    createLead(db, { ...ALAP, title: 'Novemberi', next_step_type: 'wakeup', next_step_at: nap(60) }, 'geri', MOST)
    createLead(db, { ...ALAP, title: 'Marciusi', next_step_type: 'wakeup', next_step_at: nap(180) }, 'geri', MOST)
    const alvo = todayLeads(db, MOST).body.sleeping as { count: number; next_wake_at: number }
    expect(alvo.count).toBe(2)
    // a legkozelebbi ebredes a 60 napos tetel, nem a 180 napos
    const varhato = startOfLocalDay(napDelben(60))
    expect(alvo.next_wake_at).toBe(varhato)
  })

  it('az alvó összegzés NEM számolja bele a közeli, nem-ébresztés tételeket', () => {
    createLead(db, { ...ALAP, next_step_at: nap(3) }, 'geri', MOST)
    const alvo = todayLeads(db, MOST).body.sleeping as { count: number; next_wake_at: number | null }
    expect(alvo.count).toBe(0)
    expect(alvo.next_wake_at).toBeNull()
  })
})
