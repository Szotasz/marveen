import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import {
  PROJECT_ROOT,
  MAIN_AGENT_ID,
  ALLOWED_CHAT_ID,
} from '../config.js'
import {
  appendTaskRun,
  listPendingTaskRetries,
  deletePendingTaskRetry,
  updatePendingTaskRetry,
  insertPendingTaskRetryIfNew,
  markPendingTaskRetryAlert,
  clearPendingTaskRetryAlert,
} from '../db.js'
import { toPendingRetryView, type PendingRetryView } from '../pending-retries.js'
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../prompt-safety.js'
import { cronMatchesNow } from './cron.js'
import {
  listScheduledTasks,
  type ScheduledTask,
} from './scheduled-tasks-io.js'
import { listAgentNames, readFileOr } from './agent-config.js'
import {
  agentSessionName,
  isAgentRunning,
  isSessionReadyForPrompt,
  sendPromptToSession,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { sendTelegramMessage } from './telegram.js'

const TMUX = resolveFromPath('tmux')

// --- Schedule Runner ---
// Checks every minute if any scheduled task is due and injects the prompt
// into the agent's tmux session.
//
// Tasks that matched their cron but found the target session busy are
// persisted in the `pending_task_retries` DB table and retried on every
// subsequent 60s tick until the session frees up or the operator cancels
// them from the UI. The previous design kept them in an in-memory Map
// and abandoned them after an hour -- which silently dropped business-
// critical schedules. The new policy never abandons; once the age
// crosses ALERT_THRESHOLD_MS the alerting layer stamps alert_sent_at
// before each Telegram send and clears the stamp on delivery failure,
// giving exactly-one stamp per attempt and at-least-once delivery until
// success. See sendPendingRetryAlert below.

const scheduleLastRun: Map<string, number> = new Map()

// Try to fire a task at a single target agent. Returns the outcome so the
// caller can decide whether to queue a retry. Splitting this out means the
// pendingTaskRetries loop and the normal cron loop share one code path.
function attemptFireTask(task: ScheduledTask, agentName: string, now: number): 'fired' | 'busy' | 'missing' | 'error' {
  const isMainAgent = agentName === MAIN_AGENT_ID
  const session = isMainAgent ? MAIN_CHANNELS_SESSION : agentSessionName(agentName)

  let sessionExists = false
  try {
    const sessions = execSync(`${TMUX} list-sessions -F "#{session_name}"`, { timeout: 3000, encoding: 'utf-8' })
    sessionExists = sessions.split('\n').some(s => s.trim() === session)
  } catch { /* no tmux */ }

  if (!sessionExists) {
    logger.warn({ task: task.name, agent: agentName, session }, 'Schedule target session not running, skipping')
    return 'missing'
  }

  if (!isSessionReadyForPrompt(session)) {
    logger.warn({ task: task.name, agent: agentName, session }, 'Schedule target session busy or has pending input, will retry')
    return 'busy'
  }

  try {
    let prefix: string
    if (task.type === 'heartbeat') {
      prefix = `[Heartbeat: ${task.name}] FONTOS: Ez egy csendes ellenorzes. CSAK AKKOR irj Telegramon (chat_id: ${ALLOWED_CHAT_ID}), ha tenyleg fontos/surgos dolgot talalsz. Ha minden rendben, NE irj semmit -- maradj csendben. `
    } else {
      prefix = `[Utemezett feladat: ${task.name}] Az eredmenyt kuldd el Telegramon (chat_id: ${ALLOWED_CHAT_ID}, reply tool). `
    }
    // Task prompts are editable via /api/schedules (bearer-gated), which means
    // they can carry injection payloads just like inter-agent messages. Wrap
    // the user-editable part and prepend the preamble so the receiving agent
    // treats it as data, not an instruction override.
    const fullPrompt =
      UNTRUSTED_PREAMBLE + '\n' +
      prefix.trimEnd() + '\n\n' +
      wrapUntrusted(`scheduled-task:${task.name}`, task.prompt)
    sendPromptToSession(session, fullPrompt)
    scheduleLastRun.set(task.name, now)
    appendTaskRun(task.name, agentName)
    logger.info({ task: task.name, agent: agentName, session }, 'Scheduled task fired')

    // Post-send verify: if the agent started a new turn during our chunk
    // stream, the Enter from sendPromptToSession might have landed while
    // the agent was thinking and Claude Code parked the bytes on the input
    // line. We want the prompt to run, not disappear -- so if the pane
    // still shows our marker below ❯ after a short wait, re-send Enter so
    // the submit sticks. We retry a couple of times before giving up.
    const marker = task.type === 'heartbeat'
      ? `[Heartbeat: ${task.name}]`
      : `[Utemezett feladat: ${task.name}]`
    const resubmit = (attempt: number) => {
      try {
        const pane = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], { timeout: 3000, encoding: 'utf-8' })
        const stuck = /❯\s+\S/.test(pane) && pane.includes(marker)
        if (!stuck) return
        if (attempt >= 5) {
          logger.warn({ task: task.name, session }, 'Scheduled prompt still stuck after 5 Enter retries -- giving up')
          return
        }
        execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
        setTimeout(() => resubmit(attempt + 1), 3000)
      } catch (err) {
        logger.warn({ err, task: task.name }, 'Post-send resubmit failed')
      }
    }
    setTimeout(() => resubmit(0), 2000)
    return 'fired'
  } catch (err) {
    logger.warn({ err, task: task.name }, 'Failed to fire scheduled task')
    return 'error'
  }
}

