// Support access: the consent text the owner sees before switching support
// standby on, bound to its version (SUPPORTKULCS1109; Geri 78479, Samu 78475).
//
// The launcher prints the text of exactly the version it will pass to
// `enable --consent <n>`, and takes that version from the status line
// `consent_version=<n>`. The text is the owner's: this file is its place, and
// a version without an approved text refuses (`consent_text_unset`) rather
// than show something nobody approved.
import { SUPPORT_CONSENT_VERSION } from './support-standby-enable.js'

/** Approved texts by version. null = the version is known, its approved text is not in the source yet. */
export const SUPPORT_CONSENT_TEXTS: Readonly<Record<number, string | null>> = {
  1: null,
}

export type ConsentTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: 'consent_invalid' | 'consent_text_unset' }

/** The text of `version`: only a version this release knows (1 .. SUPPORT_CONSENT_VERSION), only an approved text. */
export function supportConsentText(version: number): ConsentTextResult {
  if (!Number.isInteger(version) || version < 1 || version > SUPPORT_CONSENT_VERSION) return { ok: false, problem: 'consent_invalid' }
  const text = Object.prototype.hasOwnProperty.call(SUPPORT_CONSENT_TEXTS, version) ? SUPPORT_CONSENT_TEXTS[version] : undefined
  if (text === undefined) return { ok: false, problem: 'consent_invalid' }
  if (text === null || text.length === 0) return { ok: false, problem: 'consent_text_unset' }
  return { ok: true, text: text.endsWith('\n') ? text : text + '\n' }
}
