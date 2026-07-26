import { statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { hardRestartMarveenChannels, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS } from './channel-monitor.js'
import { shouldDeferForRecentRespawn } from './stuck-tool-call-watcher.js'
import { listAgentNames, agentDir, readAgentModel, readAgentClaudeConfigDir, readAgentRemoteHost } from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  sendPromptToSession,
  isSessionReadyForPrompt,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle, paneShowsContextSaturation } from '../pane-state.js'
import { readContextTokensFromProjectDir, readActiveModelFromProjectDir } from './active-model.js'
import { readContextGuardConfig } from './context-guard-store.js'
import {
  decideGuard,
  contextLimitForModel,
  calibrateLimit,
  INITIAL_GUARD_STATE,
  type GuardState,
  type GuardInputs,
} from '../context-guard.js'

// Fleet context guard (kanban #81): acts BEFORE a session drowns in its own
// context. Sweep every agent (main included) every five minutes; at actPct ask the
// agent to write HANDOFF.md, then fresh-restart it and inject a resume prompt
// pointing at the handoff. The always-on saturation net additionally rescues a
// pane already showing "100% context used" -- unreachable by prompt dispatch,
// so nothing else can recover it (samu stall, 2026-07-18). See
// src/context-guard.ts for the why and the pure state machine; this module is
// only the I/O, mirroring auto-restart-runner.
//
// Remote-host agents are skipped: their transcripts live on the remote machine,
// so the context size cannot be measured here (v1 limitation, logged once).

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000

// agent name -> guard state. In-memory: a dashboard restart re-arms every
// agent at 'idle', which is safe -- the worst case is a repeated handoff
// request, and cooldown prevents restart loops within a run.
const guardStates = new Map<string, GuardState>()
const remoteSkipLogged = new Set<string>()

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function workingDirFor(name: string): string {
  return name === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(name)
}

function handoffPathFor(name: string): string {
  return join(workingDirFor(name), 'HANDOFF.md')
}

function handoffMtime(name: string): number | null {
  try { return statSync(handoffPathFor(name)).mtimeMs } catch { return null }
}

export function handoffPrompt(pctRound: number, handoffPath: string): string {
  return (
    `[CONTEXT-GUARD] A munkakontextusod ~${pctRound}%-on van -- kritikus. ` +
    `NE folytasd a feladatot. EGYETLEN dolgod ebben a körben: írj HANDOFF.md-t a /handoff skill struktúrája szerint ide: ${handoffPath} ` +
    `(purpose: a folyamatban lévő feladat folytatása friss kontextusban; Goal / Current Progress / What Worked / What Didn't Work / Next Steps szekciók, ` +
    `konkrét fájl-útvonalakkal és kanban kártya-azonosítókkal). Ha nincs aktív feladatod, írd bele hogy nincs. ` +
    `Utána ÁLLJ MEG -- a rendszer friss kontextussal újraindít és a HANDOFF.md-ből folytatod.`
  )
}

export function resumePrompt(name: string, handoffPath: string, hadHandoff: boolean): string {
  const base =
    `[CONTEXT-GUARD] Friss kontextussal indultál, mert az előző session kontextusa megtelt (auto-handoff). `
  const source = hadHandoff
    ? `Első lépés: olvasd be ${handoffPath} -- ez az előző session átadója. `
    : `HANDOFF.md nem készült el időben, ezért az élő forrásokból dolgozz. `
  return (
    base + source +
    `Utána ellenőrizd a kanban tábládat (in_progress kártyák, assignee=${name}) és a hot memóriáidat, ` +
    `és FOLYTASD a megkezdett munkát magadtól. Ne kezdd elölről ami a handoff szerint már kész. ` +
    `Röviden jelezz a csatornádon, hogy friss kontextussal folytatod.`
  )
}

function measurePct(name: string, cfgLimit: number | null): number | null {
  const workingDir = workingDirFor(name)
  const configDir = name === MAIN_AGENT_ID ? undefined : (readAgentClaudeConfigDir(name) ?? undefined)
  const tokens = readContextTokensFromProjectDir(workingDir, configDir)
  if (tokens === null || tokens <= 0) return null
  let limit: number
  if (cfgLimit) {
    limit = cfgLimit
  } else {
    const model = name === MAIN_AGENT_ID
      ? readActiveModelFromProjectDir(PROJECT_ROOT)
      : readAgentModel(name)
    limit = calibrateLimit(tokens, contextLimitForModel(model))
  }
  return tokens / limit
}

function performRestart(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // Platform-correct main-session restart. This was a hardcoded
    // `/bin/launchctl kickstart`, which exists only on macOS: on Linux every
    // rescue died instantly with `spawnSync /bin/launchctl ENOENT`, caught by
    // checkAgent's catch and buried in a single WARN. Measured on 2026-07-26:
    // the main agent sat at 100% context from 09:47, the saturation net -- the
    // only mechanism that can rescue a pane prompt dispatch refuses -- fired
    // four times and failed every time, and main was unreachable for ~2h until
    // a hand restart.
    //
    // hardRestartMarveenChannels() is the existing helper the channel-monitor
    // down-cascade already uses: it keeps the launchd path for macOS installs
    // (and warns + falls back to a pane respawn if the plist is absent), uses
    // respawn-pane-FRESH on Linux -- fresh is exactly what the guard wants --
    // and writes the shared respawn stamp so the other respawners defer to us.
    const res = hardRestartMarveenChannels()
    if (!res.ok) throw new Error(res.error ?? 'main channels hard restart failed')
  } else {
    restartAgentProcess(name, { fresh: true })
  }
}

