// Reap orphaned channel-plugin pollers (bun/node processes that survived a
// tmux kill-session or are left over from a previous agent crash).
//
// The bug we close (2026-06-01 incident, channel-disconnect roundtrip):
//   - stopAgentProcess used `pkill -f TELEGRAM_STATE_DIR=<dir>`, but the
//     plugin process argv is just `bun run --cwd .../telegram/0.0.6 start`
//     - the env var lives in /proc-equivalent environment storage, not argv,
//     so `pkill -f` never matches and the orphan keeps polling getUpdates
//     with the same bot token until SIGTERM by hand.
//   - startAgentProcess only killed the tmux session pre-launch and did NOT
//     reap orphans at all. After a restart the old poller raced the new one
//     and Telegram returned 409 Conflict in a loop.
//   - The plugin writes bot.pid in <chanDir>/bot.pid. That works on the
//     happy path but if a new poller crashed and a later one overwrote the
//     file, the older orphan is no longer in bot.pid - we miss it.
//
// Strategy: combine two identifiers.
//   1. bot.pid (cheap, works for the supervised process).
//   2. `ps eww -e` scan for the *_STATE_DIR=<chanDir> env-var match. This
//      catches orphans whose pid is no longer in bot.pid - any process that
//      was started against this channel state dir is in scope, regardless
//      of how its argv was rendered. macOS BSD ps emits each process's full
//      environment when invoked with `e`; we grep that.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelProviderType } from '../channel-provider.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'

const STATE_ENV_VAR: Record<ChannelProviderType, string> = {
  telegram: 'TELEGRAM_STATE_DIR',
  slack: 'SLACK_STATE_DIR',
  discord: 'DISCORD_STATE_DIR',
  googlechat: 'GOOGLECHAT_STATE_DIR',
  teams: 'TEAMS_STATE_DIR',
}

