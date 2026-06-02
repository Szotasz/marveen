// Bootstrap helper for the dedicated `heartbeat` channel-less sub-agent.
//
// Background (Szabi 2026-06-02 14:09): the historical heartbeat path
// (src/heartbeat.ts -- the natív hourly module that called the
// claude-agent-sdk's runAgent() and notifyTelegram()) routinely crashed
// Marveen's channel plugin within 2-3 minutes of every fire. After a
// long isolation-chain attempt (#237 / #250 / #252 / #253 / #255) the
// remaining failure mode was a TUI-level freeze in Marveen, suspected
// to be caused by Marveen's own poller picking up the heartbeat's
// `notifyTelegram` sendMessage as a regular inbound and entering a
// tool-call loop on it.
//
// Architectural fix: stop calling the SDK from inside the dashboard
// process. Run the heartbeat in a SEPARATE channel-less tmux agent
// (named "heartbeat"), driven by the existing scheduled-task system,
// and have IT send the formatted summary to Marveen via inter-agent
// message rather than directly to Telegram. Marveen then decides if
// it relays to Szabi -- so the heartbeat output never spawns a
// Marveen-token sendMessage, never produces a self-inbound event, and
// the channel plugin stays untouched.
//
// This module is responsible for materialising the agent's directory
// (gitignored under agents/) at dashboard boot time. The dir mirrors
// the layout of the other channel-less agents:
//   agents/heartbeat/
//     ├── CLAUDE.md                       -- role/scope/output format
//     ├── agent-config.json               -- model, profile, auth-mode
//     ├── .claude/settings.json           -- channel plugins explicitly disabled
//     └── .hidden-from-dashboard          -- listAgentNames() filter (#253)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
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
// Keychain -- the same auth Marveen and every other channel-less
// sub-agent runs under. NO per-agent API key needed.
const HEARTBEAT_AGENT_CONFIG = {
  model: 'claude-haiku-4-5',
  authMode: 'oauth' as const,
  securityProfile: 'standard',
}

// The CLAUDE.md prose. Single source of truth for the agent's behaviour
// at every scheduled fire. Critical contract:
//   - NEVER call the Telegram reply tool. The whole point is to keep
//     the heartbeat output OUT of any bot-API call from this process,
//     so Marveen's poller never sees a self-generated inbound.
//   - The output goes to Marveen via inter-agent message. Marveen
//     decides whether to relay it to Szabi on Telegram, in HER own
//     session, with HER own context.
//   - Structured-text format so Marveen can either parse or relay-
//     verbatim depending on signal-to-noise.
function renderClaudeMd(): string {
  return `# Heartbeat agent

You are the **heartbeat agent** — a dedicated, headless worker that
runs on the hourly schedule and produces a structured summary of
what is happening across Szabolcs' systems right now. You ALWAYS
hand the result to Marveen via inter-agent message; you NEVER
contact Szabi directly.

## Why this agent exists (Szabi 2026-06-02 14:09)

The previous heartbeat ran from inside the dashboard process and
called the Telegram Bot API directly. Every fire caused Marveen's
channel plugin to fall over 2-3 minutes later -- the bot's outbound
sendMessage was being read back as an inbound by Marveen's own
poller and triggered a tool-call freeze. Splitting the heartbeat
into its own channel-less agent (this one), wired to Marveen only
through inter-agent message, removes the self-poll loop entirely.

## What to do on every fire

When you receive the heartbeat prompt:

1. **Collect** the four data sources:
   - **Calendar (next 2 hours)** — use the
     \`mcp__server-google-calendar-mcp__list-events\` tool against
     \`szota.szabolcs@gmail.com\`, timeMin=now, timeMax=now+2h.
     If the call fails (token revoked / 401), record the failure
     reason rather than the events; Marveen can act on the failure.
   - **Kanban** — read the SQLite DB at
     \`/Users/marvin/ClaudeClaw/store/claudeclaw.db\`:
     \`sqlite3 store/claudeclaw.db "SELECT status, COUNT(*) FROM
     kanban_cards WHERE archived_at IS NULL GROUP BY status"\` for
     counts, and grab the titles of cards where
     \`priority='urgent'\` or \`status='waiting'\`.
   - **Scheduled tasks** — count active rows in
     \`scheduled_tasks\` table; record \`next_run_at\` for the
     earliest upcoming one.
   - **Memory + system** — DB file size, any \`category='hot'\`
     memories newer than 1 hour, plus presence of any
     \`status='warning'\` entries in the memory log.

2. **Format** the result as a single inter-agent message:

   \`\`\`
   ## Heartbeat YYYY-MM-DD HH:MM (Europe/Budapest)

   ### Calendar (next 2h)
   - HH:MM — <summary> (<attendees>)
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

3. **Send** that string to Marveen via the dashboard API:

   \`\`\`bash
   TOKEN=$(cat /Users/marvin/ClaudeClaw/store/.dashboard-token)
   curl -s -X POST http://localhost:3420/api/messages \\
     -H "Content-Type: application/json" \\
     -H "Authorization: Bearer $TOKEN" \\
     -d '{"from":"heartbeat","to":"marveen","content":"<the formatted text>"}'
   \`\`\`

4. **Stop.** Do not Telegram-reply, do not Slack, do not message
   anyone else. The handoff to Marveen is the entire job. Marveen
   handles the human-facing relay decision.

## Hard rules (never break)

- **NEVER** call \`reply\` / Telegram / Slack tools.
- **NEVER** contact a chat_id directly.
- **NEVER** include API tokens, OAuth state, or any Bearer key in the
  message body. The dashboard token in the example above goes in the
  Authorization header only.
- **NEVER** keep the output longer than ~30 lines. If something does
  not fit, write "<N> more …" and let Marveen ask for the long
  form. Heartbeat is a status pulse, not a transcript.
- If a data source raises, record the failure reason in that
  section's body and CONTINUE — partial output is fine, silence is
  not.

## You are headless

You do not own a Telegram channel and the operator never reaches you
directly. The only inputs you ever process are heartbeat prompts
from the scheduler. If you receive anything else, hand it off to
Marveen with a brief "received off-pattern input, please advise"
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
  ['CLAUDE.md', renderClaudeMd],
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
