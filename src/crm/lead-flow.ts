/**
 * A maradék három kényszer (CRM 2. ütem, G2 -- CRM2SENDSTATE922).
 *
 * MÉRVADÓ: `workspace/CRM-GERI-KAPUK-ES-NYOM.md` 1. szakasz, (2), (3) és (4) pont.
 *
 * MINDHÁROMNÁL UGYANAZ A NÉGY KÉRDÉS: hol áll a kapu, mit mér, mit tagad meg, és mi a megtagadás
 * szövege. A megtagadás a TANÍTÓ FELÜLET: ha a szövege nem mondja meg a helyes utat, a felhasználó
 * a kibúvót tanulja meg.
 *
 * SÉMA-VÁLTOZÁS NINCS: a halasztás-történet az `audit_log`-ban áll, a számláló a meglévő
 * `leads.postpone_count`, a döntés-kérés pedig `tasks` sor. Ami már van, azt nem duplázzuk.
 */
import type { Database } from 'better-sqlite3'
import { checkActor, startOfLocalDay } from './leads-gate.js'

export type ApiResult = { status: number; body: Record<string, unknown> }

/**
 * AZ INDOK KATEGÓRIA, NEM MONDAT (Marveen kérdésére adott válasz).
 *
 * A szó szerinti egyezés kevés, a hasonlóság-mérés pedig csendben téved MINDKÉT irányba, és a hamis
 * "más" a rosszabb, mert nem látszik: hagyja tovább futni a hurkot. Ezért nem prózát mérünk. Az
 * "ugyanaz" KATEGÓRIA-AZONOSSÁG: objektív, olcsó, és az átfogalmazás nem kerüli meg, mert a
 * kategória választás, nem szöveg.
 */
export const POSTPONE_REASONS = [
  'ugyfelre_varunk',
  'rank_varunk',
  'kapacitas',
  'ar_vagy_hatokor',
  'masik_blokkolja',
  'egyeb',
] as const
export type PostponeReason = (typeof POSTPONE_REASONS)[number]

export const REASON_LABEL: Record<PostponeReason, string> = {
  ugyfelre_varunk: 'ügyfélre várunk',
  rank_varunk: 'ránk várunk',
  kapacitas: 'kapacitás',
  ar_vagy_hatokor: 'ár- vagy hatókör-kérdés',
  masik_blokkolja: 'másik tétel blokkolja',
  egyeb: 'egyéb',
}

/**
 * KEMÉNY HATÁR a kategóriáktól függetlenül: a HARMADIK halasztás döntésre megy, akkor is, ha
 * mindhárom másik kategóriában történt. A kategóriák váltogatással kijátszhatók, a darabszám nem.
 * A költség-aszimmetria ezt támogatja: egy fölösleges kérdés a gazdának olcsó, egy 100 napos álló
 * lead nem.
 */
export const HARD_POSTPONE_LIMIT = 3

/** A napi összefoglaló felső határa. Egy jelentés, ami MINDIG ad hármat, három nap alatt zajjá válik. */
export const SUMMARY_MAX_ITEMS = 3

type LeadRow = {
  id: number
  title: string
  owner: string
  status: string
  next_step_at: number
  next_step_type: string
  next_step_text: string
  postpone_count: number
}

function audit(db: Database, actor: string, entityId: number | null, action: string, detail: string): void {
  db.prepare('INSERT INTO audit_log (at, actor, entity, entity_id, action, detail) VALUES (?,?,?,?,?,?)').run(
    Math.floor(Date.now() / 1000), actor, 'lead', entityId, action, detail,
  )
}

function szerzoKapu(actor: string): { ok: true; actor: string } | { ok: false; result: ApiResult } {
  const kapu = checkActor(actor)
  if (kapu.ok) return { ok: true, actor: kapu.actor }
  return {
    ok: false,
    result: { status: 400, body: { error: kapu.reason === 'empty' ? 'nincs szerzo' : 'tul hosszu szerzo', message: kapu.message } },
  }
}