// Parse `ps eww -e` output and return every PID whose process environment
// contains `<envVar>=<value>`. Exported for testability.
//
// `ps eww -e` rows on macOS look like:
//   90798 s000  S+   0:00.01 bun run --cwd ... HOME=/Users/... TELEGRAM_STATE_DIR=/path... ...
// The match must be precise: substring `TELEGRAM_STATE_DIR=/path` against
// `TELEGRAM_STATE_DIR=/path-elsewhere` is acceptable because the value is an
// absolute path, but we still anchor on the env-var literal to avoid
// matching a row that just *mentions* the path string in its argv.
export function parsePollerPidsFromPs(
  psOutput: string,
  envVar: string,
  value: string,
): number[] {
  const needle = `${envVar}=${value}`
  const out: number[] = []
  for (const line of psOutput.split('\n')) {
    if (!line.includes(needle)) continue
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

function listPollerPidsByStateDir(envVar: string, chanDir: string): number[] {
  try {
    const out = execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    return parsePollerPidsFromPs(out, envVar, chanDir)
  } catch (err) {
    logger.warn({ err, chanDir }, 'channel-poller-reap: ps scan failed')
    return []
  }
}

// ---------------------------------------------------------------------------
// Plugin-process markers for the reap candidates (card cf075d41).
//
// The state-dir variable is exported by the session launcher, so every
// descendant of the owning agent inherits it: its claude, its Bash tools,
// builds, test runs and watchers. selectReapablePollers spares the pane, its
// ancestors, any `claude` and every env-scan hit that is not a JS runtime, but
// a node/npm/npx job the agent started (and detached) passes the runtime check.
// Claude Code sets CLAUDE_PLUGIN_ROOT=<plugin cache>/<provider>/<ver> only for
// the plugin server it spawns and that server's children; measured on a live
// host, every real poller carried it and none of the other processes with the
// state dir did. So an env-scan candidate needs BOTH markers, and bot.pid is
// honoured only while it names a process with the plugin marker: the pid space
// wraps, and a stale bot.pid can name a pid the kernel has since given to an
// unrelated process.

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The CLAUDE_PLUGIN_ROOT anchor for one provider: the env literal, then the
// provider dir segment ending on a path/version/space boundary, so `/telegram`
// does not match a longer sibling like `/telegram-inline`.
function pluginRootRegex(pluginRootNeedle: string): RegExp {
  return new RegExp(`CLAUDE_PLUGIN_ROOT=\\S*${escapeRe(pluginRootNeedle)}(?:[/@ ]|$)`)
}

/**
 * The poller candidates of ONE channel state dir: a `ps eww -e` row counts only
 * if it carries BOTH the state-dir literal `<envVar>=<chanDir>` (ending on
 * whitespace or end of line, so `/x/telegram` does not also match
 * `/x/telegram-old`) AND the provider's CLAUDE_PLUGIN_ROOT anchor.
 * Exported for testability.
 */
export function parseStateDirPollerPids(
  psEwwOutput: string,
  envVar: string,
  chanDir: string,
  pluginRootNeedle: string,
): number[] {
  const rootRe = pluginRootRegex(pluginRootNeedle)
  const dirRe = new RegExp(`(?:^|\\s)${escapeRe(envVar)}=${escapeRe(chanDir)}(?:\\s|$)`)
  const out: number[] = []
  for (const line of psEwwOutput.split('\n')) {
    if (!dirRe.test(line) || !rootRe.test(line)) continue
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

/**
 * Is `pid`, in the same `ps eww -e` snapshot, a plugin process of the provider
 * (CLAUDE_PLUGIN_ROOT anchor present)? bot.pid is only trusted through this
 * check. Exported for testability.
 */
export function isPluginPollerPid(psEwwOutput: string, pid: number, pluginRootNeedle: string): boolean {
  const rootRe = pluginRootRegex(pluginRootNeedle)
  for (const line of psEwwOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s/)
    if (m && parseInt(m[1]!, 10) === pid) return rootRe.test(line)
  }
  return false
}

// One `ps eww -e` snapshot; empty on failure (no candidate then, so nothing is reaped).
function psEwwSnapshot(chanDir: string): string {
  try {
    return execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  } catch (err) {
    logger.warn({ err, chanDir }, 'channel-poller-reap: ps scan failed')
    return ''
  }
}

function readBotPid(chanDir: string): number | null {
  const path = join(chanDir, 'bot.pid')
  if (!existsSync(path)) return null
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

export interface ReapResult {
  reaped: number[]
  source: { fromBotPid: number | null; fromEnvScan: number[] }
  // Candidates that matched bot.pid/env-scan but were spared because they ARE a
  // live tmux pane's own leader process right now. Non-empty here is the exact
  // signature of the 2026-09-19 bug (card 08a02137): env-var inheritance makes a
  // pane's own claude process match its own *_STATE_DIR export, and killing it
  // here (instead of leaving it to the caller's imminent `respawn-pane -k`)
  // collapsed the pane before respawn-pane could run. Logged whenever non-empty
  // so a recurrence is visible instead of silently "just working".
  skippedLivePane: number[]
  // True when the tmux server itself matched the candidate sources and was
  // spared (TMUXSERVERREAP929). Killing it takes every agent session down.
  skippedTmuxServer?: boolean
  // 35ea0375: targets spared because another uid owns them, or their owner could not be read.
  skippedOtherUid: number[]
  skippedUnknownOwner: number[]
  // 35ea0375: the signal outcome by kind; `reaped` holds only the pids actually killed.
  killOutcome: KillOutcomes
  // cf075d41: processes that carry the state dir, or sit in bot.pid, but are not plugin processes: never candidates.
  skippedNotPlugin: number[]
}

// ---------------------------------------------------------------------------
// Down-verdict forensics (2026-07-14).
//
// The watchdog restarted agents ~10x/day on a "channel plugin down" verdict,
// and the restart DESTROYS the evidence: the poller is reaped, the session is
// respawned, and the post-mortem log says only "down -- auto-restarting". So
// the interesting question -- did the poller really die, or did the tree-walk
// lose a live one? -- could not be answered from the logs at all.
//
// This captures the state at the MOMENT the verdict is formed, before anything
// is torn down: is a poller process for this chanDir alive at all, is it in the
// claude process tree, and does bot.pid still point at it. One WARN per
// down-spell, so it costs a ps per spell, not per sweep.

export interface PollerEvidenceRow {
  pid: number
  ppid: number
  // Whether claudePid is an ancestor of this pid. FALSE with a live pid is the
  // interesting case: the poller exists but hangs outside the tree the liveness
  // probe walks (reparented / attached to a previous claude).
  inClaudeTree: boolean
}

export interface PollerEvidence {
  botPid: number | null
  botPidAlive: boolean
  // Pollers found by env-var scan, i.e. every process started against this
  // channel state dir regardless of parentage.
  envScanPids: number[]
  rows: PollerEvidenceRow[]
  // The verdict this evidence supports, spelled out so the log line is readable
  // without re-deriving it:
  //   'no-poller'      -> nothing alive: the plugin really did die.
  //   'orphaned'       -> a live poller exists but is NOT under claude.
  //   'in-tree'        -> a live poller IS under claude: the probe was WRONG.
  interpretation: 'no-poller' | 'orphaned' | 'in-tree'
}

// Pure core: exported for tests (no ps, no fs).
export function buildPollerEvidence(
  procs: ProcRow[],
  botPid: number | null,
  envScanPids: number[],
  claudePid: number,
): PollerEvidence {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)

  const isUnderClaude = (pid: number): boolean => {
    let cur = pid
    const seen = new Set<number>()
    for (let hops = 0; hops < 8; hops++) {
      if (cur === claudePid) return true
      if (seen.has(cur)) break
      seen.add(cur)
      const next = byPid.get(cur)?.ppid
      if (next === undefined || next === cur || next <= 1) break
      cur = next
    }
    return false
  }

  const candidates = new Set<number>(envScanPids)
  if (botPid != null) candidates.add(botPid)

  const rows: PollerEvidenceRow[] = []
  for (const pid of candidates) {
    const row = byPid.get(pid)
    if (!row) continue // not in the ps snapshot -> dead
    rows.push({ pid, ppid: row.ppid, inClaudeTree: isUnderClaude(pid) })
  }

  const interpretation: PollerEvidence['interpretation'] = rows.length === 0
    ? 'no-poller'
    : rows.some((r) => r.inClaudeTree) ? 'in-tree' : 'orphaned'

  return {
    botPid,
    botPidAlive: botPid != null && byPid.has(botPid),
    envScanPids,
    rows,
    interpretation,
  }
}

// Collect the evidence for one agent. Call this ONCE per down-spell, at the
// first down observation, BEFORE any teardown.
export function collectPollerEvidence(
  provider: ChannelProviderType,
  agentDirPath: string,
  claudePid: number,
): PollerEvidence {
  const chanDir = channelStateDir(provider, agentDirPath)
  return buildPollerEvidence(
    snapshotProcs(),
    readBotPid(chanDir),
    listPollerPidsByStateDir(STATE_ENV_VAR[provider], chanDir),
    claudePid,
  )
}

// ---------------------------------------------------------------------------
// Own-uid guard and kill outcomes (card 35ea0375).
//
// The process tables the reapers read are host-wide: `ps -axww` and `ps eww -e`
// list every user's processes. A detached `claude --channels` that belongs to
// ANOTHER user on the same host therefore passed the orphan test, its SIGTERM
// failed with EPERM, the catch read that as "already gone", and the log said
// "killed" for the same pids every cycle while they lived on. Two rules close it:
//   - every kill path signals only processes owned by the dashboard's own uid
//     (the owner of /proc/<pid>; `ps -o uid=` where there is no /proc). The rest
//     is skipped, and the skips are ONE count per reap call, not a line per pid;
//   - each signal's outcome is kept by kind (ok / ESRCH / EPERM / other), and a
//     pid counts as killed only when a signal of ours reached it and it is gone
//     or got SIGKILL. The returned and the logged `reaped` lists are those pids.

const HAS_PROC = existsSync('/proc/self')

/**
 * The owner uid of a process: the owner of /proc/<pid> where /proc exists, else
 * `ps -o uid= -p <pid>`. null when it cannot be read (the process is gone, or
 * neither source answers); such a pid is never signalled. `useProc` is a test
 * seam (the ps path on a host that has /proc). Exported for testability.
 */
export function processOwnerUid(pid: number, useProc: boolean = HAS_PROC): number | null {
  if (useProc) {
    try { return statSync(`/proc/${pid}`).uid } catch { return null }
  }
  try {
    const out = execFileSync('/bin/ps', ['-o', 'uid=', '-p', String(pid)], { timeout: 3000, encoding: 'utf-8' }).trim()
    return /^\d+$/.test(out) ? Number(out) : null
  } catch { return null }
}

/** The dashboard's own uid; null where the platform has none (then nothing is signalled). */
function dashboardUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

export interface OwnerSplit {
  // owned by the dashboard's uid: the only pids a reaper may signal
  own: number[]
  // owned by another uid: skipped
  foreign: number[]
  // the owner could not be read (gone, or no source answered): skipped
  unknown: number[]
}

/** Pure: split candidate pids by owner against `uid` (null: nothing is ours). Exported for testability. */
export function splitByOwner(
  pids: number[],
  uid: number | null,
  ownerOf: (pid: number) => number | null = processOwnerUid,
): OwnerSplit {
  const split: OwnerSplit = { own: [], foreign: [], unknown: [] }
  for (const pid of pids) {
    const owner = uid === null ? null : ownerOf(pid)
    if (owner === null) split.unknown.push(pid)
    else if (owner === uid) split.own.push(pid)
    else split.foreign.push(pid)
  }
  return split
}

export type SignalOutcome = 'ok' | 'ESRCH' | 'EPERM' | 'other'
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void

const processKill: KillFn = (pid, signal) => { process.kill(pid, signal) }

/**
 * One signal and its outcome by kind: process.kill throws ESRCH for a pid that is
 * gone and EPERM for one this user may not signal. Exported for testability.
 */
export function sendSignal(pid: number, signal: NodeJS.Signals | 0, kill: KillFn = processKill): SignalOutcome {
  try {
    kill(pid, signal)
    return 'ok'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ESRCH' || code === 'EPERM' ? code : 'other'
  }
}

export interface KillOutcomes {
  // a signal of ours reached the pid, and it is gone or got SIGKILL
  killed: number[]
  // ESRCH on the first SIGTERM: it was gone before we signalled
  alreadyGone: number[]
  // EPERM: not ours to signal
  permissionDenied: number[]
  // any other failure
  failed: number[]
}

function noKills(): KillOutcomes {
  return { killed: [], alreadyGone: [], permissionDenied: [], failed: [] }
}

/** Test seams of the reapers (35ea0375): the owner lookup, the own uid and the signal function. */
export interface ReapSeams {
  ownerOf?: (pid: number) => number | null
  ownUid?: number | null
  kill?: KillFn
}

function pauseForFlush(): void {
  try { execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 }) } catch { /* ignore */ }
}

/**
 * SIGTERM every pid, give bun/node ~300ms to flush, then SIGKILL any survivor,
 * keeping each pid's outcome by kind. `kill` and `pause` are test seams.
 * Exported for testability.
 */
export function terminatePids(pids: number[], deps: { kill?: KillFn; pause?: () => void } = {}): KillOutcomes {
  const kill = deps.kill ?? processKill
  const out = noKills()
  const notKilled = (pid: number, outcome: SignalOutcome) => {
    if (outcome === 'EPERM') out.permissionDenied.push(pid)
    else out.failed.push(pid)
  }
  const termed: number[] = []
  for (const pid of pids) {
    const sent = sendSignal(pid, 'SIGTERM', kill)
    if (sent === 'ok') termed.push(pid)
    else if (sent === 'ESRCH') out.alreadyGone.push(pid)
    else notKilled(pid, sent)
  }
  if (termed.length === 0) return out
  const pause = deps.pause ?? pauseForFlush
  pause()
  for (const pid of termed) {
    const probe = sendSignal(pid, 0, kill)
    if (probe === 'ESRCH') { out.killed.push(pid); continue } // our SIGTERM ended it
    if (probe !== 'ok') { notKilled(pid, probe); continue }
    const sigkill = sendSignal(pid, 'SIGKILL', kill)
    if (sigkill === 'ok' || sigkill === 'ESRCH') out.killed.push(pid) // delivered, or it died just now
    else notKilled(pid, sigkill)
  }
  return out
}

/** The outcome counts by kind for a log line. */
function outcomeByKind(o: KillOutcomes): { ok: number; ESRCH: number; EPERM: number; other: number } {
  return { ok: o.killed.length, ESRCH: o.alreadyGone.length, EPERM: o.permissionDenied.length, other: o.failed.length }
}

/** One line per reap call for the spared owners: counts only, never a line per pid. */
function logOwnerSkips(where: Record<string, unknown>, split: OwnerSplit): void {
  if (split.foreign.length === 0 && split.unknown.length === 0) return
  logger.info({ ...where, skippedOtherUid: split.foreign.length, skippedUnknownOwner: split.unknown.length },
    'channel-poller-reap: spared processes not owned by this user (35ea0375)')
}

/** The signalled pids that were NOT killed, with the outcome by kind (warn when a signal was refused or failed). */
function logNotKilled(where: Record<string, unknown>, o: KillOutcomes): void {
  const notKilled = [...o.alreadyGone, ...o.permissionDenied, ...o.failed]
  if (notKilled.length === 0) return
  const unexpected = o.permissionDenied.length + o.failed.length > 0
  const line = { ...where, notKilled, outcome: outcomeByKind(o) }
  const msg = 'channel-poller-reap: signalled pid(s) not killed, outcome by kind'
  if (unexpected) logger.warn(line, msg)
  else logger.info(line, msg)
}

/**
 * Reap every channel-plugin poller process associated with this agent.
 * Combines bot.pid (cheap, supervised pid) with a `ps eww -e` env-var scan
 * (catches orphans whose pid is no longer in bot.pid). SIGTERM first; after
 * a short grace period, SIGKILL any survivor. Safe to call multiple times
 * (process.kill on a missing pid is caught). Signals only processes of the
 * dashboard's own uid, and `reaped` lists only the pids actually killed (35ea0375).
 */
// ---------------------------------------------------------------------------
// WHO IS ACTUALLY A POLLER (2026-09-21, card ee485f5e).
//
// The env-var scan above answers "which processes were started against this
// channel state dir". For years that was the same set as "which processes are
// the plugin poller", because channels.sh launched the MAIN session withOUT
// exporting *_STATE_DIR -- a fact the comments in this file and in
// channel-monitor.ts still asserted. #915 changed it: channels.sh now exports
// the var (see scripts/channels.sh, "the plugin honours *_STATE_DIR, and with
// it exported the main session's poller does carry it"), and env vars are
// INHERITED. So the needle now also matches:
//   * the session's own `claude` process -- which on the main session IS the
//     tmux pane leader, so SIGTERMing it destroys the session, and
//   * every unrelated child that happened to inherit it, down to the watchdog's
//     own `sleep 5` inside scripts/channels.sh.
//
// Measured on this host 2026-09-21 06:55 (5 matches for one channel dir):
//   641057 claude  <- tmux pane pid of lean-chief-channels
//   641186 bun     <- plugin launcher      }  the only real pollers
//   641196 bun     <- bot.pid              }
//   668857 sleep   <- child of channels.sh (the watchdog's own sleep)
// and in the outage (03:00-06:31) the reaper killed all four of them, 40 times,
// every attempt taking the bridge down for the next 4-6 minutes.
//
// So the candidate list is now a SUPERSET of the pollers and must be filtered.
// Three independent guards, because the expensive failure is killing the
// session and the cheap failure is leaving one orphan for the next sweep:
//   1. pane        -- the pid IS a live tmux pane pid. Never killable here:
//                     that is an agent session, not a poller.
//   2. pane-ancestor -- an ancestor of a live pane (the tmux server, systemd).
//   3. claude      -- argv[0] basename is `claude`. An agent process, whatever
//                     its parentage; DETACHED ones are reapDetachedChannelClaudes'
//                     job, and that function identifies them by pane attribution
//                     instead of env/argv heuristics (see its comment).
//   4. not-a-runtime -- argv[0] basename is not a JS runtime. A channel plugin
//                     poller is always run by one (`bun run ...`, `node
//                     server.ts`); a `sleep`/`git`/`npm install` that merely
//                     inherited the env var is not. Applied to ENV-SCAN
//                     candidates only: bot.pid is written by the plugin itself,
//                     so a poller shipped as a compiled binary is still reaped
//                     through that path. The gap this leaves is narrow and
//                     named: a NON-JS orphan whose pid is no longer in bot.pid.
//
// The candidates reach this selection already narrowed to plugin processes
// (cf075d41, "Plugin-process markers" above): an env-scan hit needs the
// CLAUDE_PLUGIN_ROOT marker too, and bot.pid counts only while it names a
// process with that marker. Guard 4 stays as a second layer for the env scan.
//
// The pollers themselves are descendants of the pane and are still reaped --
// that is the whole point of reaping BEFORE a respawn (a surviving poller
// 409-races the new one). Only the pane itself and its ancestors are spared.
const POLLER_RUNTIMES = new Set(['bun', 'bunx', 'node', 'nodejs', 'deno', 'npm', 'npx'])

function argv0Base(command: string): string {
  const argv0 = command.trim().split(/\s+/, 1)[0] ?? ''
  return argv0.split('/').pop() ?? ''
}

export interface PollerSelection {
  reap: number[]
  spared: { pid: number; reason: 'pane' | 'pane-ancestor' | 'claude' | 'not-a-runtime' | 'gone' }[]
}

/**
 * Pure: split reap candidates into "actually a poller" and "spared, with a
 * reason". `fromBotPid` is exempt from the runtime check (see guard 4 above).
 * Exported for testability -- no ps, no tmux, no kill.
 */
export function selectReapablePollers(
  candidates: number[],
  procs: ProcRow[],
  panePids: Set<number>,
  fromBotPid: number | null,
): PollerSelection {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)

  const paneAncestors = paneAncestorPids(procs, panePids)

  const reap: number[] = []
  const spared: PollerSelection['spared'] = []
  for (const pid of candidates) {
    const row = byPid.get(pid)
    if (!row) { spared.push({ pid, reason: 'gone' }); continue }
    if (panePids.has(pid)) { spared.push({ pid, reason: 'pane' }); continue }
    if (paneAncestors.has(pid)) { spared.push({ pid, reason: 'pane-ancestor' }); continue }
    if (argv0Base(row.command) === 'claude') { spared.push({ pid, reason: 'claude' }); continue }
    if (pid !== fromBotPid && !POLLER_RUNTIMES.has(argv0Base(row.command))) {
      spared.push({ pid, reason: 'not-a-runtime' }); continue
    }
    reap.push(pid)
  }
  return { reap, spared }
}

