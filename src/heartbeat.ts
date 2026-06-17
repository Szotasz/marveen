import { statSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, readdirSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { getEffectiveSettingValue } from './settings-store.js'
import {
  HEARTBEAT_CALENDAR_ID,
  STORE_DIR,
  DB_FILENAME,
  PROJECT_ROOT,
  OWNER_NAME,
} from './config.js'
import { getHeartbeatKanbanSummary, getActiveScheduledTaskCount } from './db.js'
import { getCalendarEvents, type CalendarEvent } from './google-api.js'
import { runAgent } from './agent.js'
import { notifyTelegram } from './notify.js'
import { logger } from './logger.js'
import { wrapUntrusted, UNTRUSTED_PREAMBLE } from './prompt-safety.js'

// Isolation cwd for the heartbeat sub-agent. Keep this OUT of PROJECT_ROOT
// so the @anthropic-ai/claude-agent-sdk-spawned headless claude does NOT
// load Marveen's project + user plugin config -- in particular the
// claude-plugins-official Telegram channel plugin, which would spawn its
// own `bun` poller against the same bot token Marveen is already polling
// (409 Conflict crashes the live Marveen poller). 2026-06-01: ~65 % of
// daily Marveen restarts clustered in the 0-10 min window after each
// hourly heartbeat fire BECAUSE of this collision; 20:00 fire window
// directly observed taking the bun-poller down within 2 min.
//
// agents/ is gitignored (per-install state), so this directory is built
// at runtime by ensureHeartbeatWorkerCwd() on every executeHeartbeat()
// call -- safe to delete by hand, will be recreated next tick.
const HEARTBEAT_AGENT_CWD = join(PROJECT_ROOT, 'agents', 'heartbeat-worker')

// Isolated CLAUDE_CONFIG_DIR for the heartbeat sub-agent. The claude-agent-sdk
// recognises the CLAUDE_CONFIG_DIR env var and reads ALL Claude Code config
// (settings.json, projects/, plugins/, marketplaces/, OAuth tokens) from this
// path instead of ~/.claude/. We construct this dir as a SET OF SYMLINKS to
// the real ~/.claude/ -- preserving auth, project transcripts and plugin
// marketplaces -- but REPLACE settings.json with an explicit
// enabledPlugins:{} (all-false) override.
//
// Why: 2026-06-02 10:00 incident proved that the project-scope settings.json
// (#247) does NOT override the user-scope enabledPlugins map inside the
// claude-agent-sdk spawn path. The SDK reads ~/.claude/settings.json
// directly. Repointing CLAUDE_CONFIG_DIR is the documented way the SDK
// supports an isolated config root (sdk.d.ts: "set CLAUDE_CONFIG_DIR=/tmp
// for ephemeral local copy").
const HEARTBEAT_CONFIG_DIR = join(HEARTBEAT_AGENT_CWD, '.claude-config')

// Plugins that MUST be disabled at the project-scope settings.json for the
// heartbeat sub-agent. The user-scope ~/.claude/settings.json keeps these
// enabled for Marveen / sub-agents that legitimately need them; the
// project-scope override is just for this isolated cwd. 2026-06-02 09:00
// incident: the original #237 fix only emptied `.mcp.json` (project-scope
// MCPs), but the user-scope `enabledPlugins` is GLOBAL and was still
// loading the Telegram plugin in the sub-agent. The sub-agent then spawned
// its own bun poller against the same bot token -> 409 Conflict -> Marveen
// channel down by 09:02:45. Project-scope `enabledPlugins: false` overrides
// the user-scope `true` per Claude Code settings precedence.
const HEARTBEAT_DISABLED_PLUGINS = [
  'telegram@claude-plugins-official',
  'slack-channel@marveen-marketplace',
  'discord@claude-plugins-official',
] as const

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>
  hooks?: unknown
  [key: string]: unknown
}

// Items under ~/.claude/ that must NOT be symlinked into the isolated
// config dir. settings.json is the WHOLE POINT -- it gets replaced with
// our enabledPlugins:{} override. .DS_Store / lock files are just noise.
const HEARTBEAT_CONFIG_SKIP = new Set(['settings.json', '.DS_Store', '.lock'])

