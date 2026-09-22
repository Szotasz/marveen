/**
 * A küldés-állapotgép TISZTA része (CRM 2. ütem, G2 -- CRM2SENDSTATE922).
 *
 * MÉRVADÓ: `workspace/CRM-SAMU-RENDSZER-OLDAL.md` 7. és 9. szakasz, és
 * `workspace/CRM-GERI-KAPUK-ES-NYOM.md` 2. szakasz.
 *
 * MIÉRT VAN: a néma duplikálás. A felhasználó nem lát visszajelzést, ezért újraküld. Ez a modul
 * azt a pontot zárja, ahol ma a "zöld válasz" és a "kézbesítve" összemosódik: a HTTP 200 önmagában
 * NEM bizonyíték. Mértük ugyanezt az alakot máshol, ahol a zöld válasz a BEKÜLDÖTT SORT olvasta
 * vissza, nem a kézbesítést.
 *
 * NINCS BENNE I/O ÉS NINCS BENNE VALÓDI KÜLDÉS. Ebben az ütemben a szolgáltatói hívás STUB
 * (`send-provider-stub.ts`): ügyfélüzenet nem megy ki.
 */

export const SEND_STATES = ['draft', 'queued', 'accepted', 'failed', 'uncertain'] as const
export type SendState = (typeof SEND_STATES)[number]

export const PROVIDERS = ['gmail_api', 'smtp_support', 'resend'] as const
export type Provider = (typeof PROVIDERS)[number]

/**
 * AZ ÁTMENET-TÁBLA. Ötnél több állapot helyett kevesebb rossz átmenet (Samu 28220): a "nyom
 * hiányos" NEM hatodik állapot, hanem az elfogadott JELÖLÉSE, mert a küldés-jogosultság azonos.
 *
 * Az `accepted` és a `failed` VÉGÁLLAPOT. Egy elutasított küldés újrapróbálása ÚJ kísérlet (új sor),
 * nem visszalépés: különben a sor elveszítené, hogy hányszor indult el valójában.
 * Az `uncertain -> queued` az EGYETLEN visszaút, és az is csak ellenőrzés után (lásd send-routes).
 */
const ATMENETEK: Record<SendState, readonly SendState[]> = {
  draft: ['queued'],
  queued: ['accepted', 'failed', 'uncertain'],
  uncertain: ['accepted', 'failed', 'queued'],
  accepted: [],
  failed: [],
}

export function transitionAllowed(from: SendState, to: SendState): boolean {
  return (ATMENETEK[from] ?? []).includes(to)
}

/** Amit a szolgáltatótól kapunk. A "nincs ítélet" KÜLÖN eset, nem egy státusz-szám. */
export type ProviderOutcome =
  | {
      kind: 'response'
      http_status: number
      provider_msg_id?: string | null
      thread_id_provider?: string | null
      sent_folder_uid?: string | null
    }
  /** Időtúllépés, értelmezhetetlen válasz, megszakadt kapcsolat: NEM hiba, hanem a TUDÁS hiánya. */
  | { kind: 'no_verdict'; reason: string }

export type Classification = {
  state: SendState
  /** A hiányzó TANÚ neve az elfogadotton. NULL, ha a nyom teljes. */
  audit_gap: string | null
  evidence: {
    provider_msg_id: string | null
    thread_id_provider: string | null
    sent_folder_uid: string | null
    http_status: number | null
  }
  /** Mi hiányzott a bizonyítékból. Az ÜZENET ebből épül, ezért mérhető. */
  missing: string[]
  message: string
}

const TANU_NEVE: Record<string, string> = {
  provider_msg_id: 'a szolgáltató levél-azonosítója',
  thread_id_provider: 'a szolgáltatói szál-azonosító',
  sent_folder_uid: 'az elküldött mappába írt másolat azonosítója',
  rfc_message_id: 'a saját, küldés előtt generált Message-ID',
  http_status: 'a szolgáltató válasz-státusza',
}

