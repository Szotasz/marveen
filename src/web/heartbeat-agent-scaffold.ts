// Bootstrap helper for the dedicated `heartbeat` channel-less sub-agent.
//
// Background (2026-06-02): the historical heartbeat path (src/heartbeat.ts
// -- the native hourly module that called the claude-agent-sdk's
// runAgent() and notifyTelegram()) routinely crashed the main agent's
// channel plugin within 2-3 minutes of every fire. After a long
// isolation-chain attempt (#237 / #250 / #252 / #253 / #255) the
// remaining failure mode was a TUI-level freeze, suspected to be caused
// by the main agent's own poller picking up the heartbeat's
// `notifyTelegram` sendMessage as a regular inbound and entering a
// tool-call loop on it.
//
// Architectural fix: stop calling the SDK from inside the dashboard
// process. Run the heartbeat in a SEPARATE channel-less tmux agent
// (named "heartbeat"), driven by the existing scheduled-task system,
// and have IT send the formatted summary to the main agent via
// inter-agent message rather than directly to Telegram. The main agent
// then decides if it relays to the operator -- so the heartbeat output
// never spawns a main-agent-token sendMessage, never produces a
// self-inbound event, and the channel plugin stays untouched.
//
// This module materialises the agent's directory (gitignored under
// agents/) when the heartbeat is enabled. The dir mirrors the layout of
// the other channel-less agents:
//   agents/heartbeat/
//     ├── CLAUDE.md                       -- role/scope/output format
//     ├── agent-config.json               -- model, profile, auth-mode
//     ├── .claude/settings.json           -- channel plugins explicitly disabled
//     └── .hidden-from-dashboard          -- listAgentNames() filter (#253)
//
// Nothing operator-specific is hardcoded here: the boot-time auto-start
// is gated on HEARTBEAT_AGENT_ENABLED, and every identity baked into the
// CLAUDE.md (owner, main-agent name, store path, calendar account) comes
// from config via currentHeartbeatIdentity().

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROJECT_ROOT,
  STORE_DIR,
  OWNER_NAME,
  BOT_NAME,
  MAIN_AGENT_ID,
  WEB_PORT,
  HEARTBEAT_CALENDAR_ACCOUNT,
  APP_TZ,
  DASHBOARD_PUBLIC_URL,
} from '../config.js'
import { resolveDashboardOrigin } from './agent-scaffold.js'
import { logger } from '../logger.js'

const HEARTBEAT_AGENT_NAME = 'heartbeat'
const HEARTBEAT_AGENT_DIR = join(PROJECT_ROOT, 'agents', HEARTBEAT_AGENT_NAME)

// Channel plugins MUST be explicitly disabled in the agent's
// project-scope .claude/settings.json. Without this they leak through
// from the user-scope ~/.claude/settings.json (every channel plugin
// the operator has enabled globally would otherwise activate here,
// open its own poller against the OPERATOR's bot token, and race the
// main agent's poller for the same getUpdates slot -- see
// agent-process.ts:137 for the same disable baked into startup).
const CHANNEL_PLUGIN_DISABLES = {
  'telegram@claude-plugins-official': false,
  'slack-channel@marveen-marketplace': false,
  'discord@claude-plugins-official': false,
}

// Haiku-class model: the heartbeat job is data-formatting (Calendar
// events + kanban counts + memory + tasks list -> a short structured
// message). Opus is wildly overpowered, and the previous hourly Opus
// spawns burned tokens with no upside. Haiku finishes in seconds and
// costs effectively nothing.
//
// authMode 'oauth' uses the host's Claude Code OAuth from the
// Keychain -- the same auth the main agent and every other channel-less
// sub-agent runs under. NO per-agent API key needed.
const HEARTBEAT_AGENT_CONFIG = {
  model: 'claude-haiku-4-5',
  authMode: 'oauth' as const,
  securityProfile: 'standard',
}

// Per-deployment identity threaded into the rendered CLAUDE.md. Pulled
// from config (see currentHeartbeatIdentity) so the shipped scaffold
// carries no operator-specific calendar address, owner name, store path
// or main-agent name.
export interface HeartbeatIdentity {
  // Whose systems the heartbeat summarises (OWNER_NAME).
  ownerName: string
  // The main agent's display name -- the relay target (BOT_NAME).
  botName: string
  // The main agent's id for inter-agent routing (MAIN_AGENT_ID).
  mainAgentId: string
  // Absolute path to store/ (holds the DB and the dashboard token).
  storeDir: string
  // Dashboard origin for the inter-agent message POST, e.g.
  // http://localhost:3420.
  dashboardOrigin: string
  // Google Calendar account to summarise, or '' to let the calendar MCP
  // server use whatever account it is authenticated as.
  calendarAccount: string
}