/**
 * (2) A LEJÁRT KÖVETKEZŐ LÉPÉS AKADÁLY -- A FELELŐS KÖVETKEZŐ ÍRÁSÁN, nem a gazda nézetén.
 *
 * MIÉRT ÍGY: a gazda nézetén álló akadály a gazdát bünteti azért, amit más nem csinált meg, és a
 * gazda nem tudja feloldani. A felelős írásán álló akadály azt éri el, amiért létezik: aki
 * elakadt, az mondja ki, mi legyen az elakadt tétellel, MIELŐTT új munkát vesz fel.
 *
 * AMIT NEM TAGAD MEG: az olvasást, a keresést, a gazda bármely nézetét. Ez a függvény csak ÍRÁS
 * előtt hívandó.
 */
export function expiredBlockers(db: Database, owner: string, now: Date): LeadRow[] {
  const napKezdet = startOfLocalDay(now)
  return db
    .prepare(
      `SELECT id, title, owner, status, next_step_at, next_step_type, next_step_text, postpone_count
         FROM leads
        WHERE status = 'open' AND owner = ? AND next_step_at < ?
        ORDER BY next_step_at ASC, id ASC`,
    )
    .all(owner, napKezdet) as LeadRow[]
}

export function blockerRefusal(blokkolok: LeadRow[]): ApiResult {
  const lista = blokkolok.map((l) => ({ id: l.id, title: l.title, next_step_text: l.next_step_text }))
  return {
    status: 409,
    body: {
      error: 'lejart lepes akadalyoz',
      blockers: lista,
      message:
        'Van ' + blokkolok.length + ' lejárt következő lépésed, ezért most nem veszek fel új munkát. ' +
        'Nem a büntetés a cél: egy lejárt tétel mellett felvett új lead pontosan az a mozdulat, ' +
        'amitől a régi végleg elsüllyed. Írj EGY mondatot arról, mi történjen vele, és utána ' +
        'mehetsz tovább. Három út zárja: új dátumozott lépés, más felelős, vagy lezárás indokkal. ' +
        'Az olvasást és a keresést semmi nem korlátozza.',
    },
  }
}

/**
 * A lejárt tétel FELOLDÁSA. Ez az egyetlen írás, amit az akadály NEM blokkol: különben a felhasználó
 * ki sem tudna mászni belőle.
 */