/**
 * A BIZONYÍTÉK ÚTONKÉNT MÁS (Samu mérése, 7. szakasz). Ez nem elegancia-kérdés: ma EGYIK út sem
 * rögzít szolgáltatói azonosítót, tehát a "Sent mappa mint második tanú" nem meglévő képesség,
 * hanem KÖVETKEZMÉNY, ami csak a saját Message-ID bevezetése után áll be.
 *
 * ELFOGADVA CSAK TIPIZÁLT BIZONYÍTÉKKAL, bizonyíték nélkül BIZONYTALAN, SOSEM elfogadva.
 */
export function classifyOutcome(
  provider: Provider,
  rfcMessageId: string,
  outcome: ProviderOutcome,
): Classification {
  const ures = { provider_msg_id: null, thread_id_provider: null, sent_folder_uid: null, http_status: null }

  if (outcome.kind === 'no_verdict') {
    return {
      state: 'uncertain',
      audit_gap: null,
      evidence: ures,
      missing: ['http_status'],
      message:
        'A küldés elindult, de nincs szolgáltatói nyugtánk (' + outcome.reason + '). Ez NEM azt ' +
        'jelenti, hogy nem ment ki: azt jelenti, hogy nem tudjuk. Mielőtt bármit újraküldenél, ' +
        'ellenőriztetni kell az állapotot a saját Message-ID-vel.',
    }
  }

  const ev = {
    provider_msg_id: outcome.provider_msg_id ?? null,
    thread_id_provider: outcome.thread_id_provider ?? null,
    sent_folder_uid: outcome.sent_folder_uid ?? null,
    http_status: outcome.http_status,
  }

  const sikeresHttp = outcome.http_status >= 200 && outcome.http_status < 300
  const smtpElfogadta = outcome.http_status === 250

  if (provider === 'smtp_support') {
    if (!smtpElfogadta) {
      return { state: 'failed', audit_gap: null, evidence: ev, missing: [], message: megtagadasSzoveg(provider, outcome.http_status) }
    }
    // A HÁROM TAG NEM EGYENRANGÚ (Samu élesítése, 28215).
    //
    // A 250 ÖNMAGÁBAN bizonytalan: ez a legcsábítóbb hamis zöld, mert úgy néz ki, mint a siker.
    // Megjegyzendő kockázat, és KIMONDOM, nem elrejtem: ebben az ágban a levél a valóságban
    // valószínűleg KIMENT, és egy újraküldés duplikálna. Ezért a saját Message-ID a küldés
    // ELŐFELTÉTELE (lásd send-routes: a sorba állítás megtagadja nélküle), tehát ez az ág a mi
    // utunkon nem áll elő; ha mégis, az újraküldés csak KIMONDOTT tudomásulvétellel megy.
    if (!rfcMessageId.trim()) {
      return {
        state: 'uncertain',
        audit_gap: null,
        evidence: ev,
        missing: ['rfc_message_id'],
        message:
          'A szolgáltató 250-et adott, de nincs saját Message-ID-nk ehhez a küldéshez. A 250 ' +
          'önmagában nem bizonyíték, és keresni sem tudunk utána: ezért az állapot bizonytalan. ' +
          'Ezen az úton később SEM lesz mérőeszközünk, amíg a saját Message-ID nincs bevezetve.',
      }
    }
    if (!ev.sent_folder_uid) {
      // ELFOGADVA, NYOM HIÁNYOS: a levél KIMENT (a 250 + a saját azonosító ezt mondja), csak a
      // másolat nem íródott be. Ez NEM bizonytalan: ha egy állapotba esne, a felhasználó pont ott
      // nyomna újraküldést, ahol a levél már kint van.
      return {
        state: 'accepted',
        audit_gap: 'sent_folder_uid',
        evidence: ev,
        missing: ['sent_folder_uid'],
        message:
          'Elküldve, de a nyom hiányos: ' + TANU_NEVE.sent_folder_uid + ' nem került be. ' +
          'A levél KIMENT, ezért újraküldeni TILOS. A teendő a másolat pótlása, és erről feladat ' +
          'készült, hogy ne csak jelvény maradjon.',
      }
    }
    return { state: 'accepted', audit_gap: null, evidence: ev, missing: [], message: elfogadvaSzoveg(provider) }
  }

  if (!sikeresHttp) {
    return { state: 'failed', audit_gap: null, evidence: ev, missing: [], message: megtagadasSzoveg(provider, outcome.http_status) }
  }

  const kell: string[] = provider === 'gmail_api' ? ['provider_msg_id', 'thread_id_provider'] : ['provider_msg_id']
  const missing = kell.filter((k) => !ev[k as 'provider_msg_id' | 'thread_id_provider'])
  if (missing.length) {
    return {
      state: 'uncertain',
      audit_gap: null,
      evidence: ev,
      missing,
      message:
        'A szolgáltató ' + outcome.http_status + '-t adott, de a bizonyíték hiányos (' +
        missing.map((m) => TANU_NEVE[m] ?? m).join(', ') + '). A státusz-szám önmagában nem ' +
        'kézbesítés, ezért az állapot bizonytalan, nem elfogadott.',
    }
  }
  return { state: 'accepted', audit_gap: null, evidence: ev, missing: [], message: elfogadvaSzoveg(provider) }
}

