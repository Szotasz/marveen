/**
 * A küldés-végpontok (CRM 2. ütem, G2 -- CRM2SENDSTATE922).
 *
 * SZÁNDÉKOSAN KERETRENDSZER-FÜGGETLEN, ahogy a lead-végpontok: nyitott better-sqlite3 kapcsolat +
 * törzs -> `{status, body}`. Így a váz bármilyen HTTP-réteget használ, ez beilleszthető, és a teszt
 * futtathatja szerver nélkül.
 *
 * VALÓDI KÜLDÉS NINCS: a szolgáltatót a `SendProvider` STUB képviseli.
 */
import type { Database } from 'better-sqlite3'
import { checkActor } from './leads-gate.js'
import {
  PROVIDERS,
  classifyOutcome,
  lookupPlan,
  transitionAllowed,
  type Provider,
  type ProviderOutcome,
  type SendState,
} from './send-state.js'
import type { SendProvider } from './send-provider-stub.js'

export type ApiResult = { status: number; body: Record<string, unknown> }

/**
 * A nyom-hiány pótlásának határideje. NEM kerek szám kedvéért kettő: a másolatot addig érdemes
 * pótolni, amíg a levél még visszakereshető, és egy határidő nélküli feladat pontosan úgy kopik el,
 * mint a mai "Ertesites: nem ment" sor, amit egy napon tízszer olvastunk el és tízszer léptünk tovább.
 */
export const AUDIT_GAP_TASK_DUE_DAYS = 2

type AttemptRow = {
  id: number
  rfc_message_id: string
  provider: Provider
  state: SendState
  audit_gap: string | null
  actor: string
  requested_at: number
}

function audit(db: Database, actor: string, entityId: number | null, action: string, detail: string): void {
  db.prepare('INSERT INTO audit_log (at, actor, entity, entity_id, action, detail) VALUES (?,?,?,?,?,?)').run(
    Math.floor(Date.now() / 1000), actor, 'send_attempt', entityId, action, detail,
  )
}

function loadAttempt(db: Database, id: number): AttemptRow | undefined {
  return db
    .prepare('SELECT id, rfc_message_id, provider, state, audit_gap, actor, requested_at FROM send_attempts WHERE id = ?')
    .get(id) as AttemptRow | undefined
}

function szerzoKapu(actor: string): { ok: true; actor: string } | { ok: false; result: ApiResult } {
  const kapu = checkActor(actor)
  if (kapu.ok) return { ok: true, actor: kapu.actor }
  return {
    ok: false,
    result: {
      status: 400,
      body: { error: kapu.reason === 'empty' ? 'nincs szerzo' : 'tul hosszu szerzo', message: kapu.message },
    },
  }
}

/**
 * A SORBA ÁLLÍTÁS. A saját Message-ID ELŐFELTÉTEL, nem melléktermék.
 *
 * MIÉRT KAPU ÉS NEM ALAPÉRTELMEZÉS: ez az idempotencia-kulcs. Enélkül a bizonytalan állapot
 * SOSEM oldható fel (nincs mivel keresni a Sent mappában vagy a szolgáltatónál), tehát egy
 * azonosító nélkül elindított küldés egy jövőbeli néma duplikálás. A szolgáltatás nem generál
 * helyette csendben: aki hív, az adja meg, és a hiány MEGTAGADÁS.
 */