// Fire a Telegram alert when a pending retry has been stuck past the
// threshold. Stamps `alert_sent_at` BEFORE the network call so concurrent
// ticks and crash-restarts cannot race into double-alerting on the same
// attempt. If the send fails, the stamp is cleared so the next tick can
// retry -- that way a transient Telegram outage or a bad token doesn't
// silently suppress every future alert on this row. Net semantics:
// exactly-one stamp per delivery attempt, at-least-once delivery with a
// 60s retry cadence until success.
function sendPendingRetryAlert(view: PendingRetryView, nowMs: number): void {
  // Stamp first. If another tick raced us, markPendingTaskRetryAlert
  // returns false (the WHERE alert_sent_at IS NULL guards it) and we
  // skip the send entirely.
  const claimed = markPendingTaskRetryAlert(view.taskName, view.agentName, nowMs)
  if (!claimed) return

  const ageMinutes = Math.floor(view.ageMs / 60000)
  const firstAttempt = new Date(view.firstAttempt).toLocaleString('hu-HU')
  const text = [
    `[Marveen scheduler] A(z) "${view.taskName}" (${view.agentName}) utemezett feladat ${ageMinutes} perce varakozik.`,
    `Elso probalkozas: ${firstAttempt}.`,
    'A rendszer tovabb probalkozik; a dashboard /Utemezesek oldalan visszavonhato.',
  ].join('\n')
  ;(async () => {
    try {
      const envPath = join(PROJECT_ROOT, '.env')
      const envContent = readFileOr(envPath, '')
      const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
      const token = tokenMatch?.[1]?.trim()
      if (!token) {
        logger.warn({ task: view.taskName, agent: view.agentName }, 'Pending-retry alert skipped: no TELEGRAM_BOT_TOKEN, clearing stamp for retry')
        clearPendingTaskRetryAlert(view.taskName, view.agentName)
        return
      }
      await sendTelegramMessage(token, ALLOWED_CHAT_ID, text)
      logger.info({ task: view.taskName, agent: view.agentName, ageMinutes }, 'Pending-retry Telegram alert sent')
    } catch (err) {
      // Real send failure (network error, 4xx from Telegram). Clear the
      // per-attempt stamp so the next tick can legitimately retry --
      // otherwise a bad token silently wedges the alerting forever.
      logger.warn({ err, task: view.taskName, agent: view.agentName }, 'Pending-retry alert delivery failed, clearing stamp for retry')
      clearPendingTaskRetryAlert(view.taskName, view.agentName)
    }
  })()
}

