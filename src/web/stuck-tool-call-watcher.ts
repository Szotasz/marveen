// Stuck tool-call watchdog for the main channels session (2026-06-02 incident).
//
// Symptom & root cause (from cold-memory entry `marveen,deafness,Worked for`):
//   Marveen's TUI gets stuck at "Worked for 31s" indefinitely. The Telegram
//   reply tool-call hung server-side (no client-side timeout), and the
//   claude TUI render loop blocks on its stdio pipe. CPU drops to 0.3%,
//   IO-wait. The bun channel-plugin poller is still alive, so #240's
//   bun-alive short-circuit hides the freeze from the main recovery cascade --
//   stage 1-4 never fires. Inbound traffic is read by bun and delivered into
//   the prompt buffer, but the TUI can never act on it: Szabi sees "Marveen
//   válaszol, de a válasz nem jön meg Telegramra".
//
// Detection: parse the TUI's "<verb> for Ns" progress line; if the same
// tag+seconds is observed across multiple polls AND the seconds value has
// reached freezeSeconds, the tool-call is wedged. Recovery (#248 fix) is the
// respawn-pane path resumeMarveenSession() -- NOT the launchctl hard-restart.
// `tmux respawn-pane -k` replaces only the pane's claude process: it does NOT
// `tmux kill-session`, so an attached client is never kicked ([exited], the
// #248 user-visible crash), and it runs the pane-attribution detached-claude
// reap first (breaking the orphan->409->freeze doom-loop the env-grep reap on
// the launchctl/channels.sh path never cleaned). A CPU-profile guard skips the
// recovery unless the process matches the idle stdio-wedge profile.
//
// Critical guard (Marveen 2026-06-02 review): a legitimate long-running
// tool-call (slow Anthropic inference, multi-stage research agent) MUST
// NOT trigger this. Two layers of false-positive protection:
//   1. seconds >= freezeSeconds (180s default) -- below that, just record.
//   2. The counter must be STAGNANT for stagnantPolls (2 default) consecutive
//      polls. A real tool-call increments the seconds every TUI redraw
//      (~once per second). A non-incrementing counter across two 30s poll
//      intervals (60s wall clock at least) is the wedge signature.
// A real wedge satisfies BOTH. A real slow-but-progressing tool-call fails
// the second (counter keeps incrementing) so we never act.
//
// Scope, main session: detect AND recover (respawn-pane), as above. One
// waiting shape is alert-only on the main session too: a held peer message
// (see checkMainHeldPeer below).
//
// Scope, sub-agents (SUBWAIT925, card c3f8f062): detect and ALERT only, never
// recover, never a keystroke. The case materialised on 2026-09-23: a sub-agent
// in a strict permission profile sat on an approval dialog (a held cross-session
// message) for hours, and nothing told the owner -- this watcher was main-only,
// the channel-monitor's menu pass only walks channel-owning agents and does not
// recognise that dialog, and the router's session-stuck alert needs QUEUED
// inter-agent messages, which a cross-session send never leaves behind. Every
// running sub-agent is now swept for two WAITING shapes:
//   - a held peer message: on every sub-agent;
//   - a tool-permission prompt: only on sub-agents WITHOUT a channel. For a
//     channel-owning agent the channel-monitor's menu pass already alerts the
//     owner on that prompt (45 s confirm, 5 min dedup), so alerting here too
//     sent two messages for one prompt (#1596 review, point 1).
// A second signal for the tool-permission wait (STATEOBS1012): the
// agent-state-observer file (<store>/mod-state/<agent>.json). The mod writes
// awaiting_approval when a dialog opens, including the one a hook's `ask` opens
// with no PermissionRequest, whose card the pane matcher may not know. It can
// only ADD a 'permission' wait the pane did not show, and the one-owner rule
// above applies to it unchanged.
// A waiting prompt is a QUESTION, not a wedge: the alert says who is waiting
// and what it asks, and never sends a keystroke (Escape would answer "no").
// A stagnant tool-call counter on a sub-agent is deliberately NOT watched here:
// without the main path's transcript-freshness and CPU guards it reads a
// residual "Worked for Ns" summary above a working turn as a wedge (#1596
// review, point 2). That half follows separately, with a per-agent
// transcript-mtime guard.

import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { tmuxStderr } from './tmux-stderr.js'
import { resolveFromPath } from '../platform.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR, BOT_NAME, MAIN_AGENT_ID } from '../config.js'
import { capturePane, isAgentRunning, agentSessionName, agentHasChannel } from './agent-process.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { readTranscriptMtimeAcrossConfigDirs } from './active-model.js'
import { STATE_OBSERVER_STATE_DIR } from './state-observer.js'
import { mainConfigRoots } from './inbound-probe.js'
import { MAIN_CHANNELS_SESSION, withoutMainAgent } from './main-agent.js'
import { resumeMarveenSession, sendAlert, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS } from './channel-monitor.js'
import { sendRoutineAlert } from './routine-alert.js'
import {
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  detectPaneState,
  parkedChannelInput,
  parkedMachineOriginInput,
  detectsPermissionDialog,
  detectsHeldPeerMessage,
  permissionPromptSummary,
  decidePaneErrorAlert,
  type StuckToolCallState,
  type StuckToolCallThresholds,
  type PaneErrorAlertState,
  type PaneErrorAlertThresholds,
  type PermissionPromptSummary,
} from '../pane-state.js'
import { exactTmuxTarget } from '../tmux-target.js'
import { whileNotFrozen } from './fleet-freeze.js'

const TMUX = resolveFromPath('tmux')

// CPU-profile guard (#248): the genuine wedge is a render loop blocked on stdio
// -- CPU collapses to ~0.3% (IO-wait). A frozen "Worked for Ns" counter on a
// process that is STILL BURNING CPU is not that wedge: it is a session doing
// heavy synchronous work that just hasn't yielded to a TUI redraw. Only recover
// when the process matches the idle wedge profile (CPU <= maxCpuPercent).
// Fail-open: a null sample (ps failed) does NOT block recovery -- the
// counter-stagnation signal stands on its own.
const WEDGE_MAX_CPU_PERCENT = 30

// Pure: does the sampled CPU% match the idle stdio-wedge profile? null (sample
// failed) -> true (fail-open; do not block recovery on a missing sample).
export function confirmsWedgeProfile(cpuPercent: number | null, maxCpuPercent: number): boolean {
  if (cpuPercent === null) return true
  return cpuPercent <= maxCpuPercent
}

