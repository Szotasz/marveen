/**
 * CRM2SENDSTATE922: a küldés-állapotgép, a tipizált bizonyíték útonként, a nyom-hiány jelölése és
 * a feladat ugyanabban a tranzakcióban, az újraküldés kapui.
 *
 * A FIXTÚRA A VÁZ SAJÁT SÉMÁJÁT HASZNÁLJA (`initCrmDatabase`), nem kézzel másolt DDL-t: ha a séma
 * elmozdul, ezek az állítások nem maradhatnak zöldek a régi táblán.
 *
 * VALÓDI KÜLDÉS NINCS: a szolgáltatót a stub képviseli, és a stub ALAPÉRTELMEZÉSE a MA MÉRT
 * valóságot tükrözi, nem a kívánt állapotot.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initCrmDatabase } from '../crm/db.js'
import { classifyOutcome, transitionAllowed, lookupPlan, SEND_STATES } from '../crm/send-state.js'
import { createSendProviderStub, MA_MERT_ALAP } from '../crm/send-provider-stub.js'
import { queueSend, recordOutcome, checkUncertain, requestResend, performSend } from '../crm/send-routes.js'
import { createCrmServer } from '../crm/server.js'
import { fileURLToPath } from 'node:url'

let dir: string
let db: Database.Database
const MOST = new Date(Date.UTC(2026, 8, 22, 12, 30, 0))
const SAJAT_ID = '<crm-1758543000-abc@aiamindennapokban.hu>'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crm-send-'))
  db = initCrmDatabase(join(dir, 'crm.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function allapot(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM send_attempts WHERE id = ?').get(id) as Record<string, unknown>
}
function feladatok(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM tasks').all() as Array<Record<string, unknown>>
}
function nyomok(action?: string): Array<Record<string, unknown>> {
  return (action
    ? db.prepare("SELECT * FROM audit_log WHERE entity='send_attempt' AND action=? ORDER BY id").all(action)
    : db.prepare("SELECT * FROM audit_log WHERE entity='send_attempt' ORDER BY id").all()) as Array<Record<string, unknown>>
}
function sorbaAllit(provider = 'smtp_support'): number {
  const r = queueSend(db, { rfc_message_id: SAJAT_ID, provider }, 'geri', MOST)
  expect(r.status).toBe(201)
  return Number(r.body.id)
}

describe('a sorba állítás kapuja: a saját Message-ID ELŐFELTÉTEL', () => {
  it('a saját Message-ID nélkül nincs sorba állítás', () => {
    const r = queueSend(db, { provider: 'resend' }, 'geri', MOST)
    expect(r.status).toBe(422)
    expect(r.body.missing).toEqual(['rfc_message_id'])
    expect(String(r.body.message)).toContain('idempotencia-kulcs')
  })

  it('HARMADIK ÁLLAPOT: megadta, de üresen (csak whitespace) -> ugyanúgy megtagadás', () => {
    const r = queueSend(db, { rfc_message_id: '   \n\t ', provider: 'resend' }, 'geri', MOST)
    expect(r.status).toBe(422)
    expect(r.body.missing).toEqual(['rfc_message_id'])
  })

  it('HARMADIK ÁLLAPOT az ÚT kapcsolóján is: üres és ismeretlen út egyaránt megtagadva', () => {
    expect(queueSend(db, { rfc_message_id: SAJAT_ID, provider: '  ' }, 'geri', MOST).body.missing).toEqual(['provider'])
    expect(queueSend(db, { rfc_message_id: SAJAT_ID, provider: 'postagalamb' }, 'geri', MOST).body.missing).toEqual(['provider'])
  })

  it('szerző nélkül nincs sorba állítás, és a közös kapu 64 karakteres felső határa itt is áll', () => {
    expect(queueSend(db, { rfc_message_id: SAJAT_ID, provider: 'resend' }, '   ', MOST).status).toBe(400)
    expect(queueSend(db, { rfc_message_id: SAJAT_ID, provider: 'resend' }, 'x'.repeat(65), MOST).status).toBe(400)
    expect((db.prepare('SELECT count(*) AS n FROM send_attempts').get() as { n: number }).n).toBe(0)
  })

  it('a megtagadás IS nyom: a sorba állítás elutasítása audit sort hagy', () => {
    queueSend(db, { provider: 'resend' }, 'boni', MOST)
    const n = nyomok('send_queue_refused')
    expect(n).toHaveLength(1)
    expect(n[0].actor).toBe('boni')
  })
})

describe('a bizonyíték ÚTONKÉNT MÁS, és elfogadott CSAK bizonyítékkal', () => {
  it('gmail: azonosító ÉS szál-azonosító kell; a szál hiánya bizonytalan, nem elfogadott', () => {
    const teljes = classifyOutcome('gmail_api', SAJAT_ID, { kind: 'response', http_status: 200, provider_msg_id: 'gm-1', thread_id_provider: 'th-1' })
    expect(teljes.state).toBe('accepted')
    const fel = classifyOutcome('gmail_api', SAJAT_ID, { kind: 'response', http_status: 200, provider_msg_id: 'gm-1' })
    expect(fel.state).toBe('uncertain')
    expect(fel.missing).toEqual(['thread_id_provider'])
  })

  it('resend: az azonosító elég, DE a szöveg kimondja, hogy nincs helyi másolat', () => {
    const r = classifyOutcome('resend', SAJAT_ID, { kind: 'response', http_status: 200, provider_msg_id: 'rs-1' })
    expect(r.state).toBe('accepted')
    expect(r.message).toContain('NINCS helyi másolat')
  })

  it('A LEGCSÁBÍTÓBB HAMIS ZÖLD: a 200-as státusz azonosító nélkül NEM elfogadott', () => {
    const r = classifyOutcome('resend', SAJAT_ID, { kind: 'response', http_status: 200 })
    expect(r.state).toBe('uncertain')
    expect(r.missing).toEqual(['provider_msg_id'])
    expect(r.message).toContain('nem kézbesítés')
  })

  it('smtp: a 250 ÖNMAGÁBAN (saját azonosító nélkül) bizonytalan', () => {
    const r = classifyOutcome('smtp_support', '   ', { kind: 'response', http_status: 250, sent_folder_uid: 'u-1' })
    expect(r.state).toBe('uncertain')
    expect(r.missing).toEqual(['rfc_message_id'])
  })

  it('smtp: 250 + saját azonosító + Sent-UID -> elfogadott, a nyom teljes', () => {
    const r = classifyOutcome('smtp_support', SAJAT_ID, { kind: 'response', http_status: 250, sent_folder_uid: 'u-1' })
    expect(r.state).toBe('accepted')
    expect(r.audit_gap).toBeNull()
  })

  it('smtp: 250 + saját azonosító, DE bukott Sent-append -> ELFOGADOTT, nyom hiányos (NEM bizonytalan)', () => {
    const r = classifyOutcome('smtp_support', SAJAT_ID, { kind: 'response', http_status: 250, sent_folder_uid: null })
    expect(r.state).toBe('accepted')
    expect(r.audit_gap).toBe('sent_folder_uid')
    expect(r.message).toContain('KIMENT')
  })

  it('nincs ítélet (időtúllépés) -> bizonytalan, és a szöveg kimondja, hogy ez nem a "nem ment ki"', () => {
    const r = classifyOutcome('gmail_api', SAJAT_ID, { kind: 'no_verdict', reason: 'időtúllépés' })
    expect(r.state).toBe('uncertain')
    expect(r.message).toContain('nem tudjuk')
  })

  it('a szolgáltató elutasítása SIKERTELEN, nem bizonytalan: van ítéletünk', () => {
    expect(classifyOutcome('resend', SAJAT_ID, { kind: 'response', http_status: 422 }).state).toBe('failed')
    expect(classifyOutcome('smtp_support', SAJAT_ID, { kind: 'response', http_status: 550 }).state).toBe('failed')
  })
})

describe('az átmenet-tábla: kevesebb állapot, kevesebb rossz átmenet', () => {
  it('az elfogadott és a sikertelen VÉGÁLLAPOT', () => {
    for (const cel of SEND_STATES) {
      expect(transitionAllowed('accepted', cel), `accepted -> ${cel}`).toBe(false)
      expect(transitionAllowed('failed', cel), `failed -> ${cel}`).toBe(false)
    }
  })

  it('a bizonytalanból VAN visszaút a sorba (ugyanazzal a kulccsal), a sorból nincs piszkozatba', () => {
    expect(transitionAllowed('uncertain', 'queued')).toBe(true)
    expect(transitionAllowed('queued', 'draft')).toBe(false)
  })

  it('a végpont a tiltott átmenetet 409-cel utasítja el, nem írja felül az állapotot', () => {
    const id = sorbaAllit('resend')
    recordOutcome(db, id, 'geri', { kind: 'response', http_status: 200, provider_msg_id: 'rs-1' }, MOST)
    expect(allapot(id).state).toBe('accepted')
    const ujra = recordOutcome(db, id, 'geri', { kind: 'response', http_status: 500 }, MOST)
    expect(ujra.status).toBe(409)
    expect(allapot(id).state).toBe('accepted')
  })
})

describe('a nyom-hiány JELÖLÉS, és ugyanabban a tranzakcióban FELADAT', () => {
  it('a jelölés feladatot ír, határidővel és gazdával', () => {
    const id = sorbaAllit('smtp_support')
    const r = recordOutcome(db, id, 'geri', { kind: 'response', http_status: 250, sent_folder_uid: null }, MOST)
    expect(r.status).toBe(200)
    expect(allapot(id).audit_gap).toBe('sent_folder_uid')
    const t = feladatok()
    expect(t).toHaveLength(1)
    expect(t[0].kind).toBe('audit_gap')
    expect(t[0].owner).toBe('geri')
    expect(String(t[0].text)).toContain(SAJAT_ID)
    expect(Number(t[0].due_at)).toBe(Math.floor(MOST.getTime() / 1000) + 2 * 86400)
    expect(r.body.task_id).toBe(t[0].id)
  })

  it('NEGATÍV KONTROLL: teljes nyom esetén NINCS feladat', () => {
    const id = sorbaAllit('smtp_support')
    recordOutcome(db, id, 'geri', { kind: 'response', http_status: 250, sent_folder_uid: 'u-9' }, MOST)
    expect(allapot(id).audit_gap).toBeNull()
    expect(feladatok()).toHaveLength(0)
  })

  it('a jelölés és a feladat EGY tranzakcióban: ha a feladat-írás bukik, az állapot sem marad ott', () => {
    const id = sorbaAllit('smtp_support')
    // a tasks táblát elvesszük a tranzakció alól: a feladat-írás bukik
    db.exec('ALTER TABLE tasks RENAME TO tasks_elrejtve')
    expect(() => recordOutcome(db, id, 'geri', { kind: 'response', http_status: 250, sent_folder_uid: null }, MOST)).toThrow()
    // A JELÖLÉS SEM MARADT OTT: enélkül egy nyom-hiányos küldés feladat NÉLKÜL állna, vagyis pont
    // az a jelvény lenne belőle, ami ellen a kikötés szól.
    expect(allapot(id).state).toBe('queued')
    expect(allapot(id).audit_gap).toBeNull()
  })
})

describe('az újraküldés kapui', () => {
  it('elfogadott után TILOS', () => {
    const id = sorbaAllit('resend')
    recordOutcome(db, id, 'geri', { kind: 'response', http_status: 200, provider_msg_id: 'rs-1' }, MOST)
    const r = requestResend(db, id, 'geri', {}, MOST)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('ujrakuldes tiltott')
  })

  it('NYOM-HIÁNYOS elfogadott után is TILOS, és a szöveg megmondja, miért (kiment)', () => {
    const id = sorbaAllit('smtp_support')
    recordOutcome(db, id, 'geri', { kind: 'response', http_status: 250, sent_folder_uid: null }, MOST)
    const r = requestResend(db, id, 'geri', {}, MOST)
    expect(r.status).toBe(409)
    expect(r.body.audit_gap).toBe('sent_folder_uid')
    expect(String(r.body.message)).toContain('KIMENT')
  })

  it('a nyom-hiány ÖNMAGÁBAN tilt, nem csak az "elfogadott" állapoton keresztül', () => {
    // MERT MUTANSSAL MERVE: a `|| sor.audit_gap` tag a mai kodban REDUNDANS, mert jeloles csak
    // elfogadott melle kerul, tehat az elso tag amugy is elkapja. A kartya szabalya viszont KET
    // feltetelt mond ("ha audit_gap all VAGY az allapot accepted"), es a kapu nem tamaszkodhat egy
    // masik fuggveny invarianciajara: ha egy KESOBBI iro (G3, vagy a felulet) mas allapot melle tesz
    // jelolest, az ujrakuldesnek ugyanugy tilosnak kell lennie. Ezert itt KOZVETLENUL allitok elo
    // ilyen sort, es a kaput magat merem, nem a mai egyuttallast.
    const most = Math.floor(MOST.getTime() / 1000)
    const r = db
      .prepare(
        `INSERT INTO send_attempts (rfc_message_id, provider, requested_at, state, audit_gap, actor)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(SAJAT_ID, 'smtp_support', most, 'uncertain', 'sent_folder_uid', 'geri')
    const id = Number(r.lastInsertRowid)
    const v = requestResend(db, id, 'geri', {}, MOST)
    expect(v.status).toBe(409)
    expect(v.body.error).toBe('ujrakuldes tiltott')
    expect(v.body.audit_gap).toBe('sent_folder_uid')
    expect(allapot(id).state).toBe('uncertain')
  })

  it('sikertelen után TILOS: ott ÚJ kísérlet kell, nem ennek a sornak az átírása', () => {
    const id = sorbaAllit('resend')
    recordOutcome(db, id, 'geri', { kind: 'response', http_status: 422 }, MOST)
    expect(requestResend(db, id, 'geri', {}, MOST).status).toBe(409)
  })

  it('bizonytalanból ELLENŐRZÉS NÉLKÜL nem megy: ez a néma duplikálás fő forrása', () => {
    const id = sorbaAllit('gmail_api')
    recordOutcome(db, id, 'geri', { kind: 'no_verdict', reason: 'időtúllépés' }, MOST)
    const r = requestResend(db, id, 'geri', {}, MOST)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('elobb ellenorzes')
    expect(allapot(id).state).toBe('uncertain')
  })

  it('ellenőrzés után (nincs ott) MEHET, ugyanazzal a kulccsal', () => {
    const id = sorbaAllit('gmail_api')
    recordOutcome(db, id, 'geri', { kind: 'no_verdict', reason: 'időtúllépés' }, MOST)
    const e = checkUncertain(db, id, 'geri', createSendProviderStub(), MOST)
    expect(e.body.found).toBe(false)
    expect(e.body.measurable).toBe(true)
    expect(e.body.resend_allowed).toBe(true)
    const r = requestResend(db, id, 'geri', {}, MOST)
    expect(r.status).toBe(200)
    expect(allapot(id).state).toBe('queued')
    // A KULCS UGYANAZ MARAD: ha a régi mégis megérkezett, a kettő összetartozik.
    expect(allapot(id).rfc_message_id).toBe(SAJAT_ID)
    expect(r.body.rfc_message_id).toBe(SAJAT_ID)
  })

  it('az ellenőrzés MEGTALÁLHATJA a levelet: akkor elfogadott lesz, és újraküldés már tilos', () => {
    const id = sorbaAllit('gmail_api')
    recordOutcome(db, id, 'geri', { kind: 'no_verdict', reason: 'időtúllépés' }, MOST)
    const szolgaltato = createSendProviderStub({ lookup: { gmail_api: { kind: 'found', provider_msg_id: 'gm-7', thread_id_provider: 'th-7' } } })
    const e = checkUncertain(db, id, 'geri', szolgaltato, MOST)
    expect(e.body.state).toBe('accepted')
    expect(allapot(id).provider_msg_id).toBe('gm-7')
    expect(requestResend(db, id, 'geri', {}, MOST).status).toBe(409)
  })
})

describe('"nincs bizonyíték" kontra "NINCS MÉRŐESZKÖZ" (a támogatási út)', () => {
  it('a támogatási úton az ellenőrzés nem talál, de ezt NEM "nem ment ki"-ként mondja', () => {
    const id = sorbaAllit('smtp_support')
    recordOutcome(db, id, 'geri', { kind: 'no_verdict', reason: 'megszakadt kapcsolat' }, MOST)
    const e = checkUncertain(db, id, 'geri', createSendProviderStub(), MOST)
    expect(e.body.found).toBe(false)
    expect(e.body.measurable).toBe(false)
    expect(String(e.body.message)).toContain('NEM AZT JELENTI, HOGY NEM MENT KI')
    expect(e.body.resend_allowed).toBe(false)
  })

  it('ott az újraküldés KIMONDOTT tudomásulvételt kér, és anélkül megtagadva', () => {
    const id = sorbaAllit('smtp_support')
    recordOutcome(db, id, 'geri', { kind: 'no_verdict', reason: 'megszakadt kapcsolat' }, MOST)
    checkUncertain(db, id, 'geri', createSendProviderStub(), MOST)
    const nelkule = requestResend(db, id, 'geri', {}, MOST)
    expect(nelkule.status).toBe(409)
    expect(nelkule.body.error).toBe('nincs meroeszkoz')
    expect(allapot(id).state).toBe('uncertain')
    const vele = requestResend(db, id, 'geri', { acknowledge_no_instrument: true }, MOST)
    expect(vele.status).toBe(200)
    expect(allapot(id).state).toBe('queued')
  })

  it('a tudomásulvétel NYOMOT hagy: később mérhető, hány küldés ment ki vakon', () => {
    const id = sorbaAllit('smtp_support')
    recordOutcome(db, id, 'geri', { kind: 'no_verdict', reason: 'megszakadt kapcsolat' }, MOST)
    checkUncertain(db, id, 'geri', createSendProviderStub(), MOST)
    requestResend(db, id, 'geri', { acknowledge_no_instrument: true }, MOST)
    const n = nyomok('send_resend')
    expect(n).toHaveLength(1)
    expect(JSON.parse(String(n[0].detail)).acknowledged_no_instrument).toBe(true)
  })

  it('a terv MEGNEVEZI, hol keresünk és mire számíthatunk, útonként másként', () => {
    expect(lookupPlan('smtp_support', SAJAT_ID).mire_szamithatsz).toContain('NINCS MÉRŐESZKÖZ')
    expect(lookupPlan('resend', SAJAT_ID).mire_szamithatsz).toContain('NINCS helyi másolat')
    expect(lookupPlan('gmail_api', SAJAT_ID).hol).toContain(SAJAT_ID)
  })
})

describe('a STUB: valódi küldés nincs, és az alapértelmezés a MA MÉRT valóságot tükrözi', () => {
  it('a támogatási út alapértelmezett lookupja "nincs mérőeszköz", nem "nincs ott"', () => {
    expect(MA_MERT_ALAP.lookup.smtp_support?.kind).toBe('no_instrument')
  })

  it('a támogatási út alapértelmezett küldése 250-et ad Sent-UID NÉLKÜL: a ma mért állapot', () => {
    const k = MA_MERT_ALAP.send.smtp_support
    expect(k?.kind === 'response' && k.http_status).toBe(250)
    expect(k?.kind === 'response' && k.sent_folder_uid).toBeNull()
  })

  it('a három lépés egyben (performSend): a támogatási úton nyom-hiányos elfogadott + feladat', () => {
    const r = performSend(db, createSendProviderStub(), { rfc_message_id: SAJAT_ID, provider: 'smtp_support' }, 'geri', MOST)
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('accepted')
    expect(r.body.audit_gap).toBe('sent_folder_uid')
    expect(feladatok()).toHaveLength(1)
  })

  it('performSend a kapun is átmegy: szerző nélkül nincs küldés, és nem keletkezik kísérlet', () => {
    const r = performSend(db, createSendProviderStub(), { rfc_message_id: SAJAT_ID, provider: 'resend' }, '', MOST)
    expect(r.status).toBe(400)
    expect((db.prepare('SELECT count(*) AS n FROM send_attempts').get() as { n: number }).n).toBe(0)
  })
})

describe('HTTP-úton: a küldés-végpontok a vázban (ugyanaz a token-kapu)', () => {
  // A LEAD-VÉGPONTNÁL EZ TALÁLT HIBÁT, ezért itt is élőben mérem: a függvény-hívás és a beillesztés
  // két külön dolog, és a kettő közé csendben be tud csúszni egy rosszul átadott mező.
  const TOKEN = 'crm-send-test-token-not-a-real-one'
  const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..')
  let httpDir: string
  let httpDb: Database.Database
  let server: ReturnType<typeof createCrmServer>
  let port = 0
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const post = (p: string, body: unknown, token: string | null = TOKEN) =>
    fetch(url(p), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    httpDir = mkdtempSync(join(tmpdir(), 'crm-send-http-'))
    httpDb = initCrmDatabase(join(httpDir, 'crm.db'))
    server = createCrmServer({ token: TOKEN, webDir: join(REPO, 'web-crm'), crmDb: httpDb, readDb: null })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    httpDb.close()
    rmSync(httpDir, { recursive: true, force: true })
  })

  it('a küldés-végpont a token-kapu MÖGÖTT van', async () => {
    expect((await post('/api/send', { actor: 'geri' }, null)).status).toBe(401)
  })

  it('a válasz KIMONDJA, hogy stub: fixtúra áll mögötte, nem kézbesítés', async () => {
    const r = await post('/api/send', { actor: 'geri', rfc_message_id: '<http-1@pelda.hu>', provider: 'smtp_support' })
    expect(r.status).toBe(200)
    const b = (await r.json()) as { state: string; audit_gap: string; stub: boolean }
    expect(b.stub).toBe(true)
    expect(b.state).toBe('accepted')
    expect(b.audit_gap).toBe('sent_folder_uid')
    expect((httpDb.prepare("SELECT count(*) AS n FROM tasks WHERE kind='audit_gap'").get() as { n: number }).n).toBe(1)
  })

  it('a szerző a TÖRZSBŐL jön a küldésnél is: nélküle 400, és nem keletkezik kísérlet', async () => {
    const elotte = (httpDb.prepare('SELECT count(*) AS n FROM send_attempts').get() as { n: number }).n
    const r = await post('/api/send', { rfc_message_id: '<http-2@pelda.hu>', provider: 'resend' })
    expect(r.status).toBe(400)
    expect((httpDb.prepare('SELECT count(*) AS n FROM send_attempts').get() as { n: number }).n).toBe(elotte)
  })

  it('az újraküldés a HTTP-úton is a kapukba fut: ellenőrzés nélkül 409', async () => {
    const q = await post('/api/send/queue', { actor: 'geri', rfc_message_id: '<http-3@pelda.hu>', provider: 'gmail_api' })
    const id = ((await q.json()) as { id: number }).id
    await post('/api/send/outcome', { actor: 'geri', attempt_id: id, outcome: { kind: 'no_verdict', reason: 'időtúllépés' } })
    const r = await post('/api/send/resend', { actor: 'geri', attempt_id: id })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toBe('elobb ellenorzes')
  })

  it('GET-tel nem hívható: a küldés nem olvasás', async () => {
    expect((await fetch(url('/api/send'), { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
  })
})
