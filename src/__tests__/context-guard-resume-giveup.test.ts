import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// When the restarted session does not become ready within READY_TIMEOUT_MS,
// the guard gives up on the resume injection. That decision is action 'none',
// and the runner's none-branch logged nothing: the agent could sit without the
// pointer to its handoff while nobody knew the resume path had failed. The
// runner now warns and tells a human -- the main agent for a sub-agent, the
// operator channel for the main agent itself.

const SANDBOX = mkdtempSync(join(tmpdir(), 'resume-giveup-test-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}) }))
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
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))

const { reportResumeGiveUp, resumeGiveUpNotice } = await import('../web/context-guard-runner.js')
const { decideGuard, DEFAULT_CONTEXT_GUARD, RESUME_GIVE_UP_REASON, READY_TIMEOUT_MS } = await import('../context-guard.js')
const { createAgentMessage } = await import('../db.js')
const { notifyChannel } = await import('../notify.js')
const { logger } = await import('../logger.js')

const RUNNER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../web/context-guard-runner.ts'),
  'utf-8',
)

beforeEach(() => {
  vi.mocked(createAgentMessage).mockReset()
  vi.mocked(notifyChannel).mockReset()
  vi.mocked(logger.warn).mockReset()
  vi.mocked(logger.error).mockReset()
})

describe('resume give-up', () => {
  it('the ready timeout decides with the reason the runner matches', () => {
    const NOW = 1_000_000_000
    const d = decideGuard(
      {
        phase: 'await-ready',
        handoffMtimeAtRequest: null,
        deadlineMs: NOW,
        cooldownUntilMs: 0,
        saturatedStreak: 0,
        staleRefreshCount: 0,
        handoffStaleMinutes: null,
      },
      {
        nowMs: NOW,
        pct: null,
        running: true,
        paneIdle: true,
        paneBusy: false,
        sessionReady: false,
        handoffMtime: null,
        paneSaturated: false,
        dailyHandoffDue: false,
        contextTokens: null,
        idleMs: null,
        usageLimited: false,
        pendingResumeExpiresAtMs: null,
      },
      { ...DEFAULT_CONTEXT_GUARD, enabled: true },
    )
    expect(d.action).toBe('none')
    expect(d.reason).toBe(RESUME_GIVE_UP_REASON)
  })

  it('checkAgent reports the give-up from its none-branch', () => {
    const start = RUNNER_SRC.indexOf('async function checkAgent(')
    const end = RUNNER_SRC.indexOf('export function getContextGuardStatus(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = RUNNER_SRC.slice(start, end)
    const noneBranch = body.indexOf("if (decision.action === 'none') {")
    expect(noneBranch).toBeGreaterThan(-1)
    const wiring = body.indexOf('if (decision.reason === RESUME_GIVE_UP_REASON) await reportResumeGiveUp(name)')
    expect(wiring).toBeGreaterThan(noneBranch)
    // inside the none-branch: before that branch's own early return
    expect(wiring).toBeLessThan(body.indexOf('return', noneBranch))
  })

  it('a sub-agent give-up warns and messages the main agent', async () => {
    await reportResumeGiveUp('samu')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(createAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, text] = vi.mocked(createAgentMessage).mock.calls[0]
    expect(from).toBe('samu')
    expect(to).toBe('marveen')
    expect(text).toContain('"samu"')
    expect(text).toContain('NEM ment ki')
    expect(text).toContain('HANDOFF.md')
    expect(notifyChannel).not.toHaveBeenCalled()
  })

  it('a main-agent give-up goes to the operator channel, not to its own inbox', async () => {
    await reportResumeGiveUp('marveen')
    expect(notifyChannel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyChannel).mock.calls[0][0]).toContain('"marveen"')
    expect(createAgentMessage).not.toHaveBeenCalled()
  })

  it('a failing sink is logged, not thrown', async () => {
    vi.mocked(createAgentMessage).mockImplementation(() => { throw new Error('db down') })
    await expect(reportResumeGiveUp('samu')).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('the notice names the agent, the timeout and the handoff path', () => {
    const text = resumeGiveUpNotice('samu', '/x/HANDOFF.md')
    expect(text).toContain('"samu"')
    expect(text).toContain(`${READY_TIMEOUT_MS / 60_000} percen belul`)
    expect(text).toContain('/x/HANDOFF.md')
  })
})