// STUCKFREEZE819: last-instant verdict-validity gate, at KILL EXECUTION time
// (deliberately NOT folded into the verdict formation -- that would rebuild
// the same gap smaller). Both false kills measured on 2026-08-19 hit a LIVE
// session with a STALE verdict: stagnation accrued during a parked/idle
// stretch, and by the time the kill executed (~2 minutes after the verdict's
// inputs), the session had woken and was working -- the 20:23:19 kill landed
// ONE second after a healthy tool_result, mid-turn (79s of healthy work); the
// 14:08:59 kill landed 9 seconds after an inbox-wakeup injection. The
// cheapest live-signal is the session transcript's mtime: a working session
// appends constantly (measured ages at the two false kills: ~2s and ~9s),
// while a genuinely wedged TUI writes nothing -- by construction its
// transcript is at least freezeSeconds (180s) old when the verdict fires.
//
// Threshold derivation (not a round guess): must sit ABOVE the largest
// measured false-kill age (9s, with margin) and WELL BELOW the 180s
// stagnation floor of a real wedge. 30s = 3x the measured maximum and 6x
// under the floor; any value in (9s, 180s) discriminates the two measured
// populations.
//
// Known limit, stated not hidden: the mtime is DIRECTORY-level (newest jsonl
// under the main session's project dir), so another session writing into the
// same project dir (same cwd) masks a real wedge. Since STUCKATTEMPTS1018 the
// kill also needs NO write since the freeze (transcriptWrittenSinceStagnation),
// so the mask lasts for as long as the other writer writes at all during the
// spell, not for one sweep: one write after stagnantSince holds the recovery
// until the counter moves or the spell ends. Measured on this host
// (2026-10-11..18, Samu's #2051 review): the main project dir held 10 jsonl
// files that replace each other, and of 938 five-minute windows with writes
// only 5 had two writers, all of them session hand-overs -- so no overlap here.
// An install that runs a second claude session in the same project dir has it.
export const STALE_VERDICT_FRESH_MS = 30_000

// STUCKALLCLEAR923 (owner request, 2026-09-23). The failed-recovery branch
// below sends "kezi beavatkozas kellhet" and then NOTHING, ever -- there is no
// path in this file, or any other, that tells the owner the session came back.
// Measured that day: the alert went out at 17:28:07, the session was usable
// again at 17:28:23 (the service manager relaunched channels.sh, 16 seconds
// later), and no message ever said so. The owner's answer was to stop reading
// the alerts, which is the correct response to an alert that never resolves
// and exactly what CLAUDE.md's message rules warn about: an unclosed warning
// is not information, it is background noise that teaches the reader to skip
// the next one. So the alert now gets a closing line.
//
// Two sweeps, not one: the pane can read 'idle' in the gap between a failed
// respawn and the relaunch, and a single sample there would announce a
// recovery that did not happen yet. Two consecutive sweeps mean the session
// held for a full INTERVAL_MS.
export const ALL_CLEAR_HEALTHY_SWEEPS = 2

// Pure: is the session usable again, in the sense the failure alert used
// ("tmux attach ... kezi beavatkozas")? A live idle prompt is exactly that.
// NOTE the deliberate asymmetry: everywhere else in this file a null pane
// fails OPEN (a capture failure must not block a recovery). Here it must fail
// CLOSED -- capture-pane returns null when the session does not exist, and
// claiming an all-clear off a missing session would be the one lie this whole
// change exists to prevent.
export function paneLooksRecovered(pane: string | null): boolean {
  return pane != null && detectPaneState(pane) === 'idle'
}

// Pure: close out the pending alert?
export function shouldSendAllClear(
  pendingSince: number | null,
  healthyStreak: number,
  needed = ALL_CLEAR_HEALTHY_SWEEPS,
): boolean {
  return pendingSince !== null && healthyStreak >= needed
}

// Pure: ONE sweep of the all-clear logic. `pending` is the persisted stamp, `pane` this sweep's capture,
// `streak` the healthy sweeps seen so far. Returns the streak to keep and whether to send the all-clear.
// Extracted from checkSession so the two things the reviewer found unpinned (the unhealthy-sweep reset
// and the send itself) are a function with a test, not an inline expression nothing noticed removing.
export function allClearStep(
  pending: number | null,
  pane: string | null,
  streak: number,
  needed = ALL_CLEAR_HEALTHY_SWEEPS,
): { streak: number; send: boolean } {
  if (pending === null) return { streak: 0, send: false }
  const next = paneLooksRecovered(pane) ? streak + 1 : 0
  if (shouldSendAllClear(pending, next, needed)) return { streak: 0, send: true }
  return { streak: next, send: false }
}

// The pending-alert stamp is PERSISTED, not just held in memory, and that is
// the point rather than an optimisation: the alert is sent by the dashboard
// process, and if that process restarts between the alert and the recovery
// (auto-update, crash, manual restart) an in-memory flag would drop the
// follow-up silently -- the same hole one level up.
const ALERT_STATE_PATH = join(STORE_DIR, 'stuck-alert-state.json')

