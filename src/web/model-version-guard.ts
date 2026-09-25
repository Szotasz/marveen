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
// So: when the session's LAST answer is that error, the binary the session was
// launched from is now new enough, and the process is still running an older
// file than the one installed at that path, restart it (the fresh process picks
// up the new binary). If the installed binary is still too old, alert instead:
// a restart cannot help, `claude update` is needed.
//
// What keeps it from firing on a healthy session (review follow-up):
// - State, not text: the error must be the last block right above the input
//   prompt, rendered as an error line (`⏺ API Error: 400` / `⎿ API Error: 400`).
//   A reply that quotes the message, or an older turn above it, does not count.
// - The running file, not an mtime: the process's executable inode is compared
//   with the inode currently at the same path. A same-version reinstall changes
//   the inode, which is why the version test comes first: the error states the
//   running version, the path's `--version` states the installed one.
// - A process this guard started is never restarted again for the same error:
//   a `--continue` session re-renders its history, so the old error can stay
//   on screen after the fix.
// - The installed version is read from the binary the session runs, not from
//   the `claude` on the dashboard's PATH.
// - Opt-in: off unless MODEL_VERSION_GUARD=1.

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { runLsof } from '../lsof.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane, agentSessionName, restartAgentProcess } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { sendAlert, hardRestartMarveenChannels } from './channel-monitor.js'

export const MODEL_VERSION_GUARD_INTERVAL_MS = 120_000
const MODEL_VERSION_GUARD_INITIAL_DELAY_MS = 65_000
// One restart attempt per session per window: if the restart did not help, the
// cause is something else and a loop would only destroy context.
export const MODEL_VERSION_RESTART_COOLDOWN_MS = 60 * 60 * 1000
// How far above the input prompt the last block may start. The error plus its
// wrap and the status line span well under this.
const LAST_BLOCK_SCAN_LINES = 15

const UNSUPPORTED_RX =
  /Claude Code (\d+\.\d+\.\d+) does not support this model;\s*version (\d+\.\d+\.\d+) or newer is required/
// The input prompt, bare or inside the input box border.
const PROMPT_RX = /^\s*(?:│\s*)?❯/
// A line that starts a new block: an answer, a tool result, a user prompt.
const BLOCK_HEAD_RX = /^\s*(?:[⏺●⎿❯>]|│\s*❯)/
// How Claude Code renders a turn-level API error.
const ERROR_HEAD_RX = /^\s*[⏺●⎿]\s*API Error:\s*400\b/
// Chrome between the last answer and the prompt: rules, spinner/status lines.
const CHROME_RX = /^\s*(?:[─━╭╰│]+.*|[✻✽✶✳✢·*]\s.*)$/

export interface UnsupportedModelError { running: string; required: string }

export function parseUnsupportedModelError(pane: string | null): UnsupportedModelError | null {
  if (!pane) return null
  const lines = pane.split('\n')
  let promptIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_RX.test(lines[i])) { promptIdx = i; break }
  }
  if (promptIdx < 0) return null
  const body: string[] = []
  for (let i = promptIdx - 1; i >= Math.max(0, promptIdx - LAST_BLOCK_SCAN_LINES); i--) {
    const line = lines[i]
    if (!line.trim()) continue
    if (BLOCK_HEAD_RX.test(line)) {
      if (!ERROR_HEAD_RX.test(line)) return null
      const m = [line, ...body].join(' ').replace(/\s+/g, ' ').match(UNSUPPORTED_RX)
      return m ? { running: m[1], required: m[2] } : null
    }
    if (body.length === 0 && CHROME_RX.test(line)) continue
    body.unshift(line)
  }
  return null
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
  processInode: number | null
  installedInode: number | null
  processPid: number | null
  restartedPid: number | null
  lastActionAt: number | null
  now: number
  cooldownMs: number
}): VersionGuardAction {
  if (!opts.error) return 'none'
  if (opts.lastActionAt !== null && opts.now - opts.lastActionAt < opts.cooldownMs) return 'none'
  if (!opts.installedVersion) return 'none' // cannot judge -> do nothing destructive
  if (!semverGte(opts.installedVersion, opts.error.required)) return 'alert-update'
  // Installed build is new enough. Restart only a process that still runs an
  // older file; unknown -> do nothing (a false restart costs the context).
  if (opts.processInode === null || opts.installedInode === null) return 'none'
  if (opts.processInode === opts.installedInode) return 'none'
  if (opts.processPid !== null && opts.processPid === opts.restartedPid) return 'none'
  return 'restart'
}

export interface SessionBinary { pid: number; path: string; inode: number }

