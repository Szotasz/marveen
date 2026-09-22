/**
 * CRM2SENDSTATE922 (PR-B): a maradék három kényszer.
 *
 * (2) a lejárt következő lépés AKADÁLY a FELELŐS következő írásán,
 * (3) kétszeri halasztás után gazdát vált vagy döntésre megy,
 * (4) a napi összefoglaló 1-3 ma eldönthető tételt mond, nem darabszámot.
 *
 * A fixtúra a váz saját sémáját építi, a próba pillanata ABSZOLÚT (nem a futtató zónájában értett
 * óra), és a nap-várakozások UTC-délből épülnek: egy korábbi körben pont ez a függőség adott
 * 86400 másodperces hamis bukást UTC+14-ben.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initCrmDatabase } from '../crm/db.js'
import { startOfLocalDay } from '../crm/leads-gate.js'
import { createLead } from '../crm/leads-routes.js'
import {
  dailySummary, expiredBlockers, postponeLead, resolveExpired,
  HARD_POSTPONE_LIMIT, SUMMARY_MAX_ITEMS, POSTPONE_REASONS,
} from '../crm/lead-flow.js'
import { createCrmServer } from '../crm/server.js'
import { fileURLToPath } from 'node:url'

let dir: string
let db: Database.Database
const MOST = new Date(Date.UTC(2026, 8, 22, 12, 30, 0)) // 2026-09-22 14:30 Budapesten
const nap = (n: number) => new Date(Date.UTC(2026, 8, 22 + n, 12, 0, 0))
const napSec = (n: number) => startOfLocalDay(nap(n))

const ALAP = { title: 'Péter, Marveen telepítés', origin: 'referral', next_step_type: 'call', next_step_text: 'Visszahívom.' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crm-flow-'))
  db = initCrmDatabase(join(dir, 'crm.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Lejárt tétel csak közvetlenül hozható létre: a felvételi kapu nem enged múltbeli dátumot. */
function lejartLead(owner: string, cim = 'Régi tétel', napokkalEzelott = 5, tipus = 'call'): number {
  const mikor = napSec(-napokkalEzelott)
  const r = db
    .prepare(
      `INSERT INTO leads (contact_id,title,origin,status,owner,next_step_type,next_step_at,next_step_text,created_at,created_by,updated_at)
       VALUES (NULL,?,'other','open',?,?,?,'Rég esedékes',?,?,?)`,
    )
    .run(cim, owner, tipus, mikor, mikor, owner, mikor)
  return Number(r.lastInsertRowid)
}
function nyitottLead(owner: string, cim: string, napEltolas: number, tipus = 'call'): number {
  const r = createLead(db, { ...ALAP, title: cim, next_step_type: tipus, next_step_at: napSec(napEltolas) }, owner, MOST)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return Number(r.body.id)
}
function feladatok(kind?: string): Array<Record<string, unknown>> {
  return (kind
    ? db.prepare('SELECT * FROM tasks WHERE kind = ?').all(kind)
    : db.prepare('SELECT * FROM tasks').all()) as Array<Record<string, unknown>>
}