/**
 * Pure: every ancestor of every live pane (the tmux server, a pane's parent),
 * walked once, at most 16 hops per pane. Exported for testability.
 */
export function paneAncestorPids(procs: ProcRow[], panePids: Set<number>): Set<number> {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)
  const paneAncestors = new Set<number>()
  for (const pane of panePids) {
    let cur = byPid.get(pane)?.ppid
    const seen = new Set<number>()
    for (let hops = 0; hops < 16 && cur !== undefined && cur > 1; hops++) {
      if (seen.has(cur)) break
      seen.add(cur)
      paneAncestors.add(cur)
      cur = byPid.get(cur)?.ppid
    }
  }
  return paneAncestors
}

export function reapChannelOrphans(
  provider: ChannelProviderType,
  agentDirPath: string,
  opts: { tmuxPath?: string } & ReapSeams = {},
): ReapResult {
  const chanDir = channelStateDir(provider, agentDirPath)
  const envVar = STATE_ENV_VAR[provider]
  const pluginRootNeedle = PLUGIN_ROOT_NEEDLE[provider]

  // cf075d41: one `ps eww -e` snapshot, both sources narrowed to plugin
  // processes (see "Plugin-process markers" above).
  const psEww = psEwwSnapshot(chanDir)
  const botPid = readBotPid(chanDir)
  const fromBotPid = botPid !== null && isPluginPollerPid(psEww, botPid, pluginRootNeedle) ? botPid : null
  const fromEnvScan = parseStateDirPollerPids(psEww, envVar, chanDir, pluginRootNeedle)
  const skippedNotPlugin = [...new Set([
    ...(botPid !== null && fromBotPid === null ? [botPid] : []),
    ...parsePollerPidsFromPs(psEww, envVar, chanDir).filter((pid) => !fromEnvScan.includes(pid) && pid !== fromBotPid),
  ])]
  if (skippedNotPlugin.length > 0) {
    logger.info({ provider, chanDir, skippedNotPlugin: skippedNotPlugin.length },
      'channel-poller-reap: spared processes that carry the state dir or sit in bot.pid but are not plugin processes (cf075d41)')
  }

  // Deduplicate while preserving order so the bot.pid path is logged first.
  const candidates: number[] = []
  const seen = new Set<number>()
  for (const pid of [fromBotPid, ...fromEnvScan]) {
    if (pid && !seen.has(pid)) {
      seen.add(pid)
      candidates.push(pid)
    }
  }

  // FAIL SAFE, same precedent as reapDetachedChannelClaudes below: without a
  // process snapshot we cannot tell the poller from the pane, and the wrong
  // guess costs the whole channel. An un-reaped orphan costs one 409-racing
  // sweep. Refuse rather than kill blind.
  const procs = candidates.length > 0 ? snapshotProcs() : []
  if (candidates.length > 0 && procs.length === 0) {
    logger.warn({ provider, chanDir, candidates }, 'channel-poller-reap: ps snapshot unavailable, skipping reap (fail-safe)')
    return { reaped: [], source: { fromBotPid, fromEnvScan }, skippedLivePane: [], skippedOtherUid: [], skippedUnknownOwner: [], killOutcome: noKills(), skippedNotPlugin }
  }
  // Second fail-safe layer (upstream, Logra's review 2026-09-19, card 08a02137):
  // an empty live-pane set means the tmux query itself failed (a real server
  // always has at least one pane), not "nothing is live". Without it the
  // pane / pane-ancestor guards in selectReapablePollers have nothing to match
  // against, so refuse instead of relying on the runtime check alone.
  const panePids = candidates.length > 0 ? livePanePids(opts.tmuxPath ?? 'tmux') : new Set<number>()
  if (candidates.length > 0 && panePids.size === 0) {
    logger.warn({ provider, chanDir, candidates },
      'channel-poller-reap: could not resolve live tmux panes, refusing to reap (fail-safe)')
    return { reaped: [], source: { fromBotPid, fromEnvScan }, skippedLivePane: [], skippedOtherUid: [], skippedUnknownOwner: [], killOutcome: noKills(), skippedNotPlugin }
  }
  const selection = selectReapablePollers(candidates, procs, panePids, fromBotPid)
  // A candidate that IS a live pane leader is the exact 08a02137 signature;
  // surfaced separately (warn below) from the other spare reasons.
  const skippedLivePane = selection.spared.filter((s) => s.reason === 'pane').map((s) => s.pid)
  if (selection.spared.length > 0) {
    logger.info({ provider, chanDir, spared: selection.spared }, 'channel-poller-reap: candidates spared (not pollers)')
  }

  // Never kill the tmux SERVER either (TMUXSERVERREAP929). When channels.sh
  // creates the server itself (after a host reboot it usually does: it runs
  // `tmux start-server` with the state-dir var already exported), the server
  // process carries TELEGRAM_STATE_DIR in its own environment, so the env scan
  // matches it. Killing it tears down EVERY agent's pane on the host, not just
  // this one's poller. Measured 2026-09-28 12:47, 14:47 and 2026-09-29 04:31:
  // the reap's `reaped` list held the server pid (the parent of every pane),
  // the next `tmux list-panes` answered "no server running", and the whole
  // fleet died and came back only through the service manager.
  // Fail-safe like the live-pane guard: an unresolved server pid refuses the
  // reap instead of guessing, because the guess is exactly the fleet kill.
  // selectReapablePollers already spares the server through its pane-ancestor
  // guard (the server is every pane's parent); this explicit check is the
  // independent second layer, and it covers the one path the selection lets
  // through: the server pid sitting in bot.pid with no resolved pane under it.
  const serverPid = candidates.length > 0 ? tmuxServerPid(opts.tmuxPath ?? 'tmux') : null
  const serverQueryFailed = candidates.length > 0 && serverPid === null
  if (serverQueryFailed) {
    logger.warn({ provider, chanDir, candidates },
      'channel-poller-reap: could not resolve the tmux server pid, refusing to reap (fail-safe)')
  }
  const skippedTmuxServer = serverPid !== null && candidates.includes(serverPid) && !panePids.has(serverPid)
  const all = serverQueryFailed ? [] : selection.reap.filter((pid) => pid !== serverPid)
  if (skippedTmuxServer) {
    logger.warn({ provider, chanDir, serverPid, fromBotPid, fromEnvScan },
      'channel-poller-reap: candidate IS the tmux server, sparing it (killing it would take down every agent session)')
  }

  // 35ea0375: only this user's processes are signalled. SIGTERM, give bun/node
  // ~300ms to flush, then SIGKILL stragglers; the outcome is kept by kind.
  const owners = splitByOwner(all, opts.ownUid === undefined ? dashboardUid() : opts.ownUid, opts.ownerOf)
  logOwnerSkips({ provider, chanDir }, owners)
  const killOutcome = terminatePids(owners.own, { kill: opts.kill })
  const reaped = killOutcome.killed

  if (reaped.length > 0) {
    logger.info({ provider, chanDir, reaped, outcome: outcomeByKind(killOutcome), fromBotPid, fromEnvScan },
      'channel-poller-reap: orphans killed')
  }
  logNotKilled({ provider, chanDir }, killOutcome)
  if (skippedLivePane.length > 0) {
    logger.warn({ provider, chanDir, skippedLivePane, fromBotPid, fromEnvScan },
      'channel-poller-reap: candidate IS a live pane leader, sparing it (respawn-pane will replace it)')
  }
  return {
    reaped,
    source: { fromBotPid, fromEnvScan },
    skippedLivePane,
    skippedTmuxServer,
    skippedOtherUid: owners.foreign,
    skippedUnknownOwner: owners.unknown,
    killOutcome,
    skippedNotPlugin,
  }
}

