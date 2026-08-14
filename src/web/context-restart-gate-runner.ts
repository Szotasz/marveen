import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { makeLazyBinResolver } from '../platform.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { listAgentNames, readAgentClaudeConfigDir } from './agent-config.js'
import { agentSessionName, capturePane } from './agent-process.js'
import { detectPaneState } from '../pane-state.js'
import { detectsUsageLimit } from '../model-fallback.js'
import { readContextTokensFromProjectDir, projectsDirFor } from './active-model.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { withSessionSendLock } from './session-send-lock.js'
import { getHardGuardPhase } from './context-guard-runner.js'
import { readGateConfig, readGateRunState, writeGateRunState } from './context-restart-gate-store.js'
import {
  getDispatchedPendingStats,
  hasOpenInboundQuestion,
  createAgentMessage,
} from '../db.js'
import {
  decideGate,
  nextBlockClock,
  type GateInputs,
} from '../context-restart-gate.js'

// Fleet context-restart gate: proactively send /clear to an agent session
// before the context grows unwieldy, while holding the send lane and only
// when ALL gate conditions confirm no work is in flight.
//
// This complements the hard context-guard (context-guard-runner.ts), which
// acts at 90%/97% of the context window via hard process restarts. The soft
// gate acts much earlier (default 400k tokens) via /clear -- the SessionStart
// hooks (ledger-replay, taskstate-replay, daily-log-digest) then inject a rich
// context snapshot into the fresh session automatically.
//
// The runner starts 3 minutes after dashboard boot (offset from context-guard's
// 4.5 min so the two sweeps do not fire simultaneously) and then sweeps on each
// agent's configured retryIntervalMs.

const INITIAL_DELAY_MS = 3 * 60_000   // 3 min

// tmux path. The hardcoded `/usr/bin/tmux` fallback that used to live here does
// not exist on a Homebrew macOS install (tmux is /opt/homebrew/bin/tmux), so
// getPanePid() threw on EVERY sweep, returned null, and the child-process check
// went fail-closed at its very first line -- this gate could never open here.
// The rest of the codebase already resolves binaries from PATH; do the same.
const tmuxBin = makeLazyBinResolver('tmux')

// Child-process measurement constants.
//
// Two-tier filter to separate "infrastructure" (MCP servers, telegram plugin,
// gmail runner) from "work" (Task-tool subagents, background Bash):
//
//   CHILD_MIN_AGE_S     -- lower bound: skip children younger than this to
//                          ignore transient exec() calls (<1s typical).
//
//   INFRA_AGE_DELTA_S   -- absolute delta upper bound: if a child's age is
//                          within this many seconds of the claude process age,
//                          it started near session boot and is infrastructure.
//                          Measured on this host: MCP servers start 1-3 seconds
//                          after claude (ratio 0.9996-0.9999). 60s is a generous
//                          but ABSOLUTE cap -- unlike a ratio, it does NOT loosen
//                          as session length grows. A Task-tool subagent running
//                          for 90 min in a 2h session would have a delta >> 60s.
//
// A child is treated as "possibly work" only when:
//   age >= CHILD_MIN_AGE_S  AND  age < claudeAgeS - INFRA_AGE_DELTA_S
//
// On ps failure (null age): fail-closed → treat as work.
const CHILD_MIN_AGE_S    = 3
const INFRA_AGE_DELTA_S  = 60   // seconds; 60s >> measured 3s max MCP startup delta

/**
 * Pure: true if a child process with the given age (seconds) should be treated
 * as infrastructure (MCP server, plugin runner) rather than in-flight work.
 * Exported for tests.
 *
 * Infrastructure is detected by absolute age delta from the claude process:
 *   - age < CHILD_MIN_AGE_S                          → transient exec() → infra
 *   - age >= claudeAgeS - INFRA_AGE_DELTA_S          → started within 60s of claude → infra
 *   - otherwise                                      → spawned during session → possibly work
 *
 * Using absolute delta (not ratio) is intentional: a ratio loosens with session
 * length, so a 90-min subagent in a 2h session would be misclassified. An
 * absolute 60s cap is generous yet immune to session age.
 */