function ensureHeartbeatWorkerCwd(): void {
  try {
    if (!existsSync(HEARTBEAT_AGENT_CWD)) {
      mkdirSync(HEARTBEAT_AGENT_CWD, { recursive: true })
    }
    // Project-scope empty MCP list (defense in depth -- the load-bearing
    // gates are the enabledPlugins override + CLAUDE_CONFIG_DIR).
    const mcpPath = join(HEARTBEAT_AGENT_CWD, '.mcp.json')
    if (!existsSync(mcpPath)) {
      writeFileSync(mcpPath, '{"mcpServers":{}}\n')
    }

    // Build the isolated CLAUDE_CONFIG_DIR. Symlink every top-level entry
    // from ~/.claude/ EXCEPT settings.json (which we replace) and noise
    // files. Symlinks let auth tokens / project transcripts / plugin
    // marketplaces remain shared, while settings.json -- the only file
    // whose enabledPlugins map matters here -- is private to this dir.
    if (!existsSync(HEARTBEAT_CONFIG_DIR)) {
      mkdirSync(HEARTBEAT_CONFIG_DIR, { recursive: true })
    }
    const realClaude = join(homedir(), '.claude')
    if (existsSync(realClaude)) {
      for (const entry of readdirSync(realClaude)) {
        if (HEARTBEAT_CONFIG_SKIP.has(entry)) continue
        const linkPath = join(HEARTBEAT_CONFIG_DIR, entry)
        const target = join(realClaude, entry)
        // Already a correct symlink? Skip. Anything else (stale file,
        // wrong target) gets unlinked and re-created so a manual edit
        // doesn't permanently break the isolation.
        let needsLink = true
        if (existsSync(linkPath) || lstatSyncSafe(linkPath)) {
          try {
            const st = lstatSync(linkPath)
            if (st.isSymbolicLink()) {
              needsLink = false
            } else {
              rmSync(linkPath, { recursive: true, force: true })
            }
          } catch { /* will recreate */ }
        }
        if (needsLink) {
          try {
            symlinkSync(target, linkPath)
          } catch (err) {
            logger.warn({ err, target, linkPath }, 'Heartbeat: failed to symlink config entry, sub-agent may degrade')
          }
        }
      }
    }

    // The actual override: a fresh settings.json with enabledPlugins:{}
    // (every channel plugin explicitly false). MERGE with anything
    // Claude Code may have written in a prior tick so hook configs etc.
    // survive -- but if a real ~/.claude/settings.json exists, we DO NOT
    // copy its content (only the enabledPlugins flip is intended).
    const settingsPath = join(HEARTBEAT_CONFIG_DIR, 'settings.json')
    let current: ClaudeSettings = {}
    if (existsSync(settingsPath) && !lstatSync(settingsPath).isSymbolicLink()) {
      try {
        const raw = readFileSync(settingsPath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          current = parsed as ClaudeSettings
        }
      } catch (err) {
        logger.warn({ err, path: settingsPath }, 'Heartbeat: failed to parse worker settings.json, rewriting')
      }
    } else if (lstatSyncSafe(settingsPath)?.isSymbolicLink()) {
      // Symlink to real settings.json from a prior tick or HEARTBEAT_CONFIG_SKIP
      // change -- remove it so we own the file. Reading through the symlink
      // would import the user-scope enabledPlugins, defeating the override.
      rmSync(settingsPath, { force: true })
    }
    const enabledPlugins: Record<string, boolean> = { ...(current.enabledPlugins ?? {}) }
    let dirty = false
    for (const plugin of HEARTBEAT_DISABLED_PLUGINS) {
      if (enabledPlugins[plugin] !== false) {
        enabledPlugins[plugin] = false
        dirty = true
      }
    }
    if (dirty || current.enabledPlugins == null || !existsSync(settingsPath)) {
      const next: ClaudeSettings = { ...current, enabledPlugins }
      writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n')
    }

    // macOS auth bridge: the Keychain holds the credentials JSON but there
    // is no source file to symlink into the isolated config dir. Read the
    // blob and materialise it as .credentials.json so the sub-agent finds
    // standard config-dir auth there (the same path Claude Code uses on
    // Linux installs natively). Marveen 2026-06-02 live A/B confirmed this
    // path succeeds where the CLAUDE_CODE_OAUTH_TOKEN env-var approach
    // failed with 401 (the Keychain output is the full JSON, not a bare
    // bearer token). The write is mode 0600 (owner rw only). Re-written
    // every tick so a rotated Keychain token propagates within the hour.
    const credentialsJson = readClaudeCodeOauthJson()
    if (credentialsJson) {
      const credPath = join(HEARTBEAT_CONFIG_DIR, '.credentials.json')
      writeFileSync(credPath, credentialsJson, { mode: 0o600 })
    }

    // MCP-server bridge: Claude Code stores PROJECT-scoped MCP server
    // configs in ~/.claude.json under the `projects[<cwd>]` map. The
    // 2026-06-02 14:00 hb-fire ran with an empty .claude.json (Claude
    // Code generated a fresh one in CLAUDE_CONFIG_DIR), so the sub-agent
    // saw zero user-level MCPs -- Gmail OAuth lost, Calendar fell back to
    // the wrong default account (Szabi 14:27 report).
    //
    // Copy the real ~/.claude.json into the isolated config dir AND
    // duplicate the `projects[PROJECT_ROOT]` entry under
    // `projects[HEARTBEAT_AGENT_CWD]` so the sub-agent inherits Marveen's
    // server-gmail-autoauth-mcp + server-google-calendar-mcp config from
    // its own cwd key. Channel-plugin isolation stays in force because
    // enabledPlugins is governed by the CLAUDE_CONFIG_DIR settings.json
    // (which we still write with all channel plugins = false), NOT by
    // .claude.json.
    try {
      const homeClaudeJsonPath = join(homedir(), '.claude.json')
      if (existsSync(homeClaudeJsonPath)) {
        const raw = readFileSync(homeClaudeJsonPath, 'utf-8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed && typeof parsed === 'object') {
          const projects = (parsed as { projects?: Record<string, unknown> }).projects
          if (projects && typeof projects === 'object' && projects[PROJECT_ROOT] && !projects[HEARTBEAT_AGENT_CWD]) {
            projects[HEARTBEAT_AGENT_CWD] = projects[PROJECT_ROOT]
          }
          const heartbeatClaudeJsonPath = join(HEARTBEAT_CONFIG_DIR, '.claude.json')
          writeFileSync(heartbeatClaudeJsonPath, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Heartbeat: failed to materialise .claude.json into isolated config dir (sub-agent will lack project MCPs)')
    }

    // Dashboard-hide sentinel: Szabi 2026-06-02 asked that this technical
    // worker NOT show up as a real agent on the dashboard. listAgentNames()
    // filters out any subdir of agents/ that contains this sentinel file.
    const sentinelPath = join(HEARTBEAT_AGENT_CWD, '.hidden-from-dashboard')
    if (!existsSync(sentinelPath)) {
      writeFileSync(sentinelPath, '')
    }
  } catch (err) {
    logger.warn({ err, cwd: HEARTBEAT_AGENT_CWD }, 'Heartbeat: failed to ensure isolated worker cwd, falling back to PROJECT_ROOT')
  }
}

function lstatSyncSafe(p: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(p) } catch { return null }
}

// Read the Claude Code credentials JSON from the macOS Keychain and write
// it to the isolated CLAUDE_CONFIG_DIR's `.credentials.json` so the
// SDK-spawned claude finds the standard auth file there.
//
// On macOS, Claude Code stores the FULL credentials JSON in the login
// Keychain under service='Claude Code-credentials', account=<unix user>.
// There is NO ~/.claude/.credentials.json file to symlink. Without auth
// in CLAUDE_CONFIG_DIR, the sub-agent treats it as a fresh install
// ("Not logged in -- Please run /login") and exits before sending the
// heartbeat (verified live 13:00 hb of 2026-06-02).
//
// IMPORTANT (Marveen 2026-06-02 review with live test): the `security -w`
// output is the FULL credentials JSON, NOT a bare bearer token:
//   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, ... },
//     "mcpOAuth": { ... } }
// (~809 bytes). We MUST write the whole blob -- the refreshToken inside
// is what lets the sub-agent renew its session without us. An earlier
// attempt to drop the JSON into CLAUDE_CODE_OAUTH_TOKEN (env-var) failed
// with 401 because that env expects a bare access token (sk-ant-oat...).
// The config-dir .credentials.json path is the one Claude Code expects
// on Linux installs and Marveen's live A/B test confirmed it succeeds.
//
// SECURITY:
//   - `security` is invoked via execFileSync so the JSON never traverses
//     a shell string.
//   - stdio = ['ignore', 'pipe', 'ignore'] keeps it off stderr.
//   - The catch block logs ONLY a bare message; `err` is NEVER passed to
//     the logger (some macOS auth errors echo a fragment of the lookup
//     key, and we never want that anywhere near our log stream).
//   - The .credentials.json file is written with mode 0600 (owner rw),
//     same as how Claude Code creates it on Linux.
//   - Local file lifetime: until the next ensureHeartbeatWorkerCwd
//     rewrites it. We re-write it every tick so a rotated Keychain
//     token reaches the sub-agent within an hour.
//
// Returns the JSON string on success, null on failure or non-darwin.
// On Linux, the existing symlink loop captures ~/.claude/.credentials.json
// so this function intentionally does nothing.
function readClaudeCodeOauthJson(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username, '-w'],
      { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (!out) return null
    return out
  } catch {
    // Intentionally NOT logging `err` -- some macOS auth errors echo a
    // fragment of the lookup key. Bare message is enough; the operator
    // can reproduce manually with the documented `security
    // find-generic-password ...` command.
    logger.warn('Heartbeat: failed to read Claude Code credentials from Keychain (sub-agent will run logged-out)')
    return null
  }
}

// --- Data types ---

interface SystemInfo {
  dbSizeMB: number
  dbWarning: boolean
}

interface HeartbeatData {
  timestamp: Date
  calendar: CalendarEvent[]
  kanban: { urgent: number; in_progress: number; waiting: number; urgentTitles: string[]; waitingTitles: string[] }
  system: SystemInfo
  tasks: { count: number; nextRun: number | null }
}

// --- Data collection ---

async function collectCalendar(): Promise<CalendarEvent[]> {
  try {
    const now = new Date()
    const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000)
    return await getCalendarEvents(HEARTBEAT_CALENDAR_ID, now, twoHoursLater)
  } catch (err) {
    logger.error({ err }, 'Heartbeat: calendar fetch failed')
    return []
  }
}

