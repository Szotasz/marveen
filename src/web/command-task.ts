import { spawn } from "node:child_process"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { PROJECT_ROOT, STORE_DIR, TELEGRAM_BOT_TOKEN } from "../config.js"
import { shQuote } from "./ssh-tmux.js"
import { resolveOwnerChatId } from "../owner-chat.js"
import { atomicWriteFileSync } from "./atomic-write.js"
import { logger } from "../logger.js"
import { sendTelegramMessage } from "./telegram.js"
import { appendTaskRun, markTaskRunCompleted } from "../db.js"
import type { ScheduledTask } from "./scheduled-tasks-io.js"

// command-type scheduled tasks run a raw shell command directly (no LLM
// agent, no tmux session) and alert on Telegram after N consecutive
// failures. This keeps infra heartbeats inside the one system that gets
// backed up (the Marveen store) instead of a separate crontab.

const HEALTH_PATH = join(STORE_DIR, "command-task-health.json")

export interface CommandHealth {
  fails: number
  alerted: boolean
  lastStatus: "ok" | "fail" | "unknown"
  lastRun: number
}
type HealthMap = Record<string, CommandHealth>

let healthMap: HealthMap | null = null
function load(): HealthMap {
  if (healthMap) return healthMap
  try { healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { healthMap = {} }
  return healthMap
}
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}

export type CommandAction = "none" | "alert" | "recover"

// Pure decision function so the failure/recovery policy is unit-testable
// without spawning processes. success=true zeroes the streak; an alert
// fires exactly once when the streak first reaches failThreshold; a
// recover fires once when a previously-alerted task succeeds again.
export function evaluateCommandResult(
  prev: CommandHealth | undefined,
  success: boolean,
  failThreshold: number,
  now: number,
): { next: CommandHealth; action: CommandAction } {
  const wasAlerted = prev?.alerted ?? false
  const fails = success ? 0 : (prev?.fails ?? 0) + 1
  let action: CommandAction = "none"
  let alerted = wasAlerted
  if (success) {
    if (wasAlerted) { action = "recover"; alerted = false }
  } else if (fails >= failThreshold && !wasAlerted) {
    action = "alert"; alerted = true
  }
  return {
    next: { fails, alerted, lastStatus: success ? "ok" : "fail", lastRun: now },
    action,
  }
}

// ASYNC on purpose -- this used to be spawnSync, and that was a whole-server
// outage (measured 2026-09-14).
//
// spawnSync blocks the Node event loop for the entire command. While a command
// task ran, the dashboard answered NOTHING: no HTTP, no /api/messages, not even
// its own log lines. That alone would be bad; what made it a deadlock is that a
// command can call BACK into the dashboard. A heartbeat gate script that wakes
// an agent does exactly that (POST /api/messages, then it waits for
// confirmation). The server was synchronously waiting for a script
// that was waiting for the server, so the script only returned when its own
// confirm window expired.
//
// The numbers: that task finished ~14s after firing until 07:00 that day, then
// 4m22s on EVERY run afterwards -- so the dashboard was dead for four minutes
// out of every thirty. Three agents duplicated inter-agent messages because
// their sends timed out, their read-backs looked empty, and every copy landed
// once the loop resumed.
//
// Each direction looked correct in isolation: a scheduler may wait for its
// task, and a task may talk to the API. The defect only exists in the pair.
function runCommand(cmd: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("bash", ["-lc", cmd])
    } catch (err) {
      resolve({ ok: false, detail: (err as Error).message })
      return
    }
    let stderr = ""
    let settled = false
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    // The kill is ours now: spawn() has no `timeout` option that fires
    // reliably across platforms, and a command that hangs must not hold a
    // slot for ever. SIGKILL rather than SIGTERM -- a hung command is by
    // definition not responding to a polite request.
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* already gone */ }
      done({ ok: false, detail: `timeout ${timeoutMs}ms` })
    }, timeoutMs)
    // Drain stdout: nothing else reads it, and an undrained pipe blocks a
    // command that prints more than the pipe buffer until our timeout kills it
    // (spawnSync used to buffer it for us).
    child.stdout?.resume()
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString()
    })
    child.on("error", (err) => done({ ok: false, detail: err.message }))
    child.on("close", (code) => {
      if (code === 0) { done({ ok: true, detail: "exit 0" }); return }
      const err = stderr.trim().slice(0, 200)
      done({ ok: false, detail: `exit ${code}${err ? ": " + err : ""}` })
    })
  })
}

// A shipped command task cannot hard-code the install path, and the node
// seeder copies task-config.json without template rendering. So the command
// may name the install root as {{PROJECT_ROOT}} / {{INSTALL_DIR}} (the same
// placeholders preCheck accepts), resolved here at run time. The root is
// inserted shell-quoted, so a template writes it bare:
//   python3 {{PROJECT_ROOT}}/scripts/x.py  ->  python3 '/path/to/root'/scripts/x.py
export function resolveCommandPlaceholders(cmd: string, root: string = PROJECT_ROOT): string {
  return cmd.replace(/\{\{(PROJECT_ROOT|INSTALL_DIR)\}\}/g, () => shQuote(root))
}

// A command task that is still running must not be started again. Before the
// async change this was impossible by construction (the loop was blocked);
// now a 7-minute command on a 2-minute schedule would pile up copies of
// itself, which is exactly the failure the fix is meant to remove.
const inFlight = new Set<string>()

export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  if (inFlight.has(task.name)) {
    logger.warn({ task: task.name }, "command task still running from a previous tick, skipping this one")
    return
  }
  const map = load()
  inFlight.add(task.name)
  void runCommand(resolveCommandPlaceholders(task.command), timeoutMs)
    .then(({ ok, detail }) => finish(task, now, failThreshold, map, ok, detail))
    .catch((err) => finish(task, now, failThreshold, map, false, (err as Error).message))
    .finally(() => inFlight.delete(task.name))
}

// Everything that used to follow the blocking call, unchanged in behaviour --
// only in WHEN it runs. The run is closed here because these tasks are never
// injected into a session, so the pane watchdog never sees them; without this
// they would be the one class of run that stays open for ever.
function finish(
  task: ScheduledTask,
  now: number,
  failThreshold: number,
  map: HealthMap,
  ok: boolean,
  detail: string,
): void {
  const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
  map[task.name] = next
  persist()
  try {
    const runId = appendTaskRun(task.name, task.agent || "system")
    markTaskRunCompleted(runId, "done")
  } catch { /* non-fatal */ }
  logger.info({ task: task.name, ok, detail, fails: next.fails, action }, "command task ran")

  if (action === "none") return
  const ownerChat = resolveOwnerChatId()
  if (!TELEGRAM_BOT_TOKEN || !ownerChat) {
    logger.warn({ task: task.name }, "command task alert suppressed: missing token, or no owner chat (ALLOWED_CHAT_ID unset/placeholder and no paired channel)")
    return
  }
  const label = task.description || task.name
  const text = action === "alert"
    ? `\u{1F534} Hiba: ${label} nem v\u00e1laszol (${next.fails}. egym\u00e1s ut\u00e1ni hiba). R\u00e9szlet: ${detail}`
    : `\u{1F7E2} Helyre\u00e1llt: ${label} ism\u00e9t OK.`
  sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text)
    .then(() => logger.info({ task: task.name, action }, "command task alert sent"))
    .catch((err) => logger.warn({ err, task: task.name }, "command task alert send failed"))
}
