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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROJECT_ROOT,
  STORE_DIR,
  OWNER_NAME,
  BOT_NAME,
  MAIN_AGENT_ID,
  HEARTBEAT_AGENT_ID,
  WEB_PORT,
  HEARTBEAT_CALENDAR_ACCOUNT,
  APP_TZ,
  DASHBOARD_PUBLIC_URL,
} from '../config.js'
import { resolveDashboardOrigin } from './agent-scaffold.js'
import { logger } from '../logger.js'
import { CHANNEL_PLUGIN_IDS } from './plugin-ids.js'

const HEARTBEAT_AGENT_NAME = HEARTBEAT_AGENT_ID
const HEARTBEAT_AGENT_DIR = join(PROJECT_ROOT, 'agents', HEARTBEAT_AGENT_NAME)

// Channel plugins MUST be explicitly disabled in the agent's
// project-scope .claude/settings.json. Without this they leak through
// from the user-scope ~/.claude/settings.json (every channel plugin
// the operator has enabled globally would otherwise activate here,
// open its own poller against the OPERATOR's bot token, and race the
// main agent's poller for the same getUpdates slot -- see
// agent-process.ts:137 for the same disable baked into startup).
const CHANNEL_PLUGIN_DISABLES = Object.fromEntries(
  Object.values(CHANNEL_PLUGIN_IDS).map(id => [id, false as const])
)

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
  // Absolute path to scripts/heartbeat-metrics.sh -- the round's single
  // callable instrument (HBMEMBLIND819 third contract). The rendered
  // CLAUDE.md references this path and nothing else about how the
  // numbers are produced, so there is no command prose left to
  // recompose.
  metricsScript: string
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
    metricsScript: join(PROJECT_ROOT, 'scripts', 'heartbeat-metrics.sh'),
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