function collectKanban(): HeartbeatData['kanban'] {
  try {
    const summary = getHeartbeatKanbanSummary()
    return {
      urgent: summary.urgent.length,
      in_progress: summary.in_progress.length,
      waiting: summary.waiting.length,
      urgentTitles: summary.urgent.map((c) => c.title),
      waitingTitles: summary.waiting.map((c) => c.title),
    }
  } catch (err) {
    logger.error({ err }, 'Heartbeat: kanban fetch failed')
    return { urgent: 0, in_progress: 0, waiting: 0, urgentTitles: [], waitingTitles: [] }
  }
}

function collectSystem(): SystemInfo {
  try {
    const dbPath = join(STORE_DIR, DB_FILENAME)
    const dbSize = statSync(dbPath).size / (1024 * 1024)
    return { dbSizeMB: Math.round(dbSize * 10) / 10, dbWarning: dbSize > 100 }
  } catch {
    return { dbSizeMB: 0, dbWarning: false }
  }
}

async function collectData(): Promise<HeartbeatData> {
  const [calendar, kanban, system] = await Promise.all([
    collectCalendar(),
    Promise.resolve(collectKanban()),
    Promise.resolve(collectSystem()),
  ])
  const tasks = getActiveScheduledTaskCount()
  return { timestamp: new Date(), calendar, kanban, system, tasks }
}

