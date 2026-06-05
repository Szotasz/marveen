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

// Canonical identifier for the main agent in the DB, tmux sessions, plist
// labels, API routing, etc. The installer derives this from BOT_NAME
// (NFKD + ASCII + lowercase dashes). Older installs without this env var
// fall back to "marveen" so nothing breaks when upgrading in place.
export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? 'marveen'

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
export const HEARTBEAT_END_HOUR = 23
export const HEARTBEAT_CALENDAR_ID = env['HEARTBEAT_CALENDAR_ID'] ?? ''
