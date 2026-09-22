/**
 * A lead-felvétel kapuja (CRM 1. ütem, G1 -- CRM1LEADKAPU922).
 *
 * MÉRVADÓ SPEC: workspace/CRM-GERI-KAPUK-ES-NYOM.md 6. szakasz.
 *
 * MIÉRT VAN EGYÁLTALÁN: mérve a saját kanban táblánkon, négy meleg lead állt 79, 81, 84 és 100
 * napja ugyanabban az állapotban, közülük az egyiken NULLA komment 84 nap alatt. Az észlelés
 * működött (a reggeli javaslat mind a négyet néven nevezte, 61 nappal korábban), a LEZÁRÁS nem.
 * Egy felület, ami csak kategorizál és listáz, ezt pontosan reprodukálná. Ezért az első funkció
 * nem a nézet, hanem ez a kapu.
 *
 * A KAPU A TARTALMAT MÉRI, NEM A DEKLARÁCIÓT. Ez nem stílus: 2026-09-22-én élesben mértük, hogy
 * egy ÜRES fájl teljesített egy követelményt, miközben semmi nem történt -- a kapu az útvonalat
 * nézte, a hatás a tartalmon múlt. Itt ugyanez két alakban állna elő: az üres szöveg és a távoli
 * dátum. Mindkettőt itt zárjuk.
 */

/** A következő érintkezés típusai. EGY HELYEN, mert a séma CHECK-je ezt tükrözi. */
export const NEXT_STEP_TYPES = ['email', 'call', 'meeting', 'offer', 'wakeup'] as const
export type NextStepType = (typeof NEXT_STEP_TYPES)[number]

/**
 * A dátum-horizont felső határa NAPBAN. A távoli dátum a kibúvó: aki "majd valamikor"-t akar
 * rögzíteni, az ezzel kerülné meg a kaput.
 *
 * A 14 NAP CSAK A CSELEKVÉSRE VONATKOZIK. A korlát két különböző dolgot mosna össze: "mikor fogok
 * cselekedni" és "mikor érdemes cselekedni". Az elsőre jó, a másodikat HAZUGSÁGRA kényszerítené:
 * ha az ügyfél novemberben kéri a hívást, a felvevő beírna egy közeli dátumot, amit ő sem hisz el,
 * majd azonnal halasztana -- és a halasztás-számláló egy teljesen egészséges tételen indulna el.
 *
 * EZÉRT VAN A "wakeup" TÍPUS (döntés: Marveen, 2026-09-22): ott a horizont 12 hónap, a tétel ALSZIK
 * a megadott dátumig, és NEM számít halasztásnak. A kivételt a TÍPUS hordozza, nem egy szabad
 * szöveges indok: a típus választás, nem lehet átfogalmazni, és meg lehet számolni.
 */
export const HORIZON_DAYS = 14
/** Az ébresztés horizontja. Felső korlát azért van, mert a "majd valamikor" itt is kibúvó lenne. */
export const WAKEUP_HORIZON_DAYS = 365

/**
 * A SZERZO-KAPU (Samu strukturalis dontese, 2026-09-22; spec 4. szakasz).
 *
 * A szabaly: trim UTAN 1..64 karakter. Ket kulonbozo dolgot zar, es mindketto valodi:
 *  - az ALSO hatar: "lead sosem szinkronbol". Egy szinkron-folyamatnak nincs szerzoje, tehat
 *    ezen az uton nem tud leadet nyitni. A szolgaltatas SOHA nem tolt szerzot konfigbol vagy
 *    konstansbol (nincs CRM_ACTOR, nincs 'system'), ezert az ures szerzo megtagadas, nem alapertek.
 *  - a FELSO hatar: a nev a NYOMBA kerul, es a nyom olvashato kell maradjon. Felso hatar nelkul
 *    egy beillesztett levelnyi szoveg is beallna nevnek, es a sor onmagat tenne olvashatatlanna.
 *    A hatar a KAPUBAN van, nem a semaban: a sema CHECK-je csak azt mondana, hogy nem ment be,
 *    azt nem, hogy miert -- es a felhasznalonak a miert kell.
 *
 * A szabaly MINDEN iro vegpontra all (leads, contacts, tasks, kesobb send_attempts.actor), ezert
 * all itt, a tiszta modulban, es nem a lead-utvonal belsejeben.
 */
export const ACTOR_MAX_LENGTH = 64

