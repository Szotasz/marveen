// Once a day the dashboard asks Entra for a token with each Teams agent's
// credentials. A refused secret (wrong or expired) is alerted once until it
// works again; a network error is only logged.
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { channelStateDir, checkTeamsCredentials, readChannelEnv, teamsSecretExpiry, TEAMS_SECRET_EXPIRY_KEY, TEAMS_SECRET_WARN_DAYS, type TokenValidation } from '../channel-provider.js'
import { agentDir, listAgentNames } from './agent-config.js'
import { readAgentTeamsConfig, readMarveenTeamsConfig } from './telegram.js'
import { whileNotFrozen } from './fleet-freeze.js'

export const TEAMS_CREDENTIAL_CHECK_MS = 24 * 60 * 60 * 1000
export const TEAMS_CREDENTIAL_INITIAL_DELAY_MS = 5 * 60 * 1000

export interface TeamsCredentialMonitorDeps {
  check?: (env: Record<string, string>) => Promise<TokenValidation>
  agents?: () => Array<{ name: string; envPath: string }>
  alert?: (text: string) => void
  now?: () => number
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
  const expiryAlerts = new Map<string, { date: string; sent: Set<string> }>()
  const invalidWarned = new Map<string, string>()
  const now = deps.now ?? Date.now
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
      const env = readChannelEnv(envPath, ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID', TEAMS_SECRET_EXPIRY_KEY])
      try {
        r = await check(env)
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
      const e = teamsSecretExpiry(env[TEAMS_SECRET_EXPIRY_KEY], now())
      if (e.state === 'invalid') {
        if (invalidWarned.get(name) !== e.value) {
          invalidWarned.set(name, e.value)
          log.warn({ agent: name, value: e.value }, 'teams-credential-monitor: secret expiry date is not YYYY-MM-DD; ignored')
        }
      } else if (e.state !== 'missing') {
        let entry = expiryAlerts.get(name)
        if (!entry || entry.date !== e.date) {
          entry = { date: e.date, sent: new Set() }
          expiryAlerts.set(name, entry)
        }
        if (e.state === 'expired') {
          if (!entry.sent.has('expired')) {
            entry.sent.add('expired')
            alert(`⚠️ ${name}: a Teams-bot titka lejárt (${e.date}). Amíg nincs új titok, a Teams-válaszok nem mennek ki.`)
          }
        } else if (e.state === 'soon') {
          const k = [...TEAMS_SECRET_WARN_DAYS].sort((a, b) => a - b).find((w) => e.daysLeft <= w)!
          if (!entry.sent.has(String(k))) {
            for (const w of TEAMS_SECRET_WARN_DAYS) if (w >= k) entry.sent.add(String(w))
            alert(`⏳ ${name}: a Teams-bot titka ${e.daysLeft} nap múlva lejár (${e.date}). Cseréld le, mielőtt a Teams-válaszok leállnak.`)
          }
        }
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