export function queueSend(
  db: Database,
  body: { rfc_message_id?: unknown; provider?: unknown; lead_id?: unknown },
  actor: string,
  now: Date = new Date(),
): ApiResult {
  const sz = szerzoKapu(actor)
  if (!sz.ok) return sz.result

  const hianyzik: string[] = []
  // A HARMADIK ÁLLAPOT ("megadta, de üresen") a trim UTÁN dől el, minden kapcsolónál külön.
  const rfc = typeof body.rfc_message_id === 'string' ? body.rfc_message_id.trim() : ''
  if (!rfc) hianyzik.push('rfc_message_id')
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  if (!(PROVIDERS as readonly string[]).includes(provider)) hianyzik.push('provider')

  if (hianyzik.length) {
    audit(db, sz.actor, null, 'send_queue_refused', JSON.stringify({ missing: hianyzik }))
    return {
      status: 422,
      body: {
        error: 'hianyzo kuldes-adat',
        missing: hianyzik,
        message:
          'Ezt a küldést nem állítom sorba. Hiányzik: ' +
          hianyzik
            .map((h) =>
              h === 'rfc_message_id'
                ? 'a saját Message-ID, amit a küldés ELŐTT kell megadni'
                : 'a küldési út (gmail_api, smtp_support, resend)',
            )
            .join(', ') +
          '. A saját Message-ID az idempotencia-kulcs: enélkül egy bizonytalanná vált küldés ' +
          'később nem kereshető vissza, és pont ott fogsz újraküldeni, ahol a levél már kiment.',
      },
    }
  }

  const most = Math.floor(now.getTime() / 1000)
  const res = db
    .prepare('INSERT INTO send_attempts (rfc_message_id, provider, requested_at, state, actor) VALUES (?,?,?,?,?)')
    .run(rfc, provider, most, 'queued' satisfies SendState, sz.actor)
  const id = Number(res.lastInsertRowid)
  audit(db, sz.actor, id, 'send_queued', JSON.stringify({ rfc_message_id: rfc, provider }))
  return { status: 201, body: { id, state: 'queued', rfc_message_id: rfc, provider } }
}

/**
 * A SZOLGÁLTATÓI VÁLASZ RÖGZÍTÉSE. Itt dől el az állapot, és itt születik a nyom-hiány jelölése.
 *
 * A JELÖLÉS UGYANABBAN A TRANZAKCIÓBAN FELADATOT ÍR. Ez Samu élesítése (28220), és erősebb, mint
 * egy felületi jelvény: így a teendő nem attól függ, hogy a felület megjeleníti-e.
 */
export function recordOutcome(
  db: Database,
  attemptId: number,
  actor: string,
  outcome: ProviderOutcome,
  now: Date = new Date(),
  opts: { lead_id?: number | null } = {},
): ApiResult {
  const sz = szerzoKapu(actor)
  if (!sz.ok) return sz.result

  const sor = loadAttempt(db, attemptId)
  if (!sor) return { status: 404, body: { error: 'nincs ilyen kuldes-kiserlet' } }

  // A KIMENET ALAKJA IS MERENDO (Samu lelete). Enelkul egy hianyzo vagy rossz alaku `outcome`
  // TypeError-ba fut, amit a HTTP-reteg 413 "request failed"-kent mutat -- vagyis egy ROSSZ KERES
  // ugy nez ki, mint egy tul nagy torzs, es a hivo a rossz helyen keresi a hibat.
  const alak = outcome as Partial<ProviderOutcome> | null | undefined
  const alakHibas =
    !alak ||
    typeof alak !== 'object' ||
    (alak.kind !== 'response' && alak.kind !== 'no_verdict') ||
    (alak.kind === 'response' && typeof (alak as { http_status?: unknown }).http_status !== 'number')
  if (alakHibas) {
    return {
      status: 400,
      body: {
        error: 'rossz alaku kimenet',
        message:
          'A szolgáltatói kimenet vagy `{kind:"response", http_status:<szám>, ...}`, vagy ' +
          '`{kind:"no_verdict", reason:"..."}`. A hiányzó válasz NEM ugyanaz, mint egy státusz-szám: ' +
          'az egyik a tudás hiánya, a másik ítélet, és a kettő más állapotba visz.',
      },
    }
  }

  const k = classifyOutcome(sor.provider, sor.rfc_message_id, outcome)
  if (!transitionAllowed(sor.state, k.state)) {
    return {
      status: 409,
      body: {
        error: 'tiltott atmenet',
        from: sor.state,
        to: k.state,
        message:
          `Ez a küldés ${sor.state} állapotban áll, onnan a(z) ${k.state} nem következhet. ` +
          'Az elfogadott és a sikertelen VÉGÁLLAPOT: egy újabb próbálkozás ÚJ kísérlet, nem ' +
          'ennek a sornak az átírása, különben elveszne, hányszor indult el valójában.',
      },
    }
  }

  const most = Math.floor(now.getTime() / 1000)
  const tranzakcio = db.transaction(() => {
    db.prepare(
      `UPDATE send_attempts
          SET state = ?, http_status = ?, provider_msg_id = ?, thread_id_provider = ?,
              sent_folder_uid = ?, audit_gap = ?
        WHERE id = ?`,
    ).run(
      k.state, k.evidence.http_status, k.evidence.provider_msg_id, k.evidence.thread_id_provider,
      k.evidence.sent_folder_uid, k.audit_gap, attemptId,
    )

    let taskId: number | null = null
    if (k.audit_gap) {
      const r = db
        .prepare(
          'INSERT INTO tasks (lead_id, kind, due_at, owner, text, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          opts.lead_id ?? null,
          'audit_gap',
          most + AUDIT_GAP_TASK_DUE_DAYS * 86400,
          sz.actor,
          `A küldés nyoma hiányos (${k.audit_gap}), a levél KIMENT. Pótold a másolatot az elküldött ` +
            `mappában. Message-ID: ${sor.rfc_message_id}. Újraküldeni TILOS.`,
          most,
          sz.actor,
        )
      taskId = Number(r.lastInsertRowid)
    }

    audit(db, sz.actor, attemptId, 'send_outcome', JSON.stringify({
      state: k.state, audit_gap: k.audit_gap, missing: k.missing, task_id: taskId,
    }))
    return taskId
  })

  const taskId = tranzakcio()
  return {
    status: 200,
    body: {
      id: attemptId,
      state: k.state,
      audit_gap: k.audit_gap,
      missing: k.missing,
      message: k.message,
      task_id: taskId,
      // KÖZVETLENÜL EGY KIMENET UTÁN AZ ÚJRAKÜLDÉS SOSEM ENGEDETT, és ez nem óvatosság:
      // elfogadottnál tilos (kiment), sikertelennél új kísérlet kell, bizonytalannál pedig előbb
      // az ellenőrzés fut. Ezért itt nincs elágazás, egyetlen érték áll.
      resend_allowed: false,
      ...(k.state === 'uncertain' ? { next: lookupPlan(sor.provider, sor.rfc_message_id) } : {}),
    },
  }
}