// ---------------------------------------------------------------------------
// Detached channel CLAUDE reaper (the parent-process leak, 2026-06-03).
//
// reapChannelOrphans (above) kills bun/node POLLERS by env-var scan + bot.pid.
//
// CORRECTED 2026-09-21 (card ee485f5e): the paragraph that stood here claimed
// the env scan "MISSES the main channels session entirely", because channels.sh
// launched the main `claude --channels` with no *_STATE_DIR export. That has
// been false since #915 -- channels.sh exports it, the plugin writes bot.pid,
// and the main claude and its bun poller BOTH match the needle. The claim was
// load-bearing: it was the reason reapChannelOrphans had no pane guard, and
// once it went stale the reaper started SIGTERMing the main session's own
// pane leader (measured: 40 times between 03:00 and 06:31 on 2026-09-21).
// reapChannelOrphans now filters its candidates (selectReapablePollers).
//
// What this function is still for: a detached `claude --channels` left behind by
// a --continue respawn. When a --continue respawn (channel-monitor
// respawn-pane / agent-process start) fails to tear down the prior claude, the
// detached claude survives -- reparented to the tmux server -- and keeps a bun
// poller hitting getUpdates on the SHARED bot token. 5 such orphans accumulated
// over 13 days, each 409-racing the live poller (token churn + a self-feeding
// agent thrash-restart loop). See project_channels_continue_respawn_leak.
//
// Identification is by tmux-pane attribution, NOT env/argv heuristics (cmdline
// alone cannot tell a live agent claude from a detached one -- see
// feedback_verify_session_before_kill): a `claude --channels` process is an
// orphan iff neither its pid nor any ancestor pid is a LIVE tmux pane pid.
//   - main session: tmux runs claude as the pane leader, so claudePid == panePid.
//   - sub-agents:   tmux runs `sh -c "...claude..."`, so the pane pid is the sh
//                   and claude is its child -> ancestor walk catches it.
// The tmux SERVER process is excluded up front: its argv embeds the full
// `new-session ... claude --channels ...` string, a false positive, but argv[0]
// is tmux, not claude.

