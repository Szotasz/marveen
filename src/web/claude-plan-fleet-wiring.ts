// Production wiring for the fleet leg of a rotation (CLAUDE_ROTATION_FLEET).
// The logic lives in ../claude-plan-fleet-rotation.ts (IO-injected, tested);
// this module only binds it to the real vault, fleet token file, agent
// registry and restart primitive, and records + prints the outcome.
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import {
  agentUsesFleetToken,
  performFleetRotation,
  writeFleetTokenFile,
} from '../claude-plan-fleet-rotation.js'
import type { ClaudePlan } from './claude-plans.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { readClaudePlansState, writeClaudePlansState, recordFleetRotation, type FleetRotationRecord } from './claude-plans-state.js'
import { listAllAgentNames, readAgentModel, readAgentAuthMode, readAgentRemoteHost } from './agent-config.js'
import { FLEET_OAUTH_TOKEN_PATH, isAgentRunning, restartAgentProcess } from './agent-process.js'
import { resolveOpenRouterModel } from './openrouter-models.js'
import { getSecret } from './vault.js'

function usesFleetToken(name: string): boolean {
  return agentUsesFleetToken({
    name,
    mainAgentId: MAIN_AGENT_ID,
    model: resolveOpenRouterModel(readAgentModel(name)),
    authMode: readAgentAuthMode(name),
    configuredConfigDir: resolveAgentConfigDir(name).configDir,
    remote: readAgentRemoteHost(name) !== null,
  })
}

/**
 * Run the fleet leg for a main-agent rotation onto `target`, record it in the
 * state side-car and print its one structured line on stdout. Never throws.
 */
export async function runFleetLeg(target: ClaudePlan): Promise<FleetRotationRecord | null> {
  try {
    const record = await performFleetRotation(target, {
      readPlanToken: (p) => (p.tokenSecretId ? getSecret(p.tokenSecretId) : null),
      writeFleetToken: (token, nowMs) => writeFleetTokenFile(FLEET_OAUTH_TOKEN_PATH, token, nowMs),
      listAgents: listAllAgentNames,
      usesFleetToken,
      isRunning: isAgentRunning,
      restart: (name) => restartAgentProcess(name),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      nowMs: () => Date.now(),
    })
    // Re-read right before the write: the restarts above can take a minute,
    // and the heartbeat may have written observations meanwhile.
    writeClaudePlansState(recordFleetRotation(readClaudePlansState(), record))
    console.log(record.line)
    const level = record.outcome === 'failed' || record.failed.length ? 'warn' : 'info'
    logger[level](
      { fleetPlanId: record.fleetPlanId, outcome: record.outcome, reason: record.reason, restarted: record.restarted, failed: record.failed, notRunning: record.notRunning },
      'Claude plan rotation: fleet leg',
    )
    return record
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : 'error', planId: target.id }, 'Claude plan rotation: fleet leg crashed')
    return null
  }
}
