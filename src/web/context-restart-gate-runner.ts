import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { agentSessionName, capturePane } from './agent-process.js'
import { detectPaneState } from '../pane-state.js'
import { detectsUsageLimit } from '../model-fallback.js'
import { readContextTokensFromProjectDir } from './active-model.js'
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

// tmux path (matches other runners).
const TMUX = process.env.TMUX_BIN ?? '/usr/bin/tmux'

// Child-process measurement constants.
//
// Two-tier filter to separate "infrastructure" (MCP servers, telegram plugin,
// gmail runner) from "work" (Task-tool subagents, background Bash):
//
//   CHILD_MIN_AGE_S     -- lower bound: skip children younger than this to
//                          ignore transient exec() calls (<1s typical).
//
//   INFRA_AGE_RATIO     -- upper bound: if a child's age is >= this fraction
//                          of the claude process's own age, it started near
//                          session boot and is almost certainly infrastructure.
//                          Measured on this host: claude and its MCP servers
//                          (npm exec gmail-..., bun telegram plugin) all share
//                          the same etimes (~6294s). Task-tool subagents are
//                          always spawned during the session and thus much
//                          younger (etimes/claude_etimes << 0.85).
//
// A child is treated as "possibly work" only when:
//   age >= CHILD_MIN_AGE_S  AND  age < claude_age * INFRA_AGE_RATIO
//
// On ps failure (null age): fail-closed → treat as work.
const CHILD_MIN_AGE_S    = 3
const INFRA_AGE_RATIO    = 0.85

/**
 * Pure: true if a child process with the given age (seconds) should be treated
 * as infrastructure (MCP server, plugin runner) rather than in-flight work.
 * Exported for tests.
 *
 * Infrastructure is detected by age:
 *   - age < CHILD_MIN_AGE_S                    → transient exec() → infra
 *   - age >= claudeAgeS * INFRA_AGE_RATIO      → started near session boot → infra
 *   - otherwise                                → spawned during session → possibly work
 */