export interface ProcRow { pid: number; ppid: number; command: string }

// argv[0] basename === 'claude' (the binary), so the tmux server row whose argv
// merely *contains* the claude command string is excluded.
function isClaudeBinary(command: string): boolean {
  const argv0 = command.trim().split(/\s+/, 1)[0] ?? ''
  const base = argv0.split('/').pop() ?? ''
  return base === 'claude'
}

/**
 * Pure: return the pids of `claude --channels` processes that are NOT attached
 * to any live tmux pane (orphans). `livePanePids` is the set of pane pids from
 * `tmux list-panes -a`. `channelNeedle` optionally restricts to one plugin
 * (e.g. 'plugin:telegram@...'); when omitted, every channel plugin is in scope.
 * Exported for testability.
 */
export function findOrphanChannelClaudes(
  procs: ProcRow[],
  livePanePids: Set<number>,
  channelNeedle?: string,
): number[] {
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)

  const attachedToLivePane = (pid: number): boolean => {
    let cur = pid
    const seen = new Set<number>()
    for (let hops = 0; hops < 8; hops++) {
      if (livePanePids.has(cur)) return true
      if (seen.has(cur)) break
      seen.add(cur)
      const next = byPid.get(cur)?.ppid
      if (next === undefined || next === cur || next <= 1) break
      cur = next
    }
    return false
  }

  const orphans: number[] = []
  for (const p of procs) {
    if (!p.command.includes('--channels')) continue
    if (!isClaudeBinary(p.command)) continue
    if (channelNeedle && !p.command.includes(channelNeedle)) continue
    if (attachedToLivePane(p.pid)) continue
    orphans.push(p.pid)
  }
  return orphans
}

