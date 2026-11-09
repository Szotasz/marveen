// DASHNAME1109: the name a person SEES for an agent id, in text the dashboard shows (the overview's activity feed).
//
// The main agent's routing id (MAIN_AGENT_ID) and its display name (BOT_NAME) differ on a renamed install. Measured
// on the Bridge path: the headless installer runs with the default name, so MAIN_AGENT_ID becomes "marveen"; the
// dashboard wizard then renames the agent ("Patex") in BOT_NAME/BRAND_NAME and, on purpose, leaves the routing id.
// Text built from the raw id then showed "marveen" in the middle of a dashboard that says "Patex" everywhere else.
//
// The rule: the main agent's id -> its current display name (read fresh, the wizard writes .env at run time); a known
// sub-agent -> its display name (agent-config.json displayName, else the title-cased name); anything else (system,
// coordinator, a federated "peer/agent" id, an unknown or empty value) -> the id itself, unchanged. Routing, logs and
// agent-to-agent text keep using the id; this is only for what a person reads.

import { MAIN_AGENT_ID, currentBotName } from '../config.js'
import { isKnownAgent, readAgentDisplayName } from './agent-config.js'

export interface AgentDisplayLabelDeps {
  mainAgentId: string
  botName: () => string
  isKnownAgent: (id: string) => boolean
  displayName: (id: string) => string
}

const defaultDeps: AgentDisplayLabelDeps = {
  mainAgentId: MAIN_AGENT_ID,
  botName: currentBotName,
  isKnownAgent,
  displayName: readAgentDisplayName,
}

export function agentDisplayLabel(id: string | null | undefined, deps: AgentDisplayLabelDeps = defaultDeps): string {
  const raw = typeof id === 'string' ? id : ''
  if (!raw) return raw
  if (raw === deps.mainAgentId) return deps.botName() || raw
  // A federated "peer/agent" id is never a local sub-agent directory; it is shown as it is.
  if (raw.includes('/')) return raw
  try {
    if (deps.isKnownAgent(raw)) return deps.displayName(raw) || raw
  } catch { /* an unreadable config shows the id */ }
  return raw
}
