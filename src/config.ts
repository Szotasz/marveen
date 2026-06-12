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

// Chat app (per-user web chat, Google Workspace login). OFF by default: the
// feature exposes a cookie-authenticated API namespace (/chat-api/*) next to
// the bearer-gated admin /api/*, so an install must opt in explicitly and
// provide its own OAuth client. CHAT_PUBLIC_URL is the browser-facing origin
// (behind the reverse proxy) used for the OAuth redirect URI and the cookie
// Secure flag.
export const CHAT_APP_ENABLED =
  ['1', 'true', 'yes', 'on'].includes((env['CHAT_APP_ENABLED'] ?? '').trim().toLowerCase())
export const CHAT_GOOGLE_CLIENT_ID = (env['CHAT_GOOGLE_CLIENT_ID'] ?? '').trim()
export const CHAT_GOOGLE_CLIENT_SECRET = (env['CHAT_GOOGLE_CLIENT_SECRET'] ?? '').trim()
export const CHAT_ALLOWED_DOMAIN = (env['CHAT_ALLOWED_DOMAIN'] ?? '').trim().toLowerCase()
export const CHAT_PUBLIC_URL = (env['CHAT_PUBLIC_URL'] ?? '').trim().replace(/\/$/, '')
export const CHAT_SESSION_TTL_HOURS = parseInt(env['CHAT_SESSION_TTL_HOURS'] ?? '24', 10)
// Thread lifecycle. Users open/close threads themselves (ChatGPT-style); the
// idle auto-suspend is a backstop against forgotten threads, not the primary
// mechanism, and a suspended thread reopens losslessly via --resume. The
// open-thread cap is a soft server guard: every open thread is a live
// tmux+claude process (~hundreds of MB RSS each).
export const CHAT_THREAD_IDLE_MINUTES = parseInt(env['CHAT_THREAD_IDLE_MINUTES'] ?? '45', 10)
export const CHAT_MAX_OPEN_THREADS_PER_AGENT = parseInt(env['CHAT_MAX_OPEN_THREADS_PER_AGENT'] ?? '10', 10)

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
