import { describe, expect, it, vi } from 'vitest'

vi.mock('../web/agent-config.js', async original => ({
  ...await original<typeof import('../web/agent-config.js')>(),
  readAgentEngineConfig: () => ({ engine: 'codex', codexConfigDir: '/pilot/codex' }),
}))
vi.mock('../web/auto-restart-store.js', () => ({ readAutoRestartConfig: vi.fn() }))
vi.mock('../web/context-guard-store.js', () => ({ readContextGuardConfig: vi.fn() }))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))

const { readAutoRestartConfig } = await import('../web/auto-restart-store.js')
const { readContextGuardConfig } = await import('../web/context-guard-store.js')
const { checkAutoRestartAgent } = await import('../web/auto-restart-runner.js')
const { checkContextGuardAgent, measureContextTokens, measurePct, measureIdleMs, getHardGuardPhase, contextGuardDeliveryHold } = await import('../web/context-guard-runner.js')

describe('Codex supervision dispatch', () => {
  it('does not read restart configuration or make restart decisions', async () => {
    await checkAutoRestartAgent('pilot', Date.now())
    expect(readAutoRestartConfig).not.toHaveBeenCalled()
  })
  it('does not gather context inputs or read guard configuration', async () => {
    await checkContextGuardAgent('pilot', Date.now())
    expect(readContextGuardConfig).not.toHaveBeenCalled()
    expect(measureContextTokens('pilot')).toBeNull()
    expect(measurePct('pilot', null)).toBeNull()
    expect(measureIdleMs('pilot', Date.now())).toBeNull()
    expect(getHardGuardPhase('pilot')).toBe('idle')
    expect(contextGuardDeliveryHold('pilot', Date.now())).toBeNull()
  })
})
