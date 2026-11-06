// OWNER_ALERT_CHAT_ID (ISSUE2556X, marveen#2556): the chat the owner's alerts and owner-facing deliveries go to, set
// on the dashboard's settings page. Pure on purpose: the settings registry validates with it, and the registry may
// not import config.ts (config.ts imports the registry). scripts/lib/owner-chat.sh and scripts/lib/owner_chat.py
// carry the same patterns (src/__tests__/owner-chat-parity.test.ts holds the three to one table).
export const OWNER_ALERT_CHAT_KEY = 'OWNER_ALERT_CHAT_ID'

export type AlertChatProvider = 'telegram' | 'slack' | 'discord' | 'googlechat' | 'teams'

// One PERSONAL chat id shape per provider (Samu 71847: the owner's alerts and the approval text never go to a group,
// where every member would read them; the old rule, soleDmOwner, takes DM entries only, too):
//   telegram    a positive numeric chat id (a person; a "-" group or channel id is refused);
//   slack       a DM or user id (D... / U...; a C... channel or G... private group is refused);
//   discord     a snowflake: a DM channel and a server channel look the same, so the shape cannot tell them apart
//               (the settings text says so);
//   googlechat  a space resource name (spaces/AAAA);
//   teams       a conversation id (19:...@thread.v2, a:...).
export const ALERT_CHAT_FORMATS: Readonly<Record<AlertChatProvider, RegExp>> = Object.freeze({
  telegram: /^[1-9][0-9]{0,19}$/,
  slack: /^[DU][A-Z0-9]{6,}$/,
  discord: /^[1-9][0-9]{14,24}$/,
  googlechat: /^spaces\/[A-Za-z0-9_-]+$/,
  teams: /^[A-Za-z0-9:@._-]{3,}$/,
})

const PROVIDERS = Object.keys(ALERT_CHAT_FORMATS) as AlertChatProvider[]

/** CHANNEL_PROVIDER as the install reads it (channel-provider.ts resolveProviderType): unknown or empty is telegram. */
export function alertChatProviderOf(raw: string | undefined | null): AlertChatProvider {
  const v = String(raw ?? '').trim()
  return (PROVIDERS as string[]).includes(v) ? (v as AlertChatProvider) : 'telegram'
}

/** The value as stored, normalised: null when unset (empty or the "0" placeholder), else the trimmed id. */
export function alertChatValue(raw: unknown): string | null {
  const v = String(raw ?? '').trim()
  return v === '' || v === '0' ? null : v
}

/** null when `raw` is unset or a valid personal chat id for `provider`; else the reason, Hungarian then English. */
export function alertChatFormatError(provider: AlertChatProvider, raw: unknown): string | null {
  const v = alertChatValue(raw)
  if (v === null) return null
  if (ALERT_CHAT_FORMATS[provider].test(v)) return null
  return `Személyes chat-azonosító kell (${provider}): ${EXAMPLES[provider].hu}. Csoport vagy csatorna nem lehet, mert ott a gazda riasztásait és a jóváhagyások szövegét mindenki látná. / ` +
    `A personal chat id is required (${provider}): ${EXAMPLES[provider].en}. A group or channel is not allowed: every member would read the owner's alerts and the approval texts.`
}

const EXAMPLES: Readonly<Record<AlertChatProvider, { hu: string; en: string }>> = Object.freeze({
  telegram: { hu: 'a saját chated pozitív száma, pl. 1268077055', en: 'your own chat\'s positive number, e.g. 1268077055' },
  slack: { hu: 'a DM (D...) vagy a felhasználód (U...) azonosítója, pl. D0123456789', en: 'a DM (D...) or your user id (U...), e.g. D0123456789' },
  discord: { hu: 'a DM-csatornád azonosítója, pl. 1234567890123456789 (az alakból nem látszik, hogy DM-e: DM-et adj meg)', en: 'your DM channel id, e.g. 1234567890123456789 (the shape cannot show it is a DM: give a DM)' },
  googlechat: { hu: 'a közvetlen üzeneted terének neve, pl. spaces/AAAA...', en: 'your direct-message space name, e.g. spaces/AAAA...' },
  teams: { hu: 'a személyes beszélgetésed azonosítója, pl. a:1...', en: 'your personal conversation id, e.g. a:1...' },
})
