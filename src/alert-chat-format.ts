// OWNER_ALERT_CHAT_ID (ISSUE2556X, marveen#2556): the chat the owner's alerts and owner-facing deliveries go to, set
// on the dashboard's settings page. Pure on purpose: the settings registry validates with it, and the registry may
// not import config.ts (config.ts imports the registry). scripts/lib/owner-chat.sh and scripts/lib/owner_chat.py
// carry the same patterns (src/__tests__/owner-chat-parity.test.ts holds the three to one table).
export const OWNER_ALERT_CHAT_KEY = 'OWNER_ALERT_CHAT_ID'

export type AlertChatProvider = 'telegram' | 'slack' | 'discord' | 'googlechat' | 'teams'

// One chat id shape per provider, as that provider's API takes it:
//   telegram    a numeric chat id (a person, or a "-" group / channel);
//   slack       a channel, DM, private-group or user id (C... / D... / G... / U...);
//   discord     a channel snowflake;
//   googlechat  a space resource name (spaces/AAAA);
//   teams       a conversation id (19:...@thread.v2, a:...).
export const ALERT_CHAT_FORMATS: Readonly<Record<AlertChatProvider, RegExp>> = Object.freeze({
  telegram: /^-?[1-9][0-9]{0,19}$/,
  slack: /^[CDGU][A-Z0-9]{6,}$/,
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

/** null when `raw` is unset or a valid chat id for `provider`; else the reason, in the settings page's language. */
export function alertChatFormatError(provider: AlertChatProvider, raw: unknown): string | null {
  const v = alertChatValue(raw)
  if (v === null) return null
  if (ALERT_CHAT_FORMATS[provider].test(v)) return null
  return `Nem ${provider}-chatazonosító: a beállított csatorna (CHANNEL_PROVIDER=${provider}) ilyen alakot vár: ${EXAMPLES[provider]}.`
}

const EXAMPLES: Readonly<Record<AlertChatProvider, string>> = Object.freeze({
  telegram: '1268077055 (vagy csoportnál -100...)',
  slack: 'D0123456789 vagy C0123456789',
  discord: '1234567890123456789',
  googlechat: 'spaces/AAAA...',
  teams: '19:...@thread.v2',
})
