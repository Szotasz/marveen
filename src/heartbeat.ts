import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  HEARTBEAT_START_HOUR,
  HEARTBEAT_END_HOUR,
  HEARTBEAT_CALENDAR_ID,
  STORE_DIR,
} from './config.js'
import { getHeartbeatKanbanSummary, getActiveScheduledTaskCount } from './db.js'
import { getCalendarEvents, type CalendarEvent } from './google-api.js'
import { runAgent } from './agent.js'
import { notifyTelegram } from './notify.js'
import { logger } from './logger.js'

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
    const dbPath = join(STORE_DIR, 'claudeclaw.db')
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

  let prompt = `Heartbeat ellenorzes -- ${timeStr}\n\n`
  prompt += `Az alabbi adatokat gyujtottem nativ modon (API/DB). Fogalmazz tomor, emberi osszefoglalot Szabolcsnak.\n`
  prompt += `FONTOS: Nezd meg az emaileket is MCP-n keresztul (search_emails, utolso 2 ora, olvasatlanok).\n`
  prompt += `Hasznald a HEARTBEAT.md formatumot.\n\n`

  // Calendar
  prompt += `## Naptar (kovetkezo 2 ora)\n`
  if (data.calendar.length === 0) {
    prompt += `Nincs kozelgo esemeny.\n\n`
  } else {
    for (const ev of data.calendar) {
      const start = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Budapest' })
        : 'egesz napos'
      const attendees = ev.attendees?.map((a) => a.displayName || a.email).join(', ') || '-'
      prompt += `- ${ev.summary ?? '(cim nelkul)'} @ ${start} [resztvevok: ${attendees}]\n`
    }
    prompt += '\n'
  }

  // Kanban
  prompt += `## Kanban\n`
  prompt += `- In Progress: ${data.kanban.in_progress}\n`
  prompt += `- Urgent: ${data.kanban.urgent}`
  if (data.kanban.urgentTitles.length > 0) {
    prompt += ` (${data.kanban.urgentTitles.join(', ')})`
  }
  prompt += '\n'
  prompt += `- Waiting: ${data.kanban.waiting}`
  if (data.kanban.waitingTitles.length > 0) {
    prompt += ` (${data.kanban.waitingTitles.join(', ')})`
  }
  prompt += '\n\n'

  // System
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

  try {
    const { text } = await runAgent(prompt)
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