// --- Notification filter ---

function shouldNotify(data: HeartbeatData): boolean {
  const hour = data.timestamp.getHours()
  const dayOfWeek = data.timestamp.getDay()
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

  if (data.system.dbWarning) return true

  // 22:00 utan csendes ablak -- csak igazi rendszer-vesz (dbWarning, fent
  // mar return-olt) lephet at. Stale urgent kanban-kartyak este nem zavarjak
  // a felhasznalot.
  if (hour >= 22) return false

  if (hour >= 21) {
    return data.kanban.urgent > 0
  }

  if (isWeekend) {
    return data.kanban.urgent > 0
  }

  if (data.calendar.length > 0) return true
  if (data.kanban.urgent > 0) return true
  if (data.kanban.waiting > 2) return true

  return false
}

// --- Agent prompt ---

function buildAgentPrompt(data: HeartbeatData): string {
  const timeStr = data.timestamp.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })

  // Preamble first so the <untrusted> tag convention is established before any
  // attacker-controlled strings (calendar/kanban/email titles) appear.
  let prompt = UNTRUSTED_PREAMBLE + '\n'
  prompt += `Heartbeat ellenorzes -- ${timeStr}\n\n`
  prompt += `Az alabbi adatokat gyujtottem nativ modon (API/DB). Fogalmazz tomor, emberi osszefoglalot ${OWNER_NAME} szamara.\n`
  prompt += `FONTOS: Nezd meg az emaileket is MCP-n keresztul (search_emails, utolso 2 ora, olvasatlanok).\n`
  prompt += `Hasznald a HEARTBEAT.md formatumot.\n\n`

  // Calendar -- event summaries and attendee names come from whoever sent the
  // invite, so every one is wrapped individually as untrusted data.
  prompt += `## Naptar (kovetkezo 2 ora)\n`
  if (data.calendar.length === 0) {
    prompt += `Nincs kozelgo esemeny.\n\n`
  } else {
    for (const ev of data.calendar) {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Budapest' })
        : 'egesz napos'
      const attendeesRaw = ev.attendees?.map((a) => a.displayName || a.email).join(', ') || '-'
      const summaryWrapped = wrapUntrusted('gcal-event-summary', ev.summary ?? '(cim nelkul)')
      const attendeesWrapped = wrapUntrusted('gcal-event-attendees', attendeesRaw)
      prompt += `- @ ${start}\n  summary: ${summaryWrapped}\n  attendees: ${attendeesWrapped}\n`
    }
    prompt += '\n'
  }

  // Kanban -- card titles are operator-authored today, but a future Kanban-sync
  // integration could bring them from third parties. Wrap defensively.
  prompt += `## Kanban\n`
  prompt += `- In Progress: ${data.kanban.in_progress}\n`
  prompt += `- Urgent: ${data.kanban.urgent}`
  if (data.kanban.urgentTitles.length > 0) {
    prompt += ` ${wrapUntrusted('kanban-urgent-titles', data.kanban.urgentTitles.join(', '))}`
  }
  prompt += '\n'
  prompt += `- Waiting: ${data.kanban.waiting}`
  if (data.kanban.waitingTitles.length > 0) {
    prompt += ` ${wrapUntrusted('kanban-waiting-titles', data.kanban.waitingTitles.join(', '))}`
  }
  prompt += '\n\n'

  // System -- trusted (our own metrics, no external input).
  prompt += `## Rendszer\n`
  prompt += `- DB meret: ${data.system.dbSizeMB} MB${data.system.dbWarning ? ' WARNING >100MB!' : ''}\n`
  prompt += `- Aktiv utemezett feladatok: ${data.tasks.count}\n`
  if (data.tasks.nextRun) {
    const nextDate = new Date(data.tasks.nextRun * 1000)
    prompt += `- Kovetkezo feladat: ${nextDate.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })}\n`
  }

  return prompt
}