export function readPendingFailureAlert(): number | null {
  try {
    const raw = JSON.parse(readFileSync(ALERT_STATE_PATH, 'utf-8')) as { pendingSince?: unknown }
    const v = raw?.pendingSince
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

function writePendingFailureAlert(pendingSince: number | null): void {
  try {
    writeFileSync(ALERT_STATE_PATH, JSON.stringify({ pendingSince }), 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'stuck-tool-call-watcher: could not persist the pending-alert stamp')
  }
}

// Consecutive healthy sweeps seen while an alert is outstanding. In memory on
// purpose: losing it on a dashboard restart only delays the all-clear by one
// sweep, while losing the PERSISTED stamp above would lose it entirely.
let healthyStreak = 0

// The transcript mtime the kill-boundary gate reads. A function with its own default arguments so that
// "the gate reads EVERY candidate root" (STUCKROOT923) is something a test can pin: reverting the gate to a
// single root (`[mainConfigRoots()[0]]`) used to pass the whole suite. Newest wins across the roots.
export function killGateTranscriptMtime(
  workingDir: string = PROJECT_ROOT,
  roots: ReadonlyArray<string | undefined> = mainConfigRoots(),
): number | null {
  return readTranscriptMtimeAcrossConfigDirs(workingDir, roots)
}

// Pure: is the recovery verdict stale because the session's transcript shows
// recent activity? null mtime (dir unreadable) -> false: fail-open, the
// stagnation signal stands on its own, same rule as the CPU guard.
export function verdictStaleByTranscript(
  transcriptMtimeMs: number | null,
  nowMs: number,
  freshMs = STALE_VERDICT_FRESH_MS,
): boolean {
  if (transcriptMtimeMs === null) return false
  return nowMs - transcriptMtimeMs < freshMs
}

// STUCKATTEMPTS1018: has the transcript been written at all since the counter froze? A wedged TUI
// writes nothing from the moment it freezes, so a write at or after stagnantSince means the session
// was alive during the stagnation, however long ago that write was. This is the gate that holds a
// LIVE session once a deferred verdict re-fires every poll: the 30 s snapshot alone does not.
// Measured on this host (2026-10-12..17, the 9 STUCKFREEZE819 aborts in store/dashboard.log against
// the main transcript's record timestamps): after every abort a poll with a 30-56 s old write came
// within 1-3.5 minutes, and a 180-210 s silence within 3.5-18.5 minutes, each followed by more
// writes. Neither a 30 s nor a 180 s window tells that live session from a wedge; "written since
// the freeze" does. Stated limit: a wedge that begins AFTER a write inside the same frozen spell is
// not recovered by this watcher (as before STUCKATTEMPTS1018, when the first abort held the spell).
// null mtime or no stagnation recorded -> false (fail-open, as verdictStaleByTranscript).
export function transcriptWrittenSinceStagnation(transcriptMtimeMs: number | null, stagnantSince: number | null): boolean {
  return transcriptMtimeMs !== null && stagnantSince !== null && transcriptMtimeMs >= stagnantSince
}

// Recent CPU% of the main session's pane-leader claude (claudePid == panePid for
// the main channels session). null on any failure (fail-open). `ps -o %cpu=` is
// a recent decaying average on macOS/Linux -- enough to tell a 0.3% IO-wait
// wedge from a process actively burning CPU.
function sampleMainClaudeCpuPercent(session: string): number | null {
  try {
    // TMUXWINDOWATTR920: stderr piped; a failure is logged with the site below.
    const panePid = execFileSync(TMUX, ['list-panes', '-t', exactTmuxTarget(session), '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')[0]?.trim()
    if (!panePid || !/^\d+$/.test(panePid)) return null
    const out = execFileSync('/bin/ps', ['-o', '%cpu=', '-p', panePid], { timeout: 3000, encoding: 'utf-8' }).trim()
    const cpu = parseFloat(out)
    return Number.isFinite(cpu) ? cpu : null
  } catch (err) {
    logger.warn({ site: 'stuck-tool-call-watcher.sampleMainClaudeCpuPercent', session, tmux: tmuxStderr(err) }, 'tmux list-panes / ps failed')
    return null
  }
}

// STUCKCHILD1016: a long FOREGROUND tool call is not a wedge. The CPU guard above looks at the
// pane-leader claude ONLY. While a Bash/python child runs for minutes the TUI counter freezes and
// claude itself idles at ~1-2% CPU, i.e. it matches the wedge profile exactly. Measured on a
// production install: tag=baked seconds=20 stagnantPolls=7 cpuPercent=1.8 -> respawn-pane, while a
// python harness was working. The genuine wedge (a hung MCP/stdio reply) has NO tool child doing
// work. So before recovery, look at the pane-leader's descendants: a non-shell descendant that is
// running, or that burned CPU during the last polls, means a tool call is alive -> not a wedge.
//
// Which children count: only processes UNDER a shell child of the pane leader. The Bash tool runs
// every command as `<shell> -c ...` directly under claude, so a tool call's work is always in a
// shell's subtree. The leader's other direct children (an MCP/channel plugin, caffeinate, node MCP
// servers) stay alive -- and sometimes busy -- in a REAL wedge and must not mask it. Residual risk:
// an MCP server that is itself launched through a shell would count; the hard cap bounds that.
//
// Hard cap: the deferral is never endless. Once the counter has been stagnant for
// MAX_CHILD_DEFER_MS, recovery proceeds regardless of child activity (the old path, still behind
// the STUCKFREEZE819 transcript gate). 15 min is well above a normal long foreground tool call
// (test suites, builds: 5-10 min) and short enough that a frozen TUI whose "tool child" never ends
// is restored within a quarter of an hour.
//
// Fail-open for recovery: a failed sample (tmux/ps error, unusable pane pid) NEVER refreshes the
// last-activity stamp (a broken poll cannot keep a deferral alive) and zeroes the CPU baseline (a CPU
// jump across the gap is not read as fresh activity). A persistent failure lets the activity window,
// and in the end the hard cap, run out.
//
// Stated limit: a tool child that only sleeps (no CPU, state S, e.g. a bare `sleep 600`) is not
// detected as active.
export interface ProcSample { pid: number; ppid: number; state: string; cpuMs: number; comm: string }

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'])
export const CHILD_ACTIVE_CPU_DELTA_MS = 1000
export const CHILD_ACTIVITY_WINDOW_MS = 90_000
export const MAX_CHILD_DEFER_MS = 15 * 60_000

// Pure: has the stagnation lasted so long that child activity may no longer defer recovery?
// stagnantSince null (no stagnation recorded) -> false.
export function childDeferExpired(stagnantSince: number | null, nowMs: number, maxMs = MAX_CHILD_DEFER_MS): boolean {
  return stagnantSince !== null && nowMs - stagnantSince >= maxMs
}

// Pure: `ps cputime` -> ms. Formats: [[dd-]hh:]mm:ss[.ff] (macOS mm:ss.ff, Linux hh:mm:ss).
export function parsePsCpuTimeMs(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!m) return null
  const [, d, h, mi, s] = m
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s)) * 1000
}

// Pure: parse `ps -axww -o pid=,ppid=,stat=,cputime=,comm=` (comm last: it may hold spaces).
export function parseProcSnapshot(out: string): ProcSample[] {
  const rows: ProcSample[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/)
    if (!m) continue
    const cpuMs = parsePsCpuTimeMs(m[4]!)
    if (cpuMs === null) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), state: m[3]!, cpuMs, comm: m[5]! })
  }
  return rows
}

function commBase(comm: string): string {
  return comm.split('/').pop()!.replace(/^-/, '').trim()
}

function isShellComm(comm: string): boolean {
  return SHELL_NAMES.has(commBase(comm))
}

// Pure: the process the tool-call subtree hangs under. Normally the pane pid IS the claude process.
// If a session's pane pid is a shell or a wrapper script, the claude process is its non-shell child
// (preferring one named `claude`, else the single non-shell child); with none identifiable the
// result is null (the guard cannot scope the subtree and stays inactive -- the caller warns once).
export function resolveToolRoot(procs: ProcSample[], panePid: number): { root: number | null; viaShell: boolean } {
  const self = procs.find(p => p.pid === panePid)
  if (!self) return { root: null, viaShell: false }
  if (!isShellComm(self.comm)) return { root: panePid, viaShell: false }
  const kids = procs.filter(p => p.ppid === panePid && !isShellComm(p.comm))
  const claude = kids.find(k => commBase(k.comm) === 'claude') ?? (kids.length === 1 ? kids[0] : undefined)
  return { root: claude ? claude.pid : null, viaShell: true }
}

