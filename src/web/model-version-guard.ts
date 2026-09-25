// Model-version guard (MODELVER924).
//
// Measured 2026-09-23: four agents were restarted onto
// claude-opus-5-5 at 13:46-13:48, but Claude Code 2.1.280 (the first build that
// supports it) only landed at 13:50. The restarted sessions kept running the old
// 2.1.278 binary, and every prompt answered
//   "API Error: 400 Claude Code 2.1.278 does not support this model;
//    version 2.1.280 or newer is required."
// for about an hour, until a manual restart. The newer binary was already on
// disk the whole time; the session just predated it.
//
// So: when a pane shows that error, and the installed binary is new enough, and
// the session's process started BEFORE the binary was installed, restart it (the
// fresh process picks up the new binary). If the installed binary is still too
// old, alert instead: a restart cannot help, `claude update` is needed.
//
// The process-start check is what keeps this safe on `--continue` sessions: a
// restarted session re-renders its history, so the old error text stays on
// screen after the fix. A process that started after the binary was installed
// is already running the new build, and is never restarted for stale text.

import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane, agentSessionName, restartAgentProcess } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { sendAlert, hardRestartMarveenChannels } from './channel-monitor.js'

export const MODEL_VERSION_GUARD_INTERVAL_MS = 120_000
const MODEL_VERSION_GUARD_INITIAL_DELAY_MS = 65_000
// One restart attempt per session per window: if the restart did not help, the
// cause is something else and a loop would only destroy context.
export const MODEL_VERSION_RESTART_COOLDOWN_MS = 60 * 60 * 1000
// Only the live bottom of the pane: an error far up in the scrollback is history.
const LIVE_TAIL_LINES = 40

const UNSUPPORTED_RX =
  /Claude Code (\d+\.\d+\.\d+) does not support this model;\s*version (\d+\.\d+\.\d+) or newer is required/

export interface UnsupportedModelError { running: string; required: string }

export function parseUnsupportedModelError(pane: string | null): UnsupportedModelError | null {
  if (!pane) return null
  const lines = pane.split('\n').filter((l) => l.trim().length > 0)
  // The message wraps across lines in a narrow pane; join the tail before matching.
  const tail = lines.slice(-LIVE_TAIL_LINES).join(' ').replace(/\s+/g, ' ')
  const m = tail.match(UNSUPPORTED_RX)
  return m ? { running: m[1], required: m[2] } : null
}

export function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return true
}

export type VersionGuardAction = 'none' | 'restart' | 'alert-update'

export function decideVersionGuard(opts: {
  error: UnsupportedModelError | null
  installedVersion: string | null
  processStartMs: number | null
  binaryMtimeMs: number | null
  lastActionAt: number | null
  now: number
  cooldownMs: number
}): VersionGuardAction {
  if (!opts.error) return 'none'
  if (opts.lastActionAt !== null && opts.now - opts.lastActionAt < opts.cooldownMs) return 'none'
  if (!opts.installedVersion) return 'none' // cannot judge -> do nothing destructive
  if (!semverGte(opts.installedVersion, opts.error.required)) return 'alert-update'
  // Installed build is new enough. Restart only a process that predates it;
  // unknown timestamps -> do nothing (a false restart costs the session's context).
  if (opts.processStartMs === null || opts.binaryMtimeMs === null) return 'none'
  return opts.processStartMs < opts.binaryMtimeMs ? 'restart' : 'none'
}

function installedClaude(): { version: string | null; mtimeMs: number | null } {
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 })
    const version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null
    let mtimeMs: number | null = null
    try {
      const bin = execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 5_000 }).trim()
      mtimeMs = statSync(realpathSync(bin)).mtimeMs
    } catch { mtimeMs = null }
    return { version, mtimeMs }
  } catch {
    return { version: null, mtimeMs: null }
  }
}

function sessionProcessStartMs(session: string): number | null {
  try {
    const panePid = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 5_000 })
      .split('\n')[0].trim()
    if (!panePid) return null
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', panePid], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } }).trim()
    const t = Date.parse(lstart)
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

const lastActionAt = new Map<string, number>()

async function tick(): Promise<void> {
  const targets: { session: string; name: string; isMain: boolean }[] = [
    { session: MAIN_CHANNELS_SESSION, name: MAIN_AGENT_ID, isMain: true },
  ]
  for (const a of listAgentNames()) {
    if (a !== MAIN_AGENT_ID && isAgentRunning(a)) targets.push({ session: agentSessionName(a), name: a, isMain: false })
  }
  let installed: { version: string | null; mtimeMs: number | null } | null = null
  for (const t of targets) {
    const error = parseUnsupportedModelError(capturePane(t.session))
    if (!error) continue
    installed ??= installedClaude()
    const now = Date.now()
    const action = decideVersionGuard({
      error,
      installedVersion: installed.version,
      processStartMs: sessionProcessStartMs(t.session),
      binaryMtimeMs: installed.mtimeMs,
      lastActionAt: lastActionAt.get(t.session) ?? null,
      now,
      cooldownMs: MODEL_VERSION_RESTART_COOLDOWN_MS,
    })
    if (action === 'none') continue
    lastActionAt.set(t.session, now)
    if (action === 'alert-update') {
      logger.warn({ agent: t.name, ...error, installed: installed.version }, 'model-version-guard: installed Claude Code too old for the configured model')
      sendAlert(`⚠️ A(z) ${t.name} ágens modellje ${error.required}+ Claude Code-ot igényel, de a telepített verzió ${installed.version}. Újraindítás nem segít: futtasd a \`claude update\`-et, utána indítsd újra az ágenst.`)
      continue
    }
    logger.warn({ agent: t.name, ...error, installed: installed.version }, 'model-version-guard: session predates the installed Claude Code build -- restarting')
    const ok = t.isMain ? hardRestartMarveenChannels().ok : (await restartAgentProcess(t.name)).ok
    sendAlert(ok
      ? `🔄 A(z) ${t.name} ágens a régi Claude Code ${error.running} verzión futott, ami nem támogatja a modelljét. Újraindítottam az újonnan telepített ${installed.version} verzióra.`
      : `⚠️ A(z) ${t.name} ágens a régi Claude Code ${error.running} verzión fut (a modelljéhez ${error.required}+ kell, telepítve ${installed.version}), de az automatikus újraindítás nem sikerült. Kézzel indítsd újra.`)
  }
}

export function startModelVersionGuard(): NodeJS.Timeout {
  let running = false
  const run = () => {
    if (running) return
    running = true
    tick().catch((err) => logger.warn({ err }, 'model-version-guard tick failed')).finally(() => { running = false })
  }
  setTimeout(run, MODEL_VERSION_GUARD_INITIAL_DELAY_MS)
  return setInterval(run, MODEL_VERSION_GUARD_INTERVAL_MS)
}