/**
 * A BIZONYTALAN ELLENŐRZÉSE a saját Message-ID-vel. Ez a felületen az "Állapot ellenőrzése", és
 * SZÁNDÉKOSAN külön művelet a küldéstől: bizonytalan állapotban nincs "Küldés újra" gomb.
 */
export function checkUncertain(
  db: Database,
  attemptId: number,
  actor: string,
  szolgaltato: SendProvider,
  now: Date = new Date(),
): ApiResult {
  const sz = szerzoKapu(actor)
  if (!sz.ok) return sz.result
  const sor = loadAttempt(db, attemptId)
  if (!sor) return { status: 404, body: { error: 'nincs ilyen kuldes-kiserlet' } }
  if (sor.state !== 'uncertain') {
    return {
      status: 409,
      body: { error: 'nem bizonytalan', state: sor.state, message: 'Csak bizonytalan állapotot van értelme ellenőrizni.' },
    }
  }

  const terv = lookupPlan(sor.provider, sor.rfc_message_id)
  const talalat = szolgaltato.lookupByMessageId(sor.provider, sor.rfc_message_id)
  const most = Math.floor(now.getTime() / 1000)

  if (talalat.kind === 'found') {
    const tranzakcio = db.transaction(() => {
      db.prepare(
        `UPDATE send_attempts SET state = 'accepted', provider_msg_id = COALESCE(?, provider_msg_id),
            thread_id_provider = COALESCE(?, thread_id_provider), sent_folder_uid = COALESCE(?, sent_folder_uid)
          WHERE id = ?`,
      ).run(talalat.provider_msg_id ?? null, talalat.thread_id_provider ?? null, talalat.sent_folder_uid ?? null, attemptId)
      audit(db, sz.actor, attemptId, 'send_check', JSON.stringify({ result: 'found', searched: sor.rfc_message_id, at: most }))
    })
    tranzakcio()
    return {
      status: 200,
      body: {
        id: attemptId, state: 'accepted', found: true, searched: sor.rfc_message_id, where: terv.hol,
        message: 'Megvan: a levél kiment. Az állapot elfogadott, újraküldeni nem kell és nem is szabad.',
      },
    }
  }

  audit(db, sz.actor, attemptId, 'send_check', JSON.stringify({
    result: talalat.kind, searched: sor.rfc_message_id, at: most,
  }))

  if (talalat.kind === 'no_instrument') {
    // A KÜLÖNBSÉG, AMIT KI KELL MONDANI: "nincs bizonyíték" kontra "nincs mérőeszköz".
    return {
      status: 200,
      body: {
        id: attemptId, state: 'uncertain', found: false, measurable: false,
        searched: sor.rfc_message_id, where: terv.hol, expect: terv.mire_szamithatsz,
        message:
          'NEM TALÁLTUNK SEMMIT, DE EZ NEM AZT JELENTI, HOGY NEM MENT KI. ' + talalat.reason +
          '. Ezen az úton ma nincs mérőeszközünk, tehát az újraküldés kockázatot vállal: ha a ' +
          'levél kiment, duplikálni fog. Ezért itt az újraküldés kimondott tudomásulvételt kér.',
        resend_allowed: false,
        resend_requires: 'acknowledge_no_instrument',
      },
    }
  }

  return {
    status: 200,
    body: {
      id: attemptId, state: 'uncertain', found: false, measurable: true,
      searched: sor.rfc_message_id, where: terv.hol, expect: terv.mire_szamithatsz,
      message:
        'Kerestük, és nincs ott: ez valódi "nincs bizonyíték". Küldhető újra UGYANAZZAL a kulccsal ' +
        '(ez nem új levél, ugyanaz a Message-ID megy ki).',
      resend_allowed: true,
    },
  }
}

