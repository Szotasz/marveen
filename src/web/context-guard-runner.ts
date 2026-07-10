import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID, PROJECT_ROOT } from '../config.js'
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
import { paneLooksIdle } from '../pane-state.js'
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
// context. Sweep every agent (main included) once a minute; at actPct ask the
// agent to write HANDOFF.md, then fresh-restart it and inject a resume prompt
// pointing at the handoff. See src/context-guard.ts for the why and the pure
// state machine; this module is only the I/O, mirroring auto-restart-runner.
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
    // launchd-managed; channels.sh always starts fresh, KeepAlive respawns it.
    const uid = typeof process.getuid === 'function' ? process.getuid() : ''
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`], { timeout: 10_000 })
  } else {
    restartAgentProcess(name, { fresh: true })
  }
}

function checkAgent(name: string, nowMs: number): void {
  const cfg = readContextGuardConfig(name)
  const state = guardStates.get(name) ?? INITIAL_GUARD_STATE

  if (!cfg.enabled) {
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
  const inputs: GuardInputs = {
    nowMs,
    running,
    pct: running && needPct ? measurePct(name, cfg.limitTokens) : null,
    paneIdle: pane !== null ? paneLooksIdle(pane) : false,
    sessionReady: running && state.phase === 'await-ready' ? isSessionReadyForPrompt(session) : false,
    handoffMtime: needPct ? handoffMtime(name) : null,
  }

  const decision = decideGuard(state, inputs, cfg)
  guardStates.set(name, decision.nextState)
  if (decision.action === 'none') return

  const pctRound = inputs.pct !== null ? Math.round(inputs.pct * 100) : null
  logger.info({ name, action: decision.action, reason: decision.reason, pct: pctRound }, 'context-guard: acting')

  try {
    switch (decision.action) {
      case 'request-handoff':
        sendPromptToSession(session, handoffPrompt(pctRound ?? 0, handoffPathFor(name)))
        break
      case 'restart':
        performRestart(name)
        break
      case 'inject-resume': {
        const hadHandoff = inputs.handoffMtime !== null || handoffMtime(name) !== null
        sendPromptToSession(session, resumePrompt(name, handoffPathFor(name), hadHandoff))
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
    }
  })
}

export function startContextGuardRunner(): NodeJS.Timeout {
  function sweep() {
    const now = Date.now()
    try { checkAgent(MAIN_AGENT_ID, now) } catch (err) { logger.debug({ err }, 'context-guard: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'context-guard: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
