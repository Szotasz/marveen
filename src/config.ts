import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import { getProviderType, getChannelToken, getChannelChatId, type ChannelProviderType } from './channel-provider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = join(__dirname, '..')
export const STORE_DIR = join(PROJECT_ROOT, 'store')
export const DB_FILENAME = 'claudeclaw.db'
export const PID_FILENAME = 'claudeclaw.pid'

const env = readEnvFile()

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

export const SLACK_BOT_TOKEN = env['SLACK_BOT_TOKEN'] ?? ''
export const SLACK_APP_TOKEN = env['SLACK_APP_TOKEN'] ?? ''
export const SLACK_CHANNEL_ID = env['SLACK_CHANNEL_ID'] ?? ''

export const OWNER_NAME = env['OWNER_NAME'] ?? 'Szabolcs'
export const BOT_NAME = env['BOT_NAME'] ?? 'Marveen'

// Product / system brand shown in the dashboard chrome (browser tab title,
// mobile topbar, sidebar, updates page). Kept SEPARATE from BOT_NAME so an
// operator can name the product one thing (BRAND_NAME) and the main agent
// another (BOT_NAME, the agent's display name). Defaults to BOT_NAME -- which
// itself defaults to 'Marveen' -- so an install that sets neither, or only
// BOT_NAME, behaves exactly as before.
export const BRAND_NAME = env['BRAND_NAME'] ?? BOT_NAME

// Pure resolution rule for BRAND_NAME, so the default (brandEnv unset =>
// botName) is provable without a live .env. brandEnv is the raw env value
// (undefined / empty when unset). Mirrors the `env['BRAND_NAME'] ?? BOT_NAME`
// above plus an empty-string guard (an empty .env line should not blank the
// brand).
export function resolveBrandName(brandEnv: string | undefined, botName: string): string {
  const b = (brandEnv ?? '').trim()
  return b || botName
}

// Pure derivation of the OS service id from a brand slug and the agent id:
// the brand slug names the service units when it differs from the agent id,
// otherwise the agent id is used. Mirrors the installer's SERVICE_ID choice so
// the default (brandSlug == mainAgentId) is provably label-identical.
export function resolveServiceId(brandSlug: string, mainAgentId: string): string {
  const s = (brandSlug ?? '').trim()
  return s && s !== mainAgentId ? s : mainAgentId
}

// ASCII slug used for agent/service ids, mirroring the install scripts'
// Python NFKD rule: NFKD-normalize, drop non-ASCII, collapse runs of non-
// alphanumerics to a single dash, trim dashes, lowercase, and fall back to
// 'marveen' when the result is empty. Exported so the launchd/systemd label
// derivation is provable for any brand string in one place.
export function brandSlug(raw: string): string {
  const ascii = (raw ?? '')
    .normalize('NFKD')
    // strip combining marks left by NFKD, then any remaining non-ASCII
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7f]/g, '')
  const slug = ascii.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return slug || 'marveen'
}

// Canonical identifier for the main agent in the DB, tmux sessions, plist
// labels, API routing, etc. The installer derives this from BOT_NAME
// (NFKD + ASCII + lowercase dashes). Older installs without this env var
// fall back to "marveen" so nothing breaks when upgrading in place.
export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? 'marveen'

// Identifier the OS service manager uses for the main agent's units (launchd
// label com.<id>.channels / com.<id>.dashboard, systemd <id>-channels, etc.).
// The installer derives this from BRAND_NAME when the operator picks a brand
// distinct from the agent id; otherwise it equals MAIN_AGENT_ID. Defaults to
// MAIN_AGENT_ID here, so an install without SERVICE_ID in its .env (every
// existing install) keeps byte-identical service labels and the recovery path
// (launchctl unload/load, kickstart) still targets the right unit.
export const SERVICE_ID = env['SERVICE_ID'] ?? MAIN_AGENT_ID

export const WEB_PORT = parseInt(env['WEB_PORT'] ?? '3420', 10)

export const WEB_HOST = env['WEB_HOST'] ?? '127.0.0.1'
export const DASHBOARD_PUBLIC_URL = env['DASHBOARD_PUBLIC_URL'] ?? ''
export const OLLAMA_URL = env['OLLAMA_URL'] ?? 'http://localhost:11434'

export const CHANNEL_PROVIDER: ChannelProviderType = getProviderType(env['CHANNEL_PROVIDER'])
export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)
export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)

// Respawn / keep-alive gate.
// The in-process channel-plugin monitor (main-agent respawn + sub-agent
// auto-restart) must run on exactly ONE machine. When the same checkout runs
// on more than one host (e.g. a dev box alongside the production host), each
// would independently respawn agents and the two would fight over the same bot
// tokens / getUpdates slot. Gate it so only the intended host keeps agents alive.
//   RESPAWN_ENABLED -- "1"/"true" forces on, "0"/"false" forces off
//   RESPAWN_HOST    -- optional substring matched against the OS hostname; when
//                      set, respawn is enabled only on a host whose name matches
// Default (neither set): enabled, so a single-host install needs no config.
const RESPAWN_HOST = (env['RESPAWN_HOST'] ?? '').toLowerCase()
const RESPAWN_OVERRIDE = (env['RESPAWN_ENABLED'] ?? '').toLowerCase()
export const RESPAWN_ENABLED =
  RESPAWN_OVERRIDE === '1' || RESPAWN_OVERRIDE === 'true'
    ? true
    : RESPAWN_OVERRIDE === '0' || RESPAWN_OVERRIDE === 'false'
      ? false
      : RESPAWN_HOST
        ? hostname().toLowerCase().includes(RESPAWN_HOST)
        : true

// Heartbeat
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
export const HEARTBEAT_START_HOUR = 9

// Dedicated channel-less `heartbeat` sub-agent (hourly summary worker).
// OFF by default: a fresh or upgrading install must NOT silently spawn a
// sub-agent that reads the operator's calendar and database. Opt in with
// HEARTBEAT_AGENT_ENABLED=1 (it additionally requires the respawn gate
// above, since the heartbeat has to run on exactly one host).
export const HEARTBEAT_AGENT_ENABLED =
  ['1', 'true', 'yes', 'on'].includes((env['HEARTBEAT_AGENT_ENABLED'] ?? '').trim().toLowerCase())

// Google Calendar account the heartbeat summarises (next 2h). Empty (the
// default) means the agent uses whatever calendar its MCP server is
// authenticated as, so no personal address is baked into the shipped
// scaffold.
export const HEARTBEAT_CALENDAR_ACCOUNT = (env['HEARTBEAT_CALENDAR_ACCOUNT'] ?? '').trim()
export const HEARTBEAT_END_HOUR = 23
export const HEARTBEAT_CALENDAR_ID = env['HEARTBEAT_CALENDAR_ID'] ?? ''
