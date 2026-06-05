import { describe, it, expect } from 'vitest'
import { isMainChannelsAgent } from '../web/main-agent.js'
import { MAIN_AGENT_ID } from '../config.js'

// Locks the restart-routing policy: the main channels agent restarts via the
// systemd/launchd channels helper (hardRestartMarveenChannels), while every
// sub-agent keeps the agent-<name> process lifecycle. See the restart route in
// src/web/routes/agents.ts.
describe('isMainChannelsAgent', () => {
  it('is true for the main agent', () => {
    expect(isMainChannelsAgent(MAIN_AGENT_ID)).toBe(true)
  })

  it('is false for sub-agents (they keep the agent-process path)', () => {
    for (const name of ['dia', 'erno-ba', 'virgil', 'kolos', 'tekla', 'stori']) {
      expect(isMainChannelsAgent(name)).toBe(false)
    }
  })

  it('is false for empty / unknown names', () => {
    expect(isMainChannelsAgent('')).toBe(false)
    expect(isMainChannelsAgent('marveen-channels')).toBe(false) // the session name, not the agent id
  })
})
