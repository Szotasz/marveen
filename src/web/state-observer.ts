// agent-state-observer launch wiring (MODSTERMEK1005).
//
// The observer is a Claude Code mod (plugins/agent-state-observer): it only
// watches the session and writes the agent's state to <STORE>/mod-state/
// <agent>.json. It is OFF by default and per agent: `"stateObserver": true` in
// the agent's agent-config.json turns it on, and the launcher then exports
// three variables into that agent's launch command:
//   CLAUDE_CODE_PLUGIN_DIRS     loads the mod folder for this session only
//   MARVEEN_AGENT_ID            the name the mod writes under
//   MARVEEN_STATE_OBSERVER_DIR  the folder it writes into
// Nothing reads the state file yet: alerting on it is a later, measured step.
//
// Version gate: Claude Code loads mods from 2.1.287 on. Below that, or when the
// version cannot be measured, the variables are simply not exported -- the
// agent starts exactly as before, with no error and no alert. A remote or
// run-as agent is skipped as well: the mod folder and the state folder are
// paths on THIS machine, readable by this OS user.

import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { compareVersions } from '../claude-cli-support.js'

export const STATE_OBSERVER_MIN_CLI = '2.1.287'
export const STATE_OBSERVER_PLUGIN_DIR = join(PROJECT_ROOT, 'plugins', 'agent-state-observer')
export const STATE_OBSERVER_STATE_DIR = join(STORE_DIR, 'mod-state')

export interface StateObserverInput {
  enabled: boolean
  isMainAgent: boolean
  installedCli: string | null
  remote: boolean
  runAs: boolean
}

export function decideStateObserver(i: StateObserverInput): { load: boolean; reason: string } {
  if (!i.enabled) return { load: false, reason: 'off (stateObserver not set)' }
  if (i.isMainAgent) return { load: false, reason: 'main agent: launched by the channels service, not here' }
  if (i.remote) return { load: false, reason: 'remote agent: the mod folder is a local path' }
  if (i.runAs) return { load: false, reason: 'run-as agent: another OS user may not reach the mod or state folder' }
  if (!i.installedCli) return { load: false, reason: 'Claude Code version not measurable' }
  if (compareVersions(i.installedCli, STATE_OBSERVER_MIN_CLI) < 0) {
    return { load: false, reason: `Claude Code ${i.installedCli} is below ${STATE_OBSERVER_MIN_CLI}` }
  }
  return { load: true, reason: 'on' }
}

/**
 * The `export ... && ` prefix for the launch command; '' when not loading.
 * `quote` is the launcher's shSingleQuote (passed in: importing it here would
 * make agent-process and this module import each other).
 */
export function stateObserverLaunchEnv(
  load: boolean,
  agentName: string,
  quote: (value: string) => string,
  pluginDir: string = STATE_OBSERVER_PLUGIN_DIR,
  stateDir: string = STATE_OBSERVER_STATE_DIR,
): string {
  if (!load) return ''
  const q = quote
  return `export CLAUDE_CODE_PLUGIN_DIRS=${q(pluginDir)} MARVEEN_AGENT_ID=${q(agentName)} MARVEEN_STATE_OBSERVER_DIR=${q(stateDir)} && `
}