describe('(2) a lejárt lépés AKADÁLY a FELELŐS írásán', () => {
  it('lejárt tétel mellett a felelős NEM vehet fel új leadet', () => {
    lejartLead('geri')
    const r = createLead(db, { ...ALAP, next_step_at: napSec(1) }, 'geri', MOST)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('lejart lepes akadalyoz')
    expect((r.body.blockers as unknown[]).length).toBe(1)
    expect(String(r.body.message)).toContain('EGY mondatot')
  })

  it('AZ AKADÁLY A FELELŐSÉ, NEM MINDENKIÉ: más felelős ugyanakkor felvehet', () => {
    // Ez a kényszer legfontosabb tulajdonsága: a gazda nézetén álló akadály a gazdát büntetné
    // azért, amit MÁS nem csinált meg, és ő nem is tudja feloldani.
    lejartLead('geri')
    expect(createLead(db, { ...ALAP, next_step_at: napSec(1) }, 'boni', MOST).status).toBe(201)
  })

  it('az akadály a LEJÁRTSÁGON áll, nem a lead létezésén: mai tétel nem blokkol', () => {
    nyitottLead('geri', 'Mai tétel', 0)
    expect(createLead(db, { ...ALAP, next_step_at: napSec(2) }, 'geri', MOST).status).toBe(201)
  })

  it('a lezárt tétel nem blokkol: az akadály csak NYITOTT leadre áll', () => {
    const id = lejartLead('geri')
    db.prepare("UPDATE leads SET status='lost' WHERE id=?").run(id)
    expect(expiredBlockers(db, 'geri', MOST)).toHaveLength(0)
    expect(createLead(db, { ...ALAP, next_step_at: napSec(1) }, 'geri', MOST).status).toBe(201)
  })

  it('a feloldás EGY MONDAT: üresen megtagadva (a harmadik állapot itt is)', () => {
    const id = lejartLead('geri')
    expect(resolveExpired(db, id, 'geri', { sentence: '   ', outcome: 'lost' }, MOST).status).toBe(422)
    expect(resolveExpired(db, id, 'geri', { sentence: 'Marad, de később.', outcome: '' }, MOST).body.error).toBe('nincs kimenet')
  })

  it('feloldás új dátummal -> az akadály megszűnik, és jöhet az új lead', () => {
    const id = lejartLead('geri')
    const r = resolveExpired(db, id, 'geri', { sentence: 'Jövő héten hívom, addig vár.', outcome: 'reschedule', next_step_at: napSec(3) }, MOST)
    expect(r.status).toBe(200)
    expect(expiredBlockers(db, 'geri', MOST)).toHaveLength(0)
    expect(createLead(db, { ...ALAP, next_step_at: napSec(1) }, 'geri', MOST).status).toBe(201)
  })

  it('feloldás ÚJABB MÚLTBELI dátummal NEM megy: azzal semmi nem oldódna meg', () => {
    const id = lejartLead('geri')
    const r = resolveExpired(db, id, 'geri', { sentence: 'Majd.', outcome: 'reschedule', next_step_at: napSec(-1) }, MOST)
    expect(r.status).toBe(422)
    expect(expiredBlockers(db, 'geri', MOST)).toHaveLength(1)
  })

  it('feloldás ÁTADÁSSAL: a tétel a másiknál áll, és MOSTANTÓL ŐT blokkolja', () => {
    const id = lejartLead('geri')
    const r = resolveExpired(db, id, 'geri', { sentence: 'Boni jobban ismeri, átadom.', outcome: 'handover', new_owner: 'boni' }, MOST)
    expect(r.status).toBe(200)
    expect(expiredBlockers(db, 'geri', MOST)).toHaveLength(0)
    expect(expiredBlockers(db, 'boni', MOST)).toHaveLength(1)
  })

  it('átadás NÉV NÉLKÜL nem megy: az "átadom valakinek" nem átadás', () => {
    const id = lejartLead('geri')
    expect(resolveExpired(db, id, 'geri', { sentence: 'Átadom.', outcome: 'handover', new_owner: '  ' }, MOST).status).toBe(422)
  })

  it('feloldás LEZÁRÁSSAL: elveszett, indokkal, és a mondat a tételen marad', () => {
    const id = lejartLead('geri')
    expect(resolveExpired(db, id, 'geri', { sentence: 'Másnál vették meg, lezárom.', outcome: 'lost' }, MOST).status).toBe(200)
    const sor = db.prepare('SELECT status, next_step_text FROM leads WHERE id=?').get(id) as { status: string; next_step_text: string }
    expect(sor.status).toBe('lost')
    expect(sor.next_step_text).toBe('Másnál vették meg, lezárom.')
  })

  it('a megtagadás NYOMOT hagy: a blokkolt felvétel is mérhető', () => {
    lejartLead('geri')
    createLead(db, { ...ALAP, next_step_at: napSec(1) }, 'geri', MOST)
    const n = db.prepare("SELECT * FROM audit_log WHERE action='create_blocked'").all()
    expect(n).toHaveLength(1)
  })
})