function snapshotProcs(): ProcRow[] {
  try {
    const out = execSync('/bin/ps -axww -o pid=,ppid=,command=', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    const rows: ProcRow[] = []
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      rows.push({ pid: parseInt(m[1]!, 10), ppid: parseInt(m[2]!, 10), command: m[3]! })
    }
    return rows
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: ps -axww snapshot failed')
    return []
  }
}

// The tmux server's own pid, or null when it cannot be resolved.
function tmuxServerPid(tmuxPath: string): number | null {
  try {
    const out = execSync(`${tmuxPath} display-message -p '#{pid}'`, { timeout: 5000, encoding: 'utf-8' })
    const n = parseInt(out.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(n) && n > 1 ? n : null
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: tmux display-message failed')
    return null
  }
}

function livePanePids(tmuxPath: string): Set<number> {
  try {
    const out = execSync(`${tmuxPath} list-panes -a -F '#{pane_pid}'`, { timeout: 5000, encoding: 'utf-8' })
    const s = new Set<number>()
    for (const line of out.split('\n')) {
      const n = parseInt(line.trim(), 10)
      if (Number.isFinite(n) && n > 1) s.add(n)
    }
    return s
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: tmux list-panes failed')
    return new Set()
  }
}

function killBunChildren(claudePid: number, uid: number | null, seams: ReapSeams): void {
  try {
    const out = execSync(`/usr/bin/pgrep -P ${claudePid} bun`, { timeout: 3000, encoding: 'utf-8' })
    const children = out.split('\n').map((line) => parseInt(line.trim(), 10)).filter((pid) => Number.isFinite(pid) && pid > 1)
    // 35ea0375: the same own-uid rule as for the claude itself.
    for (const pid of splitByOwner(children, uid, seams.ownerOf).own) sendSignal(pid, 'SIGTERM', seams.kill)
  } catch { /* no bun children (pgrep exits 1) */ }
}

/**
 * Reap detached `claude --channels` orphans (parent-process leak). SAFE to call
 * before any (re)spawn: it spares every claude attached to a live tmux pane, so
 * it never kills the active session or a live sibling agent -- only truly
 * detached leftovers. Kills each orphan's bun poller children first, then the
 * claude (SIGTERM, ~300ms grace, SIGKILL stragglers). Signals only processes of
 * the dashboard's own uid (35ea0375). Returns the pids actually killed.
 *
 * tmuxPath defaults to a bare `tmux` (resolved on PATH); callers that already
 * hold an absolute path should pass it.
 */
export function reapDetachedChannelClaudes(opts: { channelNeedle?: string; tmuxPath?: string } & ReapSeams = {}): number[] {
  const tmuxPath = opts.tmuxPath ?? 'tmux'
  const procs = snapshotProcs()
  const live = livePanePids(tmuxPath)
  // No live panes resolved (tmux query failed) -> refuse to reap: without the
  // live set we cannot tell orphans from the active session. Fail safe.
  if (live.size === 0) {
    logger.warn('channel-poller-reap: no live panes resolved, skipping detached-claude reap (fail-safe)')
    return []
  }
  const detached = findOrphanChannelClaudes(procs, live, opts.channelNeedle)
  const where = { channelNeedle: opts.channelNeedle ?? '(all)' }
  // cf075d41: the orphan test looks UP from the claude (is it or an ancestor a
  // live pane?), so a detached `claude --channels` that sits ABOVE a live pane
  // leader passes it. Such a claude is never signalled: the pane under it is a
  // live session. The same pane-ancestor set as selectReapablePollers.
  const paneAncestors = paneAncestorPids(procs, live)
  const skippedPaneAncestor = detached.filter((pid) => paneAncestors.has(pid))
  if (skippedPaneAncestor.length > 0) {
    logger.warn({ skippedPaneAncestor, ...where },
      'channel-poller-reap: detached channel claude is an ancestor of a live pane, sparing it (cf075d41)')
  }
  const orphans = detached.filter((pid) => !paneAncestors.has(pid))
  // 35ea0375: the process table is host-wide; only this user's orphans are signalled.
  const uid = opts.ownUid === undefined ? dashboardUid() : opts.ownUid
  const owners = splitByOwner(orphans, uid, opts.ownerOf)
  logOwnerSkips(where, owners)
  for (const pid of owners.own) killBunChildren(pid, uid, opts)
  const killOutcome = terminatePids(owners.own, { kill: opts.kill })
  if (killOutcome.killed.length > 0) {
    logger.info({ reaped: killOutcome.killed, outcome: outcomeByKind(killOutcome), ...where },
      'channel-poller-reap: detached channel claudes killed')
  }
  logNotKilled(where, killOutcome)
  return killOutcome.killed
}

// ---------------------------------------------------------------------------
// Foreign MAIN-token poller reaper (2026-07-18 incident: the main bot went
// silent for ~half an afternoon).
//
// The two reapers above share a blind spot that this one closes:
//
//   reapChannelOrphans          -> matches by <PROVIDER>_STATE_DIR=<chanDir>.
//     The MAIN channels session is launched by channels.sh with NO
//     TELEGRAM_STATE_DIR export (the plugin falls back to its default dir,
//     ~/.claude/channels/<provider>), so the main poller carries no state-dir
//     needle and is invisible to that env scan.
//   reapDetachedChannelClaudes  -> matches `claude --channels` processes not
//     attached to a live pane. A THIEF here is NOT a `--channels` session: it
//     is a plain local-agent-mode / CLI `claude` running in the project cwd,
//     which AUTO-LOADS the telegram plugin because the PROJECT settings.json
//     has enabledPlugins.telegram=true. Its argv has no `--channels`, so that
//     reaper never even considers it.
//
// Net effect: a local-agent-mode subagent (e.g. one the main session's own
// Agent/Task tool spawns) loads the plugin with the DEFAULT state dir, grabs
// the MAIN bot token, and long-polls getUpdates alongside the legit poller ->
// 409 Conflict -> the main bot silently drops inbound. The existing
// down-recovery restarts the VICTIM (the legit session), never the THIEF, so
// the outage persists until the thief happens to exit.
//
// This reaper targets exactly that class: a poller bound to the MAIN (default)
// state dir -- i.e. WITHOUT a <PROVIDER>_STATE_DIR override, which cleanly
// excludes every sub-agent -- whose owning `claude` process is NOT the pane
// leader of the main channels session. The legit main poller's nearest claude
// ancestor IS the channels pane pid; a thief's nearest claude ancestor is the
// local-agent-mode claude (a DESCENDANT of the pane, but not the pane leader).
// So pane-pid EQUALITY -- not mere descent -- is the discriminator (the thief
// is a descendant of the channels pane too, so an "ancestor includes pane"
// test would wrongly spare it).

// argv[0] basename of the CLAUDE_PLUGIN_ROOT plugin dir per provider. The
// telegram plugin cache path ends in `.../telegram/<ver>`; slack-channel in
// `.../slack-channel/<ver>`; etc.
const PLUGIN_ROOT_NEEDLE: Record<ChannelProviderType, string> = {
  telegram: '/telegram',
  slack: '/slack-channel',
  discord: '/discord',
  googlechat: '/googlechat',
  teams: '/teams',
}

// Candidate = a poller bound to the MAIN default state dir: its env carries
// CLAUDE_PLUGIN_ROOT=.../<provider>/<ver> but NO <PROVIDER>_STATE_DIR override
// (the override is exactly what every sub-agent sets, so its absence isolates
// the main-dir pollers). Exported for testability.
export function parseMainDirPollerPids(
  psEwwOutput: string,
  pluginRootNeedle: string, // e.g. '/telegram'
  stateEnvVar: string,      // e.g. 'TELEGRAM_STATE_DIR'
): number[] {
  const escaped = pluginRootNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Anchor on the CLAUDE_PLUGIN_ROOT env literal, then the provider dir segment
  // ending on a path/version/space boundary so `/telegram` does not match a
  // longer sibling like `/telegram-inline`.
  const rootRe = new RegExp(`CLAUDE_PLUGIN_ROOT=\\S*${escaped}(?:[/@ ]|$)`)
  const out: number[] = []
  for (const line of psEwwOutput.split('\n')) {
    if (!rootRe.test(line)) continue
    if (line.includes(`${stateEnvVar}=`)) continue // sub-agent override -> not main dir
    const m = line.match(/^\s*(\d+)\s/)
    if (!m) continue
    const pid = parseInt(m[1]!, 10)
    if (pid > 1) out.push(pid)
  }
  return out
}

// Nearest ancestor whose argv[0] basename is `claude`. Null if none is found
// within the hop budget (a cycle-guarded 8-hop walk). Exported for testability.
export function nearestClaudeAncestor(pid: number, byPid: Map<number, ProcRow>): number | null {
  const seen = new Set<number>()
  let cur = byPid.get(pid)?.ppid
  for (let hops = 0; hops < 8; hops++) {
    if (cur === undefined || cur <= 1 || seen.has(cur)) break
    seen.add(cur)
    const row = byPid.get(cur)
    if (row && isClaudeBinary(row.command)) return cur
    cur = row?.ppid
  }
  return null
}

/**
 * Pure: from the candidate MAIN-dir poller pids, return those whose owning
 * claude (nearest claude ancestor) is NOT a legit main-session pane leader.
 *
 * Fail-safe on two fronts:
 *   - legitClaudePids empty (the main channels session could not be resolved)
 *     -> return [] : without the legit set we cannot tell the real poller from
 *     a thief, and killing the real one would take the bot down.
 *   - a candidate whose owning claude cannot be resolved -> skipped : we never
 *     kill on an ambiguous parent chain.
 * Exported for testability.
 */
export function findForeignMainPollers(
  candidatePollerPids: number[],
  procs: ProcRow[],
  legitClaudePids: Set<number>,
): number[] {
  if (legitClaudePids.size === 0) return []
  const byPid = new Map<number, ProcRow>()
  for (const p of procs) byPid.set(p.pid, p)
  const out: number[] = []
  for (const pid of candidatePollerPids) {
    const owner = nearestClaudeAncestor(pid, byPid)
    if (owner == null) continue
    if (legitClaudePids.has(owner)) continue
    out.push(pid)
  }
  return out
}

function mainSessionPanePids(session: string, tmuxPath: string): Set<number> {
  try {
    const out = execSync(`${tmuxPath} list-panes -t ${session} -F '#{pane_pid}'`, { timeout: 5000, encoding: 'utf-8' })
    const s = new Set<number>()
    for (const line of out.split('\n')) {
      const n = parseInt(line.trim(), 10)
      if (Number.isFinite(n) && n > 1) s.add(n)
    }
    return s
  } catch {
    // Session absent OR tmux query failed -> empty set -> caller fails safe.
    return new Set()
  }
}

/**
 * Reap foreign pollers contending for the MAIN bot token (see the block comment
 * above). SIGTERM -> ~300ms grace -> SIGKILL stragglers. Kills only the poller
 * process, never its owning claude (a real Agent/Task subagent may still be
 * doing legit work -- it just must not hold the main channel's poller). Returns
 * the pids killed; signals only processes of the dashboard's own uid (35ea0375).
 * Fail-safe: does nothing when the main session can't be resolved or the ps/tmux
 * snapshot fails.
 */
export function reapForeignMainPollers(opts: {
  provider: ChannelProviderType
  mainSession: string
  tmuxPath?: string
} & ReapSeams): number[] {
  const tmuxPath = opts.tmuxPath ?? 'tmux'
  const legit = mainSessionPanePids(opts.mainSession, tmuxPath)
  if (legit.size === 0) return [] // fail-safe: cannot distinguish legit from thief

  let psEww: string
  try {
    psEww = execSync('/bin/ps eww -e', { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  } catch (err) {
    logger.warn({ err }, 'channel-poller-reap: ps eww scan failed (foreign-main reap skipped)')
    return []
  }
  const candidates = parseMainDirPollerPids(psEww, PLUGIN_ROOT_NEEDLE[opts.provider], STATE_ENV_VAR[opts.provider])
  if (candidates.length === 0) return []

  const foreign = findForeignMainPollers(candidates, snapshotProcs(), legit)
  // 35ea0375: only this user's pollers are signalled; the outcome is kept by kind.
  const owners = splitByOwner(foreign, opts.ownUid === undefined ? dashboardUid() : opts.ownUid, opts.ownerOf)
  const where = { provider: opts.provider, mainSession: opts.mainSession }
  logOwnerSkips(where, owners)
  const killOutcome = terminatePids(owners.own, { kill: opts.kill })
  if (killOutcome.killed.length > 0) {
    logger.info(
      { ...where, reaped: killOutcome.killed, outcome: outcomeByKind(killOutcome), legit: [...legit] },
      'channel-poller-reap: foreign main-token poller(s) killed (thief contending for the main bot token)',
    )
  }
  logNotKilled(where, killOutcome)
  return killOutcome.killed
}