export function isInfrastructureChild(childAgeS: number, claudeAgeS: number): boolean {
  if (childAgeS < CHILD_MIN_AGE_S) return true
  if (childAgeS >= claudeAgeS - INFRA_AGE_DELTA_S) return true
  return false
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function workingDirFor(name: string): string {
  if (name === MAIN_AGENT_ID) return PROJECT_ROOT
  return join(PROJECT_ROOT, 'agents', name)
}

/**
 * Claude Code config root for an agent, or undefined for the host default.
 *
 * Transcripts live under <config-root>/projects/<encoded-working-dir>/, and an
 * agent launched with CLAUDE_CONFIG_DIR keeps them somewhere other than
 * ~/.claude. Reading without this looks in the default root, finds nothing, and
 * the gate's contextTokens comes back null -- which is a fail-closed BLOCK, so
 * the symptom is a gate that never opens and never says why.
 */
function configDirFor(name: string): string | undefined {
  return name === MAIN_AGENT_ID ? undefined : (readAgentClaudeConfigDir(name) ?? undefined)
}

function agentIdForLedger(name: string): string {
  // The main agent's ledger key is the MAIN_AGENT_ID (e.g. "bigme"), same as
  // returned by ledger_lib.agent_id_from_cwd for the project root.
  return name
}

// ---- Pane helpers -----------------------------------------------------------

function capturePaneOrNull(session: string): string | null {
  try { return capturePane(session) } catch { return null }
}

// ---- Child-process detection ------------------------------------------------
//
// Session shapes measured on this host (see review #938 rounds 1+2):
//
//   Direct shape (most sessions):
//     pane_pid comm=claude → the pane IS the claude process.
//     bigme-channels, agent-eddie/ford/slarti/trillian/zaphod all have this.
//
//   Wrapper shape (worker sessions):
//     pane_pid comm=BASH → the pane is a shell; claude is a child.
//     bigme-worker (pane=2797), bigme-worker-fast (pane=2888) both have this.
//     If we skip the comm check and assume pane_pid=claude, we look at BASH's
//     children instead of claude's -- in the wrapper shape, claude itself is a
//     child of BASH with age ≈ BASH age (ratio ≈ 1.0 → classified as infra) and
//     all real work children of claude are invisible. This is a false-allow.
//
// Solution: read comm of pane_pid first; if not 'claude', find the child whose
// comm IS 'claude'. That is the process whose children we inspect.
//
// Two-tier age filter separates infrastructure from work (see constants above):
//   - age < CHILD_MIN_AGE_S                  → transient exec(), skip
//   - age >= claude_age - INFRA_AGE_DELTA_S  → started near boot = infra, skip
//   - otherwise                              → spawned during session = possibly work
//
// On ps failure for any PID: fail-closed (return null → decideGate blocks).

function getPanePid(session: string): number | null {
  try {
    const raw = execFileSync(tmuxBin(), ['list-panes', '-t', session, '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf-8' })
    const pid = parseInt(raw.split('\n')[0]?.trim() ?? '', 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

// PORTABILITY: `ps --ppid` is GNU/procps-only. BSD ps (macOS) rejects it with
// "illegal option -- -", so this returned [] for every parent -- and an empty
// child list reads as "no work running". Enumerating the whole table and
// filtering on ppid works on both platforms.
function getChildPids(parentPid: number): number[] {
  try {
    const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='],
      { timeout: 5000, encoding: 'utf-8' })
    const kids: number[] = []
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      if (m && parseInt(m[2], 10) === parentPid) kids.push(parseInt(m[1], 10))
    }
    return kids
  } catch { return [] }
}

/**
 * Parse ps `etime` ([[dd-]hh:]mm:ss) into seconds. Exported for tests.
 */
export function parseEtimeSeconds(raw: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim())
  if (!m) return null
  const [, d, h, mi, s] = m
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s)
}

// PORTABILITY: `etimes` (whole seconds) is GNU-only; BSD ps answers "keyword
// not found" and exits non-zero, so EVERY age lookup returned null. Since a
// null age is fail-closed, that pinned this gate permanently shut on macOS --
// the context restart could never fire. `etime` exists on both platforms.
function getPidAgeSeconds(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'etime='],
      { timeout: 2000, encoding: 'utf-8' })
    return parseEtimeSeconds(out)
  } catch { return null }
}

// True if the pid is still alive. EPERM means it exists but belongs to someone
// else, which is still "alive" for our purposes.
function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

function getChildArgsStr(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='],
      { timeout: 2000, encoding: 'utf-8' })
    return out.trim() || null
  } catch { return null }
}

function getCommForPid(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='],
      { timeout: 2000, encoding: 'utf-8' })
    return out.trim() || null
  } catch { return null }
}