0. **Read the clock.** Every timestamp you print is local time in
   ${APP_TZ}, and you have no clock of your own -- so measure it:

   \`\`\`bash
   TZ=${APP_TZ} date +'%Y-%m-%d %H:%M'
   \`\`\`

   Use THAT string in the header. Never \`date -u\`, never
   \`datetime.now(timezone.utc)\`, never the hour the schedule was
   supposed to fire. UTC printed under a \`${APP_TZ}\` label is worse
   than no timestamp: every window in this report ("next 2h", "last
   1h") is read against it, so an hour of drift silently moves the
   window as well as the label.

1. **Collect** the four data sources:
   - **Calendar (next 2 hours)** -- use the
     \`mcp__server-google-calendar-mcp__list-events\` tool
     ${calendarTarget}, timeMin=now, timeMax=now+2h.
     Call it as a TOOL, directly. Do not try to reach an MCP server
     from Bash, python, curl or any other subprocess: MCP tools exist
     only in your own tool list, so a subprocess will always come back
     empty and that emptiness says nothing about the server.

     DEFERRED LOADING (2026-08-09, HBCALMCP808): MCP tools may arrive
     DEFERRED -- their names appear in a system-reminder listing but
     the schema is not loaded, and a direct call fails as if the tool
     did not exist. That failure is NOT absence. Before concluding
     anything, run:

     ToolSearch with query "select:mcp__server-google-calendar-mcp__list-events"

     and then call the tool normally. Between 2026-08-08 20:00 and
     2026-08-09 every hourly round reported "calendar tool not
     available" while all 13 calendar tools sat in the deferred list
     of the very same session -- the section went empty for a day
     because this step was missing.

     You may say "calendar tool not available in this session" ONLY
     when ToolSearch itself cannot surface the tool either -- that is
     a different fact from a failed direct call on a deferred tool,
     and a different fact again from a failed call (token revoked /
     401), which only the loaded tool can produce.
     If the call fails (token revoked / 401), record the failure
     reason rather than the events; the main agent can act on the
     failure.
   - **Metrics (kanban + tasks + memory + DB size)** -- ONE fixed,
     on-disk instrument. Run it EXACTLY as written and copy its output
     lines VERBATIM into the report sections below; never recompose any
     of its measurements yourself:

     \`\`\`bash
     CLAW_STORE_DIR=${id.storeDir} CLAW_DASHBOARD_ORIGIN=${id.dashboardOrigin} CLAW_TZ=${APP_TZ} bash ${id.metricsScript}
     \`\`\`

     THE SENTINEL RULE (HBMEMBLIND819): a number may enter your report
     ONLY from an output whose FIRST line starts with the known
     sentinel \`HB_METRICS_V1\`. Anything else -- an unknown or newer
     sentinel (a future \`HB_METRICS_V2\` under these instructions
     included), "No such file or directory", a shell error, empty
     output -- is an INSTRUMENT FAILURE: put the literal first line of
     what you got into EVERY affected section as
     \`muszer-hiba: <line>\`. NEVER write 0 for a value the instrument
     did not print, and NEVER rebuild these numbers with your own
     curl / python3 / sqlite3 / du / ls / stat -- not even a
     correct-looking one-liner. That includes the pipe+heredoc shape
     that produced HBHEREDOC819 (\`echo "$X" | python3 << 'PY'\` loses
     the piped data silently: the heredoc becomes python3's stdin).

     If the output contains \`ERROR <section>: <reason>\` lines, copy
     each into its section verbatim as \`muszer-hiba: ERROR ...\` and
     use the lines that ARE present -- partial output is fine, silence
     and substitution are not. The instrument is fail-closed: a
     missing or null field never prints as 0, so
     \`new hot memories (1h): nincs adat (muszer-hiba)\` is the honest
     report and a fabricated 0 is the defect.

     Why a fixed script and not a prescribed command, measured three
     times on the SAME metric: 2026-08-07 (HBMEMBLIND807) a prose
     bullet let the round compose its own SQL (reported 0 beside 3 hot
     memories); the fix prescribed a ready-made query, and 2026-08-19
     (HBMEMBLIND819) post-compact rounds reconstructed it with the
     wrong agent_id (14/14 rounds a false 0); the next fix shipped a
     ready-made one-liner, and 2026-08-24 22:00 a round re-composed
     THAT with a truncated format string, so the missing field printed
     as 0 again. A prescription you must re-copy every hour is not a
     mechanism; a script on disk has nothing to recompose.

     What the lines mean, and where each number is allowed to come from:
     - \`COUNTS ...\` -- kanban totals plus \`counts.new_hot_memories_1h\`
       and \`counts.db_size_mb\`, all computed server-side on
       \`${id.dashboardOrigin}/api/kanban/heartbeat-summary\` and copied
       through. EVERY number comes from this line and nowhere else
       (HBKANBANDRIFT819: the URGENT/WAITING lists are capped and
       their titles truncated BY DESIGN -- counting list items once
       reported waiting: 12 against a real 280).
     - \`URGENT <id> <title>\` / \`WAITING <id> <title>\` -- only
       UNFINISHED cards, never \`done\`, \`planned\` included. If a
       list is empty, report it as empty: do not widen the query, do
       not fill the line with closed cards. An empty urgent list is
       the good news, and a report nobody can trust to be empty is a
       report nobody reads.
     - \`SCHEDULES enabled=N\` -- the live registry
       (\`${id.dashboardOrigin}/api/schedules\`), NOT the
       \`scheduled_tasks\` table (empty on this deployment; a count
       from it reports 0 forever).
     - \`TASK_RUNS_1H ...\` -- what actually ran in the last hour.
       \`task_runs.ts\` is in MILLISECONDS and the script bakes the
       \`*1000\` cutoff in -- exactly the kind of trap that must never
       be re-derived by hand.
     HBWARN807 still holds: there is NO warnings metric here on
     purpose. The old bullet pointed at a source that does not exist
     (memories has no status column, the store has no such log table),
     so the line could only ever say 'none' -- an unfalsifiable metric
     is zero evidence wearing the costume of a check. If a warnings
     line ever returns, it must come as a field of this instrument's
     output, backed by a real source.

2. **Format** the result as a single inter-agent message:

   \`\`\`
   ## Heartbeat <the string step 0 measured> (${APP_TZ})

   ### Calendar (next 2h)
   - HH:MM -- <summary> (<attendees>)
   - <or: "no upcoming events">
   - <or: "calendar fetch failed: <reason>">

   ### Kanban
   - urgent: <N from COUNTS> (<short titles from the URGENT lines>)
   - in_progress: <N from COUNTS>
   - waiting: <N from COUNTS> (<short titles from the WAITING lines>)
   - planned: <N from COUNTS>

   ### Tasks
   - enabled schedules: <N from SCHEDULES>
   - last hour: <the TASK_RUNS_1H line, verbatim>

   ### Memory / system
   - DB size: <db_size_mb from COUNTS> MB
   - new hot memories (1h): <new_hot_memories_1h from COUNTS>
   \`\`\`

   Every line above is a MEASUREMENT of this round, never a memory of
   an earlier one. Run the instrument again and report what it returns
   now, even when you are sure nothing changed -- especially then.
   A value carried over from an earlier round makes its line constant,
   and a line that always says the same thing stops being read -- at
   which point a real change looks exactly like the noise around it.

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
- **NEVER** copy a value from an earlier round's report, and never
  fill a field from what you remember saying last time. Every number,
  title and timestamp comes from a query you ran in THIS
  round. If a query fails, say it failed -- do not substitute the
  previous answer, because a stale value is indistinguishable from a
  fresh one once it is in the message.
  This applies to the whole report: the
  urgent titles, the task counts, \`next:\`, the DB size and the
  one-hour hot-memory count are all measurements with a timestamp,
  and every one of them is wrong the moment it is reused.

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

// The project-scope settings must MERGE, never overwrite (HBGATEWIRE826):
// the hook-seeding pass (web.ts) writes gate hooks into this SAME file, and
// this scaffold reruns at every boot after it -- the previous wholesale
// rewrite deleted every seeded hook, which was one half of how the heartbeat
// worker ran with ZERO dashboard-side hooks (the kanban-write-gate included)
// while every test stayed green. Only the key this scaffold OWNS
// (enabledPlugins) is enforced; everything else (hooks, permissions) is
// preserved. Exported pure so the wiring test can pin the contract.
export function mergeClaudeSettingsJson(existingRaw: string | null): string {
  let existing: Record<string, unknown> = {}
  if (existingRaw) {
    try { existing = JSON.parse(existingRaw) as Record<string, unknown> } catch { existing = {} }
  }
  existing.enabledPlugins = CHANNEL_PLUGIN_DISABLES
  return JSON.stringify(existing, null, 2) + '\n'
}

// Files we ALWAYS rewrite wholesale. Agent-config is recreated to keep it in
// sync with the constants in this file; if the operator hand-edited the
// on-disk copy, our boot rewrite wins. CLAUDE.md is re-rendered every boot
// for the same reason: the canonical source of truth for the agent's
// instructions lives here, not on disk. settings.json is deliberately NOT
// here -- it is merge-written (see mergeClaudeSettingsJson).
const ALWAYS_WRITE: ReadonlyArray<readonly [string, () => string]> = [
  ['CLAUDE.md', () => renderHeartbeatClaudeMd(currentHeartbeatIdentity())],
  ['agent-config.json', renderAgentConfigJson],
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
    const settingsPath = join(claudeDir, 'settings.json')
    const existingRaw = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null
    writeFileSync(settingsPath, mergeClaudeSettingsJson(existingRaw))
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
