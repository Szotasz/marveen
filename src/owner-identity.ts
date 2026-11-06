// Who is the OWNER for the chat commands (OWNERAUTHGUESS1106).
//
// resolveOwnerChatId (owner-chat.ts) answers WHERE an owner-facing message goes, and with several paired DMs and the
// installer's ALLOWED_CHAT_ID=0 it takes the FIRST allowFrom entry: a guess, which is acceptable for a delivery and
// not for a permission. The command gate (routes/commands.ts, midturn-commands.ts) used it to decide who may run the
// owner's chat commands, so on a two-DM install the pairing ORDER decided it: if a family member paired first, their
// commands ran as the owner's and the owner's own answered "not the owner".
//
// This resolver never guesses (Samu 71849):
//   1. TELEGRAM_OWNER_USER_ID, the owner's explicit Telegram user id, set on the dashboard's settings page (an
//      overrides-only registry key, the Telegram twin of SLACK_OWNER_USER_ID). Not the memory key, and not
//      OWNER_ALERT_CHAT_ID: a delivery setting never makes anyone the owner;
//   2. a positive ALLOWED_CHAT_ID (a DM chat id is the user id);
//   3. the SOLE DM entry of the main bot's access.json (soleDmOwner: never a group, never the first of several);
//   4. else nobody: the chat commands do not run, and the caller says so without naming anyone.
// One DM, or a positive ALLOWED_CHAT_ID, answers exactly as before.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_CHAT_ID } from './config.js'
import { channelStateDir } from './channel-provider.js'
import { normalizeChatId, soleDmOwner } from './owner-chat.js'
import { logger } from './logger.js'

export const TELEGRAM_OWNER_KEY = 'TELEGRAM_OWNER_USER_ID'
/** A Telegram user id (= the user's DM chat id): a positive number. */
export const TELEGRAM_USER_ID_RX = /^[1-9][0-9]{0,19}$/

// The install's store/config-overrides.json, the file settings-store reads. TELEGRAM_OWNER_USER_ID is an
// overrides-only string key with the default '': the store answers the override, else ''. Read directly (parity-tested
// against the store in settings-overrides-only.test.ts) so this module does not pull settings-store, and with it
// config.ts's STORE_DIR, into the command route and its tests.
export const OVERRIDES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'config-overrides.json')
export function readTelegramOwnerSetting(path: string = OVERRIDES_FILE): string {
  try {
    const v = (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)[TELEGRAM_OWNER_KEY]
    return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
  } catch {
    return ''
  }
}

export type OwnerIdentity =
  | { chatId: string; source: 'setting' | 'allowed-chat-id' | 'sole-dm'; ambiguous?: undefined }
  | { chatId: null; source: null; ambiguous: boolean; reason: string }

const reportedBadSetting = new Set<string>()

export function resolveOwnerIdentity(
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = ALLOWED_CHAT_ID,
  explicit: string = readTelegramOwnerSetting(),
): OwnerIdentity {
  const setting = explicit.trim()
  if (setting && setting !== '0') {
    if (TELEGRAM_USER_ID_RX.test(setting)) return { chatId: setting, source: 'setting' }
    if (!reportedBadSetting.has(setting)) {
      reportedBadSetting.add(setting)
      logger.error({ key: TELEGRAM_OWNER_KEY }, `${TELEGRAM_OWNER_KEY} is set but is not a positive Telegram user id -- NOT used`)
    }
  }
  const fromEnv = normalizeChatId(configured)
  if (fromEnv && TELEGRAM_USER_ID_RX.test(fromEnv)) return { chatId: fromEnv, source: 'allowed-chat-id' }
  let raw: Record<string, unknown> | null
  try {
    raw = JSON.parse(readAccessFile(join(channelStateDir('telegram'), 'access.json'))) as Record<string, unknown>
  } catch {
    return { chatId: null, source: null, ambiguous: false, reason: 'no owner: no explicit owner id and no readable access.json' }
  }
  const sole = soleDmOwner(raw)
  if (sole.chatId) return { chatId: sole.chatId, source: 'sole-dm' }
  const reason = sole.reason ?? 'no owner'
  const ambiguous = /\d+ DM entries, refusing to guess/.test(reason)
  return { chatId: null, source: null, ambiguous, reason }
}

/** The generic answer to a chat command when no owner can be named: it says nothing about who the owner is. */
export const OWNER_UNSET_REPLY = 'Ez a parancs most nem futtatható; a gazda a dashboardon tudja beállítani.'

/** The dashboard / doctor line for an install whose chat commands are off because of several DMs; null otherwise. */
export function ownerUnsetNotice(identity: OwnerIdentity): string | null {
  if (identity.chatId !== null || !identity.ambiguous) return null
  return `A chat-parancsok le vannak tiltva: több párosított DM van, és nincs megadva, melyik a gazdáé. Beállítás: Dashboard -> Beállítások -> ${TELEGRAM_OWNER_KEY} (a saját Telegram-felhasználói azonosítód).`
}
