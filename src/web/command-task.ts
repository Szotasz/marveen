import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { STORE_DIR, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID } from "../config.js"
import { atomicWriteFileSync } from "./atomic-write.js"
import { logger } from "../logger.js"
import { sendTelegramMessage } from "./telegram.js"
import { appendTaskRun } from "../db.js"
import type { ScheduledTask } from "./scheduled-tasks-io.js"

// `command`-type scheduled tasks run a raw shell command directly (no LLM
// agent, no tmux session) and alert on Telegram after N consecutive failures.
// This keeps lightweight infra checks (HTTP probes, SMTP reachability, custom
// scripts) inside the one system that already gets scheduled + backed up (the
// Marveen store) instead of a separate, unmonitored crontab.
//
// A `command` task is defined entirely by its task-config.json -- it needs no
// SKILL.md, because there is no prompt and no agent. Minimal config:
//   { "type": "command", "schedule": "*/5 * * * *",
//     "command": "curl -fsS https://example.com/health",
//     "timeoutMs": 10000, "failThreshold": 2 }

const HEALTH_PATH = join(STORE_DIR, "command-task-health.json")

export interface CommandHealth {
  fails: number          // consecutive-failure streak (0 when healthy)
  alerted: boolean       // a failure alert is currently outstanding
  lastStatus: "ok" | "fail" | "unknown"
  lastRun: number
}
type HealthMap = Record<string, CommandHealth>

// Health is persisted (not just in-memory) so a dashboard restart does not
// reset failure streaks and re-alert on an already-known outage.
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
// without spawning processes. success=true zeroes the streak; an alert fires
// exactly once when the streak first reaches failThreshold; a recover fires
// once when a previously-alerted task succeeds again. This "edge-triggered"
// design means a flapping or long outage produces one alert + one recovery,
// never a per-tick stream.
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

// Run the command through `bash -lc` with a hard timeout. A non-zero exit, a
// spawn error, or a timeout all count as a failure; the first 200 chars of
// stderr are surfaced into the alert detail.
function runCommand(cmd: string, timeoutMs: number): { ok: boolean; detail: string } {
  try {
    const r = spawnSync("bash", ["-lc", cmd], { timeout: timeoutMs, encoding: "utf-8" })
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code
      if (code === "ETIMEDOUT") return { ok: false, detail: `timeout ${timeoutMs}ms` }
      return { ok: false, detail: r.error.message }
    }
    if (r.status === 0) return { ok: true, detail: "exit 0" }
    const err = (r.stderr || "").trim().slice(0, 200)
    return { ok: false, detail: `exit ${r.status}${err ? ": " + err : ""}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  const map = load()
  const { ok, detail } = runCommand(task.command, timeoutMs)
  const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
  map[task.name] = next
  persist()
  try { appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
  logger.info({ task: task.name, ok, detail, fails: next.fails, action }, "command task ran")

  if (action === "none") return
  if (!TELEGRAM_BOT_TOKEN || !ALLOWED_CHAT_ID) {
    logger.warn({ task: task.name }, "command task alert suppressed: missing token/chat_id")
    return
  }
  const label = task.description || task.name
  const text = action === "alert"
    ? `[Marveen scheduler] Hiba: ${label} nem valaszol (${next.fails}. egymas utani hiba). Reszlet: ${detail}`
    : `[Marveen scheduler] Helyreallt: ${label} ismet OK.`
  sendTelegramMessage(TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, text)
    .then(() => logger.info({ task: task.name, action }, "command task alert sent"))
    .catch((err) => logger.warn({ err, task: task.name }, "command task alert send failed"))
}