// Build the identity from the live config. Kept separate from the pure
// renderer so the renderer stays unit-testable without importing config.
export function currentHeartbeatIdentity(): HeartbeatIdentity {
  return {
    ownerName: OWNER_NAME,
    botName: BOT_NAME,
    mainAgentId: MAIN_AGENT_ID,
    storeDir: STORE_DIR,
    dashboardOrigin: resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT),
    calendarAccount: HEARTBEAT_CALENDAR_ACCOUNT,
  }
}

// Pure boot gate. The heartbeat sub-agent must run on exactly one host
// (the respawn gate) AND be explicitly opted in (HEARTBEAT_AGENT_ENABLED,
// off by default) -- both are required before the dashboard scaffolds and
// spawns it at boot.
export function shouldBootHeartbeatAgent(opts: { respawnEnabled: boolean; agentEnabled: boolean }): boolean {
  return opts.respawnEnabled && opts.agentEnabled
}

// The CLAUDE.md prose. Pure: every operator-specific value comes from the
// supplied identity, so the same renderer produces a correct file on any
// deployment and the unit tests can assert the output without fs or
// config. Critical contract:
//   - NEVER call the Telegram reply tool. The whole point is to keep the
//     heartbeat output OUT of any bot-API call from this process, so the
//     main agent's poller never sees a self-generated inbound.
//   - The output goes to the main agent via inter-agent message; the main
//     agent decides whether to relay it to the operator.
//   - Structured-text format so the main agent can parse or relay verbatim
//     depending on signal-to-noise.
export function renderHeartbeatClaudeMd(id: HeartbeatIdentity): string {
  const calendarTarget = id.calendarAccount
    ? `against \`${id.calendarAccount}\``
    : 'against your primary calendar (whatever account the calendar MCP server is authenticated as)'
  return `# Heartbeat agent

You are the **heartbeat agent** -- a dedicated, headless worker that
runs on the hourly schedule and produces a structured summary of
what is happening across ${id.ownerName}'s systems right now. You
ALWAYS hand the result to the main agent (${id.botName}) via
inter-agent message; you NEVER contact ${id.ownerName} directly.

## Why this agent exists

The previous heartbeat ran from inside the dashboard process and
called the Telegram Bot API directly. Every fire caused the main
agent's channel plugin to fall over 2-3 minutes later -- the bot's
outbound sendMessage was being read back as an inbound by the main
agent's own poller and triggered a tool-call freeze. Splitting the
heartbeat into its own channel-less agent (this one), wired to the
main agent only through inter-agent message, removes the self-poll
loop entirely.

## What to do on every fire

When you receive the heartbeat prompt:

1. **Collect** the four data sources:
   - **Calendar (next 2 hours)** -- use the
     \`mcp__server-google-calendar-mcp__list-events\` tool
     ${calendarTarget}, timeMin=now, timeMax=now+2h.
     If the call fails (token revoked / 401), record the failure
     reason rather than the events; the main agent can act on the
     failure.
   - **Kanban** -- read the SQLite DB at
     \`${id.storeDir}/claudeclaw.db\`:
     \`sqlite3 ${id.storeDir}/claudeclaw.db "SELECT status, COUNT(*)
     FROM kanban_cards WHERE archived_at IS NULL GROUP BY status"\`
     for counts, and grab the titles of cards where
     \`priority='urgent'\` or \`status='waiting'\`.
   - **Scheduled tasks** -- count active rows in
     \`scheduled_tasks\` table; record \`next_run_at\` for the
     earliest upcoming one.
   - **Memory + system** -- DB file size, any \`category='hot'\`
     memories newer than 1 hour, plus presence of any
     \`status='warning'\` entries in the memory log.

2. **Format** the result as a single inter-agent message:

   \`\`\`
   ## Heartbeat YYYY-MM-DD HH:MM (${APP_TZ})

   ### Calendar (next 2h)
   - HH:MM -- <summary> (<attendees>)
   - <or: "no upcoming events">
   - <or: "calendar fetch failed: <reason>">

   ### Kanban
   - urgent: <N> (<short titles, comma-separated>)
   - in_progress: <N>
   - waiting: <N> (<short titles>)
   - planned: <N>

   ### Tasks
   - active: <N>
   - next: <task name @ YYYY-MM-DD HH:MM>

   ### Memory / system
   - DB size: <X> MB
   - new hot memories (1h): <N>
   - warnings: <none | comma-separated>
   \`\`\`

3. **Send** that string to the main agent via the dashboard API:

   \`\`\`bash
   TOKEN=$(cat ${id.storeDir}/.dashboard-token)
   curl -s -X POST ${id.dashboardOrigin}/api/messages \\
     -H "Content-Type: application/json" \\
     -H "Authorization: Bearer $TOKEN" \\
     -d '{"from":"heartbeat","to":"${id.mainAgentId}","content":"<the formatted text>"}'
   \`\`\`

4. **Stop.** Do not Telegram-reply, do not Slack, do not message
   anyone else. The handoff to the main agent is the entire job. The
   main agent handles the human-facing relay decision.

## Hard rules (never break)

- **NEVER** call \`reply\` / Telegram / Slack tools.
- **NEVER** contact a chat_id directly.
- **NEVER** include API tokens, OAuth state, or any Bearer key in the
  message body. The dashboard token in the example above goes in the
  Authorization header only.
- **NEVER** keep the output longer than ~30 lines. If something does
  not fit, write "<N> more ..." and let the main agent ask for the
  long form. Heartbeat is a status pulse, not a transcript.
- If a data source raises, record the failure reason in that
  section's body and CONTINUE -- partial output is fine, silence is
  not.

## You are headless

You do not own a Telegram channel and the operator never reaches you
directly. The only inputs you ever process are heartbeat prompts
from the scheduler. If you receive anything else, hand it off to the
main agent with a brief "received off-pattern input, please advise"
note and stop.
`
}

