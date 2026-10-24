// Once a day the dashboard asks Entra for a token with each Teams agent's
// credentials. A refused secret (wrong or expired) is alerted once until it
// works again; a network error is only logged.
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { channelStateDir, checkTeamsCredentials, readChannelEnv, type TokenValidation } from '../channel-provider.js'
import { agentDir, listAgentNames } from './agent-config.js'
import { readAgentTeamsConfig, readMarveenTeamsConfig } from './telegram.js'
import { whileNotFrozen } from './fleet-freeze.js'

export const TEAMS_CREDENTIAL_CHECK_MS = 24 * 60 * 60 * 1000
export const TEAMS_CREDENTIAL_INITIAL_DELAY_MS = 5 * 60 * 1000

export interface TeamsCredentialMonitorDeps {
  check?: (env: Record<string, string>) => Promise<TokenValidation>
  agents?: () => Array<{ name: string; envPath: string }>
  alert?: (text: string) => void
  log?: { warn: (obj: object, msg: string) => void }
}

export function teamsAgents(): Array<{ name: string; envPath: string }> {
  const out: Array<{ name: string; envPath: string }> = []
  if (readMarveenTeamsConfig().hasTeams) {
    out.push({ name: MAIN_AGENT_ID, envPath: join(channelStateDir('teams'), '.env') })
  }
  for (const name of listAgentNames()) {
    if (name === MAIN_AGENT_ID) continue
    if (readAgentTeamsConfig(name).hasTeams) {
      out.push({ name, envPath: join(agentDir(name), '.claude', 'channels', 'teams', '.env') })
    }
  }
  return out
}

export function createTeamsCredentialChecker(deps: TeamsCredentialMonitorDeps = {}): () => Promise<void> {
  const alerted = new Set<string>()
  const check = deps.check ?? checkTeamsCredentials
  const log = deps.log ?? logger
  // Loaded on first use: channel-monitor is a large module with its own start-up wiring.
  const alert = deps.alert ?? ((text: string) => {
    import('./channel-monitor.js')
      .then((m) => m.sendAlert(text))
      .catch((err) => log.warn({ error: String(err) }, 'teams-credential-monitor: alert could not be sent'))
  })
  return async () => {
    for (const { name, envPath } of (deps.agents ?? teamsAgents)()) {
      let r: TokenValidation
      try {
        r = await check(readChannelEnv(envPath, ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID']))
      } catch (err) {
        log.warn({ agent: name, error: String(err) }, 'teams-credential-monitor: check not possible')
        continue
      }
      if (r.ok) {
        alerted.delete(name)
      } else if (r.error?.startsWith('Teams credentials could not be checked')) {
        log.warn({ agent: name, error: r.error }, 'teams-credential-monitor: check not possible')
      } else if (!alerted.has(name)) {
        alerted.add(name)
        alert(`⚠️ ${name}: a Teams-bot hitelesítése nem sikerül (${r.error}). Amíg nincs új titok, a Teams-válaszok nem mennek ki.`)
      }
    }
  }
}

export function startTeamsCredentialMonitor(deps: TeamsCredentialMonitorDeps = {}): NodeJS.Timeout {
  const checker = createTeamsCredentialChecker(deps)
  const run = whileNotFrozen('teams-credential', () => {
    checker().catch((err) => logger.warn({ error: String(err) }, 'teams-credential-monitor: run failed'))
  })
  setTimeout(run, TEAMS_CREDENTIAL_INITIAL_DELAY_MS)
  return setInterval(run, TEAMS_CREDENTIAL_CHECK_MS)
}
