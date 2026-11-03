// Shape-based outbound scrub for free text that leaves the machine over the bridge.
//
// containsPrivateData (capabilities.ts) matches KNOWN values: the owner's name, the chat id,
// this install's own tokens. It cannot see a secret it was never told about -- a third-party
// API key pasted into a result, a home path, a customer's e-mail address. This module matches
// the SHAPE of such data instead. It is deterministic (regexes only, no model), and it is
// deliberately biased towards false positives: a hit withholds the message, and the closer
// can always answer with a separate, reviewed message, while a miss cannot be taken back.
//
// Not wired into the capability manifest on purpose: that text is fixed template text or a
// cached summary already checked by containsPrivateData, and a shape check there would only
// add false positives to the directory. It is for the free-text completion receipt.

export type SensitiveShape =
  | 'private-key'
  | 'secret-token'
  | 'home-path'
  | 'email-address'
  | 'phone-number'

interface ShapeRule { shape: SensitiveShape; label: string; re: RegExp }

// Order matters only for which reason is reported first; any hit withholds.
const RULES: ShapeRule[] = [
  { shape: 'private-key', label: 'private key block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  // Vendor-prefixed tokens: OpenAI/Anthropic (sk-, sk-ant-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  // github_pat_), Slack (xoxa-/xoxb-/xoxp-/xoxr-/xoxs-, xapp-), GitLab (glpat-), AWS access key
  // ids (AKIA/ASIA), Google API keys (AIza), Stripe-style live/test keys.
  { shape: 'secret-token', label: 'vendor token', re: /(?<![A-Za-z0-9])(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|A[KS]IA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,})/ },
  { shape: 'secret-token', label: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i },
  { shape: 'secret-token', label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // A long hex run: 32+ hex digits is a key, a digest or a full commit hash. The last is a
  // known false positive (a 7-12 char short hash passes); withholding it is the cheap error.
  { shape: 'secret-token', label: 'long hex string', re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/ },
  { shape: 'home-path', label: 'home path', re: /(?:^|[^A-Za-z0-9_.~-])(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root(?=\/|\s|$)|~[A-Za-z0-9_.-]*\/|[A-Za-z]:\\Users\\[^\\\s]+)/m },
  { shape: 'email-address', label: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  // Phone numbers: the international form (+ or 00 prefix, 7-15 further digits with the usual
  // separators), the Hungarian domestic 06 form, and the North American (NNN) NNN-NNNN form.
  // Plain digit runs and ISO dates (2026-10-25) do not match.
  { shape: 'phone-number', label: 'phone number', re: /(?<![\w+])(?:\+|00)[1-9](?:[\s().-]{0,2}\d){6,14}(?!\d)/ },
  { shape: 'phone-number', label: 'phone number', re: /(?<!\d)06[\s/-]?\d{1,2}[\s/-]?\d{3}[\s-]?\d{3,4}(?!\d)/ },
  { shape: 'phone-number', label: 'phone number', re: /(?<!\d)\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?!\d)/ },
]

/** A long run of base64/base64url characters mixing upper case, lower case and digits:
 *  the shape of an opaque credential. Kept out of RULES because the mix test is not a
 *  single regex. Prose, slugs and paths fail the mix test (no digits or no capitals). */
function hasOpaqueToken(text: string): boolean {
  const runs = text.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) ?? []
  return runs.some((r) => /[A-Z]/.test(r) && /[a-z]/.test(r) && /[0-9]/.test(r))
}

/** The first secret-, path- or contact-shaped substring in `text`, as its category and a
 *  human label, or null when none is found. Never returns the matched text itself: the
 *  caller logs and returns the reason, and a log line must not carry the secret. */
export function findSensitiveShape(text: string): { shape: SensitiveShape; label: string } | null {
  for (const r of RULES) if (r.re.test(text)) return { shape: r.shape, label: r.label }
  if (hasOpaqueToken(text)) return { shape: 'secret-token', label: 'opaque token' }
  return null
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary, so a surrogate
 *  pair (emoji, astral characters) or a multi-byte character is never split. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let bytes = 0
  let end = 0 // UTF-16 index just past the last code point that fits
  for (const cp of text) { // string iteration yields whole code points, never half a pair
    const n = Buffer.byteLength(cp, 'utf8')
    if (bytes + n > maxBytes) break
    bytes += n
    end += cp.length
  }
  return text.slice(0, end)
}
