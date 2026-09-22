/**
 * A lead-végpontok (CRM 1. ütem, G1 -- CRM1LEADKAPU922).
 *
 * SZÁNDÉKOSAN KERETRENDSZER-FÜGGETLEN: a két függvény egy nyitott better-sqlite3 kapcsolatot és a
 * kérés törzsét kapja, és sima objektumot ad vissza. Így a D1 váz (Dani) bármilyen HTTP-réteget
 * használ, ez beilleszthető, és a teszt is futtathatja szerver nélkül.
 *
 * A KAPU AZ ÍRÁS ELŐTT ÁLL. A séma CHECK-jei a MÁSODIK tanú, nem az első: egy CHECK csak azt
 * mondja meg, hogy nem ment be, azt nem, hogy MIÉRT nem, és a felhasználónak a miért kell.
 */
import type { Database } from 'better-sqlite3'
import { checkActor, checkLeadInput, startOfLocalDay, type LeadInput } from './leads-gate.js'
import { blockerRefusal, expiredBlockers } from './lead-flow.js'

export type ApiResult = { status: number; body: Record<string, unknown> }

function audit(
  db: Database,
  actor: string,
  entity: string,
  entityId: number | null,
  action: string,
  detail: string,
): void {
  db.prepare(
    'INSERT INTO audit_log (at, actor, entity, entity_id, action, detail) VALUES (?,?,?,?,?,?)',
  ).run(Math.floor(Date.now() / 1000), actor, entity, entityId, action, detail)
}

/**
 * POST /api/leads
 *
 * LEAD SOSEM SZINKRONBÓL: ezért KÖTELEZŐ a megnevezett szerző. Egy szinkron-folyamatnak nincs
 * szerzője, tehát ezen az úton nem tud leadet létrehozni. Ez nem dokumentációs kikötés, hanem
 * ellenőrzés: a szerző nélküli hívás megtagadva.
 */
export function createLead(
  db: Database,
  body: LeadInput,
  actor: string,
  now: Date = new Date(),
): ApiResult {
  // A SZERZO-KAPU A KOZOS MODULBAN VAN (leads-gate), mert a szabaly minden iro vegpontra all.
  // Ha itt allna, a G2 (send_attempts.actor) sajat masolatot kapna, es a ketto eszrevetlenul
  // csuszna szet -- pont az a hiba-alak, amit a tipus-lista egy-helyen-tartasa mar elkerult.
  const szerzoKapu = checkActor(actor)
  if (!szerzoKapu.ok) {
    return {
      status: 400,
      body: { error: szerzoKapu.reason === 'empty' ? 'nincs szerzo' : 'tul hosszu szerzo', message: szerzoKapu.message },
    }
  }
  const szerzo = szerzoKapu.actor

  // (2) A LEJÁRT KÖVETKEZŐ LÉPÉS AKADÁLY, A FELELŐS KÖVETKEZŐ ÍRÁSÁN (spec 1. szakasz, (2) pont).
  //
  // ITT áll, az új munka felvétele előtt, mert pont ez a mozdulat süllyeszti el a régit: aki lejárt
  // tétel mellett vesz fel új leadet, az a régit soha nem fogja elővenni. A megtagadás NEM az
  // olvasásra vonatkozik, és a feloldás egy mondat a lejárt tételhez (`resolveExpired`).
  const blokkolok = expiredBlockers(db, szerzo, now)
  if (blokkolok.length) {
    audit(db, szerzo, 'lead', null, 'create_blocked', JSON.stringify({ blockers: blokkolok.map((b) => b.id) }))
    return blockerRefusal(blokkolok)
  }

  const kapu = checkLeadInput(body, now)
  if (!kapu.ok) {
    // A MEGTAGADÁS IS NYOM. Ma mértük, hogy az értesítés nélküli létrehozás nem hagy nyomot, tehát
    // a használati mód láthatatlan marad a méréseinknek. A megtagadás számát épp ugyanígy kell
    // látnunk: ha sok, a SZÖVEG rossz, nem a felhasználó.
    audit(db, szerzo, 'lead', null, 'create_refused', JSON.stringify({ missing: kapu.missing }))
    return { status: 422, body: { error: 'hianyzo kovetkezo lepes', missing: kapu.missing, message: kapu.message } }
  }

  const v = kapu.value
  const most = Math.floor(now.getTime() / 1000)

  const tranzakcio = db.transaction(() => {
    let contactId = v.contact_id
    let ujKontakt = false
    if (contactId === null && (v.display_name || v.email || v.phone)) {
      // A MEGLEVO KONTAKTOT MEG KELL KERESNI AZ IRAS ELOTT (Samu lelete a #1470 review-jan).
      //
      // MERVE a javitas elott: ugyanaz az e-mail ketszer (csak kis/nagybetuben elterve) KET
      // contacts sort csinalt, mindketto 201-gyel, es a masodik kontakt e-mail NELKUL maradt --
      // mert az `INSERT OR IGNORE` a UNIQUE-on CSENDBEN eldobta a sort. Vagyis a tabla ketszer
      // tartalmazta ugyanazt az embert, es semmi nem jelezte. Pont az a hiba-alak, ami ellen ez a
      // kartya egyaltalan letezik: minden zold, es kozben rossz az adat.
      //
      // A KULCS AZ E-MAIL: a `contact_emails.email` a semaban GLOBALISAN egyedi, `COLLATE NOCASE`.
      // A telefon NEM az (a PK `(contact_id, phone)`), ezert ott tobb sor is lehet; a legkisebb
      // azonositot vesszuk, hogy a valasztas determinisztikus legyen, ne a beszurasi sorrend dontse.
      // A telefon-egyezes SZO SZERINTI: normalizalas (orszaghivo, szokozok) nem az 1. utem dolga,
      // es egy fel-kesz normalizalas rosszabb lenne, mint a semmi.
      const emailTalalat = v.email
        ? (db
            .prepare('SELECT contact_id FROM contact_emails WHERE email = ? COLLATE NOCASE')
            .get(v.email) as { contact_id: number } | undefined)
        : undefined
      const telefonTalalat =
        !emailTalalat && v.phone
          ? (db
              .prepare('SELECT contact_id FROM contact_phones WHERE phone = ? ORDER BY contact_id LIMIT 1')
              .get(v.phone) as { contact_id: number } | undefined)
          : undefined

      const talalt = emailTalalat ?? telefonTalalat
      if (talalt) {
        // A MEGLEVO NEVET NEM IRJUK FELUL. Egy uj lead nem tud tobbet a kontaktrol, mint ami mar
        // all rola: ha itt csendben felulirnank, egy elgepelt nev eltuntetne a helyeset.
        contactId = talalt.contact_id
      } else {
        const r = db
          .prepare('INSERT INTO contacts (display_name, created_at, created_by) VALUES (?,?,?)')
          .run(v.display_name ?? v.email ?? v.phone, most, szerzo)
        contactId = Number(r.lastInsertRowid)
        ujKontakt = true
      }

      // A HIANYZO ELERHETOSEG HOZZAKERUL a megtalalt kontakthoz is: ez bovites, nem feluliras.
      // Az e-mail itt biztosan szabad (ha foglalt lenne, a fenti kereses MEGTALALTA volna), tehat
      // az `INSERT OR IGNORE` nem tud csendben nyelni egy MASIK emberhez tartozo sort.
      if (v.email) {
        db.prepare(
          'INSERT OR IGNORE INTO contact_emails (contact_id, email, is_primary) VALUES (?,?,1)',
        ).run(contactId, v.email)
      }
      if (v.phone) {
        db.prepare('INSERT OR IGNORE INTO contact_phones (contact_id, phone) VALUES (?,?)').run(
          contactId,
          v.phone,
        )
      }
    }

    const res = db
      .prepare(
        `INSERT INTO leads (contact_id, title, origin, status, owner, next_step_type, next_step_at,
                            next_step_text, postpone_count, created_at, created_by, updated_at)
         VALUES (?,?,?,'open',?,?,?,?,0,?,?,?)`,
      )
      .run(contactId, v.title, v.origin, szerzo, v.next_step_type, v.next_step_at, v.next_step_text, most, szerzo, most)
    const leadId = Number(res.lastInsertRowid)
    // A NYOM MEGMONDJA, HOGY UJ EMBER-E. A dedup enelkul nem merheto visszamenoleg: a contacts
    // darabszama onmagaban nem valaszolja meg, hogy osszevontunk-e vagy csak kevesebbet vettunk fel.
    audit(
      db,
      szerzo,
      'lead',
      leadId,
      'create',
      JSON.stringify({
        next_step_at: v.next_step_at,
        next_step_type: v.next_step_type,
        contact_id: contactId,
        contact: contactId === null ? 'none' : ujKontakt ? 'created' : 'reused',
      }),
    )
    return leadId
  })

  const leadId = tranzakcio()
  return { status: 201, body: { id: leadId } }
}