export function startScheduleRunner(): NodeJS.Timeout {
  let firstRun = true

  function runCheck() {
    const tasks = listScheduledTasks()
    const now = Date.now()
    // On first run after restart, catch up missed tasks from last 30 min
    const catchUp = firstRun ? 30 * 60000 : 60000
    firstRun = false

    // Retry tasks that were busy-skipped on earlier ticks (persisted in
    // pending_task_retries so they survive dashboard restart). cronMatchesNow
    // only fires on an exact minute boundary, so without this the noon
    // check skipped because the session was busy at 12:00:50 would never
    // run that day. We NEVER abandon -- the operator can cancel from the
    // UI if a retry has become obsolete.
    const pendingRows = listPendingTaskRetries()
    const pendingKeys = new Set<string>()
    for (const row of pendingRows) {
      // Locate the task definition. If it was deleted meanwhile, drop the
      // retry silently -- nothing to fire.
      const taskDef = tasks.find(t => t.name === row.task_name)
      if (!taskDef) {
        deletePendingTaskRetry(row.task_name, row.agent_name)
        continue
      }
      // Honor the operator's disable action: if the task was toggled off
      // while the retry sat in the queue, drop the retry so a long-stuck
      // task doesn't surprise-fire the moment the session frees up.
      if (!taskDef.enabled) {
        deletePendingTaskRetry(row.task_name, row.agent_name)
        continue
      }

      // Register the key only once we know the retry is live, so the cron
      // loop below doesn't treat a dead row as a reason to skip.
      const key = `${row.task_name}@${row.agent_name}`
      pendingKeys.add(key)

      const view = toPendingRetryView(row, now)
      const result = attemptFireTask(taskDef, row.agent_name, now)
      if (result === 'fired' || result === 'missing') {
        deletePendingTaskRetry(row.task_name, row.agent_name)
        continue
      }
      // Still busy or errored: refresh the retry row and alert ONCE if
      // the age crossed the threshold. `updatePendingTaskRetry` returns
      // false when the row has been cancelled between load and now --
      // in that case, do not re-insert (the operator's cancel wins) and
      // do not alert.
      const stillPresent = updatePendingTaskRetry(row.task_name, row.agent_name, now, result)
      if (stillPresent && view.alertDue) sendPendingRetryAlert(view, now)
    }

    for (const task of tasks) {
      if (!task.enabled) continue
      if (!cronMatchesNow(task.schedule, catchUp)) continue

      // Prevent double-firing: skip if already ran within the catch-up window
      const lastRun = scheduleLastRun.get(task.name) || 0
      if (now - lastRun < catchUp) continue

      let targetAgents: string[]

      if (task.agent === 'all') {
        // Broadcast to all running agents + main
        const running = listAgentNames().filter(a => isAgentRunning(a))
        targetAgents = [MAIN_AGENT_ID, ...running]
      } else {
        targetAgents = [task.agent || MAIN_AGENT_ID]
      }

      for (const agentName of targetAgents) {
        const key = `${task.name}@${agentName}`
        // If already queued for retry from an earlier tick, leave it to
        // the retry handler -- don't re-queue or double-fire.
        if (pendingKeys.has(key)) continue
        const result = attemptFireTask(task, agentName, now)
        if (result === 'busy') {
          // First encounter -- insert a new pending row. If somehow a
          // row already exists (race with a just-cancelled retry), do
          // nothing so the cancel wins the tiebreak.
          insertPendingTaskRetryIfNew(task.name, agentName, now, 'busy')
        }
      }
    }
  }

  // Run immediately on start (catches missed tasks)
  setTimeout(runCheck, 5000)
  return setInterval(runCheck, 60000)
}