describe('(3) kétszeri halasztás: az INDOK számít, nem a mondat', () => {
  it('a halasztáshoz KATEGÓRIA kell, nem csak szöveg', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    const r = postponeLead(db, id, 'geri', { text: 'Még nem ért rá.', next_step_at: napSec(3) }, MOST)
    expect(r.status).toBe(422)
    expect(r.body.allowed).toEqual(POSTPONE_REASONS)
  })

  it('a kategória mellé MONDAT is kell (harmadik állapot: megadta, de üresen)', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    expect(postponeLead(db, id, 'geri', { reason: 'kapacitas', text: '  ', next_step_at: napSec(3) }, MOST).status).toBe(422)
  })

  it('KÉT KÜLÖNBÖZŐ indok = munka: mindkettő átmegy, a számláló nő', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    expect(postponeLead(db, id, 'geri', { reason: 'ugyfelre_varunk', text: 'Visszajelzést vár.', next_step_at: napSec(3) }, MOST).status).toBe(200)
    const m = postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Nincs emberem rá.', next_step_at: napSec(5) }, MOST)
    expect(m.status).toBe(200)
    expect(m.body.postpone_count).toBe(2)
  })

  it('KÉTSZER UGYANAZ az indok = elakadás: döntésre megy, és a szöveg VISSZAIDÉZI az előzőt', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'ugyfelre_varunk', text: 'Kérte, hogy jövő héten keressem.', next_step_at: napSec(3) }, MOST)
    const r = postponeLead(db, id, 'geri', { reason: 'ugyfelre_varunk', text: 'Megint nem ért rá.', next_step_at: napSec(6) }, MOST)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('dontes kell')
    // SZÓ SZERINT: enélkül a felhasználó nem látja, hogy ismétel.
    expect(String(r.body.message)).toContain('Kérte, hogy jövő héten keressem.')
    expect(r.body.options).toEqual(['handover', 'owner_decision', 'lost'])
  })

  it('a döntés-kérés FELADATOT ír, nem csak üzenetet', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Nincs időm.', next_step_at: napSec(3) }, MOST)
    postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Még mindig nincs.', next_step_at: napSec(6) }, MOST)
    const t = feladatok('decision')
    expect(t).toHaveLength(1)
    expect(String(t[0].text)).toContain('Nincs időm.')
    expect(t[0].owner).toBe('geri')
  })

  it('a megtagadás után a lead NEM halasztódott el: a dátum a régi marad', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Nincs időm.', next_step_at: napSec(3) }, MOST)
    const elotte = (db.prepare('SELECT next_step_at FROM leads WHERE id=?').get(id) as { next_step_at: number }).next_step_at
    postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Még mindig.', next_step_at: napSec(9) }, MOST)
    expect((db.prepare('SELECT next_step_at FROM leads WHERE id=?').get(id) as { next_step_at: number }).next_step_at).toBe(elotte)
  })

  it('KEMÉNY HATÁR: a harmadik halasztás döntésre megy, AKKOR IS, ha mindhárom más kategória', () => {
    // A kategóriák váltogatással kijátszhatók, a darabszám nem.
    const id = nyitottLead('geri', 'Ajánlat', 1)
    expect(postponeLead(db, id, 'geri', { reason: 'ugyfelre_varunk', text: 'Egy.', next_step_at: napSec(3) }, MOST).status).toBe(200)
    expect(postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Kettő.', next_step_at: napSec(5) }, MOST).status).toBe(200)
    const harmadik = postponeLead(db, id, 'geri', { reason: 'ar_vagy_hatokor', text: 'Három.', next_step_at: napSec(7) }, MOST)
    expect(harmadik.status).toBe(409)
    expect(harmadik.body.trigger).toBe('hard_limit')
    expect(String(harmadik.body.message)).toContain(`${HARD_POSTPONE_LIMIT}. halasztás`)
  })

  it('az "egyéb" MÁSODSZOR: nyilatkozni kell, és a rendszer SZÓ SZERINT mutatja az előzőt', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Szabadságon van a döntéshozó.', next_step_at: napSec(3) }, MOST)
    const r = postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Most más miatt csúszik.', next_step_at: napSec(6) }, MOST)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('ugyanaz vagy mas')
    expect(r.body.previous_text).toBe('Szabadságon van a döntéshozó.')
  })

  it('"ugyanaz" nyilatkozat -> döntésre megy', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Szabadságon van.', next_step_at: napSec(3) }, MOST)
    const r = postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Még mindig.', same_as_previous: true, next_step_at: napSec(6) }, MOST)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('dontes kell')
  })

  it('"más" nyilatkozat MI VÁLTOZOTT nélkül nem megy: ez lenne a legolcsóbb kibúvó', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Szabadságon van.', next_step_at: napSec(3) }, MOST)
    const r = postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Más ok.', same_as_previous: false, next_step_at: napSec(6) }, MOST)
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('mi valtozott')
    expect(r.body.previous_text).toBe('Szabadságon van.')
  })

  it('"más" + MI VÁLTOZOTT -> átmegy, és a nyomban ott marad, mi változott', () => {
    const id = nyitottLead('geri', 'Ajánlat', 1)
    postponeLead(db, id, 'geri', { reason: 'egyeb', text: 'Szabadságon van.', next_step_at: napSec(3) }, MOST)
    const r = postponeLead(db, id, 'geri', {
      reason: 'egyeb', text: 'Jogi átnézés kell.', same_as_previous: false,
      what_changed: 'Visszajött a szabadságról, de jogi átnézésre küldte.', next_step_at: napSec(6),
    }, MOST)
    expect(r.status).toBe(200)
    const nyom = db.prepare("SELECT detail FROM audit_log WHERE action='postpone' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(nyom.detail).what_changed).toContain('jogi átnézésre')
  })

  it('AZ ÉBRESZTÉS NEM HALASZTÁS: a wakeup tétel dátum-mozgatása nem növeli a számlálót', () => {
    // Ha nőne, pont az EGÉSZSÉGES tételen indulna el a halasztás-hurok, és a felhasználó
    // visszatanulná a hamis közeli dátumot -- vagyis a wakeup típus értelmét veszítené.
    const id = nyitottLead('geri', 'Novemberi ébresztés', 60, 'wakeup')
    const r = postponeLead(db, id, 'geri', { reason: 'ugyfelre_varunk', text: 'Decemberre kérte.', next_step_at: napSec(90) }, MOST)
    expect(r.status).toBe(200)
    expect(r.body.counted).toBe(false)
    expect(r.body.postpone_count).toBe(0)
    expect(String(r.body.message)).toContain('NEM halasztás')
  })

  it('NEGATÍV KONTROLL: ugyanez a mozdulat NEM-ébresztés típuson SZÁMÍT', () => {
    const id = nyitottLead('geri', 'Hívás', 3)
    const r = postponeLead(db, id, 'geri', { reason: 'ugyfelre_varunk', text: 'Csúszik.', next_step_at: napSec(9) }, MOST)
    expect(r.body.counted).toBe(true)
    expect(r.body.postpone_count).toBe(1)
  })

  it('MÁSIK lejárt tétel a halasztást is blokkolja, de a SAJÁT lejárt tételét halaszthatja', () => {
    const sajat = lejartLead('geri', 'Saját lejárt')
    const r = postponeLead(db, sajat, 'geri', { reason: 'kapacitas', text: 'Most veszem elő.', next_step_at: napSec(2) }, MOST)
    expect(r.status).toBe(200)
    const masik = lejartLead('geri', 'Másik lejárt')
    const b = postponeLead(db, sajat, 'geri', { reason: 'ugyfelre_varunk', text: 'Megint.', next_step_at: napSec(4) }, MOST)
    expect(b.status).toBe(409)
    expect(b.body.error).toBe('lejart lepes akadalyoz')
    expect((b.body.blockers as Array<{ id: number }>)[0].id).toBe(masik)
  })
})