export type ActorOk = { ok: true; actor: string }
export type ActorRefusal = { ok: false; reason: 'empty' | 'too_long'; message: string }

export function checkActor(raw: unknown): ActorOk | ActorRefusal {
  const actor = typeof raw === 'string' ? raw.trim() : ''
  if (!actor) {
    return {
      ok: false,
      reason: 'empty',
      message:
        'A lead felvételéhez megnevezett szerző kell. Lead sosem keletkezik szinkronból: ' +
        'ha egy levélből akarsz leadet nyitni, az is kimondott művelet, a te nevedben.',
    }
  }
  // A hossz KARAKTERBEN ertendo, nem bajtban: az "Ékezetes Név" nem lehet mas hosszusagu
  // attol, hogy a tarolas UTF-8. A kodpont-szamlalas (Array.from) a helyes muszer.
  if (Array.from(actor).length > ACTOR_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'too_long',
      message:
        `A szerző neve legfeljebb ${ACTOR_MAX_LENGTH} karakter lehet. Ez a név kerül a nyomba, ` +
        'minden sor mellé: ha egy egész mondat áll ott, a nyom olvashatatlan lesz. ' +
        'Írd be a neved vagy a becenevedet.',
    }
  }
  return { ok: true, actor }
}

export type LeadInput = {
  title?: unknown
  origin?: unknown
  next_step_type?: unknown
  next_step_at?: unknown
  next_step_text?: unknown
  contact_id?: unknown
  display_name?: unknown
  email?: unknown
  phone?: unknown
}

export const ORIGINS = ['email', 'telegram', 'phone', 'meeting', 'referral', 'other'] as const

export type GateOk = {
  ok: true
  value: {
    title: string
    origin: string
    next_step_type: NextStepType
    next_step_at: number
    next_step_text: string
    contact_id: number | null
    display_name: string | null
    email: string | null
    phone: string | null
  }
}
export type GateRefusal = { ok: false; missing: string[]; message: string }

/**
 * A NAP HATARA NEVESITETT ZONABAN DOL EL, NEM A PROCESSZ ZONAJABAN (Samu kikotese, 28263).
 *
 * MIERT: a kapu "ma" es "ma+14" kozott enged. Ha ezt a futtato korotnyezetenek zonaja donti el, a
 * CI (UTC) es a gazda gepe (CEST) este 22 utan MAS NAPOT lat -- ugyanaz a bevitel az egyik helyen
 * atmegy, a masikon nem, es a kulonbseg semmibol nem latszik. Ezert a zona KIMONDOTT.
 */
export const CRM_TZ = process.env.CRM_TZ || 'Europe/Budapest'

/** Egy pillanat zona-eltolasa ezredmasodpercben, a zona sajat szabalyai szerint (nyari ido is). */
function zonaEltolasMs(at: Date, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const r: Record<string, string> = {}
  for (const p of f.formatToParts(at)) if (p.type !== 'literal') r[p.type] = p.value
  const mintUtc = Date.UTC(
    Number(r.year), Number(r.month) - 1, Number(r.day),
    Number(r.hour) % 24, Number(r.minute), Number(r.second),
  )
  return mintUtc - at.getTime()
}

/** A megadott zona szerinti nap eleje, epoch masodpercben. */
export function startOfLocalDay(at: Date, tz: string = CRM_TZ): number {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const [y, m, d] = f.format(at).split('-').map(Number)
  const ejfelUtcKent = Date.UTC(y, m - 1, d, 0, 0, 0)
  // Az eltolast MAGANAK A NAPNAK a pillanatan kerdezzuk, kulonben a nyari ido valtasa napjan csusznank.
  const eltolas = zonaEltolasMs(new Date(ejfelUtcKent), tz)
  return Math.floor((ejfelUtcKent - eltolas) / 1000)
}

/**
 * A dátum elfogadása NAP-alapú, nem másodperc-alapú: a "ma" és a "ma + 14 nap" is TELJES nap.
 * Enélkül a határ a futás órájától függne, és ugyanaz a bevitel délelőtt átmenne, délután nem.
 */
function normalizeDate(raw: unknown, now: Date): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw)
  if (typeof raw === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
    if (m) {
      // A datum-sztring IS a nevesitett zonaban ertendo, kulonben a bevitel es a hatar-szamitas
      // ket kulonbozo naptar szerint mozogna.
      const ejfelUtcKent = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0)
      const eltolas = zonaEltolasMs(new Date(ejfelUtcKent), CRM_TZ)
      return Math.floor((ejfelUtcKent - eltolas) / 1000)
    }
    const t = Date.parse(raw)
    if (!Number.isNaN(t)) return Math.floor(t / 1000)
  }
  return null
}