// Pure: non-shell processes in the subtrees of the SHELL children of rootPid (root, its non-shell
// direct children and their subtrees excluded).
export function toolDescendants(procs: ProcSample[], rootPid: number): ProcSample[] {
  const kids = new Map<number, ProcSample[]>()
  for (const p of procs) {
    const l = kids.get(p.ppid) ?? []
    l.push(p)
    kids.set(p.ppid, l)
  }
  const out: ProcSample[] = []
  const seen = new Set<number>([rootPid])
  const stack: number[] = []
  for (const c of kids.get(rootPid) ?? []) {
    if (isShellComm(c.comm)) { seen.add(c.pid); stack.push(c.pid) }
  }
  while (stack.length) {
    for (const c of kids.get(stack.pop()!) ?? []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      stack.push(c.pid)
      if (!isShellComm(c.comm)) out.push(c)
    }
  }
  return out
}

export interface ChildActivity { cpuMs: Map<number, number> | null; lastActiveAt: number | null }

// Pure: fold one snapshot into the tracker. A descendant is ACTIVE when it is in the running state,
// or its cumulative CPU grew by >= CHILD_ACTIVE_CPU_DELTA_MS since the previous poll (a pid first
// seen after a baseline exists counts its whole CPU time: it was spawned within the last poll). The
// first poll of a spell has no baseline, so only the running state counts there.
export function observeToolChildren(
  prev: ChildActivity,
  procs: ProcSample[],
  rootPid: number,
  nowMs: number,
): ChildActivity {
  const kids = toolDescendants(procs, rootPid)
  const cpuMs = new Map<number, number>(kids.map(k => [k.pid, k.cpuMs]))
  const active = kids.some(k =>
    k.state.startsWith('R') ||
    (prev.cpuMs !== null && k.cpuMs - (prev.cpuMs.get(k.pid) ?? 0) >= CHILD_ACTIVE_CPU_DELTA_MS),
  )
  return { cpuMs, lastActiveAt: active ? nowMs : prev.lastActiveAt }
}

// Pure: is a tool call alive (activity seen within the window)?
export function toolChildRecentlyActive(a: ChildActivity | undefined, nowMs: number): boolean {
  return a?.lastActiveAt != null && nowMs - a.lastActiveAt < CHILD_ACTIVITY_WINDOW_MS
}

const toolChildState = new Map<string, ChildActivity>()
const shellLeaderWarned = new Set<string>()