function elfogadvaSzoveg(provider: Provider): string {
  return provider === 'resend'
    ? 'A szolgáltató elfogadta, az azonosító megvan. Ezen az úton NINCS helyi másolat, tehát egy ' +
        'későbbi ellenőrzés csak a szolgáltatótól kérdezhető.'
    : 'A szolgáltató elfogadta, és a bizonyíték teljes. Az elküldött mappában ott a másolat, tehát ' +
        'egy későbbi ellenőrzésnek van hol keresnie.'
}

function megtagadasSzoveg(provider: Provider, status: number): string {
  return (
    'A szolgáltató elutasította (' + status + '). Ez NEM bizonytalan állapot: van ítéletünk, a ' +
    'levél nem ment ki. Új küldés ÚJ kísérlet, a javított tartalommal.'
  )
}

/**
 * A BIZONYTALAN FELOLDÁSÁNAK KULCSA A SAJÁT MESSAGE-ID (Samu, 9. szakasz).
 *
 * És a felhasználónak MEG KELL MONDANI, mit keresünk és melyik úton mire számíthat. A támogatási
 * úton a saját Message-ID bevezetéséig a keresés semmit nem talál, és ez "NINCS MÉRŐESZKÖZ", nem
 * "nem ment ki". A kettőt a felhasználó nem tudja szétválasztani, ha nem mondjuk meg.
 */
export function lookupPlan(provider: Provider, rfcMessageId: string): { hol: string; mire_szamithatsz: string } {
  if (provider === 'resend') {
    return {
      hol: 'a szolgáltatónál, a ' + rfcMessageId + ' azonosítóval',
      mire_szamithatsz:
        'Ezen az úton NINCS helyi másolat, tehát a válasz csak a szolgáltatótól jöhet. Ha ő nem ' +
        'tud róla, az valódi "nincs bizonyíték".',
    }
  }
  if (provider === 'gmail_api') {
    return {
      hol: 'az elküldött mappában, a ' + rfcMessageId + ' azonosítóval',
      mire_szamithatsz: 'Ezen az úton a másolat szálazható, tehát a keresés érdemi választ ad.',
    }
  }
  return {
    hol: 'az elküldött mappában, a ' + rfcMessageId + ' azonosítóval',
    mire_szamithatsz:
      'FIGYELEM: ezen az úton a másolat MA Message-ID és Date nélkül íródik be, tehát a keresés ' +
      'akkor sem talál semmit, ha a levél kiment. Ez NINCS MÉRŐESZKÖZ, nem "nem ment ki". ' +
      'Amíg a saját Message-ID nincs bevezetve a küldő oldalon, ez az út nem oldható fel.',
  }
}