/**
 * Pure: given the pane process and its immediate children (comm already resolved),
 * returns the PID of the actual claude process in the tree.
 *
 * Direct shape (most sessions): pane comm=claude → pane IS claude.
 * Wrapper shape (worker sessions): pane comm=bash/BASH → claude is a child.
 * Returns null (fail-closed) if claude cannot be located in either position.
 *
 * Exported for tests.
 */
// PORTABILITY: `ps -o comm=` prints the bare command name on Linux but the FULL
// PATH on macOS ("/opt/homebrew/bin/claude"). Comparing the raw string against
// 'claude' therefore never matched here, findClaudePidInTree returned null, and
// a null result is fail-closed -- the third platform assumption in this chain
// that silently pinned the gate shut. Compare basenames instead.
export function commBasename(comm: string | null): string | null {
  if (comm === null) return null
  const trimmed = comm.trim()
  if (!trimmed) return null
  return trimmed.split('/').pop() || null
}

export function findClaudePidInTree(
  panePid: number,
  paneComm: string | null,
  children: ReadonlyArray<{ pid: number; comm: string | null }>,
): number | null {
  if (paneComm === null) return null
  if (commBasename(paneComm) === 'claude') return panePid
  for (const child of children) {
    if (commBasename(child.comm) === 'claude') return child.pid
  }
  return null
}

// ---- MCP process pattern helpers --------------------------------------------
//
// After a channel-mcp-reconnect.ts-triggered reconnect, the MCP server process
// restarts with a fresh (young) age. The age-based infra filter would classify
// it as possibly-work and block the gate for up to 2h. To avoid this, we also
// check whether a child process's args identify it as an MCP server by:
//
//   1. Matching known plugin cache paths (/plugins/cache/) -- all Claude Code
//      channel plugins run from the global plugin cache dir.
//
//   2. Matching package names extracted from the session's .mcp.json -- covers
//      npm/npx-started MCP servers (e.g. gmail-mcp-server@1.0.30).
//
// A process matching either criterion is infra even if young.
//
// Tokens like 'npx', 'npm', 'exec', 'bun', 'node' are skipped; only the
// package/script name that uniquely identifies the server is extracted.

const MCP_SKIP_ARGS = new Set([
  'npx', 'npm', 'exec', '-y', '--yes', 'bun', 'node', 'deno',
  'python3', 'python', 'ruby', 'uvx', 'run', 'start',
])

/**
 * Pure: extract identifying package names from an mcpServers config object.
 * Strips runtime launchers (npx, npm, bun, node...) and version suffixes.
 * Exported for tests.
 */
export function extractMcpPackageNames(mcpServers: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const v of Object.values(mcpServers) as Record<string, unknown>[]) {
    const allArgs = [
      typeof v['command'] === 'string' ? v['command'] : '',
      ...((Array.isArray(v['args']) ? v['args'] : []) as string[]),
    ]
    for (const raw of allArgs) {
      if (!raw || typeof raw !== 'string') continue
      if (raw.startsWith('-')) continue
      // Take basename (strip absolute path prefix) then version suffix
      const base = raw.split('/').at(-1)?.replace(/@.*$/, '') ?? ''
      if (base.length < 5 || MCP_SKIP_ARGS.has(base.toLowerCase())) continue
      names.push(base)
    }
  }
  return names
}

function getMcpJsonPatterns(workingDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(workingDir, '.mcp.json'), 'utf-8')) as Record<string, unknown>
    const servers = (raw['mcpServers'] ?? {}) as Record<string, unknown>
    return extractMcpPackageNames(servers)
  } catch { return [] }
}

// The .mcp.json pattern list only describes the CURRENT config; a live MCP
// server can outlive its config entry (edited or removed mid-session) or be
// launched from a config this runner never reads. Such a process matches no
// pattern, and because a reconnected server is younger than the age filter
// allows, it is classified as work FOREVER -- the age gap between it and the
// claude process never closes. That is how a sub-agent's gate sat shut on
// a stale @amitgurbani/mcp-server-woocommerce child (2026-08-12).
//
// So we also recognise MCP servers structurally, from the shape of the argv:
//
//   - a package/binary token containing 'mcp-server' or 'mcp_server', or an
//     '@scope/...mcp...' package name
//   - the npx package cache path (~/.npm/_npx/<hash>/...)
//
// The npx-cache rule is safe as a DIRECT child of claude: the Bash tool runs
// commands through a shell, so a user-run `npx` is a grandchild behind
// /bin/zsh, never a direct child. A direct npx-cache child was started by
// claude itself, which only does that for MCP servers.
const MCP_ARGV_SHAPE = /mcp[-_]server|@[\w.-]+\/[\w.-]*mcp[\w.-]*|\/_npx\//i

