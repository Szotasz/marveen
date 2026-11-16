// Support access: the consent text the owner sees before switching support
// standby on, bound to its version and its language (SUPPORTKULCS1109; Geri 78479, Samu 78475, Mira 79456).
//
// The launcher prints the text of exactly the version it will pass to
// `enable --consent <n>`, and takes that version from the status line
// `consent_version=<n>`. The text is the owner's: this file is its place, and
// a version without an approved text refuses (`consent_text_unset`) rather
// than show something nobody approved.
import { createHash } from 'node:crypto'

export type SupportConsentLang = 'hu' | 'en'
export const SUPPORT_CONSENT_LANGS: readonly SupportConsentLang[] = ['hu', 'en']
/** The launcher speaks Hungarian: what it prints, and so what the owner saw on that path, is the Hungarian text. */
export const SUPPORT_CONSENT_LAUNCHER_LANG: SupportConsentLang = 'hu'

/**
 * Approved texts by version and language. null = the version is known, its approved text is not in the source yet.
 *
 * Version 2 is, byte for byte, the consent the marveen.io Profile shows for version 2 in that language: the nine
 * support.consent.* values of its dictionary joined with "\n", no line end at the end (Mira 79450 / 79456, Tomi 79448).
 * The same number means the same text on both sides, so the machine's text never differs from the web's; a change
 * is a new version on both. The owner approved it (v2.3; Marveen 79432).
 */
export const SUPPORT_CONSENT_TEXTS: Readonly<Record<number, Readonly<Record<SupportConsentLang, string>> | null>> = {
  1: null,
  2: {
    hu: "Mit tehetünk a gépeden\nA belépés alatt a Marveen csapata, munkatársaink és AI-ügynökeink, mindent megtehetnek a gépeden, ami a hiba feltárásához és kijavításához szükséges: parancsokat futtathatnak, fájlokat és beállításokat olvashatnak és módosíthatnak, és újraindíthatják a Marveent és a szolgáltatásait. Azzal a felhasználóval dolgozunk, amelyikkel a Marveened fut; ennél több jogot nem szerzünk. Ha a Marveened rendszergazdaként (root) fut, mi is így lépünk be. A gépeden futtatott parancsokkal csak a hibát keressük és javítjuk; a helyi hálózatodon lévő más eszközökhöz nem nyúlunk.\nEgy kapcsolaton legfeljebb 60 percig adhatunk ki parancsot; utána újat csak egy munkatársunk nyithat, a saját fizikai kulcsával.\nMit látunk\nMindent, amit a javításhoz meg kell néznünk a gépeden: a Marveen naplóit, beállításait és adatait, ha kell, a tárolt hozzáférési kulcsokat és a beszélgetéseid részleteit is, azt is, amit te vagy a partnereid a csatornáidra írtatok.\nAmit a javítás közben látunk, kitakarva tároljuk: a munka részletes lefolyását legfeljebb 30 napig.\nNyom és ellenőrzés\nMinden lefuttatott parancs naplózódik a gépeden. A belépésekről szóló naplót 12 hónapig őrizzük. Az engedett belépésekről e-mailt kapsz.\nA hozzáférést a Profil oldaladon egy kattintással bármikor lezárhatod; az éppen futó művelet ezután még befejeződhet, újat nem indíthatunk.",
    en: "What we can do on your machine\nWhile we are signed in, the Marveen team, our staff and our AI agents, can do whatever is needed on your machine to find and fix the problem: run commands, read and change files and settings, and restart Marveen and its services. We work as the user your Marveen runs as; we do not gain any further rights. If your Marveen runs as the system administrator (root), we sign in that way too. We use the commands on your machine only to find and fix the problem; we do not touch other devices on your local network.\nOn one connection we can issue commands for at most 60 minutes; after that only a staff member can open a new one, with their own physical key.\nWhat we see\nWhatever we need to look at on your machine to fix the problem: Marveen's logs, settings and data, and if needed the stored access keys and the details of your conversations, including what you or your partners wrote on your channels.\nWhat we see while fixing is stored with secrets masked: the detailed record of the work for at most 30 days.\nRecord and control\nEvery command we run is logged on your machine. We keep the record of sign-ins for 12 months. You get an e-mail about allowed sign-ins.\nYou can lock access with one click on your Profile page at any time; an operation already running may still finish, but we cannot start a new one.",
  },
}

export type ConsentTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: 'consent_invalid' | 'consent_text_unset' }

function approved(version: number, lang: SupportConsentLang): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(SUPPORT_CONSENT_TEXTS, version)) return undefined
  const byLang = SUPPORT_CONSENT_TEXTS[version]
  if (byLang === null) return null
  const text = byLang[lang]
  return typeof text === 'string' && text.length > 0 ? text : null
}

/**
 * The text of `version` in `lang` (the launcher's language when not given): only a version this release knows (a key
 * of the table, which a test keeps at exactly 1 .. SUPPORT_CONSENT_VERSION), only an approved text.
 */
export function supportConsentText(version: number, lang: SupportConsentLang = SUPPORT_CONSENT_LAUNCHER_LANG): ConsentTextResult {
  const text = approved(version, lang)
  if (text === undefined) return { ok: false, problem: 'consent_invalid' }
  if (text === null) return { ok: false, problem: 'consent_text_unset' }
  return { ok: true, text: text.endsWith('\n') ? text : text + '\n' }
}

/**
 * The sha256 (64 lower-case hex) of a version's approved text in a language: its UTF-8 bytes exactly as stored,
 * WITHOUT the line end the launcher adds when it prints it. The same method as the marveen.io receipt (#381), so for
 * version 2 it is the server's value for '2:hu' and '2:en'. null when there is no approved text, or no language.
 */
export function supportConsentSha256(version: number, lang: SupportConsentLang | null): string | null {
  if (lang === null) return null
  const text = approved(version, lang)
  if (typeof text !== 'string') return null
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** A request's locale as a consent language: exactly 'hu' or 'en', anything else is not known (null). */
export function supportConsentLangOf(locale: unknown): SupportConsentLang | null {
  return locale === 'hu' || locale === 'en' ? locale : null
}
