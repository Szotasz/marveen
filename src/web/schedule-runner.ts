import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { checkTaskMcpRequirements } from './schedule-mcp-precheck.js'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'
import {
  PROJECT_ROOT,
  MAIN_AGENT_ID,
  ALLOWED_CHAT_ID,
  BOT_NAME,
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
  SCHEDULED_TASK_PREAMBLE,
  wrapScheduledTask,
} from '../prompt-safety.js'
import { cronMatchesNow } from './cron.js'
import {
  listScheduledTasks,
  SCHEDULED_TASKS_DIR,
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
  clearStaleParkedInput,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { sendTelegramMessage } from './telegram.js'
import { runCommandTask } from './command-task.js'

// How many bare-Enter attempts the post-send resubmit tries before escalating
// to a clear + re-inject, and the hard cap after which it gives up.
const RESUBMIT_BARE_ENTER_ATTEMPTS = 2
const RESUBMIT_MAX_ATTEMPTS = 6

export type ResubmitAction = 'none' | 'enter' | 'reinject' | 'giveup'

// Decide what the post-send resubmit loop should do on a given attempt. Pure
// so the escalation ladder is unit-tested without tmux I/O.
//
// A scheduled prompt's closing Enter is occasionally swallowed by the Claude
// TUI in raw mode, leaving the prompt parked in the input box. A parked box
// reads 'typing' (not idle), so isSessionReadyForPrompt() stays false and
// EVERY subsequent scheduled task is deferred -- the session pins itself busy
// for hours on a single stranded prompt (observed 2026-07-01: 3223 deferrals
// and 0/96 heartbeats fired in 24h, while the b7bda8f region-scope fix only
// covered the spinner/busy path, not this typing/parked-input path). Bare
// Enter alone loses to a persistently swallowed Enter, so after
// RESUBMIT_BARE_ENTER_ATTEMPTS Enters we escalate to a real clear + re-inject
// of the prompt. Re-injecting is safe here: the scheduled prompt is locally
// authored (SKILL.md / bearer-gated editor), not the ghost-suggestion text
// that gates the MAIN plain-text re-inject path in stuck-input-watcher.
export function decideScheduledResubmitAction(
  attempt: number,
  stuck: boolean,
): ResubmitAction {
  if (!stuck) return 'none'
  if (attempt >= RESUBMIT_MAX_ATTEMPTS) return 'giveup'
  return attempt < RESUBMIT_BARE_ENTER_ATTEMPTS ? 'enter' : 'reinject'
}

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

// Run the task's pre-check script (if configured) and return whether to skip
// this LLM invocation and an optional context prefix to prepend to the prompt.
//
// Protocol (stdout + exit code):
//   exit 0, stdout = "SKIP"  → skip the LLM entirely (nothing actionable)
//   exit 0, stdout non-empty → run LLM with stdout as context prefix
//   exit 0, stdout empty     → run LLM normally
//   non-zero exit            → log warning, run LLM anyway (fail-open)
export function runPreCheck(task: ScheduledTask): { skip: boolean; prefix?: string } {
  if (!task.preCheck) return { skip: false }
  const scriptPath = isAbsolute(task.preCheck)
    ? task.preCheck
    : join(SCHEDULED_TASKS_DIR, task.name, task.preCheck)
  if (!existsSync(scriptPath)) {
    logger.warn({ task: task.name, scriptPath }, 'pre-check script not found, running LLM anyway')
    return { skip: false }
  }
  try {
    const r = spawnSync('bash', [scriptPath], { timeout: 10_000, encoding: 'utf-8' })
    if (r.error) {
      logger.warn({ task: task.name, error: r.error.message }, 'pre-check script spawn error, running LLM anyway')
      return { skip: false }
    }
    if (r.status !== 0) {
      logger.warn({ task: task.name, status: r.status, stderr: (r.stderr || '').trim().slice(0, 200) }, 'pre-check script exited non-zero, running LLM anyway')
      return { skip: false }
    }
    const out = (r.stdout || '').trim()
    if (out === 'SKIP') {
      logger.info({ task: task.name }, 'pre-check: nothing actionable, skipping LLM')
      return { skip: true }
    }
    if (out) return { skip: false, prefix: out }
    return { skip: false }
  } catch (err) {
    logger.warn({ err, task: task.name }, 'pre-check script threw, running LLM anyway')
    return { skip: false }
  }
}

// Try to fire a task at a single target agent. Returns the outcome so the
// caller can decide whether to queue a retry. Splitting this out means the
// pendingTaskRetries loop and the normal cron loop share one code path.
// Missing MCP server names from the last failed pre-check, keyed by
// task@agent, so the retry-row reason and the alert can name the servers.
const lastMcpMissing = new Map<string, string[]>()

function mcpMissingReason(taskName: string, agentName: string): string {
  const missing = lastMcpMissing.get(`${taskName}@${agentName}`) ?? []
  return missing.length ? `mcp-missing:${missing.join(',')}` : 'mcp-missing'
}

// Two pre-check gates coexist here:
//   1. the operator preCheck SCRIPT (business gate) runs in the callers via
//      runPreCheck() -- it can SKIP the whole tick (no LLM) or inject context
//      via preCheckPrefix;
//   2. the MCP manifest check (infra gate, requires.mcp_servers) runs below,
//      after the busy check, and defers delivery ('mcp-missing') when a
//      required server is dead.
// Both are fail-open: a broken script or an unreadable MCP state never
// blocks the task.
//
// lateCatchUpMs is set by the caller when this tick only matched because of
// the enlarged restart catch-up window (see startScheduleRunner) -- i.e. the
// task missed its normal tick and is only firing now as a catch-up; it is
// recorded as a distinct 'fired_late' run status further down instead of
// silently folding into 'fired'.
function attemptFireTask(
  task: ScheduledTask,
  agentName: string,
  now: number,
  preCheckPrefix?: string,
  lateCatchUpMs?: number,
): 'fired' | 'busy' | 'missing' | 'starting' | 'error' | 'mcp-missing' {
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
  //
  // KNOWN FOLLOW-UP: forceSend also bypasses the context-saturation refusal
  // now folded into isSessionReadyForPrompt(). A forceSend task can therefore
  // still land on a 100%-context session. Left open deliberately -- forceSend's
  // contract is "always eventually land, never silently drop", and a saturated
  // session needs a separate delivery policy, tracked as future work.
  if (!task.forceSend && !isSessionReadyForPrompt(session, host)) {
    logger.warn({ task: task.name, agent: agentName, session }, 'Schedule target session busy or has pending input, will retry')
    return 'busy'
  }

  if (task.forceSend) {
    logger.info({ task: task.name, agent: agentName, session }, 'forceSend=true, bypassing busy-state check')
  }

  // MCP manifest pre-check (requires.mcp_servers, Roitman 22.5): a required
  // server with no live process under the target session defers the task with
  // a reasoned alert instead of letting the prompt fail at runtime INSIDE the
  // session (2026-07-08: morning briefing ran against a silently dead gmail
  // MCP). Runs after the busy check so a busy session stays a plain 'busy'.
  // forceSend keeps its "always eventually land" contract: it logs the gap
  // loudly but still delivers.
  if (task.type !== 'command' && task.requires?.mcp_servers?.length) {
    const check = checkTaskMcpRequirements(task.requires.mcp_servers, agentName, session, host)
    if (!check.ok) {
      if (task.forceSend) {
        logger.warn({ task: task.name, agent: agentName, session, missing: check.missing }, 'MCP pre-check failed but forceSend=true -- delivering anyway')
      } else {
        lastMcpMissing.set(`${task.name}@${agentName}`, check.missing)
        logger.warn({ task: task.name, agent: agentName, session, missing: check.missing }, 'Required MCP server(s) not running in target session -- deferring task')
        return 'mcp-missing'
      }
    }
  }

  try {
    let prefix: string
    if (task.type === 'heartbeat') {
      // Heartbeat prompts get ONLY a minimal tag. The agent's CLAUDE.md and
      // the task SKILL.md drive behaviour -- the runner MUST NOT prepend any
      // operational directive here.
      //
      // SECURITY (removed 2026-06-08): the previous `agentName !== 'heartbeat'`
      // branch injected a coercive "call exactly one local tool before you
      // write anything, do NOT use Telegram" keep-alive preamble. That text sat
      // OUTSIDE the wrapUntrusted() envelope, so the receiving agent -- told to
      // trust everything outside the untrusted tags -- was instructed to perform
      // a mandatory no-op tool call and to suppress the very channel the user
      // sees. The runner was poisoning its own trusted channel: a prompt
      // injection we shipped ourselves. It also contradicted the agent contract
      // and, if the channel-plugin disable leaked through user-scope settings,
      // told the leftover Telegram tool to message ALLOWED_CHAT_ID. Removed
      // entirely; ALL heartbeat agents now get the clean tag. Channel liveness
      // is handled separately by the channels TUI keepalive
      // (channel-coordinator/liveness.ts), never by injecting instructions into
      // heartbeat prompts.
      prefix = `[Heartbeat: ${task.name}] `
    } else {
      // Target the RUNNING agent's own bound channel (chat_id: 0), NOT the
      // global ALLOWED_CHAT_ID. The latter is the main/admin chat; injecting it
      // here pointed every sub-agent's task result at the boss's chat instead of
      // its own owner (e.g. attilamarveenja -> Papp Attila). chat_id: 0 is the
      // established "bound channel" convention (template-identity-hygiene), so it
      // resolves per-agent and stays correct for the main agent too. The
      // system-level pending-retry alert below still uses ALLOWED_CHAT_ID.
      prefix = `[Utemezett feladat: ${task.name}] Az eredmenyt kuldd el Telegramon (chat_id: 0, reply tool). `
    }
    // A scheduled task body is the agent's OWN task, authored by the operator
    // (SKILL.md on disk, or the bearer-gated /api/schedules editor -- both
    // inside the local trust boundary). Framing it with UNTRUSTED_PREAMBLE +
    // wrapUntrusted was self-defeating: that preamble tells the agent to IGNORE
    // instructions inside <untrusted> tags, so a security-correct agent refused
    // to run its own heartbeat/audit and every scheduled task silently no-opped.
    // Use the scheduled-task framing instead: tags are still scrubbed (so a
    // poisoned body cannot smuggle a fake security tag) but the preamble marks
    // it as a task-to-execute with the standard escalate-if-dangerous guard.
    const taskBody = preCheckPrefix
      ? `[Pre-check eredmeny]\n${preCheckPrefix}\n\n[Feladat]\n${task.prompt}`
      : task.prompt
    const fullPrompt =
      SCHEDULED_TASK_PREAMBLE + '\n' +
      prefix.trimEnd() + '\n\n' +
      wrapScheduledTask(`scheduled-task:${task.name}`, taskBody)
    // forceSend skips the busy-state check above; it must also skip the
    // pre-flight wait-until-idle gate inside sendPromptToSession, otherwise a
    // task aimed at a long-busy session would block on the 12s idle wait every
    // tick -- defeating the very purpose of forceSend (inject regardless, let
    // Claude Code queue it). All non-forceSend tasks keep the gate ON.
    sendPromptToSession(session, fullPrompt, host, { waitForIdle: !task.forceSend })
    scheduleLastRun.set(task.name, now)
    persistScheduleLastRun()
    // A lateCatchUpMs value means this tick only matched because of the
    // enlarged first-run catch-up window (see startScheduleRunner), i.e. the
    // task missed its normal tick (e.g. the process was down/restarting at
    // the scheduled minute) and is only firing now as a catch-up. Recording
    // a distinct status -- instead of silently folding it into 'fired' --
    // means the existing per-task run-history view (dashboard schedule
    // history) surfaces exactly which tasks were missed and had to be
    // caught up, without any new alert/polling path that could race other
    // running tasks. Read-only w.r.t. everything else in this function.
    if (lateCatchUpMs != null) {
      appendTaskRun(task.name, agentName, 'fired_late')
      logger.warn(
        { task: task.name, agent: agentName, session, lateCatchUpMinutes: Math.round(lateCatchUpMs / 60000) },
        'Scheduled task fired via restart catch-up window -- missed its normal tick',
      )
    } else {
      appendTaskRun(task.name, agentName, 'fired')
    }
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
        const action = decideScheduledResubmitAction(attempt, stuck)
        if (action === 'none') return
        if (action === 'giveup') {
          logger.warn({ task: task.name, session }, 'Scheduled prompt still stuck after Enter + re-inject retries -- giving up')
          return
        }
        if (action === 'reinject') {
          // The Enter is being swallowed persistently. Clear the parked prompt
          // and re-type it. clearStaleParkedInput verifies the box is empty
          // before returning true; if it can't clear (box changed under us, or
          // its cooldown fired), fall back to one more bare Enter. waitForIdle
          // is off because the box is 'typing', not idle -- the pre-flight gate
          // would otherwise burn its whole budget and time out every attempt.
          if (clearStaleParkedInput(session, host)) {
            sendPromptToSession(session, fullPrompt, host, { waitForIdle: false })
            logger.info({ task: task.name, session, attempt }, 'Scheduled prompt re-injected after swallowed Enter')
          } else {
            sendEnterToSession(session, host)
          }
        } else {
          sendEnterToSession(session, host)
        }
        setTimeout(() => resubmit(attempt + 1), 3000)
      } catch (err) {
        logger.warn({ err, task: task.name }, 'Post-send resubmit failed')
      }
    }
    setTimeout(() => resubmit(0), 2000)
    return 'fired'
  } catch (err) {
    logger.warn({ err, task: task.name }, 'Failed to fire scheduled task')
    appendTaskRun(task.name, agentName, 'error')
    return 'error'
  }
}

