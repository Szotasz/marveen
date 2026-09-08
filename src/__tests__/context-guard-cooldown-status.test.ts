import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// CGBADGE908: the /api/context-guard status carries cooldownUntilMs ONLY in
// the cooldown phase, so the badge can show the remaining time (what the word
// "cooldown" promises) and no consumer ever reads a stale timestamp as a live
// timer. Both branches pinned -- a happy-path-only test would let either rot.
const SANDBOX = mkdtempSync(join(tmpdir(), 'cgstatus-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentRunState: () => 'stopped',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: vi.fn(),
  capturePane: () => null,
  sendPromptToSession: vi.fn(),
  isSessionReadyForPrompt: async () => false,
}))

const { cooldownStatusExtra } = await import('../web/context-guard-runner.js')

describe('cooldownStatusExtra (CGBADGE908)', () => {
  it('carries cooldownUntilMs in the cooldown phase', () => {
    const until = Date.now() + 10 * 60_000
    expect(cooldownStatusExtra({ phase: 'cooldown', cooldownUntilMs: until })).toEqual({
      cooldownUntilMs: until,
    })
  })

  it('sends nothing outside cooldown, even when a stale timestamp lingers in state', () => {
    const stale = Date.now() - 60_000
    expect(cooldownStatusExtra({ phase: 'idle', cooldownUntilMs: stale })).toEqual({})
    expect(cooldownStatusExtra({ phase: 'await-handoff', cooldownUntilMs: stale })).toEqual({})
    expect(cooldownStatusExtra(undefined)).toEqual({})
  })

  it('sends nothing for a cooldown phase with no timestamp (zeroed state)', () => {
    expect(cooldownStatusExtra({ phase: 'cooldown', cooldownUntilMs: 0 })).toEqual({})
  })
})
