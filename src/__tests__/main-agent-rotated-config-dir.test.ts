// resolveMainAgentRotatedConfigDir (PR2c, design 6.5/4): the main agent's
// CLAUDE_CONFIG_DIR when the rotation side-car has recorded an active plan
// for it. Sibling of resolveMainAgentConfigDir's tests in
// main-agent-config-dir.test.ts, gated the same way rotation itself is
// (design 6.2): MAIN_AGENT_ISOLATED_CONFIG=1 AND 2+ registered plans.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'

let isolationSetting = ''
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_ISOLATED_CONFIG' ? isolationSetting : actual.getEffectiveSettingValue(key),
  }
})

let plans: Array<{ id: string; configDir: string }> = []
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: () => plans,
  getClaudePlan: (id: string | null | undefined) => plans.find((p) => p.id === id) ?? null,
}))

let activePlanByAgent: Record<string, string> = {}
vi.mock('../web/claude-plans-state.js', () => ({
  readClaudePlansState: () => ({ activePlanByAgent, plans: {} }),
}))

const { resolveMainAgentRotatedConfigDir } = await import('../web/agent-process.js')

beforeEach(() => {
  isolationSetting = '1'
  plans = [
    { id: 'pro', configDir: '/opt/claude-pro' },
    { id: 'team', configDir: '/opt/claude-team' },
  ]
  activePlanByAgent = { [MAIN_AGENT_ID]: 'team' }
})

describe('resolveMainAgentRotatedConfigDir', () => {
  it('returns the active plan configDir when isolation is on and 2+ plans exist', () => {
    expect(resolveMainAgentRotatedConfigDir()).toBe('/opt/claude-team')
  })

  it('returns null when MAIN_AGENT_ISOLATED_CONFIG is off', () => {
    isolationSetting = '0'
    expect(resolveMainAgentRotatedConfigDir()).toBeNull()
  })

  it('returns null with fewer than 2 registered plans, even with a stale active entry', () => {
    plans = [{ id: 'team', configDir: '/opt/claude-team' }]
    expect(resolveMainAgentRotatedConfigDir()).toBeNull()
  })

  it('returns null when no plan is active for the main agent yet (bootstrap gap)', () => {
    activePlanByAgent = {}
    expect(resolveMainAgentRotatedConfigDir()).toBeNull()
  })

  it('returns null when the recorded active plan id no longer resolves (deleted/renamed)', () => {
    activePlanByAgent = { [MAIN_AGENT_ID]: 'gone' }
    expect(resolveMainAgentRotatedConfigDir()).toBeNull()
  })

  it('is keyed by MAIN_AGENT_ID, not any sub-agent entry in the same state file', () => {
    activePlanByAgent = { someSubAgent: 'pro' }
    expect(resolveMainAgentRotatedConfigDir()).toBeNull()
  })
})