// --- Scheduling ---

function msUntilNextHeartbeat(): number {
  const now = new Date()
  const currentHour = now.getHours()
  const startH = Number(getEffectiveSettingValue('HEARTBEAT_START_HOUR'))
  const endH = Number(getEffectiveSettingValue('HEARTBEAT_END_HOUR'))

  let targetHour: number

  if (currentHour < startH) {
    targetHour = startH
  } else if (currentHour >= endH) {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(startH, 0, 0, 0)
    return tomorrow.getTime() - now.getTime()
  } else {
    targetHour = currentHour + 1
    if (targetHour === 8) targetHour = startH
    if (targetHour >= endH) {
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(startH, 0, 0, 0)
      return tomorrow.getTime() - now.getTime()
    }
  }

  const target = new Date(now)
  target.setHours(targetHour, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

async function executeHeartbeat(): Promise<void> {
  const hour = new Date().getHours()
  const startH = Number(getEffectiveSettingValue('HEARTBEAT_START_HOUR'))
  const endH = Number(getEffectiveSettingValue('HEARTBEAT_END_HOUR'))
  if (hour < startH || hour >= endH) {
    logger.debug('Heartbeat: outside active window, skipping')
    return
  }

  logger.info('Heartbeat ellenorzes indul...')
  const data = await collectData()

  if (!shouldNotify(data)) {
    logger.info('Heartbeat ellenorzes kesz -- nincs ertesitendo')
    return
  }

  logger.info('Heartbeat: van tennivalo, agent indul...')
  const prompt = buildAgentPrompt(data)
  ensureHeartbeatWorkerCwd()

  try {
    // CRITICAL: run the sub-agent in an isolated cwd that does NOT load
    // the Marveen project's plugin config. The default cwd=PROJECT_ROOT
    // makes the SDK-spawned headless claude load claude-plugins-official
    // (the Telegram channel plugin), which spawns its own `bun` poller
    // against the same bot token Marveen is already polling. Telegram's
    // getUpdates allows only ONE concurrent long-poll per bot, so the
    // second poll triggers a 409 Conflict and the live Marveen bun
    // child dies -- which is why ~65 % of all Marveen restarts on
    // 2026-06-01 clustered in the 0-10 min window after every hourly
    // heartbeat fire. The agents/heartbeat-worker dir has an empty
    // .mcp.json and no agent-config, so claude finds no channel plugin
    // to activate.
    // CLAUDE_CONFIG_DIR repoints the SDK-spawned claude to the isolated
    // config root we just built. That's the gate that actually prevents
    // the user-scope enabledPlugins:{telegram:true} from leaking in --
    // the project-scope override in #247 did NOT (verified: 09/10/11/12
    // hb all loaded the plugin and crashed Marveen via 409 Conflict).
    // Auth lives in $HEARTBEAT_CONFIG_DIR/.credentials.json -- the
    // ensureHeartbeatWorkerCwd() call above wrote it from the macOS
    // Keychain JSON. The previous version injected the JSON via the
    // CLAUDE_CODE_OAUTH_TOKEN env var (Marveen-suggested but later
    // empirically disproved: that env expects a bare bearer token, the
    // JSON blob comes back 401 "Invalid bearer token"). Config-dir file
    // path is what Claude Code's Linux installs use natively and what
    // the SDK config-dir code honours.
    const { text } = await runAgent(prompt, undefined, undefined, false, HEARTBEAT_AGENT_CWD, {
      CLAUDE_CONFIG_DIR: HEARTBEAT_CONFIG_DIR,
    })
    if (text) {
      await notifyTelegram(text)
      logger.info('Heartbeat ertesites elkuldve')
    }
  } catch (err) {
    logger.error({ err }, 'Heartbeat agent hiba')
  }
}


// --- Public API ---

let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null
let stopped = false

function scheduleNext(delayMs: number): void {
  heartbeatTimeout = setTimeout(async () => {
    await executeHeartbeat().catch((err) => logger.error({ err }, 'Heartbeat hiba'))

    if (stopped) return

    const nextDelayMs = msUntilNextHeartbeat()
    const nextRun = new Date(Date.now() + nextDelayMs)
    logger.info(
      { nextRun: nextRun.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }) },
      `Heartbeat kovetkezo: ${nextRun.toLocaleTimeString('hu-HU', { timeZone: 'Europe/Budapest' })}`
    )
    scheduleNext(nextDelayMs)
  }, delayMs)
}

export function initHeartbeat(): void {
  const delayMs = msUntilNextHeartbeat()
  const nextRun = new Date(Date.now() + delayMs)
  logger.info(
    { nextRun: nextRun.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }) },
    `Heartbeat utemezve (kovetkezo: ${nextRun.toLocaleTimeString('hu-HU', { timeZone: 'Europe/Budapest' })})`
  )
  scheduleNext(delayMs)
}

export function stopHeartbeat(): void {
  stopped = true
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout)
  logger.info('Heartbeat leallitva')
}

// For manual testing
export { collectData, shouldNotify, buildAgentPrompt, executeHeartbeat }