// Manual "Run now": fire a scheduled task immediately, bypassing the cron
// match + lastRun catch-up + skipIfBusy guards (the operator explicitly asked
// for it). Reuses attemptFireTask, so a stopped agent is auto-started and the
// prompt is queued for delivery exactly like a real cron fire. Returns a
// per-target summary string for the API/UI.
export function runScheduledTaskNow(
  taskName: string,
  opts: { allowDisabled?: boolean } = {},
): { ok: boolean; result?: string; error?: string } {
  const task = listScheduledTasks().find(t => t.name === taskName)
  if (!task) return { ok: false, error: 'Schedule not found' }
  // allowDisabled: for on-demand-only tasks that are intentionally kept
  // enabled:false so the cron never fires them, but a guarded endpoint can
  // still trigger them (e.g. the post-rollback diagnosis, PR-D).
  if (!task.enabled && !opts.allowDisabled) return { ok: false, error: 'Schedule is disabled' }

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
    if (result === 'starting' || result === 'busy' || result === 'mcp-missing') {
      const reason = result === 'mcp-missing' ? mcpMissingReason(task.name, agentName) : result
      insertPendingTaskRetryIfNew(task.name, agentName, now, reason)
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
  let token = tokenMatch?.[1]?.trim()
  if (!token) {
    // Since the channels migration the bot token lives in the telegram channel
    // plugin's env, not marveen/.env (2026-07-08: every scheduler alert was
    // silently suppressed on such hosts). Same fallback as scripts/notify.sh.
    const channelEnv = readFileOr(join(homedir(), '.claude', 'channels', 'telegram', '.env'), '')
    token = channelEnv.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim()
  }
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
  // A retry stuck on a dead required MCP names the server(s): the operator's
  // fix is restarting an MCP, not freeing up a busy session.
  const mcpMissing = view.lastReason?.startsWith('mcp-missing')
    ? view.lastReason.slice('mcp-missing:'.length) || 'ismeretlen'
    : null
  const text = (mcpMissing
    ? [
        `[${BOT_NAME} scheduler] A(z) "${view.taskName}" (${view.agentName}) feladat NEM tud lefutni: a szukseges MCP szerver(ek) nem futnak a cel-sessionben: ${mcpMissing}.`,
        `Elso probalkozas: ${firstAttempt} (${ageMinutes} perce).`,
        'Amint az MCP szerver ujra el, a feladat magatol lefut; a dashboard /Utemezesek oldalan visszavonhato.',
      ]
    : [
        `[${BOT_NAME} scheduler] A(z) "${view.taskName}" (${view.agentName}) utemezett feladat ${ageMinutes} perce varakozik.`,
        `Elso probalkozas: ${firstAttempt}.`,
        'A rendszer tovabb probalkozik; a dashboard /Utemezesek oldalan visszavonhato.',
      ]).join('\n')
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
    const isFirstRunTick = firstRun
    const catchUp = isFirstRunTick ? 30 * 60000 : 60000
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

      // Re-run pre-check on retry: state may have changed since the task
      // was first scheduled (e.g. kanban cards already processed).
      const retryPc = runPreCheck(taskDef)
      if (retryPc.skip) {
        deletePendingTaskRetry(row.task_name, row.agent_name)
        appendTaskRun(row.task_name, row.agent_name, 'skipped')
        continue
      }

      const view = toPendingRetryView(row, now)
      const result = attemptFireTask(taskDef, row.agent_name, now, retryPc.prefix)
      if (result === 'fired' || result === 'missing') {
        deletePendingTaskRetry(row.task_name, row.agent_name)
        continue
      }
      // Still busy or errored: refresh the retry row and alert ONCE if
      // the age crossed the threshold. `updatePendingTaskRetry` returns
      // false when the row has been cancelled between load and now --
      // in that case, do not re-insert (the operator's cancel wins) and
      // do not alert.
      const reason = result === 'mcp-missing' ? mcpMissingReason(row.task_name, row.agent_name) : result
      const stillPresent = updatePendingTaskRetry(row.task_name, row.agent_name, now, reason)
      if (stillPresent && view.alertDue) sendPendingRetryAlert(view, now)
    }

    for (const task of tasks) {
      if (!task.enabled) continue
      if (!cronMatchesNow(task.schedule, catchUp)) continue

      // Prevent double-firing: skip if already ran within the catch-up window
      const lastRun = scheduleLastRun.get(task.name) || 0
      if (now - lastRun < catchUp) continue

      // This tick only matched because of the enlarged first-run catch-up
      // window, not the normal ~1-tick tolerance -- i.e. the task's own
      // scheduled minute was missed (process was down/restarting) and it is
      // only firing now as a catch-up. Recorded further down via
      // attemptFireTask's lateCatchUpMs param so the run-history shows it.
      const lateCatchUpMs = isFirstRunTick && catchUp > 60000 && !cronMatchesNow(task.schedule, 60000)
        ? catchUp
        : undefined

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

      // Run pre-check once per task (not per agent) since it queries shared
      // state (DB, filesystem) that does not vary by target agent.
      const cronPc = runPreCheck(task)
      if (cronPc.skip) {
        scheduleLastRun.set(task.name, now)
        persistScheduleLastRun()
        for (const agentName of targetAgents) {
          appendTaskRun(task.name, agentName, 'skipped')
        }
        continue
      }

      for (const agentName of targetAgents) {
        const key = `${task.name}@${agentName}`
        // If already queued for retry from an earlier tick, leave it to
        // the retry handler -- don't re-queue or double-fire.
        if (pendingKeys.has(key)) continue
        const result = attemptFireTask(task, agentName, now, cronPc.prefix, lateCatchUpMs)
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
            appendTaskRun(task.name, agentName, 'skipped')
            continue
          }
          // First encounter -- insert a new pending row. If somehow a
          // row already exists (race with a just-cancelled retry), do
          // nothing so the cancel wins the tiebreak.
          insertPendingTaskRetryIfNew(task.name, agentName, now, 'busy')
        } else if (result === 'mcp-missing') {
          // Deliberately NOT honoring skipIfBusy here: dropping a tick because
          // a required MCP is dead would be exactly the silent starvation this
          // pre-check exists to eliminate. The retry row keeps the task alive
          // until the server returns, and the alert names the dead server.
          insertPendingTaskRetryIfNew(task.name, agentName, now, mcpMissingReason(task.name, agentName))
        }
      }
    }
  }

  // Run immediately on start (catches missed tasks)
  setTimeout(runCheck, 5000)
  return setInterval(runCheck, 60000)
}
