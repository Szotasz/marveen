import { statSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, readdirSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  HEARTBEAT_START_HOUR,
  HEARTBEAT_END_HOUR,
  HEARTBEAT_CALENDAR_ID,
  STORE_DIR,
  DB_FILENAME,
  PROJECT_ROOT,
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
  } catch (err) {
    logger.warn({ err, cwd: HEARTBEAT_AGENT_CWD }, 'Heartbeat: failed to ensure isolated worker cwd, falling back to PROJECT_ROOT')
  }
}

function lstatSyncSafe(p: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(p) } catch { return null }
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
  prompt += `Az alabbi adatokat gyujtottem nativ modon (API/DB). Fogalmazz tomor, emberi osszefoglalot Szabolcsnak.\n`
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

  let targetHour: number

  if (currentHour < HEARTBEAT_START_HOUR) {
    targetHour = HEARTBEAT_START_HOUR
  } else if (currentHour >= HEARTBEAT_END_HOUR) {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(HEARTBEAT_START_HOUR, 0, 0, 0)
    return tomorrow.getTime() - now.getTime()
  } else {
    targetHour = currentHour + 1
    if (targetHour === 8) targetHour = HEARTBEAT_START_HOUR
    if (targetHour >= HEARTBEAT_END_HOUR) {
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(HEARTBEAT_START_HOUR, 0, 0, 0)
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
  if (hour < HEARTBEAT_START_HOUR || hour >= HEARTBEAT_END_HOUR) {
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