/**
 * Pure: true if a child process (identified by its full args string) is an
 * MCP server and should be treated as infrastructure regardless of age.
 *
 * Three criteria (any is sufficient):
 *   - args contains '/plugins/cache/' → channel plugin (telegram, slack, etc.)
 *   - args contains a package name from mcpPatterns → .mcp.json MCP server
 *   - args has the shape of an MCP server launch → config-independent fallback
 *
 * Exported for tests.
 */
export function isMcpProcess(childArgs: string, mcpPatterns: string[]): boolean {
  if (childArgs.includes('/plugins/cache/')) return true
  if (mcpPatterns.some(p => childArgs.includes(p))) return true
  return MCP_ARGV_SHAPE.test(childArgs)
}

// Environment helpers Claude Code spawns around its own work, never in-flight
// work themselves. `caffeinate -i -t 300` is re-spawned whenever the agent is
// active; counting it as a work child kept the gate blocked for the entire
// active period instead of only while real work ran.
const NON_WORK_HELPER_COMMANDS = ['caffeinate']

/**
 * Pure: true if the child's argv names a known environment helper rather than
 * agent work. Exported for tests.
 */
export function isNonWorkHelperProcess(childArgs: string): boolean {
  const first = childArgs.trim().split(/\s+/)[0] ?? ''
  return NON_WORK_HELPER_COMMANDS.includes(first.split('/').pop() ?? '')
}

/**
 * Returns true if the session's claude process has live children that look
 * like in-flight work (Task-tool subagents, background Bash), false if only
 * infrastructure children are found, null if the check cannot be completed
 * (fail-closed → decideGate blocks).
 */
function hasLiveChildProcesses(session: string, mcpPatterns: string[]): boolean | null {
  const panePid = getPanePid(session)
  if (panePid === null) return null

  // Locate the actual claude process -- may be the pane itself (direct shape)
  // or a child of the pane shell (wrapper shape, e.g. bigme-worker).
  const paneComm = getCommForPid(panePid)
  const panePidChildren = getChildPids(panePid)
  const claudePid = findClaudePidInTree(
    panePid,
    paneComm,
    panePidChildren.map(pid => ({ pid, comm: getCommForPid(pid) })),
  )
  if (claudePid === null) return null   // can't locate claude -- fail-closed

  const claudeAge = getPidAgeSeconds(claudePid)
  if (claudeAge === null) return null

  // Inspect claude's own children (MCP servers + possible Task-tool subagents).
  const claudeChildren = claudePid === panePid ? panePidChildren : getChildPids(claudePid)
  if (claudeChildren.length === 0) return false

  for (const pid of claudeChildren) {
    const age = getPidAgeSeconds(pid)
    if (age === null) {
      // A child that exited between enumeration and this lookup is a FINISHED
      // process, not an unmeasurable one -- transient `Bash` shells hit this
      // constantly. Only a genuine ps failure on a still-live pid is
      // fail-closed.
      if (!pidExists(pid)) continue
      return null
    }
    if (isInfrastructureChild(age, claudeAge)) continue   // age-based infra
    // Age alone is not enough: a reconnected MCP server starts fresh (young).
    // Check process args to identify MCP servers regardless of age.
    const args = getChildArgsStr(pid) ?? ''
    if (isMcpProcess(args, mcpPatterns)) continue   // pattern-based infra
    if (isNonWorkHelperProcess(args)) continue      // caffeinate & friends
    return true   // live work child
  }
  return false
}

// ---- Transcript activity ----------------------------------------------------

/**
 * Milliseconds since the newest session transcript for this working dir was
 * written, or null when there is no readable transcript.
 *
 * This is the honest "is the agent working right now" signal: Claude Code
 * appends to the transcript on every turn and tool result, while the pane
 * snapshot only shows whatever the terminal painted last. Between two tool
 * calls the pane reads idle; the transcript does not.
 */
function msSinceTranscriptWrite(workingDir: string, nowMs: number): number | null {
  try {
    const dir = projectsDirFor(workingDir)
    if (!existsSync(dir)) return null
    let newest = 0
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (m > newest) newest = m
    }
    if (newest === 0) return null
    return Math.max(0, nowMs - newest)
  } catch { return null }
}

