/**
 * A szolgáltatói hívás STUB-ja (CRM 2. ütem, G2 -- CRM2SENDSTATE922).
 *
 * EBBEN AZ ÜTEMBEN VALÓDI KÜLDÉS NINCS, és ez nem ideiglenes kényelem, hanem kikötés: ügyfélnek
 * szóló üzenet a gazda GO-ja nélkül nem megy ki. Ami itt van: az INTERFÉSZ, amit a valódi
 * szolgáltató-réteg később kitölt, és fixtúra-válaszok a három út bizonyíték-alakjával.
 *
 * A stub ÉRTÉKE nem a "majd lecseréljük", hanem hogy a három út bizonyíték-alakja MA mérhető: a
 * hívó kód (send-routes) ugyanazt az utat járja, mint élesben, csak a válasz jön fixtúrából.
 */
import type { Provider, ProviderOutcome } from './send-state.js'

/** Amit egy KÉSŐBBI ellenőrzés a saját Message-ID-vel talál. */
export type LookupResult =
  /** Megvan: a levél kiment, itt a bizonyíték. */
  | { kind: 'found'; provider_msg_id?: string | null; thread_id_provider?: string | null; sent_folder_uid?: string | null }
  /** Kerestük, és nincs ott. Ez VALÓDI "nincs bizonyíték". */
  | { kind: 'not_found' }
  /**
   * Nem tudtunk keresni. Ez NEM ugyanaz, mint a not_found, és a kettő összemosása a legdrágább
   * hiba ezen a felületen: a támogatási úton a Sent-másolat ma Message-ID nélkül íródik be, tehát
   * a keresés akkor sem talál semmit, ha a levél kiment.
   */
  | { kind: 'no_instrument'; reason: string }

export interface SendProvider {
  /**
   * IGAZ, ha a válaszok fixtúrából jönnek, és NEM ment ki levél. A hívó ezt továbbadja a válaszban,
   * mert egy "elküldve" felirat, ami mögött fixtúra áll, pont az a hamis zöld, ami ellen ez a modul
   * készült. Egy valódi küldő-réteg FALSE-t ad, és attól kezdve a felirat is igazat mond.
   */
  readonly isStub: boolean
  /** A küldés. A STUB nem küld semmit: a fixtúra-választ adja vissza. */
  send(provider: Provider, rfcMessageId: string): ProviderOutcome
  /** A bizonytalan feloldása a SAJÁT Message-ID-vel. */
  lookupByMessageId(provider: Provider, rfcMessageId: string): LookupResult
}

export type StubFixtures = {
  send?: Partial<Record<Provider, ProviderOutcome>>
  lookup?: Partial<Record<Provider, LookupResult>>
}

/**
 * AZ ALAPÉRTELMEZETT FIXTÚRA A MA MÉRT VALÓSÁGOT TÜKRÖZI, nem a kívánt állapotot (Samu mérése,
 * rendszer-oldal 7. szakasz): egyik út sem rögzít ma szolgáltatói azonosítót, a támogatási úton
 * pedig a Sent-másolatban nincs Message-ID. Ha a stub optimista alapértelmezést adna, a tesztjeink
 * egy nem létező képességet bizonyítanának.
 */
export const MA_MERT_ALAP: Required<StubFixtures> = {
  send: {
    gmail_api: { kind: 'response', http_status: 200, provider_msg_id: 'gm-1', thread_id_provider: 'th-1' },
    resend: { kind: 'response', http_status: 200, provider_msg_id: 'rs-1' },
    smtp_support: { kind: 'response', http_status: 250, sent_folder_uid: null },
  },
  lookup: {
    gmail_api: { kind: 'not_found' },
    resend: { kind: 'not_found' },
    smtp_support: {
      kind: 'no_instrument',
      reason:
        'a támogatási úton az elküldött mappába írt másolat ma Message-ID és Date nélkül készül, ' +
        'tehát a saját azonosítónkkal nincs mit keresni',
    },
  },
}

export function createSendProviderStub(fixtures: StubFixtures = {}): SendProvider {
  return {
    isStub: true,
    send(provider, rfcMessageId) {
      void rfcMessageId // a stub nem küld: a paraméter az interfész miatt van itt
      const v = fixtures.send?.[provider] ?? MA_MERT_ALAP.send[provider]
      if (!v) throw new Error(`send-stub: nincs fixtura ehhez az uthoz: ${provider}`)
      return v
    },
    lookupByMessageId(provider, rfcMessageId) {
      void rfcMessageId
      const v = fixtures.lookup?.[provider] ?? MA_MERT_ALAP.lookup[provider]
      if (!v) throw new Error(`send-stub: nincs lookup-fixtura ehhez az uthoz: ${provider}`)
      return v
    },
  }
}