function asTrimmed(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * A megtagadás szövege. A LEGOLCSÓBB ÚT LEGYEN A HELYES ÚT: ezért nemcsak tilt, hanem megnevezi,
 * mi hiányzik, és felkínál egy működő minimumot. Ha a megtagadás csak tilt, a felhasználó a
 * FELVÉTELT hagyja el, nem a hibát javítja.
 */
export function refusalMessage(missing: string[], horizonDays = HORIZON_DAYS): string {
  const nev: Record<string, string> = {
    next_step_type: 'a következő érintkezés típusa (levél, hívás, találkozó, ajánlat)',
    next_step_at: `a következő lépés dátuma, a mai naptól számított ${horizonDays} napon belül (ébresztésnél ${WAKEUP_HORIZON_DAYS} napon belül)`,
    next_step_text: 'egy mondat arról, mit kell tenned',
    title: 'a lead megnevezése',
    origin: 'a lead forrása',
  }
  const lista = missing.map((k) => nev[k] ?? k).join(', ')
  return (
    'Ehhez a leadhez nincs teljes következő lépés, ezért nem mentem el. Hiányzik: ' + lista + '. ' +
    'Egy lead, aminek nincs dátumozott következő lépése, két hónap múlva is ugyanitt fog állni. ' +
    'Ha most nem tudod pontosan, az is válasz: vedd fel "ajánlás, hívás egy héten belül" formában, ' +
    'és pontosítsd, amikor többet tudsz. ' +
    'Ha az ügyfél későbbre kérte (például novemberben keressük), NE írj be hamis közeli dátumot: ' +
    'válaszd az "ébresztés" típust, és add meg a valódi dátumot. Az ilyen tétel alszik addig, ' +
    'nem számít halasztásnak, és a darabszáma a fő nézeten látszik.'
  )
}

/** A kapu maga. Tiszta függvény: nincs I/O, ezért külön mérhető és mutálható. */
export function checkLeadInput(input: LeadInput, now: Date = new Date()): GateOk | GateRefusal {
  const missing: string[] = []

  const title = asTrimmed(input.title)
  if (!title) missing.push('title')

  const origin = asTrimmed(input.origin) || 'other'
  if (!(ORIGINS as readonly string[]).includes(origin)) missing.push('origin')

  const type = asTrimmed(input.next_step_type)
  if (!(NEXT_STEP_TYPES as readonly string[]).includes(type)) missing.push('next_step_type')

  // A SZÖVEG A TRIM UTÁN dől el. A "megadta, de üresen" a HARMADIK állapot, és ugyanúgy megtagadás,
  // mint a hiány -- a kapcsoló-kapu suite-ja magától a megadta/nem-adta-meg tengelyen mérne.
  const text = asTrimmed(input.next_step_text)
  if (!text) missing.push('next_step_text')

  const at = normalizeDate(input.next_step_at, now)
  const dayStart = startOfLocalDay(now)
  // A HORIZONT A TÍPUSTÓL FÜGG: cselekvésre 14 nap, ébresztésre 12 hónap.
  const horizont = type === 'wakeup' ? WAKEUP_HORIZON_DAYS : HORIZON_DAYS
  const maxDay = dayStart + horizont * 86400
  if (at === null || at < dayStart || at >= maxDay + 86400) missing.push('next_step_at')

  if (missing.length) return { ok: false, missing, message: refusalMessage(missing) }

  const contactIdRaw = input.contact_id
  const contact_id =
    typeof contactIdRaw === 'number' && Number.isInteger(contactIdRaw) ? contactIdRaw : null

  return {
    ok: true,
    value: {
      title,
      origin,
      next_step_type: type as NextStepType,
      next_step_at: at as number,
      next_step_text: text,
      contact_id,
      // E-MAIL NEM KÖTELEZŐ: a gazda kérése szó szerint tartalmazza a telefonos, találkozós és
      // ajánlásos leadet, e-mail-cím nélkül is. Aki ide később "kötelező kapcsolat-mezőt" tesz,
      // pont azt a felvételt teszi lehetetlenné, amiért a kézi felvétel készül.
      display_name: asTrimmed(input.display_name) || null,
      email: asTrimmed(input.email) || null,
      phone: asTrimmed(input.phone) || null,
    },
  }
}