// ---- Task-state helper ------------------------------------------------------

// A taskstate record survives restarts by design (taskstate-replay re-injects
// it). Its mere existence does not mean work is running NOW -- an open thread
// can live for days. Only a RECENTLY-WRITTEN record (written during the current
// work session, not hours/days ago by a prior one) is a reliable signal of
// actively in-flight work. 10 minutes covers a PreCompact or a proactive write
// at the start of a task; anything older than that is a stale thread.
export const TASKSTATE_FRESH_WINDOW_MS = 10 * 60 * 1000  // 10 min

function hasLiveTaskStateFile(name: string, nowMs: number): boolean {
  const path = join(PROJECT_ROOT, 'store', 'agent-taskstate', `${name}.json`)
  if (!existsSync(path)) return false
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (raw.consumed === true) return false
    const nextAction = String(raw.nextAction ?? '').trim()
    if (!nextAction) return false
    // Only block if the record was written recently (active work session).
    const ts = typeof raw.ts === 'number' ? raw.ts : 0
    return ts > 0 && nowMs - ts <= TASKSTATE_FRESH_WINDOW_MS
  } catch { return false }
}

/**
 * Collect args strings of live work children for diagnostic logging.
 * Called only on the alert path (infrequent) so the extra ps calls are fine.
 */
function getLiveWorkChildArgs(session: string, mcpPatterns: string[]): string[] {
  try {
    const panePid = getPanePid(session)
    if (panePid === null) return []
    const paneComm = getCommForPid(panePid)
    const panePidChildren = getChildPids(panePid)
    const claudePid = findClaudePidInTree(
      panePid, paneComm,
      panePidChildren.map(pid => ({ pid, comm: getCommForPid(pid) })),
    )
    if (claudePid === null) return []
    const claudeAge = getPidAgeSeconds(claudePid)
    if (claudeAge === null) return []
    const children = claudePid === panePid ? panePidChildren : getChildPids(claudePid)
    const result: string[] = []
    for (const pid of children) {
      const age = getPidAgeSeconds(pid)
      if (age === null || isInfrastructureChild(age, claudeAge)) continue
      const args = getChildArgsStr(pid) ?? ''
      if (isMcpProcess(args, mcpPatterns)) continue
      if (isNonWorkHelperProcess(args)) continue   // keep in step with the decision path
      result.push(args || `PID ${pid}`)
    }
    return result
  } catch { return [] }
}

// ---- Gate check for one agent -----------------------------------------------

export interface GateSnapshot {
  cfg: ReturnType<typeof readGateConfig>
  session: string
  workingDir: string
  mcpPatterns: string[]
  inputs: GateInputs
  /** True when the dispatched-stats DB query failed (counted fail-closed). */
  dispatchedStatsFailed: boolean
}

/**
 * Gather every gate input for one agent. Pure I/O, no side effects: both the
 * live sweep and the doctor script go through this, so what the diagnostic
 * prints is exactly what the runner decides on -- no second implementation to
 * drift out of step.
 */
export function gatherGateInputs(name: string, nowMs: number): GateSnapshot {
  const cfg = readGateConfig(name)
  const session = sessionFor(name)
  const workingDir = workingDirFor(name)

  // Gather inputs (all deterministic, no AI inference).
  const paneRaw = capturePaneOrNull(session)
  const paneState = paneRaw !== null ? detectPaneState(paneRaw) : null
  const paneUsageLimited = paneRaw !== null ? detectsUsageLimit(paneRaw) : false

  const hardGuardPhase = getHardGuardPhase(name)

  const contextTokens = readContextTokensFromProjectDir(workingDir, configDirFor(name))

  const dispatchedStats = (() => {
    try { return getDispatchedPendingStats(name, nowMs, cfg.staleCutoffMs) }
    catch { return null }
  })()

  const openQuestion = (() => {
    try { return hasOpenInboundQuestion(agentIdForLedger(name)) }
    catch { return false }
  })()

  const liveTaskState = hasLiveTaskStateFile(name, nowMs)

  const mcpPatterns = getMcpJsonPatterns(workingDir)
  const childProcesses = (() => {
    try { return hasLiveChildProcesses(session, mcpPatterns) }
    catch { return null }
  })()

  const inputs: GateInputs = {
    nowMs,
    contextTokens,
    paneState,
    paneUsageLimited,
    hardGuardPhase,
    pendingOutboundCount:   dispatchedStats === null ? 1 : dispatchedStats.count,
    hasStaleOutbound:       dispatchedStats?.hasStale ?? false,
    hasChildProcesses:      childProcesses,
    msSinceTranscriptWrite: msSinceTranscriptWrite(workingDir, nowMs),
    hasOpenQuestion:        openQuestion,
    hasLiveTaskState:       liveTaskState,
  }

  return {
    cfg, session, workingDir, mcpPatterns, inputs,
    dispatchedStatsFailed: dispatchedStats === null,
  }
}

