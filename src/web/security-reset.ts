// Break-glass security reset (AUTHPLAN1 #5).
//
// One operation that returns dashboard access to its baseline: every device
// key revoked, every per-agent scoped token revoked, every browser session
// cleared. Passwords and users are NOT
// touched (use dashboard-user reset-password/remove for those) and the bearer
// token keeps working -- this is the "some credential I handed out is loose,
// cut them all NOW" lever, not a factory reset.
//
// Future login-enforcement toggles (deferred to the next release) must be
// cleared here too, so a reset can never leave the operator locked out by a
// half-configured policy.
//
// Lives outside the CLI so the logic is unit-testable and reusable; the CLI
// (scripts/dashboard-user.ts security:reset) is a thin wrapper.

import { logConfigChange } from '../db.js'
import { revokeAllDeviceKeys } from './auth-device-keys.js'
import { revokeAllAgentTokens } from './auth-agent-tokens.js'
import { revokeAllSessions } from './auth-sessions.js'

export interface SecurityResetResult {
  deviceKeysRevoked: number
  agentTokensRevoked: number
  sessionsCleared: number
}

export function securityReset(actor: string): SecurityResetResult {
  const deviceKeysRevoked = revokeAllDeviceKeys()
  // A scoped agent token is a credential handed to a machine that is NOT this
  // one -- exactly the thing a break-glass reset exists to cut.
  const agentTokensRevoked = revokeAllAgentTokens()
  const sessionsCleared = revokeAllSessions()
  // Counts only -- never credential material -- into the audit trail.
  logConfigChange('security.reset', null, `device_keys=${deviceKeysRevoked} agent_tokens=${agentTokensRevoked} sessions=${sessionsCleared}`, actor)
  return { deviceKeysRevoked, agentTokensRevoked, sessionsCleared }
}
