import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = join(__dirname, '..')
export const STORE_DIR = join(PROJECT_ROOT, 'store')

const env = readEnvFile()

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

export const OWNER_NAME = env['OWNER_NAME'] ?? 'Szabolcs'
export const BOT_NAME = env['BOT_NAME'] ?? 'Marveen'

// Canonical identifier for the main agent in the DB, tmux sessions, plist
// labels, API routing, etc. The installer derives this from BOT_NAME
// (NFKD + ASCII + lowercase dashes). Older installs without this env var
// fall back to "marveen" so nothing breaks when upgrading in place.
export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? 'marveen'

export const WEB_PORT = parseInt(env['WEB_PORT'] ?? '3420', 10)

export const WEB_HOST = env['WEB_HOST'] ?? '127.0.0.1'
export const OLLAMA_URL = env['OLLAMA_URL'] ?? 'http://localhost:11434'

// Heartbeat
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
export const HEARTBEAT_START_HOUR = 9
export const HEARTBEAT_END_HOUR = 23
export const HEARTBEAT_CALENDAR_ID = env['HEARTBEAT_CALENDAR_ID'] ?? ''
