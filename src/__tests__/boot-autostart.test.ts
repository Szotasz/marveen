import { describe, it, expect, vi } from 'vitest'

vi.mock('../web/agent-process.js', () => ({ isAgentRunning: vi.fn(), startAgentProcess: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({ sendAlert: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: vi.fn(() => true) }))

import { normalizeBootAutostartConfig, agentsToStart } from '../web/boot-autostart.js'

// BOOTSTART924: after a host reboot only the dashboard + main session came back.
describe('boot autostart', () => {
  it('normalizes: keeps valid, deduplicated names; drops junk', () => {
    const c = normalizeBootAutostartConfig({ agents: ['agent-a', 'agent-a', 'agent-b', '../x', 3], staggerMs: 1000 })
    expect(c).toEqual({ enabled: true, agents: ['agent-a', 'agent-b'], staggerMs: 1000 })
  })
  it('an explicit enabled:false disables it', () => {
    expect(agentsToStart(normalizeBootAutostartConfig({ enabled: false, agents: ['agent-a'] }), () => true, () => false)).toEqual([])
  })
  it('starts only listed, known agents that are not already running', () => {
    const cfg = normalizeBootAutostartConfig({ agents: ['agent-a', 'agent-b', 'ghost'] })
    const known = (n: string) => n !== 'ghost'
    const running = (n: string) => n === 'agent-b'
    expect(agentsToStart(cfg, known, running)).toEqual(['agent-a'])
  })
  it('a plain dashboard restart (everything up) is a no-op', () => {
    expect(agentsToStart(normalizeBootAutostartConfig({ agents: ['agent-a', 'agent-b'] }), () => true, () => true)).toEqual([])
  })
})