async function checkAgent(name: string, nowMs: number): Promise<void> {
  const cfg = readContextGuardConfig(name)
  const state = guardStates.get(name) ?? INITIAL_GUARD_STATE

  // Fully disarmed only when BOTH the proactive tiers and the always-on
  // saturation net are off; the net alone keeps the sweep alive so a
  // 100%-context pane (which dispatch refuses to prompt) still gets rescued.
  if (!cfg.enabled && !cfg.saturationRestart) {
    guardStates.delete(name)
    return
  }

  // v1: local agents only -- a remote host's transcripts are unreadable here.
  if (name !== MAIN_AGENT_ID && readAgentRemoteHost(name)) {
    if (!remoteSkipLogged.has(name)) {
      remoteSkipLogged.add(name)
      logger.info({ name }, 'context-guard: remote-host agent, skipping (transcripts not local)')
    }
    return
  }

  const session = sessionFor(name)
  const running = name === MAIN_AGENT_ID
    ? capturePane(session) !== null
    : agentRunState(name) === 'running'

  // Only pay for the tmux/transcript probes a decision can actually use.
  const needPct = state.phase === 'idle' || state.phase === 'await-handoff'
  const pane = running && needPct ? capturePane(session) : null
  const sessionReady = running && state.phase === 'await-ready'
    ? await isSessionReadyForPrompt(session)
    : false
  const inputs: GuardInputs = {
    nowMs,
    running,
    // The saturation net decides from the pane alone; only the proactive
    // tiers need the (transcript-reading) pct probe.
    pct: running && needPct && cfg.enabled ? measurePct(name, cfg.limitTokens) : null,
    paneIdle: pane !== null ? paneLooksIdle(pane) : false,
    sessionReady,
    handoffMtime: needPct ? handoffMtime(name) : null,
    paneSaturated: pane !== null ? paneShowsContextSaturation(pane) : false,
  }

  const decision = decideGuard(state, inputs, cfg)

  // Post-respawn grace for the main session. Making the Linux restart path work
  // (above) also makes it repeatable: measured on 2026-07-26, the saturation net
  // fresh-restarted main five times in one morning, so the agent lost its
  // conversation roughly every half hour. Two causes of a redundant restart,
  // both covered by the same stamp: a session that is still BOOTING can read as
  // saturated/idle again on the next sweep, and ANOTHER respawner (the
  // channel-monitor down-cascade, the auto-restart runner, channel-watchdog.sh)
  // may have just restarted main for its own reasons.
  //
  // Same mechanism every other respawner already shares -- lastMainRespawnAt()
  // plus MARVEEN_POST_RESPAWN_GRACE_MS -- so there is no new tunable and no new
  // number; see the identical gate in stuck-tool-call-watcher.ts. Main only: the
  // stamp describes the main channels session, and a sub-agent restart is
  // cheap and independently coordinated.
  //
  // The state must NOT advance here. decideGuard() has already produced
  // nextState = await-ready; committing that while skipping the restart would
  // leave the machine believing main was restarted, and the next sweep would
  // inject a "continue from your handoff" resume prompt into the SAME saturated
  // pane -- the guard would consume its own recovery and never retry. Keeping
  // the previous state means the next sweep re-decides, and the restart happens
  // once the grace has elapsed.
  if (decision.action === 'restart' && name === MAIN_AGENT_ID) {
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, nowMs)) {
      logger.info(
        { name, sinceRespawnMs: lastRespawn ? nowMs - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'context-guard: recent main respawn within grace, deferring restart (avoid restart loop / boot churn)',
      )
      guardStates.set(name, state)
      return
    }
  }

  guardStates.set(name, decision.nextState)
  if (decision.action === 'none') return

  const pctRound = inputs.pct !== null ? Math.round(inputs.pct * 100) : null
  logger.info({ name, action: decision.action, reason: decision.reason, pct: pctRound }, 'context-guard: acting')

  try {
    switch (decision.action) {
      case 'request-handoff':
        await sendPromptToSession(session, handoffPrompt(pctRound ?? 0, handoffPathFor(name)))
        break
      case 'restart':
        performRestart(name)
        break
      case 'inject-resume': {
        const hadHandoff = inputs.handoffMtime !== null || handoffMtime(name) !== null
        await sendPromptToSession(session, resumePrompt(name, handoffPathFor(name), hadHandoff))
        break
      }
    }
  } catch (err) {
    logger.warn({ err, name, action: decision.action }, 'context-guard: action failed')
  }
}

/** Live status for the dashboard/API. */
export function getContextGuardStatus(): Array<{
  agent: string
  phase: string
  pct: number | null
  enabled: boolean
  saturationRestart: boolean
}> {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  return names.map((name) => {
    const cfg = readContextGuardConfig(name)
    const remote = name !== MAIN_AGENT_ID && !!readAgentRemoteHost(name)
    return {
      agent: name,
      phase: guardStates.get(name)?.phase ?? 'idle',
      pct: cfg.enabled && !remote ? measurePct(name, cfg.limitTokens) : null,
      enabled: cfg.enabled,
      saturationRestart: cfg.saturationRestart,
    }
  })
}

export function startContextGuardRunner(): NodeJS.Timeout {
  async function sweep() {
    const now = Date.now()
    try { await checkAgent(MAIN_AGENT_ID, now) } catch (err) { logger.debug({ err }, 'context-guard: main check error') }
    for (const name of listAgentNames()) {
      try { await checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'context-guard: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