function renderAgentConfigJson(): string {
  return JSON.stringify(HEARTBEAT_AGENT_CONFIG, null, 2) + '\n'
}

function renderClaudeSettingsJson(): string {
  return JSON.stringify({ enabledPlugins: CHANNEL_PLUGIN_DISABLES }, null, 2) + '\n'
}

// Files we ALWAYS rewrite. Settings + agent-config are recreated to
// keep them in sync with the constants in this file; if the operator
// hand-edited the on-disk copy, our boot rewrite wins. CLAUDE.md is
// re-rendered every boot for the same reason: the canonical source of
// truth for the agent's instructions lives here, not on disk.
const ALWAYS_WRITE: ReadonlyArray<readonly [string, () => string]> = [
  ['CLAUDE.md', () => renderHeartbeatClaudeMd(currentHeartbeatIdentity())],
  ['agent-config.json', renderAgentConfigJson],
  [join('.claude', 'settings.json'), renderClaudeSettingsJson],
] as const

// Files we write only when missing. The sentinel is a marker, not a
// payload -- once it exists we leave it alone.
const SENTINEL_FILES: ReadonlyArray<readonly [string, string]> = [
  ['.hidden-from-dashboard', ''],
] as const

/**
 * Build the heartbeat agent's directory tree if it is missing, and
 * (re)write the canonical CLAUDE.md / agent-config.json /
 * .claude/settings.json on every call. Sentinel files are created
 * idempotently. Call this once at dashboard boot, before
 * startAgentProcess('heartbeat') -- the scheduled-task runner will
 * pick it up from there.
 */
export function ensureHeartbeatAgent(): void {
  try {
    if (!existsSync(HEARTBEAT_AGENT_DIR)) {
      mkdirSync(HEARTBEAT_AGENT_DIR, { recursive: true })
    }
    const claudeDir = join(HEARTBEAT_AGENT_DIR, '.claude')
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true })
    }
    for (const [relPath, render] of ALWAYS_WRITE) {
      writeFileSync(join(HEARTBEAT_AGENT_DIR, relPath), render())
    }
    for (const [relPath, body] of SENTINEL_FILES) {
      const p = join(HEARTBEAT_AGENT_DIR, relPath)
      if (!existsSync(p)) writeFileSync(p, body)
    }
    logger.info({ dir: HEARTBEAT_AGENT_DIR }, 'Heartbeat agent scaffold ensured')
  } catch (err) {
    logger.error({ err, dir: HEARTBEAT_AGENT_DIR }, 'Failed to scaffold heartbeat agent')
  }
}

export { HEARTBEAT_AGENT_NAME, HEARTBEAT_AGENT_DIR }