// The executable the session's process is actually running: its path and the
// inode of the file it has open (not whatever is at that path now).
function sessionBinary(session: string): SessionBinary | null {
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pid = Number(out.split('\n')[0].trim())
    if (!Number.isInteger(pid) || pid <= 0) return null
    const lsof = runLsof(['-a', '-p', String(pid), '-d', 'txt', '-Fin'], 5_000)
    if (!lsof) return null
    const inode = Number(/^i(\d+)$/m.exec(lsof)?.[1])
    const path = /^n(.+)$/m.exec(lsof)?.[1]
    if (!path || !Number.isFinite(inode) || !/claude/i.test(path)) return null
    return { pid, path, inode }
  } catch {
    return null
  }
}

function installedAt(path: string): { version: string | null; inode: number | null } {
  let version: string | null = null
  let inode: number | null = null
  try {
    const out = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
    version = out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null
  } catch { version = null }
  try { inode = statSync(path).ino } catch { inode = null }
  return { version, inode }
}

export interface GuardTarget { session: string; name: string; isMain: boolean }

export interface GuardDeps {
  targets: () => GuardTarget[]
  capture: (session: string) => string | null
  binary: (session: string) => SessionBinary | null
  installed: (path: string) => { version: string | null; inode: number | null }
  restart: (t: GuardTarget) => Promise<boolean>
  alert: (text: string) => void
  now: () => number
}

const defaultDeps: GuardDeps = {
  targets: () => {
    const out: GuardTarget[] = [{ session: MAIN_CHANNELS_SESSION, name: MAIN_AGENT_ID, isMain: true }]
    for (const a of listAgentNames()) {
      if (a !== MAIN_AGENT_ID && isAgentRunning(a)) out.push({ session: agentSessionName(a), name: a, isMain: false })
    }
    return out
  },
  capture: (session) => capturePane(session),
  binary: sessionBinary,
  installed: installedAt,
  restart: async (t) => (t.isMain ? hardRestartMarveenChannels().ok : (await restartAgentProcess(t.name)).ok),
  alert: (text) => sendAlert(text),
  now: () => Date.now(),
}

export interface GuardState { lastActionAt: Map<string, number>; restartedPid: Map<string, number> }
const state: GuardState = { lastActionAt: new Map(), restartedPid: new Map() }

export async function modelVersionGuardTick(deps: GuardDeps = defaultDeps, st: GuardState = state): Promise<void> {
  for (const t of deps.targets()) {
    const error = parseUnsupportedModelError(deps.capture(t.session))
    if (!error) continue
    const bin = deps.binary(t.session)
    const installed = bin ? deps.installed(bin.path) : { version: null, inode: null }
    const now = deps.now()
    const action = decideVersionGuard({
      error,
      installedVersion: installed.version,
      processInode: bin?.inode ?? null,
      installedInode: installed.inode,
      processPid: bin?.pid ?? null,
      restartedPid: st.restartedPid.get(t.session) ?? null,
      lastActionAt: st.lastActionAt.get(t.session) ?? null,
      now,
      cooldownMs: MODEL_VERSION_RESTART_COOLDOWN_MS,
    })
    if (action === 'none') continue
    st.lastActionAt.set(t.session, now)
    if (action === 'alert-update') {
      logger.warn({ agent: t.name, ...error, installed: installed.version }, 'model-version-guard: installed Claude Code too old for the configured model')
      deps.alert(`⚠️ A(z) ${t.name} ágens modellje ${error.required}+ Claude Code-ot igényel, de a telepített verzió ${installed.version}. Újraindítás nem segít: futtasd a \`claude update\`-et, utána indítsd újra az ágenst.`)
      continue
    }
    logger.warn({ agent: t.name, ...error, installed: installed.version }, 'model-version-guard: session runs an older Claude Code build than installed -- restarting')
    const ok = await deps.restart(t)
    const after = ok ? deps.binary(t.session) : null
    if (after) st.restartedPid.set(t.session, after.pid)
    deps.alert(ok
      ? `🔄 A(z) ${t.name} ágens a régi Claude Code ${error.running} verzión futott, ami nem támogatja a modelljét. Újraindítottam az újonnan telepített ${installed.version} verzióra.`
      : `⚠️ A(z) ${t.name} ágens a régi Claude Code ${error.running} verzión fut (a modelljéhez ${error.required}+ kell, telepítve ${installed.version}), de az automatikus újraindítás nem sikerült. Kézzel indítsd újra.`)
  }
}

export function startModelVersionGuard(): NodeJS.Timeout | undefined {
  if (process.env.MODEL_VERSION_GUARD !== '1') {
    logger.info('model-version-guard: disabled (set MODEL_VERSION_GUARD=1 to enable)')
    return undefined
  }
  let running = false
  const run = () => {
    if (running) return
    running = true
    modelVersionGuardTick().catch((err) => logger.warn({ err }, 'model-version-guard tick failed')).finally(() => { running = false })
  }
  setTimeout(run, MODEL_VERSION_GUARD_INITIAL_DELAY_MS)
  return setInterval(run, MODEL_VERSION_GUARD_INTERVAL_MS)
}