export function resolveExpired(
  db: Database,
  leadId: number,
  actor: string,
  body: { sentence?: unknown; outcome?: unknown; next_step_at?: unknown; new_owner?: unknown; lost_reason?: unknown },
  now: Date = new Date(),
): ApiResult {
  const sz = szerzoKapu(actor)
  if (!sz.ok) return sz.result
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as LeadRow | undefined
  if (!lead) return { status: 404, body: { error: 'nincs ilyen lead' } }

  // A HARMADIK ÁLLAPOT itt is: megadta, de üresen.
  const mondat = typeof body.sentence === 'string' ? body.sentence.trim() : ''
  if (!mondat) {
    return {
      status: 422,
      body: {
        error: 'nincs mondat',
        message:
          'Egy mondat kell arról, mi történjen ezzel a tétellel. Nem formaság: ez az a mondat, ' +
          'amit két hét múlva te magad fogsz elolvasni, és ebből fogod tudni, hol tartott.',
      },
    }
  }

  const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : ''
  const most = Math.floor(now.getTime() / 1000)

  if (outcome === 'reschedule') {
    const ujDatum = typeof body.next_step_at === 'number' ? Math.floor(body.next_step_at) : null
    if (ujDatum === null || ujDatum < startOfLocalDay(now)) {
      return {
        status: 422,
        body: {
          error: 'hianyzo datum',
          message: 'Az új lépésnek dátuma kell, és az nem lehet a mai nap előtt: egy lejárt tételt ' +
            'nem old meg egy újabb múltbeli dátum.',
        },
      }
    }
    db.transaction(() => {
      db.prepare('UPDATE leads SET next_step_at = ?, next_step_text = ?, updated_at = ? WHERE id = ?').run(ujDatum, mondat, most, leadId)
      audit(db, sz.actor, leadId, 'expired_resolved', JSON.stringify({ outcome, sentence: mondat, next_step_at: ujDatum }))
    })()
    return { status: 200, body: { id: leadId, outcome, next_step_at: ujDatum, message: 'Feloldva, új dátumozott lépéssel.' } }
  }

  if (outcome === 'handover') {
    const ujFelelos = typeof body.new_owner === 'string' ? body.new_owner.trim() : ''
    const kapu = checkActor(ujFelelos)
    if (!kapu.ok) {
      return { status: 422, body: { error: 'nincs uj felelos', message: 'Az átadáshoz meg kell nevezni, KI veszi át. ' + kapu.message } }
    }
    db.transaction(() => {
      db.prepare('UPDATE leads SET owner = ?, next_step_text = ?, updated_at = ? WHERE id = ?').run(kapu.actor, mondat, most, leadId)
      audit(db, sz.actor, leadId, 'expired_resolved', JSON.stringify({ outcome, sentence: mondat, new_owner: kapu.actor }))
    })()
    return { status: 200, body: { id: leadId, outcome, new_owner: kapu.actor, message: 'Átadva, a tétel mostantól nála áll.' } }
  }

  if (outcome === 'lost') {
    db.transaction(() => {
      db.prepare("UPDATE leads SET status = 'lost', next_step_text = ?, updated_at = ? WHERE id = ?").run(mondat, most, leadId)
      audit(db, sz.actor, leadId, 'expired_resolved', JSON.stringify({ outcome, sentence: mondat }))
    })()
    return { status: 200, body: { id: leadId, outcome, message: 'Lezárva elveszettként, indokkal. Ez is válasz, és jobb, mint a csend.' } }
  }

  return {
    status: 422,
    body: {
      error: 'nincs kimenet',
      allowed: ['reschedule', 'handover', 'lost'],
      message:
        'Mondd meg, MI történjen: új dátumozott lépés (reschedule), más felelős (handover), vagy ' +
        'lezárás elveszettként (lost). Mindhárom zárja vagy továbbadja az ügyet; a negyedik út, ' +
        'hogy marad így, nem létezik.',
    },
  }
}

/**
 * (3) KÉTSZERI HALASZTÁS UTÁN GAZDÁT VÁLT VAGY DÖNTÉSRE MEGY.
 *
 * MIT MÉR: nem a darabszámot önmagában, hanem hogy az INDOK ugyanaz-e. Két halasztás két különböző
 * indokkal munka; kétszer ugyanaz elakadás.
 */