/**
 * GET /api/leads/today -- a "Ma" nézet adata.
 *
 * LEJÁRT ELÖL, aztán a mai. A sorrend nem kozmetika: a lejárt tétel az, amiről a felhasználónak
 * dönteni kell, és ha a mai teendők közé keveredik, ugyanúgy elsüllyed, mint egy listában.
 */
export function todayLeads(db: Database, now: Date = new Date()): ApiResult {
  const napKezdet = startOfLocalDay(now)
  const napVege = napKezdet + 86400
  const sorok = db
    .prepare(
      `SELECT id, title, origin, owner, next_step_type, next_step_at, next_step_text, contact_id,
              CASE WHEN next_step_at < ? THEN 1 ELSE 0 END AS lejart
         FROM leads
        WHERE status = 'open' AND next_step_at < ?
        ORDER BY lejart DESC, next_step_at ASC, id ASC`,
    )
    .all(napKezdet, napVege)

  // AZ ALVO TETELEK SZAMA A FO NEZETRE TARTOZIK (Marveen kikotese, 2026-09-22). Az indok a gazda
  // sajat panaszabol jon: ha az alvo halmaz csak egy masik oldalon latszik, akkor pont azt a helyet
  // epitettuk ujra, ahol a lead leul es senki nem megy oda. Ez NEM jelenti, hogy az alvo tetelek a
  // Ma nezetbe kerulnek: csak LATSZODJANAK onnan, egy sorban, kattinthato szammal.
  const alvo = db
    .prepare(
      `SELECT count(*) AS db, min(next_step_at) AS legkozelebbi
         FROM leads
        WHERE status = 'open' AND next_step_type = 'wakeup' AND next_step_at >= ?`,
    )
    .get(napVege) as { db: number; legkozelebbi: number | null }

  return {
    status: 200,
    body: {
      leads: sorok,
      sleeping: { count: alvo.db, next_wake_at: alvo.legkozelebbi },
    },
  }
}