export function isInfrastructureChild(childAgeS: number, claudeAgeS: number): boolean {
  if (childAgeS < CHILD_MIN_AGE_S) return true
  if (childAgeS >= claudeAgeS * INFRA_AGE_RATIO) return true
  return false
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function workingDirFor(name: string): string {
  if (name === MAIN_AGENT_ID) return PROJECT_ROOT
  return join(PROJECT_ROOT, 'agents', name)
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
// Measured on this host (see review #938 round 1):
//   - Both main-agent and sub-agent sessions: pane_pid comm=claude (NOT a shell).
//     The original isMainAgent distinction was wrong; panePid is the claude
//     process directly in all cases.
//   - Claude's MCP servers (npm exec gmail-..., bun telegram plugin) are direct
//     children of claude and share ~the same etimes as claude itself. They run
//     for the full session lifetime.
//
// Two-tier age filter separates infrastructure from work:
//   - age < CHILD_MIN_AGE_S            → transient exec(), skip
//   - age >= claude_age * INFRA_AGE_RATIO → started near session boot = infra, skip
//   - otherwise                         → spawned during session = possibly work
//
// On ps failure for any PID: fail-closed (return null → decideGate blocks).

function getPanePid(session: string): number | null {
  try {
    const raw = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf-8' })
    const pid = parseInt(raw.split('\n')[0]?.trim() ?? '', 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function getChildPids(parentPid: number): number[] {
  try {
    const out = execFileSync('/bin/ps', ['--ppid', String(parentPid), '-o', 'pid='],
      { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n')
      .map(l => parseInt(l.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0)
  } catch { return [] }
}

function getPidAgeSeconds(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'etimes='],
      { timeout: 2000, encoding: 'utf-8' })
    const secs = parseInt(out.trim(), 10)
    return Number.isFinite(secs) ? secs : null
  } catch { return null }
}

/**
 * Returns true if the session's claude process has live children that look
 * like in-flight work (Task-tool subagents, background Bash), false if only
 * infrastructure children are found, null if the check cannot be completed
 * (fail-closed → decideGate blocks).
 */
function hasLiveChildProcesses(session: string): boolean | null {
  // pane_pid IS the claude process on all session types on this host.
  const claudePid = getPanePid(session)
  if (claudePid === null) return null

  const claudeAge = getPidAgeSeconds(claudePid)
  if (claudeAge === null) return null   // can't measure parent → fail-closed

  const children = getChildPids(claudePid)
  if (children.length === 0) return false

  for (const pid of children) {
    const age = getPidAgeSeconds(pid)
    if (age === null) return null   // can't measure child age → fail-closed
    if (!isInfrastructureChild(age, claudeAge)) return true
  }
  return false
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

// ---- Gate check for one agent -----------------------------------------------

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readGateConfig(name)
  if (!cfg.enabled) return   // fast-exit without touching state

  const session = sessionFor(name)
  const workingDir = workingDirFor(name)

  // Gather inputs (all deterministic, no AI inference).
  const paneRaw = capturePaneOrNull(session)
  const paneState = paneRaw !== null ? detectPaneState(paneRaw) : null
  const paneUsageLimited = paneRaw !== null ? detectsUsageLimit(paneRaw) : false

  const hardGuardPhase = getHardGuardPhase(name)

  const contextTokens = readContextTokensFromProjectDir(workingDir)

  const dispatchedStats = (() => {
    try { return getDispatchedPendingStats(name, nowMs, cfg.staleCutoffMs) }
    catch { return null }
  })()

  const openQuestion = (() => {
    try { return hasOpenInboundQuestion(agentIdForLedger(name)) }
    catch { return false }
  })()

  const liveTaskState = hasLiveTaskStateFile(name, nowMs)

  const childProcesses = (() => {
    try { return hasLiveChildProcesses(session) }
    catch { return null }
  })()

  // If the DB query for dispatched stats failed, fail-closed by treating it as
  // if there are pending messages (count=1). Log the failure.
  if (dispatchedStats === null) {
    logger.warn({ agent: name }, 'context-restart-gate: dispatched-stats query failed (fail-closed)')
  }

  const inputs: GateInputs = {
    nowMs,
    contextTokens,
    paneState,
    paneUsageLimited,
    hardGuardPhase,
    pendingOutboundCount:   dispatchedStats === null ? 1 : dispatchedStats.count,
    hasStaleOutbound:       dispatchedStats?.hasStale ?? false,
    hasChildProcesses:      childProcesses,
    hasOpenQuestion:        openQuestion,
    hasLiveTaskState:       liveTaskState,
  }

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
          execFileSync(TMUX, ['send-keys', '-t', session, '-l', '/clear'], { timeout: 5000 })
          execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
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
          createAgentMessage(
            name,
            MAIN_AGENT_ID,
            `[CONTEXT-RESTART-GATE] A(z) "${name}" agens kapuja ${blockedSinceMin} perce folyamatosan blokkolt. Ok: ${decision.reason}. A(z) ${Math.round(cfg.thresholdTokens / 1000)}k tokenes kuszob ele ert, de a kapu nem enged -- ellenorizd hogy nincs-e elakadt munka.`,
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
      // Normal block: update firstBlockedAt if this is the first block in a streak.
      const firstBlockedAt = runState.firstBlockedAt ?? (
        // Only start the clock when we are above the threshold -- otherwise
        // every idle agent would accumulate a never-expiring blocking streak.
        inputs.contextTokens !== null && inputs.contextTokens >= cfg.thresholdTokens
          ? nowMs
          : null
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

function scheduleSweep(name: string, delayMs: number): void {
  sweepTimers.set(name, setTimeout(async () => {
    const cfg = readGateConfig(name)
    if (!cfg.enabled) {
      sweepTimers.delete(name)
      return
    }
    try { await checkAgent(name, Date.now()) }
    catch (err) { logger.debug({ err, agent: name }, 'context-restart-gate: sweep error') }
    // Re-schedule using the agent's current retryIntervalMs (may have changed).
    scheduleSweep(name, readGateConfig(name).retryIntervalMs)
  }, delayMs))
}

export function startContextRestartGateRunner(): void {
  // Stagger each agent slightly so they don't all hit the DB simultaneously.
  const agents = [MAIN_AGENT_ID, ...listAgentNames()]
  const seen = new Set<string>()
  let offset = 0
  for (const name of agents) {
    if (seen.has(name)) continue
    seen.add(name)
    const cfg = readGateConfig(name)
    if (!cfg.enabled) {
      // Schedule a one-time check after the initial delay in case the config
      // changes at runtime; the per-agent sweep self-terminates when disabled.
      scheduleSweep(name, INITIAL_DELAY_MS + offset)
    } else {
      scheduleSweep(name, INITIAL_DELAY_MS + offset)
    }
    offset += 2_000  // 2s stagger per agent
  }
}
