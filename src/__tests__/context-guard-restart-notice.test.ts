import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// The restart notice told the main agent that messages sent to the old session
// "may have been lost -- check and resend them", without measuring anything.
// Pending rows are delivered into the fresh session once it is ready, and the
// resume prompt makes the fresh session re-read the restart window itself, so a
// resend lands as a duplicate. The notice now carries the queue counts instead.

const SANDBOX = mkdtempSync(join(tmpdir(), 'restart-notice-test-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn(), countRestartQueueState: vi.fn() }))
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

const { restartNoticeQueueText, restartQueueAtRestart, restartLossLine, resumePrompt } = await import('../web/context-guard-runner.js')
const { countRestartQueueState } = await import('../db.js')
const realDb = await vi.importActual<typeof import('../db.js')>('../db.js')

const RUNNER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../web/context-guard-runner.ts'),
  'utf-8',
)

const RESEND_ADVICE = 'kuldd ujra oket'

describe('restart notice: queue sentence', () => {
  it('no longer tells the supervisor to resend, in any state', () => {
    for (const q of [null, { pending: 0, failed: 0 }, { pending: 3, failed: 0 }, { pending: 0, failed: 2 }, { pending: 1, failed: 1 }]) {
      expect(restartNoticeQueueText(q)).not.toContain(RESEND_ADVICE)
    }
  })

  it('carries both counts', () => {
    expect(restartNoticeQueueText({ pending: 3, failed: 2 })).toContain('3 pending, 2 failed')
  })

  it('pending rows: do not resend, they reach the fresh session', () => {
    const t = restartNoticeQueueText({ pending: 3, failed: 0 })
    expect(t).toContain('A 3 pending sort a router a friss sessionbe kezbesiti')
    expect(t).toContain('NE kuldd ujra')
    expect(t).not.toContain('failed sort')
  })

  it('failed rows are the ones to look at', () => {
    const t = restartNoticeQueueText({ pending: 0, failed: 2 })
    expect(t).toContain('A 2 failed sort a router mar NEM probalja ujra')
    expect(t).not.toContain('pending sort')
  })

  it('points at the resume re-read for rows the old session received', () => {
    expect(restartNoticeQueueText({ pending: 0, failed: 0 })).toContain('a friss session maga olvassa vissza')
    // ...only if the resume actually happens: a ready-timeout gives it up
    expect(restartNoticeQueueText({ pending: 2, failed: 0 })).toContain('ha nem, a sort es ezeket az uzeneteket kezzel nezd meg')
    // and that re-read instruction really is in every resume prompt variant
    for (const p of [resumePrompt('samu', '/x/HANDOFF.md', false), resumePrompt('samu', '/x/HANDOFF.md', true, 42)]) {
      expect(p).toContain('RESTART-ABLAK')
    }
  })

  it('an unmeasurable queue is said out loud, not guessed', () => {
    const t = restartNoticeQueueText(null)
    expect(t).toContain('NEM tudtam megmerni')
    expect(t).not.toContain('pending')
  })
})

describe('restart notice: the count', () => {
  beforeEach(() => { vi.mocked(countRestartQueueState).mockReset() })

  it('counts the restarted agent over the last hour', () => {
    vi.mocked(countRestartQueueState).mockReturnValue({ pending: 4, failed: 1 })
    const before = Math.floor(Date.now() / 1000)
    expect(restartQueueAtRestart('samu')).toEqual({ pending: 4, failed: 1 })
    const [agent, since] = vi.mocked(countRestartQueueState).mock.calls[0]
    expect(agent).toBe('samu')
    expect(since).toBeGreaterThanOrEqual(before - 3600)
    expect(since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 3600)
  })

  it('a failing count yields null, which the notice says out loud', () => {
    vi.mocked(countRestartQueueState).mockImplementation(() => { throw new Error('db down') })
    expect(restartQueueAtRestart('samu')).toBeNull()
    expect(restartLossLine(false, false, 30, null)).toContain('NEM tudtam megmerni')
  })

  it('the generic loss line carries the counts; the worksource idle-flush line is unchanged', () => {
    const generic = restartLossLine(false, false, 30, { pending: 2, failed: 1 })
    expect(generic).toContain('2 pending, 1 failed')
    expect(generic).not.toContain(RESEND_ADVICE)
    expect(restartLossLine(true, false, 30, { pending: 2, failed: 1 })).toContain('2 pending, 1 failed')
    expect(restartLossLine(false, true, 30, { pending: 2, failed: 1 })).toContain('2 pending, 1 failed')
    const worksource = restartLossLine(true, true, 30, { pending: 2, failed: 1 })
    expect(worksource).toContain('ujrakezbesulnek')
    expect(worksource).not.toContain('pending')
  })

  it('checkAgent builds the restart notice with the counted sentence', () => {
    const start = RUNNER_SRC.indexOf('async function checkAgent(')
    const end = RUNNER_SRC.indexOf('export function getContextGuardStatus(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = RUNNER_SRC.slice(start, end)
    const notice = body.indexOf('[CONTEXT-GUARD] Ujrainditottam')
    expect(notice).toBeGreaterThan(-1)
    const sentence = body.indexOf('restartQueueAtRestart(name)', notice)
    expect(sentence).toBeGreaterThan(notice)
    expect(sentence).toBeLessThan(body.indexOf("'context-guard restart notice'", notice))
    expect(body).not.toContain(RESEND_ADVICE)
  })
})

describe('countRestartQueueState', () => {
  beforeAll(() => { realDb.initDatabase(':memory:') })

  it('counts pending rows to the agent, and failed rows since the cutoff', () => {
    const now = Math.floor(Date.now() / 1000)
    const mk = (to: string) => realDb.createAgentMessage('sender', to, 'x')!.id
    mk('samu'); mk('samu') // pending
    mk('laci') // pending, other agent
    // Two recent fails against one old one: a reversed cutoff would count 1, not 2.
    const recentFail = mk('samu')
    const recentFail2 = mk('samu')
    const oldFail = mk('samu')
    const delivered = mk('samu')
    realDb.markMessageFailed(recentFail, 'boom')
    realDb.markMessageFailed(recentFail2, 'boom')
    realDb.markMessageFailed(oldFail, 'boom')
    realDb.getDb().prepare('UPDATE agent_messages SET completed_at = ? WHERE id = ?').run(now - 7200, oldFail)
    realDb.getDb().prepare("UPDATE agent_messages SET status = 'delivered' WHERE id = ?").run(delivered)

    expect(realDb.countRestartQueueState('samu', now - 3600)).toEqual({ pending: 2, failed: 2 })
    expect(realDb.countRestartQueueState('laci', now - 3600)).toEqual({ pending: 1, failed: 0 })
    expect(realDb.countRestartQueueState('nobody', now - 3600)).toEqual({ pending: 0, failed: 0 })
  })
})