export function postponeLead(
  db: Database,
  leadId: number,
  actor: string,
  body: {
    reason?: unknown
    text?: unknown
    next_step_at?: unknown
    /** Az "egyéb" MÁSODSZOR: a felhasználó kimondja, ugyanaz-e. */
    same_as_previous?: unknown
    /** Aki "mást" mond, annak azt kell leírnia, MI VÁLTOZOTT, nem egy új indokot. */
    what_changed?: unknown
  },
  now: Date = new Date(),
): ApiResult {
  const sz = szerzoKapu(actor)
  if (!sz.ok) return sz.result
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as LeadRow | undefined
  if (!lead) return { status: 404, body: { error: 'nincs ilyen lead' } }

  // A LEJÁRT TÉTEL A HALASZTÁST IS BLOKKOLJA -- DE NEM A SAJÁT MAGÁÉT.
  //
  // A kényszer célja: ne vegyél fel ÚJ munkát, amíg valamid elakadt. Ha a most halasztott lead
  // MAGA a lejárt tétel, akkor a halasztás (kategória + mondat + új dátum) épp az a kimondás, amit
  // a kapu kér, és a halasztás saját szabályai amúgy is elkapják a körbe-halasztást. Ha viszont egy
  // MÁSIK tétele járt le, az elsőbbséget élvez.
  const masikLejart = expiredBlockers(db, sz.actor, now).filter((b) => b.id !== leadId)
  if (masikLejart.length) {
    audit(db, sz.actor, leadId, 'postpone_blocked', JSON.stringify({ blockers: masikLejart.map((b) => b.id) }))
    return blockerRefusal(masikLejart)
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!(POSTPONE_REASONS as readonly string[]).includes(reason)) {
    return {
      status: 422,
      body: {
        error: 'nincs indok-kategoria',
        allowed: POSTPONE_REASONS,
        message:
          'A halasztáshoz kategória kell, nem csak szöveg. Az "ugyanaz az indok" csak így mérhető: ' +
          'a szabad szöveg átfogalmazható, a kategória nem.',
      },
    }
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return { status: 422, body: { error: 'nincs szoveg', message: 'A kategória mellé egy mondat is kell: a kategória az ügyről szól, a mondat arról, hol tart.' } }
  }

  const elozo = db
    .prepare(
      `SELECT detail FROM audit_log WHERE entity = 'lead' AND entity_id = ? AND action = 'postpone'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(leadId) as { detail: string } | undefined
  const elozoAdat = elozo ? (JSON.parse(elozo.detail) as { reason: PostponeReason; text: string }) : null

  // KEMÉNY HATÁR: a harmadik halasztás döntésre megy, a kategóriáktól FÜGGETLENÜL.
  if (lead.postpone_count + 1 >= HARD_POSTPONE_LIMIT) {
    return decisionRequired(db, lead, sz.actor, reason, text, elozoAdat, now, 'hard_limit')
  }

  if (elozoAdat && elozoAdat.reason === reason) {
    if (reason === 'egyeb') {
      // AZ "EGYÉB" A KIVÉTEL, és a kivételt MÉRNI kell. Kétszer "egyéb": a rendszer megmutatja az
      // előző indokot SZÓ SZERINT, és a felhasználó mondja ki, ugyanaz-e.
      if (body.same_as_previous === false) {
        const miValtozott = typeof body.what_changed === 'string' ? body.what_changed.trim() : ''
        if (!miValtozott) {
          return {
            status: 422,
            body: {
              error: 'mi valtozott',
              previous_text: elozoAdat.text,
              message:
                'Azt mondod, más az indok. Akkor azt írd le, MI VÁLTOZOTT az előző óta, ne egy új ' +
                'indokot: a "más indok" lenne a legolcsóbb út, és a legolcsóbb útnak a helyesnek ' +
                'kell lennie. Az előző indokod szó szerint ez volt: "' + elozoAdat.text + '". ' +
                'Amit most írsz, a következő halasztásnál is a szemed előtt lesz.',
            },
          }
        }
        return rogzitHalasztas(db, lead, sz.actor, reason, text, body.next_step_at, now, { what_changed: miValtozott })
      }
      if (body.same_as_previous !== true) {
        return {
          status: 409,
          body: {
            error: 'ugyanaz vagy mas',
            previous_reason: reason,
            previous_text: elozoAdat.text,
            message:
              'Másodszor is "egyéb" a kategória. Az előző indokod szó szerint ez volt: "' +
              elozoAdat.text + '". Mondd ki: ugyanaz (same_as_previous: true), vagy más ' +
              '(same_as_previous: false, és írd le, mi változott).',
          },
        }
      }
    }
    // KÉTSZER UGYANAZ A KATEGÓRIA = ELAKADÁS. A szabad szöveges halasztás itt véget ér.
    return decisionRequired(db, lead, sz.actor, reason, text, elozoAdat, now, 'same_reason')
  }

  return rogzitHalasztas(db, lead, sz.actor, reason, text, body.next_step_at, now, {})
}

function rogzitHalasztas(
  db: Database,
  lead: LeadRow,
  actor: string,
  reason: string,
  text: string,
  ujDatumRaw: unknown,
  now: Date,
  extra: Record<string, unknown>,
): ApiResult {
  const ujDatum = typeof ujDatumRaw === 'number' ? Math.floor(ujDatumRaw) : null
  if (ujDatum === null || ujDatum < startOfLocalDay(now)) {
    return {
      status: 422,
      body: { error: 'hianyzo datum', message: 'A halasztásnak ÚJ dátuma van, és az nem lehet a mai nap előtt.' },
    }
  }
  const most = Math.floor(now.getTime() / 1000)

  // AZ ÉBRESZTÉS NEM HALASZTÁS. A wakeup típus azért létezik, hogy a valódi későbbi dátum ne
  // kényszerítsen hazugságra; ha a számláló nőne tőle, pont az egészséges tételen indulna el a
  // halasztás-hurok, és a felhasználó visszatanulná a hamis közeli dátumot.
  const ebresztes = lead.next_step_type === 'wakeup'

  db.transaction(() => {
    db.prepare(
      `UPDATE leads SET next_step_at = ?, next_step_text = ?, postpone_count = postpone_count + ?, updated_at = ?
        WHERE id = ?`,
    ).run(ujDatum, text, ebresztes ? 0 : 1, most, lead.id)
    audit(db, actor, lead.id, 'postpone', JSON.stringify({ reason, text, next_step_at: ujDatum, counted: !ebresztes, ...extra }))
  })()

  const uj = db.prepare('SELECT postpone_count FROM leads WHERE id = ?').get(lead.id) as { postpone_count: number }
  return {
    status: 200,
    body: {
      id: lead.id,
      postpone_count: uj.postpone_count,
      counted: !ebresztes,
      reason,
      message: ebresztes
        ? 'Az ébresztés dátuma áthelyezve. Ez NEM halasztás: az alvó tétel nem elakadás, ezért a ' +
          'számláló nem nőtt.'
        : 'Elhalasztva. A következő azonos indokú halasztás már nem mehet szabad szöveggel.',
    },
  }
}

/**
 * A HÁROM ÚT, ami zárja vagy továbbadja az ügyet. És a megtagadás szövege IDÉZZE VISSZA az előző
 * halasztás indokát SZÓ SZERINT: enélkül a felhasználó nem látja, hogy ismétel.
 */
function decisionRequired(
  db: Database,
  lead: LeadRow,
  actor: string,
  reason: string,
  text: string,
  elozo: { reason: PostponeReason; text: string } | null,
  now: Date,
  trigger: 'same_reason' | 'hard_limit',
): ApiResult {
  const most = Math.floor(now.getTime() / 1000)
  db.transaction(() => {
    db.prepare('INSERT INTO tasks (lead_id, kind, due_at, owner, text, created_at, created_by) VALUES (?,?,?,?,?,?,?)').run(
      lead.id, 'decision', most + 86400, lead.owner,
      `Döntés kell: "${lead.title}". ` +
        (trigger === 'hard_limit'
          ? `Ez lenne a ${HARD_POSTPONE_LIMIT}. halasztás. `
          : `Kétszer ugyanaz az indok (${REASON_LABEL[reason as PostponeReason]}). `) +
        `Most ezt írtad: "${text}".` + (elozo ? ` Előzőleg ezt: "${elozo.text}".` : ''),
      most, actor,
    )
    audit(db, actor, lead.id, 'postpone_refused', JSON.stringify({ reason, text, trigger, previous_text: elozo?.text ?? null }))
  })()

  return {
    status: 409,
    body: {
      error: 'dontes kell',
      trigger,
      previous_reason: elozo?.reason ?? null,
      previous_text: elozo?.text ?? null,
      postpone_count: lead.postpone_count,
      options: ['handover', 'owner_decision', 'lost'],
      message:
        (trigger === 'hard_limit'
          ? `Ez lenne a ${HARD_POSTPONE_LIMIT}. halasztás ezen a leaden. A kategóriák váltogatással ` +
            'kijátszhatók, a darabszám nem, ezért itt a szabad szöveges halasztás véget ér. '
          : 'Másodszor ugyanaz az indok: ez már nem munka, hanem elakadás. ') +
        (elozo ? 'Az előző halasztásod szó szerint ez volt: "' + elozo.text + '". ' : '') +
        'Három út marad, és mindegyik zárja vagy továbbadja az ügyet: más felelős (handover), ' +
        'egy mondatos döntés-kérdés a gazdának két kimenettel (owner_decision), vagy lezárás ' +
        'elveszettként indokkal (lost). Döntés-feladat létrejött, hogy ez ne csak üzenet maradjon.',
    },
  }
}

/**
 * (4) A NAPI ÖSSZEFOGLALÓ NE DARABSZÁMOT MONDJON.
 *
 * Hol: a GENERÁLÁSNÁL, nem a megjelenítésnél. Ha a szűrés a felületen állna, egy másik felület
 * ugyanabból az adatból megint listát csinálna.
 *
 * Mit mér: "ma eldönthető" az a tétel, amihez van egy mondatban feltehető KÉRDÉS két kimenettel,
 * és a válasz MA is számít. Nálunk ez két forrásból áll elő: a döntésre váró halasztás és a lejárt
 * tétel. Mindkettő kérdés, és mindkettőnek két kimenete van.
 *
 * Mit tagad meg: a "12 nyitott lead" típusú sort. A visszatérési érték ezért NEM tartalmaz
 * nyitott-darabszámot: nincs mit megjeleníteni belőle.
 */
export function dailySummary(db: Database, now: Date = new Date()): {
  items: Array<{ lead_id: number; title: string; question: string; outcomes: [string, string]; source: string }>
  nothing_to_decide: boolean
  message: string
} {
  const napKezdet = startOfLocalDay(now)

  const dontesre = db
    .prepare(
      `SELECT t.id AS task_id, t.lead_id, t.text, l.title
         FROM tasks t JOIN leads l ON l.id = t.lead_id
        WHERE t.kind = 'decision' AND t.done_at IS NULL AND l.status = 'open'
        ORDER BY t.due_at ASC, t.id ASC`,
    )
    .all() as Array<{ task_id: number; lead_id: number; text: string; title: string }>

  const lejart = db
    .prepare(
      `SELECT id, title, owner, next_step_text FROM leads
        WHERE status = 'open' AND next_step_at < ?
        ORDER BY next_step_at ASC, id ASC`,
    )
    .all(napKezdet) as Array<{ id: number; title: string; owner: string; next_step_text: string }>

  const items: Array<{ lead_id: number; title: string; question: string; outcomes: [string, string]; source: string }> = []
  for (const d of dontesre) {
    if (items.length >= SUMMARY_MAX_ITEMS) break
    items.push({
      lead_id: d.lead_id,
      title: d.title,
      question: `"${d.title}": visszük tovább más felelőssel, vagy lezárjuk elveszettként?`,
      outcomes: ['más felelős', 'lezárás elveszettként'],
      source: 'decision',
    })
  }
  for (const l of lejart) {
    if (items.length >= SUMMARY_MAX_ITEMS) break
    if (items.some((i) => i.lead_id === l.id)) continue
    items.push({
      lead_id: l.id,
      title: l.title,
      question: `"${l.title}" lejárt (${l.owner}): adunk neki új dátumot, vagy lezárjuk?`,
      outcomes: ['új dátumozott lépés', 'lezárás'],
      source: 'expired',
    })
  }

  if (!items.length) {
    // HA MA NINCS ELDÖNTHETŐ TÉTEL, AZT MONDJA KI, és maradjon rövid. Egy jelentés, ami mindig ad
    // hármat, három nap alatt zajjá válik, és akkor az igazi is elvész.
    return {
      items: [],
      nothing_to_decide: true,
      message: 'Ma nincs eldönthető tétel. Ez nem hiba és nem üres jelentés: nincs olyan kérdés, amire ma kellene válaszolnod.',
    }
  }
  return {
    items,
    nothing_to_decide: false,
    message: items.length === 1 ? 'Egy tétel vár ma döntésre.' : `${items.length} tétel vár ma döntésre.`,
  }
}