/**
 * ÚJRAKÜLDÉS UGYANAZZAL A KULCCSAL. Három kapu áll előtte, és mind a három egy mért hibából jön.
 */
export function requestResend(
  db: Database,
  attemptId: number,
  actor: string,
  opts: { acknowledge_no_instrument?: unknown } = {},
  now: Date = new Date(),
): ApiResult {
  const sz = szerzoKapu(actor)
  if (!sz.ok) return sz.result
  const sor = loadAttempt(db, attemptId)
  if (!sor) return { status: 404, body: { error: 'nincs ilyen kuldes-kiserlet' } }

  // (1) ELFOGADOTT VAGY NYOM-HIÁNYOS: a levél KIMENT. A küldés-jogosultság a kettőnél azonos, és
  //     pont ezért nem hatodik állapot a nyom-hiány.
  if (sor.state === 'accepted' || sor.audit_gap) {
    return {
      status: 409,
      body: {
        error: 'ujrakuldes tiltott',
        state: sor.state,
        audit_gap: sor.audit_gap,
        message: sor.audit_gap
          ? `Ez a levél KIMENT, csak a nyoma hiányos (${sor.audit_gap}). Újraküldeni tilos, mert ` +
            'duplikálna. A teendő a másolat pótlása, és erről feladat áll.'
          : 'Ez a levél kiment és a bizonyíték teljes. Újraküldeni tilos.',
      },
    }
  }
  if (sor.state === 'failed') {
    return {
      status: 409,
      body: {
        error: 'ujrakuldes tiltott', state: sor.state,
        message: 'Ez a küldés elutasításra került, van ítéletünk. Az új küldés ÚJ kísérlet, a javított tartalommal.',
      },
    }
  }
  if (sor.state !== 'uncertain') {
    return { status: 409, body: { error: 'ujrakuldes tiltott', state: sor.state, message: 'Csak bizonytalan állapotból van értelme.' } }
  }

  // (2) ELŐBB ELLENŐRZÉS. Bizonytalan állapotban a "Küldés újra" nem az első gomb: ma ez a
  //     leggyakoribb néma duplikálás forrása.
  //     AZ ELLENORZESNEK A LEGUTOBBI KIMENET UTAN KELL KESZULNIE (Samu lelete a #1472 review-jan).
  //     MERVE a javitas elott: queue -> outcome(no_verdict) -> check -> resend -> outcome(no_verdict)
  //     -> resend UJ CHECK NELKUL is atment, mert a lekerdezes csak azt nezte, VAN-E valaha check.
  //     Vagyis a masodik korben egy ELAVULT ellenorzes engedte at az ujrakuldest -- es pont a
  //     bizonytalan -> ujrakuldes -> bizonytalan ciklus az, ahol ez szamit: ott halmozodik a nema
  //     duplikalas. A kapu ezert a LEGUTOBBI send_outcome/send_resend sor UTANI checket keresi.
  //     A LISTA `send_resend` TAGJA MA REDUNDANS, ES SZANDEKOSAN ALL ITT (Samu merte mutanssal,
  //     #1472 review; a tag elhagyasa TULELO, EKVIVALENS mutans). Ma ugyanis a kapu csak
  //     `uncertain` allapotban fut, oda pedig EGYEDUL a `recordOutcome` visz, ami ugyanabban a
  //     tranzakcioban `send_outcome` sort ir -- tehat a ket halmaz maximuma azonos. A tag azert
  //     marad, mert a kapu nem tamaszkodhat egy MASIK fuggveny invarianciajara: ha egy kesobbi iro
  //     kimenet-sor nelkul visz `uncertain`-be, nelkule pont az elavult-checkes ujrakuldes allna
  //     vissza. Az ar egy SQL-tag, a kockazat egy nema duplikalas-ciklus. NE VEDD KI.
  const ellenorzes = db
    .prepare(
      `SELECT detail FROM audit_log
        WHERE entity = 'send_attempt' AND entity_id = ? AND action = 'send_check'
          AND id > COALESCE((SELECT max(id) FROM audit_log
                              WHERE entity = 'send_attempt' AND entity_id = ?
                                AND action IN ('send_outcome','send_resend')), 0)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(attemptId, attemptId) as { detail: string } | undefined
  if (!ellenorzes) {
    return {
      status: 409,
      body: {
        error: 'elobb ellenorzes',
        message:
          'Bizonytalan állapotból csak ellenőrzés után küldhető újra. Előbb az "Állapot ellenőrzése" ' +
          'fut le a saját Message-ID-vel, különben pont ott küldenél újra, ahol a levél már kiment. ' +
          'Egy KORÁBBI kör ellenőrzése nem számít: minden újabb kimenet után újra kell nézni, mert ' +
          'azóta megint kiment egy levél, amiről nem tudjuk, megérkezett-e.',
      },
    }
  }

  // (3) HA NINCS MÉRŐESZKÖZ, a kockázatot KI KELL MONDANI. Nem tiltjuk (a levél tényleg elveszhetett),
  //     de nem is engedjük át csendben egy sikeresnek látszó ellenőrzés mögött.
  const eredmeny = JSON.parse(ellenorzes.detail) as { result?: string }
  if (eredmeny.result === 'no_instrument' && opts.acknowledge_no_instrument !== true) {
    return {
      status: 409,
      body: {
        error: 'nincs meroeszkoz',
        message:
          'Ezen az úton nem tudtuk ellenőrizni, kiment-e a levél (a másolat ma Message-ID nélkül ' +
          'készül). Ha most újraküldesz, és a levél kiment, az ügyfél kétszer kapja meg. Ezt ' +
          'kimondottan tudomásul kell venned (acknowledge_no_instrument), mert a rendszer nem ' +
          'tudja helyetted eldönteni.',
        resend_requires: 'acknowledge_no_instrument',
      },
    }
  }

  const most = Math.floor(now.getTime() / 1000)
  const tranzakcio = db.transaction(() => {
    db.prepare('UPDATE send_attempts SET state = ?, requested_at = ? WHERE id = ?').run('queued' satisfies SendState, most, attemptId)
    audit(db, sz.actor, attemptId, 'send_resend', JSON.stringify({
      rfc_message_id: sor.rfc_message_id,
      acknowledged_no_instrument: eredmeny.result === 'no_instrument' ? true : undefined,
    }))
  })
  tranzakcio()

  return {
    status: 200,
    body: {
      id: attemptId, state: 'queued', rfc_message_id: sor.rfc_message_id,
      message:
        'Újraküldés UGYANAZZAL a kulccsal. Ez nem új levél: ugyanaz a Message-ID megy ki, tehát ' +
        'ha a régi mégis megérkezett, a kettő összetartozik és később összevezethető.',
    },
  }
}

/** A három lépés egyben, ahogy a HTTP-réteg hívná: sorba áll, hív (STUB), rögzít. */
export function performSend(
  db: Database,
  szolgaltato: SendProvider,
  body: { rfc_message_id?: unknown; provider?: unknown; lead_id?: unknown },
  actor: string,
  now: Date = new Date(),
): ApiResult {
  const sorbaAllitas = queueSend(db, body, actor, now)
  if (sorbaAllitas.status !== 201) return sorbaAllitas
  const id = Number(sorbaAllitas.body.id)
  const kimenet = szolgaltato.send(sorbaAllitas.body.provider as Provider, String(sorbaAllitas.body.rfc_message_id))
  const lead = typeof body.lead_id === 'number' ? body.lead_id : null
  return recordOutcome(db, id, actor, kimenet, now, { lead_id: lead })
}
