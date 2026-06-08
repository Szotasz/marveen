import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-write.js'
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
import { toPendingRetryView, classifyTelegramSendError, type PendingRetryView } from '../pending-retries.js'
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../prompt-safety.js'
import { cronMatchesNow } from './cron.js'
import {
  listScheduledTasks,
  type ScheduledTask,
} from './scheduled-tasks-io.js'
import { listAgentNames, readFileOr, readAgentRemoteHost } from './agent-config.js'
import {
  agentSessionName,
  isAgentRunning,
  isSessionReadyForPrompt,
  sendPromptToSession,
  startAgentProcess,
  sessionExistsOnHost,
  capturePane,
  sendEnterToSession,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { sendTelegramMessage } from './telegram.js'
import { runCommandTask } from './command-task.js'

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

// When a task fires we record its time here so the catch-up window (30 min on
// the first tick after a restart) does not re-run it. This map is in-memory, so
// a dashboard restart that lands inside a task's catch-up window used to re-fire
// an already-run task (observed: a restart re-sent a second vmd-report). Persist
// it to disk and reload on startup so the skip-check survives restarts.
const SCHEDULE_LAST_RUN_PATH = join(PROJECT_ROOT, 'store', 'schedule-last-run.json')
const scheduleLastRun: Map<string, number> = new Map()

function loadScheduleLastRun(): void {
  try {
    const raw = JSON.parse(readFileSync(SCHEDULE_LAST_RUN_PATH, 'utf-8'))
    if (raw && typeof raw === 'object') {
      for (const [name, ts] of Object.entries(raw)) {
        if (typeof ts === 'number' && Number.isFinite(ts)) scheduleLastRun.set(name, ts)
      }
    }
  } catch { /* no file yet / unreadable -- start empty */ }
}

function persistScheduleLastRun(): void {
  try {
    atomicWriteFileSync(SCHEDULE_LAST_RUN_PATH, JSON.stringify(Object.fromEntries(scheduleLastRun), null, 2))
  } catch (err) {
    logger.warn({ err }, 'schedule-runner: failed to persist last-run map')
  }
}

// Try to fire a task at a single target agent. Returns the outcome so the
// caller can decide whether to queue a retry. Splitting this out means the
// pendingTaskRetries loop and the normal cron loop share one code path.
function attemptFireTask(task: ScheduledTask, agentName: string, now: number): 'fired' | 'busy' | 'missing' | 'starting' | 'error' {
  const isMainAgent = agentName === MAIN_AGENT_ID
  // Allow per-task session override via targetSession config field.
  // Falls back to the standard agent session name derivation.
  const session = task.targetSession
    ? task.targetSession
    : isMainAgent ? MAIN_CHANNELS_SESSION : agentSessionName(agentName)

  // A remote sub-agent's session lives on the laptop -- resolve its host so the
  // existence/readiness checks and the send cross the ssh boundary. A custom
  // targetSession override and the main channels agent stay local (host=null).
  const host = (task.targetSession || isMainAgent) ? null : readAgentRemoteHost(agentName)

  if (!sessionExistsOnHost(host, session)) {
    // Auto-start the agent, then deliver on a later tick. A daily batch agent
    // (e.g. a `0 2 * * *` digest) has no 24/7 session, so a cron fire used to
    // just skip here -- the task never ran. Launch the session now and return
    // 'starting'; the caller enqueues a retry that bypasses skipIfBusy (waking
    // the agent for its scheduled run is the whole point, so a skipIfBusy=true
    // task must NOT drop the delivery). The next tick finds the session up and
    // sends once Claude has booted (isSessionReadyForPrompt). host-aware:
    // startAgentProcess is itself remote-aware and launches over ssh when the
    // target agent is remote, so a missing remote session is auto-started too.
    const start = startAgentProcess(agentName)
    if (!start.ok) {
      // "already running" means it raced up between the check and here -- treat
      // as busy so the normal retry path delivers. Any other failure (config
      // error, launch failure) is a real miss: log and skip this tick.
      if (/already running/i.test(start.error ?? '')) return 'busy'
      logger.warn({ task: task.name, agent: agentName, session, error: start.error }, 'Schedule target session missing, auto-start failed')
      return 'missing'
    }
    logger.info({ task: task.name, agent: agentName, session }, 'Schedule target session missing, auto-started agent; will deliver on retry')
    return 'starting'
  }

  // When forceSend is true, skip the busy-state check entirely and inject
  // the prompt regardless. The Claude session queues it internally and
  // will process it at the next idle slot. This prevents the infinite
  // retry loop observed when the target session stays busy for hours
  // (275 retries overnight in production).
  if (!task.forceSend && !isSessionReadyForPrompt(session, host)) {
    logger.warn({ task: task.name, agent: agentName, session }, 'Schedule target session busy or has pending input, will retry')
    return 'busy'
  }

  if (task.forceSend) {
    logger.info({ task: task.name, agent: agentName, session }, 'forceSend=true, bypassing busy-state check')
  }

  try {
    let prefix: string
    if (task.type === 'heartbeat') {
      // Channel-less heartbeat agents (today: only `heartbeat`) MUST NOT
      // receive the Telegram-keepalive directive -- their CLAUDE.md is
      // explicit that all output goes to Marveen via inter-agent message
      // (Marveen 2026-06-02 PR #257 review block). The historical prefix
      // was Marveen-specific scaffolding ("keep the bun-poller stdio
      // alive, only Telegram-reply if urgent") and would create a direct
      // contradiction with the agent's own contract; worse, if the
      // channel-plugin disable ever leaks through from the user-scope
      // settings (which it has done before in this fleet -- the very
      // motivation for this whole rearchitecture), the leftover Telegram
      // tool would receive an explicit instruction to use chat_id
      // ALLOWED_CHAT_ID. So: emit a minimal heartbeat tag for the
      // resubmit-marker code below to match, and let the agent's own
      // CLAUDE.md + SKILL.md drive behaviour.
      if (agentName === 'heartbeat') {
        prefix = `[Heartbeat: ${task.name}] `
      } else {
        prefix = `[Heartbeat: ${task.name}] *** KOTELEZO ELSO TEENDO MIELOTT BARMIT IRSZ: hivj meg pontosan EGY local-only tool-t (peldaul Bash 'echo keepalive >> /tmp/marveen-keepalive.log' VAGY Read tool egy meglevo fajlra mint ${join(PROJECT_ROOT, 'HEARTBEAT.md')}). NE Telegram-tool-t -- az zajt eredmenyezne. Ezt a Telegram-bun MCP-stdio-pipe keep-alive-ehez kell, ha kihagyod, a Telegram-conn 30 percen belul disconnect-el. *** Aztan: ez egy csendes ellenorzes. CSAK AKKOR irj Telegramon (chat_id: ${ALLOWED_CHAT_ID}), ha tenyleg fontos/surgos dolgot talalsz. Ha minden rendben, NE kuldj Telegram uzenetet -- a kotelezo no-op tool-call mar megfelelo aktivitas. Egy rovid 'csendes heartbeat' sor a transzkriptbe + a tool-call elég. `
      }
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
    sendPromptToSession(session, fullPrompt, host)
    scheduleLastRun.set(task.name, now)
    persistScheduleLastRun()
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
        // Host-aware so a remote agent's post-send stuck-check + recovery Enter
        // hit the laptop session, not a (nonexistent) local one.
        const pane = capturePane(session, host)
        const stuck = pane != null && /❯\s+\S/.test(pane) && pane.includes(marker)
        if (!stuck) return
        if (attempt >= 5) {
          logger.warn({ task: task.name, session }, 'Scheduled prompt still stuck after 5 Enter retries -- giving up')
          return
        }
        sendEnterToSession(session, host)
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

// Manual "Run now": fire a scheduled task immediately, bypassing the cron
// match + lastRun catch-up + skipIfBusy guards (the operator explicitly asked
// for it). Reuses attemptFireTask, so a stopped agent is auto-started and the
// prompt is queued for delivery exactly like a real cron fire. Returns a
// per-target summary string for the API/UI.
export function runScheduledTaskNow(taskName: string): { ok: boolean; result?: string; error?: string } {
  const task = listScheduledTasks().find(t => t.name === taskName)
  if (!task) return { ok: false, error: 'Schedule not found' }
  if (!task.enabled) return { ok: false, error: 'Schedule is disabled' }

  const now = Date.now()
  const targets = task.agent === 'all'
    ? [MAIN_AGENT_ID, ...listAgentNames().filter(a => isAgentRunning(a))]
    : [task.agent || MAIN_AGENT_ID]

  const summary: string[] = []
  for (const agentName of targets) {
    const result = attemptFireTask(task, agentName, now)
    // A manual run ALWAYS wants delivery: an auto-started ('starting') or a
    // busy session both get a queued retry that lands once the session is
    // ready. We deliberately do NOT consult skipIfBusy here -- that flag trims
    // redundant cron ticks, but an explicit run-now must not be dropped.
    if (result === 'starting' || result === 'busy') {
      insertPendingTaskRetryIfNew(task.name, agentName, now, result)
    }
    summary.push(`${agentName}: ${result}`)
  }
  return { ok: true, result: summary.join(', ') }
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

  // Validate the delivery config BEFORE building/sending. A missing token
  // or chat_id is a permanent configuration problem -- it will fail
  // identically on every 60s tick. Earlier this path (token only) cleared
  // the stamp on failure, so the alert re-fired every minute forever and
  // spammed the log; and chat_id was never validated at all, so an empty
  // ALLOWED_CHAT_ID guaranteed a 400 from Telegram on every attempt. Leave
  // the stamp in place (it acts as the throttle) and log once so the
  // operator sees the config gap without the spin. The scheduled task
  // itself keeps retrying regardless -- only this alert is suppressed.
  const envPath = join(PROJECT_ROOT, '.env')
  const envContent = readFileOr(envPath, '')
  const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) {
    logger.warn({ task: view.taskName, agent: view.agentName }, 'Pending-retry alert suppressed: no TELEGRAM_BOT_TOKEN (config error, stamp kept to avoid 60s spin)')
    return
  }
  if (!ALLOWED_CHAT_ID.trim()) {
    logger.warn({ task: view.taskName, agent: view.agentName }, 'Pending-retry alert suppressed: empty ALLOWED_CHAT_ID (config error, stamp kept to avoid 60s spin)')
    return
  }

  const ageMinutes = Math.floor(view.ageMs / 60000)
  const firstAttempt = new Date(view.firstAttempt).toLocaleString('hu-HU')
  const text = [
    `[Marveen scheduler] A(z) "${view.taskName}" (${view.agentName}) utemezett feladat ${ageMinutes} perce varakozik.`,
    `Elso probalkozas: ${firstAttempt}.`,
    'A rendszer tovabb probalkozik; a dashboard /Utemezesek oldalan visszavonhato.',
  ].join('\n')
  ;(async () => {
    try {
      await sendTelegramMessage(token, ALLOWED_CHAT_ID, text)
      logger.info({ task: view.taskName, agent: view.agentName, ageMinutes }, 'Pending-retry Telegram alert sent')
    } catch (err) {
      // Distinguish a transient failure (network blip, 429, 5xx) from a
      // permanent one (4xx: bad chat_id / revoked token). Transient ->
      // clear the per-attempt stamp so the next tick retries. Permanent
      // -> KEEP the stamp; retrying every 60s would just repeat the same
      // rejection and spam the log until the config is fixed.
      const kind = classifyTelegramSendError(err instanceof Error ? err.message : String(err))
      if (kind === 'transient') {
        logger.warn({ err, task: view.taskName, agent: view.agentName }, 'Pending-retry alert delivery failed (transient), clearing stamp for retry')
        clearPendingTaskRetryAlert(view.taskName, view.agentName)
      } else {
        logger.warn({ err, task: view.taskName, agent: view.agentName }, 'Pending-retry alert delivery failed (permanent), stamp kept to avoid 60s spin')
      }
    }
  })()
}

export function startScheduleRunner(): NodeJS.Timeout {
  // Reload the persisted last-run times so a restart inside a task's catch-up
  // window does not re-fire an already-run task.
  loadScheduleLastRun()
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

      // type='command' tasks run a raw shell command directly -- no LLM, no
      // tmux, no target agent. They self-manage failure streaks + Telegram
      // alerts. Record the run time like a fired task so the catch-up window
      // does not double-run them on a dashboard restart.
      if (task.type === 'command') {
        runCommandTask(task, now)
        scheduleLastRun.set(task.name, now)
        persistScheduleLastRun()
        continue
      }

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
        if (result === 'starting') {
          // Agent was auto-started this tick. ALWAYS enqueue the retry that
          // delivers the prompt once the session is ready -- skipIfBusy must
          // NOT drop it (that flag is for genuinely-busy short-cadence tasks;
          // here we deliberately woke the agent for its scheduled run). The
          // pending-retry loop then sends as soon as Claude has booted.
          insertPendingTaskRetryIfNew(task.name, agentName, now, 'starting')
        } else if (result === 'busy') {
          if (task.skipIfBusy) {
            // Opt-in skip for short-cadence tasks (e.g. 30-min heartbeats):
            // a single missed tick is harmless because the next one is
            // already on the way, and queueing them produces spurious
            // "60 perce varakozik" Telegram alerts whenever the operator
            // is having an active conversation in the channels session.
            // Daily/weekly schedules keep skipIfBusy=false so the queue
            // + alert path catches a long-running busy state.
            logger.info({ task: task.name, agent: agentName }, 'Schedule busy, skipIfBusy=true: dropping tick silently')
            continue
          }
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