describe('(4) a napi összefoglaló NE darabszámot mondjon', () => {
  it('ha nincs eldönthető tétel, KIMONDJA, és rövid marad', () => {
    nyitottLead('geri', 'Nyitott, de nem sürgős', 5)
    nyitottLead('boni', 'Másik nyitott', 6)
    const o = dailySummary(db, MOST)
    expect(o.items).toHaveLength(0)
    expect(o.nothing_to_decide).toBe(true)
    expect(o.message).toContain('Ma nincs eldönthető tétel')
    // ÉS NINCS DARABSZÁM: amit nem adunk vissza, azt a felület nem tudja kiírni.
    expect(JSON.stringify(o)).not.toMatch(/2 nyitott|open_count|nyitott lead/)
  })

  it('minden tételhez EGY MONDATBAN feltehető kérdés tartozik, KÉT kimenettel', () => {
    lejartLead('geri', 'Elakadt ajánlat')
    const o = dailySummary(db, MOST)
    expect(o.items).toHaveLength(1)
    expect(o.items[0].question).toContain('Elakadt ajánlat')
    expect(o.items[0].outcomes).toHaveLength(2)
  })

  it('LEGFELJEBB HÁROM tétel, akkor is, ha több volna', () => {
    for (let i = 0; i < 6; i += 1) lejartLead('geri', `Elakadt ${i}`, 10 - i)
    const o = dailySummary(db, MOST)
    expect(o.items).toHaveLength(SUMMARY_MAX_ITEMS)
    expect(o.items.length).toBeLessThanOrEqual(3)
  })

  it('a DÖNTÉSRE váró tétel előrébb van, mint a lejárt', () => {
    lejartLead('boni', 'Lejárt tétel')
    const id = nyitottLead('geri', 'Döntésre váró', 1)
    postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Egy.', next_step_at: napSec(3) }, MOST)
    postponeLead(db, id, 'geri', { reason: 'kapacitas', text: 'Kettő.', next_step_at: napSec(6) }, MOST)
    const o = dailySummary(db, MOST)
    expect(o.items[0].source).toBe('decision')
    expect(o.items[0].title).toBe('Döntésre váró')
  })

  it('EGY lead csak EGYSZER szerepel, akkor is, ha mindkét forrásban benne van', () => {
    const id = lejartLead('geri', 'Kétszeresen érintett')
    // döntés-feladat ugyanerre a leadre
    db.prepare('INSERT INTO tasks (lead_id, kind, due_at, owner, text, created_at, created_by) VALUES (?,?,?,?,?,?,?)').run(
      id, 'decision', napSec(1), 'geri', 'Döntés kell', napSec(0), 'geri',
    )
    const o = dailySummary(db, MOST)
    expect(o.items).toHaveLength(1)
  })

  it('a LEZÁRT döntés-feladat már nem jön elő', () => {
    const id = nyitottLead('geri', 'Lezárt döntés', 4)
    db.prepare('INSERT INTO tasks (lead_id, kind, due_at, owner, text, created_at, created_by, done_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, 'decision', napSec(1), 'geri', 'Döntés kell', napSec(0), 'geri', napSec(0),
    )
    expect(dailySummary(db, MOST).items).toHaveLength(0)
  })
})

