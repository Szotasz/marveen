// FIGURAKULCS1125: the desktop companion's own read endpoint. A 'companion' scoped device key lists the agents it may
// send to: id and display name only, never the agent configuration or state that GET /api/agents returns. The gate
// (auth-gate.ts companionGate) lets the key reach this path and POST /api/messages, nothing else.
import { MAIN_AGENT_ID } from '../../config.js'
import { getCompanionKeyLimits } from '../auth-device-keys.js'
import { companionRecipients } from '../auth-gate.js'
import { isKnownAgent, readAgentDisplayName } from '../agent-config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleCompanion(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, auth } = ctx
  if (path !== '/api/companion/recipients') return false
  if (method !== 'GET') {
    json(res, { error: 'Method not allowed' }, 405)
    return true
  }
  if (auth?.kind !== 'device' || auth.scope !== 'companion' || auth.deviceId === undefined) {
    json(res, { error: 'This endpoint is for a companion device key' }, 403)
    return true
  }
  const limits = getCompanionKeyLimits(auth.deviceId)
  if (!limits) {
    json(res, { error: 'The key could not be verified' }, 403)
    return true
  }
  // A listed agent that no longer exists is left out: the key cannot send to it either (the route answers 400).
  const recipients = companionRecipients(limits, MAIN_AGENT_ID)
    .filter((id) => id === MAIN_AGENT_ID || isKnownAgent(id))
    .map((id) => ({ id, name: readAgentDisplayName(id) }))
  json(res, { recipients })
  return true
}
