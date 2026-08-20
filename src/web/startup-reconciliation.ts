import { logger } from '../logger.js'
import { listAgentNames } from './agent-config.js'
import {
  agentSessionName,
  sessionExistsOnHost,
  startAgentProcess,
  restartAgentProcess,
  capturePane,
} from './agent-process.js'
import { getDesiredAgents, addDesiredAgent } from './agent-desired-state.js'
import { readAllAutoRestartConfigs } from './auto-restart-store.js'
import { detectPaneState } from '../pane-state.js'

// On Marveen startup, reconcile desired agents with what tmux actually has.
//
// Two scenarios after a Marveen restart:
//
//   A. Tmux session alive  (tmux outlived Marveen)
//      -> Reconnect: re-register in desired set, do NOT launch a new session.
//         Claude Code context is preserved inside the existing session.
//         If the session is stale (CC crashed inside), restart it.
//
//   B. Tmux session gone
//      -> Launch a new one if the agent is desired or has autoRestart enabled.
//         Context is lost, but the agent is back within the 60-second window.
//
// Related: ADR-001 (docs/adr-001-durable-agent-execution.md).

// Check whether a tmux session with the given name exists on the local host.
export function tmuxSessionExists(session: string): boolean {
  return sessionExistsOnHost(null, session)
}

// Determine whether Claude Code is alive inside the agent's tmux session.
//
// 'live'  -> pane shows Claude Code chrome (idle, busy, or typing).
//            Safe to reconnect -- the agent's context is intact.
// 'stale' -> session exists but CC is not visible (shell fallback or empty
//            pane after a CC crash). Needs a restart to be usable.
export function probeAgentLiveness(name: string): 'live' | 'stale' {
  const pane = capturePane(agentSessionName(name))
  if (pane == null || pane.trim() === '') return 'stale'
  const state = detectPaneState(pane)
  return state === 'idle' || state === 'busy' || state === 'typing' ? 'live' : 'stale'
}

// Reconcile desired agents against actual tmux state on Marveen startup.
// Call once after the HTTP server is up; do NOT await on the critical path
// (fire-and-forget via void is fine -- logged errors never propagate).
export async function reconcileAgentsOnStartup(): Promise<void> {
  const desired = getDesiredAgents()
  const autoRestartCfgs = readAllAutoRestartConfigs()

  // Candidates = union of explicitly desired agents and autoRestart-enabled agents.
  const candidates = new Set<string>(desired)
  for (const [name, cfg] of Object.entries(autoRestartCfgs)) {
    if (cfg.enabled) candidates.add(name)
  }

  if (candidates.size === 0) {
    logger.info('startup-reconciliation: no desired agents -- skipping')
    return
  }

  logger.info({ count: candidates.size }, 'startup-reconciliation: starting')

  for (const name of candidates) {
    const session = agentSessionName(name)
    const sessionAlive = tmuxSessionExists(session)

    if (sessionAlive) {
      const liveness = probeAgentLiveness(name)

      if (liveness === 'live') {
        // Part B (ADR-001): reconnect -- session survived, context is preserved.
        logger.info({ agent: name, session }, 'startup-reconciliation: reconnected to existing tmux session')
        if (!desired.has(name)) addDesiredAgent(name)
      } else {
        // Stale: shell exists but Claude Code crashed inside the session.
        // Restart preserves the session name convention but starts a fresh CC process.
        logger.warn({ agent: name, session }, 'startup-reconciliation: session stale (CC not responsive) -- restarting')
        try {
          const result = restartAgentProcess(name)
          if (!result.ok) {
            logger.warn({ agent: name, error: result.error }, 'startup-reconciliation: stale restart failed')
          } else {
            logger.info({ agent: name }, 'startup-reconciliation: stale session restarted')
          }
        } catch (err) {
          logger.warn({ err, agent: name }, 'startup-reconciliation: stale restart threw')
        }
      }
    } else {
      // Part A (ADR-001): session gone -- launch if the agent should be running.
      const shouldLaunch = desired.has(name) || (autoRestartCfgs[name]?.enabled ?? false)
      if (!shouldLaunch) {
        logger.debug({ agent: name }, 'startup-reconciliation: session absent and not desired, skipping')
        continue
      }

      logger.info({ agent: name, session }, 'startup-reconciliation: session absent -- launching')
      try {
        const result = startAgentProcess(name)
        if (result.ok) {
          logger.info({ agent: name }, 'startup-reconciliation: launched successfully')
        } else if (result.error === 'Agent is already running') {
          // Race: another Marveen process started it between our check and now.
          logger.debug({ agent: name }, 'startup-reconciliation: agent already running (start race)')
        } else {
          logger.warn({ agent: name, error: result.error }, 'startup-reconciliation: launch failed')
        }
      } catch (err) {
        logger.warn({ err, agent: name }, 'startup-reconciliation: launch threw')
      }
    }
  }

  logger.info('startup-reconciliation: complete')
}

// SIGTERM flush: ensure agents that are actually running end up in the desired
// set so the next startup has accurate data even after an unclean shutdown.
// Only ever adds -- deliberate stops (removeDesiredAgent) are not undone here.
export function flushRunningStateToDesired(): void {
  const desired = getDesiredAgents()
  for (const name of listAgentNames()) {
    try {
      if (!desired.has(name) && tmuxSessionExists(agentSessionName(name))) {
        addDesiredAgent(name)
        logger.info({ agent: name }, 'startup-reconciliation: SIGTERM flush -- added running agent to desired set')
      }
    } catch (err) {
      logger.warn({ err, agent: name }, 'startup-reconciliation: SIGTERM flush probe failed')
    }
  }
}