// Snapshot the pane-leader's process tree and fold it into the session's tracker (see the fail-open
// note above: any failure keeps lastActiveAt and zeroes the baseline).
function sampleToolChildren(session: string, nowMs: number): void {
  const prev = toolChildState.get(session) ?? { cpuMs: null, lastActiveAt: null }
  try {
    const panePid = execFileSync(TMUX, ['list-panes', '-t', exactTmuxTarget(session), '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')[0]?.trim()
    if (!panePid || !/^\d+$/.test(panePid)) throw new Error('no pane pid')
    const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,stat=,cputime=,comm='], { timeout: 5000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
    const procs = parseProcSnapshot(out)
    const { root, viaShell } = resolveToolRoot(procs, Number(panePid))
    if (root === null) {
      if (!shellLeaderWarned.has(session)) {
        shellLeaderWarned.add(session)
        logger.warn({ session, panePid }, 'stuck-tool-call-watcher: the pane leader is a shell/wrapper with no identifiable claude child -- tool-child deferral is inactive for this session')
      }
      toolChildState.set(session, { cpuMs: null, lastActiveAt: prev.lastActiveAt })
      return
    }
    if (viaShell && !shellLeaderWarned.has(session)) {
      shellLeaderWarned.add(session)
      logger.info({ session, panePid, claudePid: root }, 'stuck-tool-call-watcher: the pane leader is a shell/wrapper -- tool children are scoped under its claude child')
    }
    toolChildState.set(session, observeToolChildren(prev, procs, root, nowMs))
  } catch (err) {
    logger.warn({ site: 'stuck-tool-call-watcher.sampleToolChildren', session, tmux: tmuxStderr(err) }, 'tmux list-panes / ps failed')
    toolChildState.set(session, { cpuMs: null, lastActiveAt: prev.lastActiveAt })
  }
}

// Defaults chosen against the 2026-06-02 incident profile.
//   - freezeSeconds = 180: long enough that a real slow Anthropic call
//     (multi-thousand-token thinking + tool result) doesn't trip it. The
//     observed wedge sat at 31s, but the seconds value when the freeze
//     actually started is irrelevant -- a wedged 31s sits at 31s forever
//     until we hit freezeSeconds when stagnation IS the signal.
//   - stagnantPolls = 2: with INTERVAL_MS=30s, two consecutive non-
//     incrementing polls means ~60s+ of wall clock without a single TUI
//     redraw advancing the counter. A healthy long-running tool-call
//     redraws every second.
// minPeakSeconds (2026-06-08 fix): the spell's highest observed counter value
// must reach >= this many seconds before recovery can fire. The 2026-06-08
// false-positive loop respawned the session 13 times in 8h on residual TUI
// footers (3-4s every poll, never advancing) left behind by a prior respawn.
// The real 2026-06-02 wedge had climbed to 31s before stalling. 20s sits
// comfortably between the residual band and the real wedge floor.
const THRESHOLDS: StuckToolCallThresholds = {
  freezeSeconds: 180,
  stagnantPolls: 2,
  minPeakSeconds: 20,
}

// Poll cadence. Offset 35s so the three pane-readers (channel-monitor 30s,
// channel-health 45s, stuck-input 15s+20s, this one) don't all hit
// capture-pane on the same tick.
const INITIAL_DELAY_MS = 35_000
const INTERVAL_MS = 30_000

const NO_STATE: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  spellPeakSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

// Session-keyed state map. Only the main session ever has an entry today,
// but the map shape leaves room for sub-agents without an API change.
const watchState = new Map<string, StuckToolCallState>()

// Pure: should a hard-restart be deferred because a respawn (any source --
// this watcher, channel-monitor's cascade, channel-watchdog.sh, or the #264
// stuck-modal-guard) happened within the post-respawn grace? lastRespawnMs is
// lastMainRespawnAt()'s epoch-ms (0 when none recorded).
export function shouldDeferForRecentRespawn(
  lastRespawnMs: number,
  nowMs: number,
  graceMs = MARVEEN_POST_RESPAWN_GRACE_MS,
): boolean {
  return lastRespawnMs > 0 && nowMs - lastRespawnMs < graceMs
}

// STUCKATTEMPTS1018: a guard that DEFERS a verdict (rather than ending the spell) must store the
// spell with attempts back at 0. decideStuckToolCallRecovery() already stored attempts=1 for this
// verdict, and with attempts >= 1 it answers "recovery already fired: hold" for the rest of the
// spell -- so a bare `return` turned every deferral into a permanent stand-down, and a real wedge
// behind it was never recovered. Measured before this fix: one CPU-busy verdict sample, then a
// frozen counter at 1.8% CPU for 30 minutes -> zero recoveries. With attempts reset, the same spell
// re-fires on the next poll and every guard is asked again.
function deferVerdict(session: string, next: StuckToolCallState): void {
  watchState.set(session, { ...next, attempts: 0 })
}

// A re-fired verdict meets the transcript gate on every poll for as long as a live session holds
// the spell. Log the abort at warn once per spell (keyed by stagnantSince), then at debug.
const transcriptAbortLogged = new Map<string, number | null>()
function logTranscriptAbort(session: string, stagnantSince: number | null, fields: Record<string, unknown>, msg: string): void {
  if (transcriptAbortLogged.get(session) === stagnantSince) {
    logger.debug(fields, msg)
    return
  }
  transcriptAbortLogged.set(session, stagnantSince)
  logger.warn(fields, msg)
}

async function checkSession(label: string, session: string): Promise<void> {
  const pane = capturePane(session)
  const sig = pane == null ? null : stuckToolCallSignature(pane)

  // STUCKALLCLEAR923: close out a failed-recovery alert once the session is
  // provably usable again. This runs BEFORE the wedge logic and independently
  // of it, because the recovery that saves us is usually NOT this watcher's:
  // on 2026-09-23 our respawn-pane failed outright ("can't find pane") and the
  // service manager brought the session back 16 seconds later. An all-clear
  // keyed to our OWN success would never have fired in the one case it was
  // asked for.
  const pendingAlert = readPendingFailureAlert()
  const clearStep = allClearStep(pendingAlert, pane, healthyStreak)
  healthyStreak = clearStep.streak
  if (pendingAlert !== null && clearStep.send) {
    const downMin = Math.max(1, Math.round((Date.now() - pendingAlert) / 60000))
    writePendingFailureAlert(null)
    logger.info({ label, session, downMin }, 'stuck-tool-call-watcher: failed-recovery alert closed out -- session healthy again')
    sendAlert(`✅ A fő session magától helyreállt, nincs teendőd. A ${downMin} perce küldött "kézi beavatkozás kellhet" riasztás ezzel le van zárva.`)
  }

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckToolCallRecovery(sig, prev, Date.now(), THRESHOLDS)

  if (next.tag === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
  }
  // STUCKCHILD1016: watch the pane-leader's tool children for as long as the counter is stagnant, so
  // the CPU baseline exists when the verdict fires.
  if (next.tag !== null && next.stagnantPolls >= 1) {
    sampleToolChildren(session, Date.now())
  } else {
    toolChildState.delete(session)
  }

  if (recover) {
    // Idle-prompt guard (2026-06-22 false-positive loop): the signature only
    // sees a frozen "<verb> for Ns" footer -- it cannot tell an ACTIVELY-wedged
    // tool-call (the 2026-06-02 incident) from the RESIDUAL footer a COMPLETED
    // turn leaves on screen while the session sits idle waiting for its next
    // heartbeat. Both read as a stagnant counter. The discriminator is the input
    // box: a genuine mid-turn wedge has no ready prompt (detectPaneState != idle,
    // the box is replaced by the busy/working indicator), whereas a completed
    // turn's residual sits ABOVE a live `❯` idle prompt. If the pane is idle, the
    // user can interact -- it is not the user-facing freeze this watcher targets
    // -- so respawning is pure churn (this is what drove ~150 spurious respawns/
    // week, each leaving a fresh residual footer that re-armed the loop). Clear
    // the stale spell so the residual stops re-triggering every poll. Fail-open:
    // a null pane (capture failed) does NOT block recovery.
    if (pane != null && detectPaneState(pane) === 'idle') {
      logger.info(
        { label, session, tag: next.tag, seconds: next.lastSeconds, spellPeakSeconds: next.spellPeakSeconds },
        'stuck-tool-call-watcher: counter stagnant but pane is at the idle prompt (residual footer of a completed turn, not a wedge) -- skipping recovery',
      )
      watchState.delete(session)
      return
    }
    // Parked-channel-input guard (2026-08-15, owner-observed false positive).
    // The idle-prompt guard above is the ONLY thing holding back a residual
    // footer -- and it stops holding the instant an inbound channel message is
    // injected into the prompt box, because detectPaneState then reads 'typing',
    // not 'idle'. Measured sequence that day: the counter had been frozen at 49s
    // since ~14:52 and was correctly skipped as residual at 14:52, 14:56 and
    // 15:00; the owner's message landed at 15:03:06; at 15:04:05 the guard no
    // longer applied, CPU was still low (the turn had not started yet), and this
    // watcher respawned the pane -- taking the not-yet-processed message with it.
    // So the ARRIVAL of a message opened the gate on evidence that predated it.
    // A parked channel block is not wedge evidence: it means the session is
    // about to be driven, and that case belongs to stuck-input-watcher, which
    // has its own escalation (Enter -> clear+re-inject -> respawn). Clear the
    // stale spell so the residual cannot re-arm on the next poll.
    // STUCKSCHED831: the guard was CHANNEL-ONLY, and that is narrower than the
    // reason it exists. parkedChannelInput() matches `<channel source="plugin:`
    // and nothing else, so a parked SCHEDULED-TASK injection (heartbeat, audit,
    // dream-engine) slipped through every gate: the pane is no longer 'idle'
    // (so the idle-prompt guard above stops applying), it is not a channel
    // block (so this guard missed it), and CPU is still low because the turn
    // has not started yet. Measured on this install 2026-08-18: 14:11:08 the
    // idle-prompt guard correctly skipped, 14:15:08 the watcher respawned an
    // idle session, and the first input after the respawn came back TRUNCATED
    // and fused with the next command -- the same damage shape as the
    // 2026-08-15 channel-message case this guard was written for.
    // The discriminator was never "is it a channel message" but "is something
    // machine-injected parked in the box", i.e. the session is about to be
    // driven. parkedMachineOriginInput() is exactly that predicate and is a
    // strict superset (its prefix list includes the channel regex), so the
    // 2026-08-15 behaviour is preserved.
    if (pane != null && (parkedChannelInput(pane) != null || parkedMachineOriginInput(pane))) {
      logger.info(
        { label, session, tag: next.tag, seconds: next.lastSeconds, spellPeakSeconds: next.spellPeakSeconds },
        'stuck-tool-call-watcher: counter stagnant but machine-injected input is parked in the prompt (stuck-input-watcher owns this) -- skipping recovery',
      )
      watchState.delete(session)
      return
    }
    // Post-respawn grace: defer if a respawn (this watcher, channel-monitor's
    // cascade, channel-watchdog.sh, or the #264 stuck-modal-guard on Linux)
    // happened within the grace window. Two reasons: (1) a freshly respawned
    // session's TUI counter can read as a fresh "spell" while it is still
    // booting -- re-restarting it would churn; (2) it symmetrizes coordination
    // with every other respawner via the shared lastMainRespawnAt() stamp, so a
    // recent external respawn can't be double-acted here (bounded the worst
    // case to a single overlap; this closes it). A genuine re-wedge is still
    // caught: the stagnation detection (freeze threshold + 2 stagnant polls)
    // restarts the clock, so it fires again once the grace has elapsed.
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, Date.now())) {
      logger.info(
        { label, session, sinceRespawnMs: lastRespawn ? Date.now() - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'stuck-tool-call-watcher: recent respawn within grace, deferring recovery (avoid double-respawn / boot churn)',
      )
      deferVerdict(session, next)
      return
    }
    // CPU-profile guard (#248): the genuine wedge is a render loop blocked on
    // stdio (CPU ~0.3%, IO-wait). A counter that froze while the claude is still
    // burning CPU is heavy synchronous work / render starvation, not the wedge
    // -- respawning it is churn. Skip unless the process matches the idle
    // profile. Fail-open on a null sample.
    const cpuPercent = sampleMainClaudeCpuPercent(session)
    if (!confirmsWedgeProfile(cpuPercent, WEDGE_MAX_CPU_PERCENT)) {
      logger.info(
        { label, session, cpuPercent, maxCpuPercent: WEDGE_MAX_CPU_PERCENT, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: counter stagnant but claude is CPU-active (not the idle wedge profile) -- deferring recovery',
      )
      deferVerdict(session, next)
      return
    }
    // STUCKCHILD1016: a live tool child (running, or CPU burned within the last polls) means a long
    // foreground tool call, not the stdio wedge -- the pane leader's own ~2% CPU says nothing about it.
    // Bounded by MAX_CHILD_DEFER_MS from the start of the stagnation. The deferral resets `attempts`:
    // the state stored above already counts this verdict, so without the reset the first deferral would
    // hold the spell for good and a real wedge arriving after the tool call ended would never recover.
    if (toolChildRecentlyActive(toolChildState.get(session), Date.now())) {
      if (!childDeferExpired(next.stagnantSince, Date.now())) {
        logger.info(
          { label, session, cpuPercent, seconds: next.lastSeconds, stagnantPolls: next.stagnantPolls },
          'stuck-tool-call-watcher: counter stagnant but a tool child process is active (long foreground tool call, not a wedge) -- deferring recovery',
        )
        deferVerdict(session, next)
        return
      }
      logger.warn(
        { label, session, stagnantMs: Date.now() - (next.stagnantSince ?? Date.now()), maxChildDeferMs: MAX_CHILD_DEFER_MS, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: tool child still active but the counter has been frozen past the hard cap -- proceeding with recovery',
      )
    }
    // STUCKFREEZE819: last-instant validity re-check at the kill boundary.
    // Every earlier guard sampled state at VERDICT time; this one samples at
    // EXECUTION time, because the two are ~2 minutes apart and both measured
    // false kills happened exactly in that gap (the session woke up between
    // verdict and kill). Abort keeps the spell and resets attempts (deferVerdict), so the verdict is
    // asked again on the next poll; the written-since-the-freeze gate below keeps a live session safe
    // on those later polls (STUCKATTEMPTS1018).
    // STUCKROOT923 (measured 2026-09-23, this guard's FOURTH sibling after
    // SCHEDLOST914 / TOKENVAK915 / GATEVAK917): reading ONE config root made
    // this gate dead code on an install where the two roots DIVERGE. There the
    // main session runs under CLAUDE_CONFIG_DIR=<PROJECT_ROOT>/.channels-config
    // and its `projects` directory is its own, so its transcript is NOT under
    // ~/.claude -- but the old directory still exists and still parses, so the
    // bad read returned a STALE NUMBER (newest jsonl frozen at 2026-09-13
    // 07:27), never a null. Where `.channels-config/projects` is a symlink to
    // `~/.claude/projects` (the reviewing host's setup) both roots resolve to
    // the same files and the old single-root read was correct; this fix only
    // matters on the diverging installs, as main-transcript-root.ts already says. A stale number never looks fresh, so
    // verdictStaleByTranscript could not fire even once in ten days, and on
    // 2026-09-23 17:28 this watcher killed a session whose transcript was being
    // written in that same second. Take the candidate list from the shared
    // mainConfigRoots() and let newest-wins decide; never write a second list.
    const transcriptMtime = killGateTranscriptMtime()
    if (verdictStaleByTranscript(transcriptMtime, Date.now())) {
      logTranscriptAbort(
        session, next.stagnantSince,
        { label, session, transcriptAgeMs: transcriptMtime ? Date.now() - transcriptMtime : null, freshMs: STALE_VERDICT_FRESH_MS, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: verdict stale -- the session transcript was written moments ago, the session is alive; ABORTING recovery (STUCKFREEZE819)',
      )
      deferVerdict(session, next)
      return
    }
    if (transcriptWrittenSinceStagnation(transcriptMtime, next.stagnantSince)) {
      logTranscriptAbort(
        session, next.stagnantSince,
        { label, session, transcriptAgeMs: transcriptMtime ? Date.now() - transcriptMtime : null, stagnantMs: next.stagnantSince ? Date.now() - next.stagnantSince : null, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: the session transcript was written after the counter froze, the session is alive; ABORTING recovery (STUCKATTEMPTS1018)',
      )
      deferVerdict(session, next)
      return
    }
    // Audit log requested by Marveen 2026-06-02: every respawn this watcher
    // decides on must record the input that led to it, so a regression
    // (spurious respawn during legitimate long work) is easy to spot.
    logger.warn(
      {
        label,
        session,
        tag: next.tag,
        seconds: next.lastSeconds,
        spellPeakSeconds: next.spellPeakSeconds,
        stagnantPolls: next.stagnantPolls,
        cpuPercent,
        thresholds: THRESHOLDS,
      },
      'stuck-tool-call-watcher: TUI counter stagnant past freeze threshold + idle wedge profile -- recovering main channels session (respawn-pane, no client-kick)',
    )
    // Recover via the respawn-pane path (resumeMarveenSession), NOT the launchctl
    // hard-restart. respawn-pane -k replaces only the pane's claude process: no
    // `tmux kill-session`, so an attached client is never kicked ([exited], the
    // #248 user-visible crash). resumeMarveenSession also runs the
    // pane-attribution detached-claude reap FIRST, breaking the
    // orphan->409->freeze doom-loop that the launchctl/channels.sh env-grep reap
    // never cleaned (the loop's launchctl path never reaped the main orphans).
    const ok = await resumeMarveenSession()
    if (!ok) {
      logger.error({ label, session }, 'stuck-tool-call-watcher: respawn-pane recovery failed')
    }
    // Owner transparency (2026-07-30, "reggeli leallas"): every wedge recovery
    // used to be silent, so the owner discovered a dead morning session only by
    // messaging into the void and then spent the morning pasting logs. One
    // proactive report replaces that whole loop. Sent on both outcomes -- a
    // FAILED recovery is exactly when the owner must know.
    // A SUCCEEDED recovery is routine: throttled, so a session that keeps
    // wedging reports once with a count instead of once per wedge. A FAILED
    // recovery is never throttled -- that is exactly when the owner must know.
    if (ok) {
      // A számot ne úgy írjuk ki, mintha időtartam lenne: a lastSeconds a
      // KIJELZŐN BEFAGYOTT számláló értéke, a beavatkozás küszöbe viszont a
      // stagnálás wall-clock hossza (freezeSeconds). A korábbi szöveg ("49s óta
      // nem haladt") azt sugallta a tulajnak, hogy 49 másodperc után
      // újraindítunk -- 2026-08-15-én pontosan ezt kérdezte vissza.
      sendRoutineAlert(
        `main-stuck-tool-call:${session}`,
        `🔧 A fő session beragadt: a kijelző számlálója ${Math.round(next.lastSeconds ?? 0)}s-nál megállt, és több mint ${THRESHOLDS.freezeSeconds}s-ig nem mozdult. Automatikusan újraindítottam a beszélgetés megtartásával. Ha volt megválaszolatlan üzeneted, mindjárt válaszolok rá.`,
      )
    } else {
      // STUCKALLCLEAR923: remember the unresolved alert so the sweep above can
      // close it out. Only the FIRST failure in an outage is stamped: a second
      // one must not push the timestamp forward, or the all-clear would report
      // a shorter outage than the owner actually lived through.
      if (readPendingFailureAlert() === null) writePendingFailureAlert(Date.now())
      sendAlert(`🚨 A fő session beragadt, és az automatikus újraindítás NEM sikerült. Kézi beavatkozás kellhet: tmux attach -t ${session}, vagy scripts/stop.sh && scripts/start.sh a marveen mappából.`)
    }
  }
}

// ---- sub-agents: alert-only (SUBWAIT925, card c3f8f062) ---------------------

export type AgentWaitKind = 'permission' | 'peer-message'

// Pure: which waiting shape, if any, the pane shows. The tool-permission card
// is checked first because it is the more specific shape (question + Yes/No);
// the held-peer-message dialog is the 2026-09-23 incident shape.
export function classifyAgentWait(pane: string | null): AgentWaitKind | null {
  if (pane == null) return null
  if (detectsPermissionDialog(pane)) return 'permission'
  if (detectsHeldPeerMessage(pane)) return 'peer-message'
  return null
}

// A prompt answered within a few minutes is the strict profile's normal
// rhythm, not an incident; the confirm window keeps those quiet. A prompt
// still open after it is exactly what the owner asked to hear about. The
// dedup window re-reports a prompt that is STILL open (with the routine-alert
// count), and the clear window rides out a flapping capture.
export const AGENT_WAIT_THRESHOLDS: PaneErrorAlertThresholds = {
  confirmMs: 3 * 60 * 1000,
  dedupMs: 30 * 60 * 1000,
  clearMs: 2 * 60 * 1000,
}

export function formatAgentWaitAlert(
  agent: string,
  session: string,
  kind: AgentWaitKind,
  waitingMs: number,
  ask: PermissionPromptSummary | null,
): string {
  const min = Math.max(1, Math.round(waitingMs / 60000))
  if (kind === 'peer-message') {
    return `⏸️ A(z) ${agent} ágens ${min} perce egy másik sessionből érkezett üzenet jóváhagyására vár. Nem hiba: a session él, csak egy igen/nem kérdés áll a bemenet előtt, és azt csak ember válaszolhatja meg. Nem nyomtam meg semmit (az Escape ott elutasítást jelentene). Döntsd el: tmux attach -t ${session}`
  }
  const what = ask ? ` Amit kér: ${ask.title}: ${ask.reason}.` : ''
  return `⏸️ A(z) ${agent} ágens ${min} perce egy tool-engedélykérésre vár.${what} Nem hiba: a session él, egy igen/nem kérdés áll a bemenet előtt, és azt csak ember válaszolhatja meg. Nem nyomtam meg semmit (az Escape ott NEM-et jelentene). Döntsd el: tmux attach -t ${session}`
}

// ---- the agent-state-observer file as a second signal (STATEOBS1012) --------

export interface AgentStateReading {
  state: string
  /** The tool the open dialog asks about; null when absent or not a plain word. */
  tool: string | null
  /** Epoch ms the session last proved alive (the mod refreshes it every minute). */
  aliveAt: number
}

/** A state file older than this says nothing: its session is gone or frozen. */
export const AGENT_STATE_STALE_MS = 5 * 60 * 1000

// The state and the tool name reach an owner alert: only a plain word passes.
const PLAIN_WORD_RX = /^[A-Za-z0-9_.:-]{1,80}$/

// Pure: the fields this watcher reads, or null for anything that is not a
// well-formed state file.
export function parseAgentStateFile(text: string): AgentStateReading | null {
  let s: unknown
  try {
    s = JSON.parse(text)
  } catch {
    return null
  }
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  if (typeof o.state !== 'string' || !PLAIN_WORD_RX.test(o.state)) return null
  if (typeof o.alive_at !== 'number' || !Number.isFinite(o.alive_at)) return null
  const tool = typeof o.tool === 'string' && PLAIN_WORD_RX.test(o.tool) ? o.tool : null
  return { state: o.state, tool, aliveAt: o.alive_at }
}

// Pure: does the state file add a 'permission' wait? Only a fresh
// awaiting_approval does, and not over a busy pane: an APPROVED tool's own run
// still reads awaiting_approval (the mod's known limit) and shows the busy
// markers, which an open dialog hides (the captured permission cards read
// 'unknown', never 'busy'). Not over an idle pane either: a dialog replaces the
// input box, so an idle prompt cannot sit under one, and a reading kept past
// the dialog (a deny path ending without tool.call or turn.complete) must not
// alert over it every 30 minutes.
export function stateFileSaysWaiting(reading: AgentStateReading | null, pane: string | null, now: number): boolean {
  if (!reading || reading.state !== 'awaiting_approval') return false
  if (now - reading.aliveAt >= AGENT_STATE_STALE_MS) return false
  if (pane != null) {
    const paneState = detectPaneState(pane)
    if (paneState === 'busy' || paneState === 'idle') return false
  }
  return true
}

// The live reader: a local agent's file only (the mod never loads into a
// remote agent, so a local file under its name would be a stale leftover).
function readLocalAgentState(agent: string): AgentStateReading | null {
  if (!/^[a-z0-9_-]+$/i.test(agent) || readAgentRemoteHost(agent)) return null
  try {
    return parseAgentStateFile(readFileSync(join(STATE_OBSERVER_STATE_DIR, `${agent}.json`), 'utf-8'))
  } catch {
    return null
  }
}

export interface SubAgentSweepDeps {
  listAgents: () => string[]
  isRunning: (agent: string) => boolean
  /** The agent owns a channel: its permission prompts are the channel-monitor's to report. */
  hasChannel: (agent: string) => boolean
  capture: (agent: string, session: string) => string | null
  now: () => number
  alertWait: (agent: string, session: string, kind: AgentWaitKind, waitingMs: number, ask: PermissionPromptSummary | null) => void
  /** The agent's agent-state-observer reading (second signal); absent = pane only. */
  readState?: (agent: string) => AgentStateReading | null
  waitThresholds?: PaneErrorAlertThresholds
}

// Per-agent waiting-spell state.
const agentWaitState = new Map<string, PaneErrorAlertState>()

export function resetSubAgentWatchState(): void {
  agentWaitState.clear()
}

// One sweep over every running sub-agent. Pure apart from the injected deps,
// so the tests drive it with canned panes and a fake clock. Never throws for
// one agent's sake: a capture failure on one session must not skip the rest.
export function sweepSubAgents(deps: SubAgentSweepDeps): void {
  const waitThresholds = deps.waitThresholds ?? AGENT_WAIT_THRESHOLDS
  let agents: string[]
  try {
    agents = withoutMainAgent(deps.listAgents())
  } catch (err) {
    logger.debug({ err }, 'stuck-tool-call-watcher: sub-agent list failed')
    return
  }
  const seen = new Set<string>()
  for (const agent of agents) {
    try {
      if (!deps.isRunning(agent)) continue
      seen.add(agent)
      const session = agentSessionName(agent)
      const pane = deps.capture(agent, session)
      const now = deps.now()

      // Waiting on a person (permission prompt / held peer message). A
      // permission prompt on a channel-owning agent is the channel-monitor's
      // (one owner per state, #1596 review point 1).
      let kind = classifyAgentWait(pane)
      // The state file only adds a wait the pane did not show (STATEOBS1012).
      const reading = kind == null && deps.readState ? deps.readState(agent) : null
      if (kind == null && stateFileSaysWaiting(reading, pane, now)) kind = 'permission'
      if (kind === 'permission' && deps.hasChannel(agent)) kind = null
      const prevWait = agentWaitState.get(agent) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const wait = decidePaneErrorAlert(kind != null, prevWait, now, waitThresholds)
      if (wait.next.firstSeenAt === null) agentWaitState.delete(agent)
      else agentWaitState.set(agent, wait.next)
      if (wait.alert && kind != null) {
        // What it asks: the card on the pane, else the tool the state file names.
        const ask = kind !== 'permission'
          ? null
          : (pane != null ? permissionPromptSummary(pane) : null)
            ?? (reading ? { title: reading.tool ?? 'ismeretlen eszköz', reason: 'az állapotfigyelő szerint jóváhagyásra vár' } : null)
        logger.warn({ agent, session, kind, waitingMs: now - (wait.next.firstSeenAt ?? now) }, 'stuck-tool-call-watcher: sub-agent is waiting on a person (no keystrokes sent) -- alerting')
        deps.alertWait(agent, session, kind, now - (wait.next.firstSeenAt ?? now), ask)
      }
    } catch (err) {
      logger.debug({ err, agent }, 'stuck-tool-call-watcher: sub-agent check error')
    }
  }
  // Forget agents that stopped, so a restart begins with a clean spell.
  for (const key of [...agentWaitState.keys()]) {
    if (!seen.has(key)) agentWaitState.delete(key)
  }
}

const LIVE_SUB_AGENT_DEPS: SubAgentSweepDeps = {
  listAgents: listAgentNames,
  isRunning: isAgentRunning,
  hasChannel: agentHasChannel,
  capture: (agent, session) => capturePane(session, readAgentRemoteHost(agent)),
  now: () => Date.now(),
  alertWait: (agent, session, kind, waitingMs, ask) => {
    sendRoutineAlert(`agent-wait:${agent}`, formatAgentWaitAlert(agent, session, kind, waitingMs, ask))
  },
  readState: readLocalAgentState,
}

// ---- the main session's held peer message (#1596 follow-up) -----------------
//
// The channel-monitor's menu pass used to Escape a held peer message on the
// main session like any other modal. #1596 stopped that (Escape there may
// decline the message and tell the sender so), and the sweep above leaves the
// main agent out, so on the main session nothing reported the dialog any more
// (#1596 review: alert instead of Escape). The main session joins the
// alert-only rule for this one shape: the same thresholds and text as a
// sub-agent, never a keystroke. Its tool-permission prompt stays with the
// channel-monitor's escalation (card 68cb6715): one owner per state.

export interface MainHeldPeerDeps {
  capture: () => string | null
  now: () => number
  alertWait: (waitingMs: number) => void
  waitThresholds?: PaneErrorAlertThresholds
}

let mainHeldPeerState: PaneErrorAlertState | null = null

export function resetMainHeldPeerState(): void {
  mainHeldPeerState = null
}

export function checkMainHeldPeer(deps: MainHeldPeerDeps): void {
  const pane = deps.capture()
  const now = deps.now()
  const held = pane != null && detectsHeldPeerMessage(pane)
  const prev = mainHeldPeerState ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
  const wait = decidePaneErrorAlert(held, prev, now, deps.waitThresholds ?? AGENT_WAIT_THRESHOLDS)
  mainHeldPeerState = wait.next.firstSeenAt === null ? null : wait.next
  if (wait.alert && held) {
    const waitingMs = now - (wait.next.firstSeenAt ?? now)
    logger.warn({ session: MAIN_CHANNELS_SESSION, waitingMs }, 'stuck-tool-call-watcher: main session holds a peer message for approval (no keystrokes sent) -- alerting')
    deps.alertWait(waitingMs)
  }
}

const LIVE_MAIN_HELD_PEER_DEPS: MainHeldPeerDeps = {
  capture: () => capturePane(MAIN_CHANNELS_SESSION),
  now: () => Date.now(),
  alertWait: (waitingMs) => {
    sendRoutineAlert(`agent-wait:${MAIN_AGENT_ID}`, formatAgentWaitAlert(BOT_NAME, MAIN_CHANNELS_SESSION, 'peer-message', waitingMs, null))
  },
}

export function startStuckToolCallWatcher(): NodeJS.Timeout {
  async function sweep() {
    try {
      await checkSession('main', MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'stuck-tool-call-watcher: main session check error')
    }
    try {
      checkMainHeldPeer(LIVE_MAIN_HELD_PEER_DEPS)
    } catch (err) {
      logger.debug({ err }, 'stuck-tool-call-watcher: main session held-peer check error')
    }
    try {
      sweepSubAgents(LIVE_SUB_AGENT_DEPS)
    } catch (err) {
      logger.debug({ err }, 'stuck-tool-call-watcher: sub-agent sweep error')
    }
  }
  setTimeout(() => { void sweep() }, INITIAL_DELAY_MS)
  return setInterval(whileNotFrozen('stuck-tool-call', () => { void sweep() }), INTERVAL_MS)
}
