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
import { checkLeadInput, startOfLocalDay, type LeadInput } from './leads-gate.js'

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
  const szerzo = typeof actor === 'string' ? actor.trim() : ''
  if (!szerzo) {
    return {
      status: 400,
      body: {
        error: 'nincs szerzo',
        message:
          'A lead felvételéhez megnevezett szerző kell. Lead sosem keletkezik szinkronból: ' +
          'ha egy levélből akarsz leadet nyitni, az is kimondott művelet, a te nevedben.',
      },
    }
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
    if (contactId === null && (v.display_name || v.email || v.phone)) {
      const r = db
        .prepare('INSERT INTO contacts (display_name, created_at, created_by) VALUES (?,?,?)')
        .run(v.display_name ?? v.email ?? v.phone, most, szerzo)
      contactId = Number(r.lastInsertRowid)
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
    audit(db, szerzo, 'lead', leadId, 'create', JSON.stringify({ next_step_at: v.next_step_at, next_step_type: v.next_step_type }))
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
