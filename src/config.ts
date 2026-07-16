import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
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

// Boot-time settings-override layer. The dashboard Settings page persists
// changes to store/config-overrides.json. config.ts is imported too early to
// use settings-store.ts (that module imports config.ts -> circular), so for
// the boot-consumed registry keys we read that file directly here and layer it
// over .env, matching the settings-store resolution order
// (config-overrides.json > .env > registry default). This is what makes a
// `requiresRestart` registry key (DASHBOARD_PUBLIC_URL, OLLAMA_URL,
// HEARTBEAT_AGENT_ENABLED) actually take effect after a restart -- without it
// the saved override would never be read by the boot-time consumers.
function readConfigOverrides(): Record<string, unknown> {
  try {
    const p = join(STORE_DIR, 'config-overrides.json')
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const overrides = readConfigOverrides()
// Effective raw value for a registry-backed key consumed at boot:
// config-overrides.json wins, then .env. Callers apply their own default.
function cfg(key: string): string | undefined {
  const ov = overrides[key]
  if (ov !== undefined && ov !== null && String(ov).length > 0) return String(ov)
  return env[key]
}

// The single timezone for this install -- drives BOTH cron scheduling (cron.ts)
// AND every human-facing time render (heartbeat, daily-log, memory labels, etc.).
// One env var (SCHEDULER_TZ) so the whole box shares one zone; falls back to the
// process zone (the TZ env / OS) when unset. Replaces the ~15 hardcoded
// 'Europe/Budapest' literals -- change the zone in ONE place, and an update that
// re-introduces a hardcoded literal is caught by a single grep, not a full review.
export const APP_TZ = cfg('SCHEDULER_TZ') || Intl.DateTimeFormat().resolvedOptions().timeZone

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

export const SLACK_BOT_TOKEN = env['SLACK_BOT_TOKEN'] ?? ''
export const SLACK_APP_TOKEN = env['SLACK_APP_TOKEN'] ?? ''
export const SLACK_CHANNEL_ID = env['SLACK_CHANNEL_ID'] ?? ''

// Distribution placeholder for an unconfigured owner name. Exported so
// consumers that treat the owner name as PRIVATE data (federation outbound
// scrub) can tell "a real configured name" apart from this generic English
// word -- scrubbing the literal word "owner" false-positives on fixed template
// text like "owner channels".
export const OWNER_NAME_PLACEHOLDER = 'Owner'
export const OWNER_NAME = env['OWNER_NAME'] ?? OWNER_NAME_PLACEHOLDER
// Shared Google Drive folder ID the fleet writes deliverables into. Empty by
// default (distribution-safe: no owner-specific folder is baked into a fresh
// install's generated agent CLAUDE.md); set OWNER_DRIVE_FOLDER in .env to wire
// the default shared drive for this install.
export const OWNER_DRIVE_FOLDER = env['OWNER_DRIVE_FOLDER'] ?? ''
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

// Legacy service id from before the OS service units were keyed off SERVICE_ID
// (the project originally shipped as "claudeclaw"). Retained so the standalone
// installer can retire a stale unit on re-run and the status command still
// recognizes a service created by an older install.
export const LEGACY_SERVICE_ID = 'claudeclaw'
export const LEGACY_APP_SERVICE_LABEL = `com.${LEGACY_SERVICE_ID}.app`

// launchd Label for the standalone interactive installer's app process
// (scripts/setup.ts, `npm run setup`). Keyed off SERVICE_ID so a branded
// install names its background service after the brand, matching how
// install-macos.sh already derives its com.<id>.dashboard / .channels units.
export function appServiceLabel(serviceId: string): string {
  return `com.${serviceId}.app`
}

// grep -E alternation matching this install's dashboard/app launchd unit
// regardless of which installer created it: the SERVICE_ID-derived app service
// (com.<id>.app from the standalone installer) or dashboard service
// (com.<id>.dashboard from install-macos.sh), plus the legacy
// "com.claudeclaw.app". The status command uses it so a running dashboard is
// detected on every install shape -- the old check only matched the legacy name
// and silently reported a modern (brand-aware) install as stopped. Anchored
// with a trailing `$` (the launchd Label is the last field of a
// `launchctl list` line) so only the exact unit matches -- an ancillary unit
// whose final segment merely starts with app/dashboard (e.g.
// com.<id>.dashboard-helper, com.<id>.appliance) does NOT count as "the
// dashboard is running". The pattern is used unchanged in both `grep -E` and a
// JS RegExp, so it sticks to features common to both (`$`, groups, `\.`).
// serviceId is an ASCII slug, so no regex escaping is needed.
export function launchdStatusPattern(serviceId: string): string {
  return `(com\\.${serviceId}\\.(app|dashboard)|com\\.${LEGACY_SERVICE_ID}\\.app)$`
}

// systemd --user unit names to probe for the dashboard, newest install shape
// first: install-linux.sh's "<id>-dashboard", the standalone installer's
// "<id>", then the legacy "claudeclaw". The status command reports active if
// any is active. Deduplicated so an id that already equals the legacy id does
// not probe the same unit twice.
export function systemdStatusUnits(serviceId: string): string[] {
  return [...new Set([`${serviceId}-dashboard`, serviceId, LEGACY_SERVICE_ID])]
}

export const WEB_PORT = parseInt(env['WEB_PORT'] ?? '3420', 10)

export const WEB_HOST = env['WEB_HOST'] ?? '127.0.0.1'

// Kanban card aging visual thresholds (hours since last update) and colours.
// Override per-install via .env; defaults match the design spec (24/72/168h).
export const KANBAN_AGING_WARN_H = parseInt(env['KANBAN_AGING_WARN_H'] ?? '24', 10)
export const KANBAN_AGING_CAUTION_H = parseInt(env['KANBAN_AGING_CAUTION_H'] ?? '72', 10)
export const KANBAN_AGING_CRITICAL_H = parseInt(env['KANBAN_AGING_CRITICAL_H'] ?? '168', 10)
export const KANBAN_AGING_WARN_COLOR = env['KANBAN_AGING_WARN_COLOR'] ?? '#c9a000'
export const KANBAN_AGING_CAUTION_COLOR = env['KANBAN_AGING_CAUTION_COLOR'] ?? '#d46b00'
export const KANBAN_AGING_CRITICAL_COLOR = env['KANBAN_AGING_CRITICAL_COLOR'] ?? '#c53030'
// Kanban WIP limits per column (0 = unlimited). Override via .env.
// NOTE: these constants are frozen at process start (this module reads .env
// once at import time). The dashboard's Settings page and the /api/marveen
// kanbanWip payload do NOT read these directly anymore -- they resolve
// through settings-store.ts (config-overrides.json > .env > registry
// default) so a value saved in the UI takes effect without a restart. These
// exports stay as the documented .env-only defaults / for any other code
// that genuinely wants the boot-time value.
export const KANBAN_WIP_PLANNED = parseInt(env['KANBAN_WIP_PLANNED'] ?? '0', 10)
export const KANBAN_WIP_IN_PROGRESS = parseInt(env['KANBAN_WIP_IN_PROGRESS'] ?? '0', 10)
export const KANBAN_WIP_TESTING = parseInt(env['KANBAN_WIP_TESTING'] ?? '0', 10)
export const KANBAN_WIP_WAITING = parseInt(env['KANBAN_WIP_WAITING'] ?? '0', 10)
export const KANBAN_WIP_DONE = parseInt(env['KANBAN_WIP_DONE'] ?? '0', 10)
// Utilisation % at which the badge turns yellow (default 80)
export const KANBAN_WIP_WARN_PCT = parseInt(env['KANBAN_WIP_WARN_PCT'] ?? '80', 10)
// Badge colours for each utilisation tier
export const KANBAN_WIP_OK_COLOR = env['KANBAN_WIP_OK_COLOR'] ?? '#6b7280'
export const KANBAN_WIP_WARN_COLOR = env['KANBAN_WIP_WARN_COLOR'] ?? '#c9a000'
export const KANBAN_WIP_FULL_COLOR = env['KANBAN_WIP_FULL_COLOR'] ?? '#d46b00'
export const KANBAN_WIP_OVER_COLOR = env['KANBAN_WIP_OVER_COLOR'] ?? '#c53030'
// requiresRestart registry keys: read through the override layer so a value
// saved on the Settings page takes effect on the next restart.
export const DASHBOARD_PUBLIC_URL = cfg('DASHBOARD_PUBLIC_URL') ?? ''
// Extra browser origins allowed to make state-changing dashboard requests
// (CORS + CSRF allowlist), comma-separated, e.g. for VPN/LAN addresses that
// aren't covered by WEB_HOST or DASHBOARD_PUBLIC_URL. Empty by default so
// existing installs keep the same allowlist as before. Not a Settings-page
// key, so it stays a plain env read (not routed through the override layer).
export const DASHBOARD_ALLOWED_ORIGINS = env['DASHBOARD_ALLOWED_ORIGINS'] ?? ''
export const OLLAMA_URL = cfg('OLLAMA_URL') ?? 'http://localhost:11434'

// Kanban swimlanes: which field the board groups by on first load. Invalid
// values silently fall back to 'none' (flat board) rather than breaking the
// grouping logic on the frontend.
const rawKanbanSwimlaneDefaultGroup = env['KANBAN_SWIMLANE_DEFAULT_GROUP'] ?? 'none'
export const KANBAN_SWIMLANE_DEFAULT_GROUP =
  rawKanbanSwimlaneDefaultGroup === 'assignee' || rawKanbanSwimlaneDefaultGroup === 'priority'
    ? rawKanbanSwimlaneDefaultGroup
    : 'none'
export const KANBAN_SWIMLANE_SEPARATOR_COLOR = env['KANBAN_SWIMLANE_SEPARATOR_COLOR'] ?? ''

// Kanban label colour palette (cold tones by default). The label CRUD UI
// offers these as swatches instead of a free-text colour input, so every
// label's colour traces back to this single configurable list rather than
// a hardcoded per-label mapping in the frontend.
const rawKanbanLabelColors = (env['KANBAN_LABEL_COLORS'] ?? '#3b82f6,#0ea5e9,#10b981,#14b8a6,#8b5cf6,#64748b')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean)
export const KANBAN_LABEL_COLORS = rawKanbanLabelColors.length > 0 ? rawKanbanLabelColors : ['#64748b']

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
export const HEARTBEAT_START_HOUR = parseInt(env['HEARTBEAT_START_HOUR'] ?? '9', 10)

// Dedicated channel-less `heartbeat` sub-agent (hourly summary worker).
// OFF by default: a fresh or upgrading install must NOT silently spawn a
// sub-agent that reads the operator's calendar and database. Opt in with
// HEARTBEAT_AGENT_ENABLED=1 (it additionally requires the respawn gate
// above, since the heartbeat has to run on exactly one host).
export const HEARTBEAT_AGENT_ENABLED =
  ['1', 'true', 'yes', 'on'].includes((cfg('HEARTBEAT_AGENT_ENABLED') ?? '').trim().toLowerCase())

// Google Calendar account the heartbeat summarises (next 2h). Empty (the
// default) means the agent uses whatever calendar its MCP server is
// authenticated as, so no personal address is baked into the shipped
// scaffold.
export const HEARTBEAT_CALENDAR_ACCOUNT = (env['HEARTBEAT_CALENDAR_ACCOUNT'] ?? '').trim()
export const HEARTBEAT_END_HOUR = parseInt(env['HEARTBEAT_END_HOUR'] ?? '23', 10)
export const HEARTBEAT_CALENDAR_ID = env['HEARTBEAT_CALENDAR_ID'] ?? ''
