// Is plan rotation in effect for the main agent's login (QUOTAHDRROT1118)?
//
// One gate, shared by the rotation heartbeat (activeTokenPlan in
// claude-plan-rotate-check-run.ts) and the last-resort rate-limit header
// reading (claude-ratelimit-reading.ts), so the two cannot disagree. It mirrors
// the launch side (agent-process.ts resolveActiveMainPlan and the
// main-agent-isolated-config.mjs precedence): a recorded plan only drives the
// main agent's login with MAIN_AGENT_ISOLATED_CONFIG=1, 2+ plans, and no
// explicit MAIN_AGENT_CONFIG_DIR. When this is true, the host's default login
// (what usage-collect.py reads its token from) is not necessarily the account
// the main agent spends.
import { getEffectiveSettingValue } from './settings-store.js'
import type { ClaudePlan } from './web/claude-plans.js'

export function planRotationInEffect(plans: readonly ClaudePlan[]): boolean {
  let isolated = false
  try { isolated = String(getEffectiveSettingValue('MAIN_AGENT_ISOLATED_CONFIG')) === '1' } catch { isolated = false }
  if (!isolated) return false
  let explicitDir = ''
  try { explicitDir = String(getEffectiveSettingValue('MAIN_AGENT_CONFIG_DIR') ?? '').trim() } catch { explicitDir = '' }
  if (explicitDir) return false
  return plans.length >= 2
}
