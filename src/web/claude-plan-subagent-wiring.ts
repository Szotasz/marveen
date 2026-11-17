// Production wiring for the sub-agent rotation stage (SUBPLANTOKEN1110 2nd PR).
// The logic lives in ../claude-plan-subagent-rotation.ts (IO-injected, tested);
// this module only binds it to the agent registry, the launcher's running and
// pane primitives, the vault and the live probe. Loaded lazily by
// claude-plan-rotate-check-run.ts, so installs without token-plan sub-agents
// never pull the launcher in.
import { MAIN_AGENT_ID } from '../config.js'
import { runSubAgentRotation, type SubAgentRotationResult } from '../claude-plan-subagent-rotation.js'
import { probePlanUsage } from '../claude-plan-usage-probe.js'
import { paneLooksIdle } from '../pane-state.js'
import type { ClaudePlan } from './claude-plans.js'
import type { ClaudePlansState } from './claude-plans-state.js'
import { listAllAgentNames, readAgentClaudePlan, readAgentRemoteHost } from './agent-config.js'
import { agentSessionName, capturePane, isAgentRunning } from './agent-process.js'
import { MANUAL_RESTART_INTERVAL_MS, MANUAL_RESTART_SAMPLES } from './manual-restart-gate.js'
import { getSecret } from './vault.js'

/** The manual-restart gate's sampling (manual-restart-gate.ts): N captures, a fixed gap apart. */
export async function paneIdleSamples(name: string): Promise<Array<boolean | null>> {
  const samples: Array<boolean | null> = []
  for (let i = 0; i < MANUAL_RESTART_SAMPLES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, MANUAL_RESTART_INTERVAL_MS))
    const pane = capturePane(agentSessionName(name))
    samples.push(pane == null ? null : paneLooksIdle(pane))
  }
  return samples
}

export function runSubAgentStage(plans: ClaudePlan[], state: ClaudePlansState, nowMs: number): Promise<SubAgentRotationResult> {
  return runSubAgentRotation({
    plans, state, mainAgentId: MAIN_AGENT_ID, nowMs,
    deps: {
      listAgents: listAllAgentNames,
      planOf: readAgentClaudePlan,
      isRemote: (name) => readAgentRemoteHost(name) !== null,
      isRunning: isAgentRunning,
      readToken: (secretId) => getSecret(secretId),
      probe: (token) => probePlanUsage(token),
      paneIdleSamples,
      warn: (line) => console.error(line),
    },
  })
}