/**
 * Read-only gate evaluation for one agent: the same inputs and the same
 * decision the sweep would reach, without sending anything. Used by
 * scripts/context-restart-gate-doctor.mjs.
 */
export function diagnoseAgent(name: string, nowMs: number) {
  const snapshot = gatherGateInputs(name, nowMs)
  const runState = readGateRunState(name)
  return {
    ...snapshot,
    runState,
    decision: decideGate(snapshot.inputs, snapshot.cfg, runState.firstBlockedAt),
    liveWorkChildArgs: snapshot.inputs.hasChildProcesses === true
      ? getLiveWorkChildArgs(snapshot.session, snapshot.mcpPatterns)
      : [],
  }
}

async function checkAgent(name: string, nowMs: number): Promise<void> {
  if (!readGateConfig(name).enabled) return   // fast-exit before any I/O
  const { cfg, session, mcpPatterns, inputs, dispatchedStatsFailed } = gatherGateInputs(name, nowMs)

  // If the DB query for dispatched stats failed, fail-closed by treating it as
  // if there are pending messages (count=1). Log the failure.
  if (dispatchedStatsFailed) {
    logger.warn({ agent: name }, 'context-restart-gate: dispatched-stats query failed (fail-closed)')
  }

  const contextTokens = inputs.contextTokens
  const paneState = inputs.paneState
  const hardGuardPhase = inputs.hardGuardPhase

  const runState = readGateRunState(name)
  const decision = decideGate(inputs, cfg, runState.firstBlockedAt)

  logger.debug({ agent: name, action: decision.action, reason: decision.reason,
    contextTokens, paneState, hardGuardPhase }, 'context-restart-gate: decision')

  switch (decision.action) {
    case 'allow': {
      if (decision.noteStaleOutbound) {
        logger.info({ agent: name },
          'context-restart-gate: opening despite stale dispatched messages (beyond staleCutoffMs)')
      }
      // Send /clear via the send lane. A pane that is truly idle should accept
      // it immediately; the SessionStart hooks fire on the next boot and inject
      // the fresh context snapshot.
      try {
        await withSessionSendLock(session, null, 'deliver', async () => {
          execFileSync(tmuxBin(), ['send-keys', '-t', session, '-l', '/clear'], { timeout: 5000 })
          execFileSync(tmuxBin(), ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
        })
        logger.info({ agent: name, contextTokens }, 'context-restart-gate: /clear sent')
        writeGateRunState(name, {
          ...runState,
          firstBlockedAt: null,
          lastClearAt: nowMs,
        })
      } catch (err) {
        logger.warn({ err, agent: name }, 'context-restart-gate: /clear send failed')
      }
      break
    }

    case 'block-alert': {
      // Continuous blocking for >= persistentBlockAlertMs. Alert bigme, but
      // only once per persistentBlockAlertMs to avoid message spam.
      const alertDue = runState.lastAlertAt === null
        || nowMs - runState.lastAlertAt >= cfg.persistentBlockAlertMs
      if (alertDue) {
        const blockedSinceMin = runState.firstBlockedAt !== null
          ? Math.round((nowMs - runState.firstBlockedAt) / 60_000)
          : '?'
        try {
          // When the block reason is child processes, include their args so
          // bigme can identify the culprit at a glance (no post-hoc investigation).
          let childInfo = ''
          if (decision.reason.startsWith('live-child-processes')) {
            const workArgs = getLiveWorkChildArgs(session, mcpPatterns)
            if (workArgs.length > 0) {
              childInfo = ` Blokkolo gyerekfolyamatok: ${workArgs.slice(0, 5).join('; ')}`
            }
          }
          createAgentMessage(
            name,
            MAIN_AGENT_ID,
            `[CONTEXT-RESTART-GATE] A(z) "${name}" agens kapuja ${blockedSinceMin} perce folyamatosan blokkolt. Ok: ${decision.reason}.${childInfo} A(z) ${Math.round(cfg.thresholdTokens / 1000)}k tokenes kuszob ele ert, de a kapu nem enged -- ellenorizd hogy nincs-e elakadt munka.`,
            'context-restart-gate persistent-block alert',
          )
          logger.warn({ agent: name, reason: decision.reason, blockedSinceMin },
            'context-restart-gate: persistent-block alert sent')
          writeGateRunState(name, {
            ...runState,
            firstBlockedAt: runState.firstBlockedAt ?? nowMs,
            lastAlertAt: nowMs,
          })
        } catch (alertErr) {
          logger.warn({ alertErr, agent: name }, 'context-restart-gate: alert message failed')
        }
      }
      break
    }

    case 'block': {
      // Advance (or clear) the blocking-streak clock; see nextBlockClock.
      const firstBlockedAt = nextBlockClock(
        runState.firstBlockedAt, inputs.contextTokens, cfg.thresholdTokens, nowMs,
      )
      if (firstBlockedAt !== runState.firstBlockedAt) {
        writeGateRunState(name, { ...runState, firstBlockedAt })
      }
      break
    }
  }
}

// ---- Runner -----------------------------------------------------------------

const sweepTimers = new Map<string, NodeJS.Timeout>()

// How often a disabled agent re-reads its config. The gate is a cost control:
// enabling it must take effect on its own, not only after a dashboard restart.
const DISABLED_RECHECK_MS = 5 * 60 * 1000

// How often the roster itself is re-read. The sweep list used to be built once
// at boot, so an agent created later was never swept at all -- no gate, no
// /clear, no persistent-block alert, silently, until someone restarted the
// dashboard. Re-scanning makes agent creation self-sufficient. (A sub-agent
// sat at 545k tokens for a full day this way.)
const ROSTER_RESCAN_MS = 5 * 60 * 1000

/** Current roster: the main agent plus every visible sub-agent. */
function currentRoster(): string[] {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  return [...new Set(names)]
}

function scheduleSweep(name: string, delayMs: number): void {
  sweepTimers.set(name, setTimeout(async () => {
    // An agent removed from the fleet stops being swept; without this its timer
    // would re-arm itself forever against a session that no longer exists.
    if (!currentRoster().includes(name)) {
      sweepTimers.delete(name)
      logger.info({ agent: name }, 'context-restart-gate: agent gone from roster, sweep retired')
      return
    }
    const cfg = readGateConfig(name)
    if (!cfg.enabled) {
      // Keep polling instead of self-terminating. Dropping the timer here made
      // `enabled: true` a silent no-op for the rest of the process lifetime --
      // the config said the gate was on, and nothing ever swept.
      scheduleSweep(name, DISABLED_RECHECK_MS)
      return
    }
    try { await checkAgent(name, Date.now()) }
    catch (err) { logger.debug({ err, agent: name }, 'context-restart-gate: sweep error') }
    // Re-schedule using the agent's current retryIntervalMs (may have changed).
    scheduleSweep(name, readGateConfig(name).retryIntervalMs)
  }, delayMs))
}

/**
 * Schedule a sweep for every rostered agent that does not have one yet.
 * Returns the names that were newly picked up. Exported for tests.
 */
export function syncSweepRoster(baseDelayMs: number): string[] {
  const added: string[] = []
  let offset = 0
  for (const name of currentRoster()) {
    if (sweepTimers.has(name)) continue
    // Every agent gets a sweep regardless of its current `enabled` value: the
    // sweep itself re-reads the config each tick, so a gate switched on later
    // starts working without a dashboard restart.
    scheduleSweep(name, baseDelayMs + offset)
    offset += 2_000  // 2s stagger per agent so they don't all hit the DB at once
    added.push(name)
  }
  return added
}

export function startContextRestartGateRunner(): void {
  syncSweepRoster(INITIAL_DELAY_MS)
  // Re-scan the roster periodically so an agent created after boot is covered
  // without a dashboard restart.
  const rescan = setInterval(() => {
    const added = syncSweepRoster(INITIAL_DELAY_MS)
    if (added.length > 0) {
      logger.info({ agents: added }, 'context-restart-gate: new agents picked up by roster rescan')
    }
  }, ROSTER_RESCAN_MS)
  rescan.unref?.()
}