describe('HTTP-úton: a három kényszer a vázban', () => {
  const TOKEN = 'crm-flow-test-token-not-a-real-one'
  let httpDir: string
  let httpDb: Database.Database
  let server: ReturnType<typeof createCrmServer>
  let port = 0
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const post = (p: string, body: unknown) =>
    fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) })

  beforeAll(async () => {
    httpDir = mkdtempSync(join(tmpdir(), 'crm-flow-http-'))
    httpDb = initCrmDatabase(join(httpDir, 'crm.db'))
    server = createCrmServer({ token: TOKEN, webDir: join(fileURLToPath(import.meta.url), '..', '..', '..', 'web-crm'), crmDb: httpDb, readDb: null })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    httpDb.close()
    rmSync(httpDir, { recursive: true, force: true })
  })

  it('az összefoglaló végpont a token-kapu mögött van, és üresen KIMONDJA, hogy nincs döntés', async () => {
    expect((await fetch(url('/api/leads/summary'))).status).toBe(401)
    const r = await fetch(url('/api/leads/summary'), { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(r.status).toBe(200)
    const b = (await r.json()) as { items: unknown[]; nothing_to_decide: boolean }
    expect(b.nothing_to_decide).toBe(true)
    expect(b.items).toHaveLength(0)
  })

  it('a halasztás HTTP-úton is a kapukba fut: kategória nélkül 422', async () => {
    const mikor = startOfLocalDay(new Date()) - 5 * 86400
    const r0 = httpDb
      .prepare(
        `INSERT INTO leads (contact_id,title,origin,status,owner,next_step_type,next_step_at,next_step_text,created_at,created_by,updated_at)
         VALUES (NULL,'HTTP lejárt','other','open','geri','call',?,'Rég',?,?,?)`,
      )
      .run(mikor, mikor, 'geri', mikor)
    const id = Number(r0.lastInsertRowid)
    const r = await post(`/api/leads/${id}/postpone`, { actor: 'geri', text: 'Csúszik.' })
    expect(r.status).toBe(422)
    expect(((await r.json()) as { error: string }).error).toBe('nincs indok-kategoria')
  })

  it('a lejárt akadály HTTP-úton is áll, és a feloldás után enged', async () => {
    const lejart = (httpDb.prepare("SELECT id FROM leads WHERE title='HTTP lejárt'").get() as { id: number }).id
    const blokkolt = await post('/api/leads', {
      actor: 'geri', title: 'Új munka', origin: 'referral', next_step_type: 'call',
      next_step_at: startOfLocalDay(new Date()) + 86400, next_step_text: 'Hívom.',
    })
    expect(blokkolt.status).toBe(409)
    expect(((await blokkolt.json()) as { error: string }).error).toBe('lejart lepes akadalyoz')

    const feloldas = await post(`/api/leads/${lejart}/resolve-expired`, { actor: 'geri', sentence: 'Lezárom, másnál vették meg.', outcome: 'lost' })
    expect(feloldas.status).toBe(200)

    const mehet = await post('/api/leads', {
      actor: 'geri', title: 'Új munka', origin: 'referral', next_step_type: 'call',
      next_step_at: startOfLocalDay(new Date()) + 86400, next_step_text: 'Hívom.',
    })
    expect(mehet.status).toBe(201)
  })

  it('GET-tel nem halasztható: az írás nem olvasás', async () => {
    expect((await fetch(url('/api/leads/1/postpone'), { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
  })
})
