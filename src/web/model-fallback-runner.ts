import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID, PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  listAgentNames,
  readAgentRemoteHost,
  readAgentModel,
  writeAgentModel,
  resolveModelId,
  DEFAULT_MODEL,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle } from '../pane-state.js'
import { readModelFallbackConfig } from './model-fallback-store.js'
import { detectsUsageLimit, decideModelAction } from '../model-fallback.js'

// Drives the model-fallback-on-limit feature (see src/model-fallback.ts for the
// why and the pure decision logic). Mirrors the auto-restart runner: a 60s
// sweep, offset from the other watchers so tmux calls do not pile onto one tick.
//
// Per agent each tick: capture the pane, detect a plan usage-limit banner, ask
// the pure decision function what to do, and -- only when the pane is idle --
// rewrite the agent's model and respawn the session (keeping the conversation)
// so the new model takes effect. A revert climbs back to the primary once the
// agent has been limit-free past the configured window.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000

// agent name -> when we last downgraded it (ms). Absent => currently on primary.
// In-memory: a dashboard restart loses this, so a downgraded agent would not be
// auto-reverted until the next downgrade cycle. Acceptable; the agent keeps
// working on the fallback model, and the operator can revert manually.
const downgradedAt = new Map<string, number>()

const MAIN_SETTINGS_PATH = join(PROJECT_ROOT, '.claude', 'settings.json')

function readMainModel(): string {
  try {
    const cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8'))
    return resolveModelId((cfg && typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL)
  } catch {
    return DEFAULT_MODEL
  }
}

function writeMainModel(model: string): void {
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8')) } catch {}
  cfg.model = model
  atomicWriteFileSync(MAIN_SETTINGS_PATH, JSON.stringify(cfg, null, 2))
}

function readModelFor(name: string): string {
  return name === MAIN_AGENT_ID ? readMainModel() : readAgentModel(name)
}

function writeModelFor(name: string, model: string): void {
  if (name === MAIN_AGENT_ID) writeMainModel(model)
  else writeAgentModel(name, model)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function restartFor(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // The main channels session is launchd-managed; a kickstart re-reads
    // .claude/settings.json (and thus the new model) on relaunch. KeepAlive
    // brings it straight back. channels.sh always starts fresh for main, so a
    // conversation is not preserved here -- the model swap is what matters.
    const uid = typeof process.getuid === 'function' ? process.getuid() : ''
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`], { timeout: 10_000 })
  } else {
    // 'continue' (fresh: false) re-spawns with --continue so the conversation
    // survives the model swap.
    restartAgentProcess(name, { fresh: false })
  }
}

function checkAgent(name: string, nowMs: number, revertAfterMs: number, chain: string[]): void {
  // Sub-agents must be up; the main session is launchd-managed (always present).
  if (name !== MAIN_AGENT_ID && agentRunState(name) !== 'running') return

  const session = sessionFor(name)
  const host = name === MAIN_AGENT_ID ? null : readAgentRemoteHost(name)
  const pane = capturePane(session, host)
  if (pane == null) return

  const limitDetected = detectsUsageLimit(pane)
  const currentModel = readModelFor(name)
  const action = decideModelAction({
    limitDetected,
    currentModel,
    chain,
    downgradedAt: downgradedAt.get(name) ?? null,
    now: nowMs,
    revertAfterMs,
  })
  if (action.kind === 'none') return

  // Downgrade may run on a limit-paused pane (which reads idle); revert must not
  // cut a live turn. Both go through restart, so require idle for both.
  if (!paneLooksIdle(pane)) {
    logger.info({ name, action: action.kind }, 'model-fallback: action due but pane busy, deferring')
    return
  }

  try {
    writeModelFor(name, action.model)
    restartFor(name)
    if (action.kind === 'downgrade') downgradedAt.set(name, nowMs)
    else downgradedAt.delete(name)
    logger.info(
      { name, from: currentModel, to: action.model, action: action.kind },
      'model-fallback: switched model',
    )
  } catch (err) {
    logger.warn({ err, name }, 'model-fallback: switch failed')
  }
}

export function startModelFallbackRunner(): NodeJS.Timeout {
  function sweep() {
    const cfg = readModelFallbackConfig()
    if (!cfg.enabled) {
      if (downgradedAt.size > 0) downgradedAt.clear() // re-seed cleanly if re-enabled
      return
    }
    const now = Date.now()
    const revertAfterMs = cfg.revertAfterMinutes * 60_000
    try { checkAgent(MAIN_AGENT_ID, now, revertAfterMs, cfg.chain) }
    catch (err) { logger.debug({ err }, 'model-fallback: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now, revertAfterMs, cfg.chain) }
      catch (err) { logger.debug({ err, agent: name }, 'model-fallback: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
