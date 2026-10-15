// The scheduler's pre-injection usage-limit gate, wired.
//
// Measured on the live install: 2798 scheduled prompts typed into a main
// session that answered each one "You're out of extra usage · resets 6am
// (Europe/Budapest)" between 2026-09-20T02:19Z and 2026-09-21T03:59Z. The
// exhausted session sat at an idle prompt, so the readiness check passed every
// time. This pins the gate that now reads the pane first:
//
//   clean pane                -> injected, as before;
//   the real banner on screen -> NOT injected, the cron run recorded as
//                                'skipped-usage-limit', a warn logged;
//   capture failed (null)     -> injected anyway (fail-open), with a warn.
//
// Driven through the real attemptFireTask (via runScheduledTaskNow and one
// real cron tick), with tmux and the DB mocked -- same fixture shape as the
// sibling scheduler suites.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const BANNER = "You're out of extra usage · resets 6am (Europe/Budapest)"
const LIMITED_PANE = [
  '> SCHEDULED TASK NOTICE -- the next <scheduled-task source="scheduled-task:morning-digest">',
  `  ⎿  ${BANNER}`,
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')
const CLEAN_PANE = LIMITED_PANE.replace(`  ⎿  ${BANNER}`, '● Nothing to drain.')

const mockAppendTaskRun = vi.fn()
const mockSendPrompt = vi.fn(async () => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
const mockWarn = vi.fn()
const mockSendMessage = vi.fn(async () => {})
// The first `gateCaptures` captures return gatePane (the gate's own, plus
// forceSend's earlier one when the case sets it to 2); every later one (the
// post-send resubmit loop) sees nothing, same as the sibling fixtures.
let gatePane: string | null = null
let gateCaptures = 1
let captureCalls = 0

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// Neutralize the real alert sink: the owner notice must be observable here,
// and must never reach a real chat from a test run.
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    readChannelToken: () => 'test-token',
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: (...a: unknown[]) => mockSendMessage(...(a as [])),
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})

// Pin the owner chat. Unmocked, it resolves from the host: ALLOWED_CHAT_ID or
// <TELEGRAM_STATE_DIR>/access.json. A machine with a paired channel passes and a
// clean CI runner (neither set) suppresses the notice, so the owner-notice
// assertions below would measure the host, not the gate.
const OWNER_CHAT = 'test-owner-chat'
vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => OWNER_CHAT }
})

// importOriginal: upstream v1.41.0's schedule-runner reads more constants from this
// module (SCHEDULED_TASK_BODY_WARN_CHARS ...) than the v1.40.0-era fixture listed.
vi.mock('../web/scheduled-tasks-io.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/scheduled-tasks-io.js')>()
  return {
    ...real,
    listScheduledTasks: () => mockListScheduledTasks(),
    SCHEDULED_TASKS_DIR: '/tmp/marveen-usage-limit-gate-no-tasks-dir',
  }
})

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: vi.fn(async () => true),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(async () => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: (..._a: unknown[]) => (captureCalls++ < gateCaptures ? gatePane : null),
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(async () => false),
  resolveAgentProvider: () => 'telegram',
  saturationRefusesDispatch: () => false,
}))

function task(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
  return {
    description: 'usage-limit gate fixture',
    prompt: 'Do the thing.',
    schedule: '0 8 * * *',
    agent: 'limitagent',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    targetSession: 'usage-limit-test-session',
    ...overrides,
  }
}

const gateWarned = () =>
  mockWarn.mock.calls.some(c => typeof c[1] === 'string' && c[1].includes('usage-limit gate'))

describe('scheduler usage-limit gate (attemptFireTask)', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T02:30:00.000Z'))
    captureCalls = 0
    gateCaptures = 1
    gatePane = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  async function runNow(t: ScheduledTask) {
    vi.resetModules()
    mockListScheduledTasks.mockReturnValue([t])
    const { runScheduledTaskNow } = await import('../web/schedule-runner.js')
    return runScheduledTaskNow(t.name)
  }

  it('injects when the pane is clean', async () => {
    gatePane = CLEAN_PANE
    const res = await runNow(task({ name: 'ul-clean' }))
    expect(res.result).toBe('limitagent: fired')
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(gateWarned()).toBe(false)
  })

  for (const type of ['heartbeat', 'task'] as const) {
    it(`does NOT inject a ${type} when the pane shows the real "out of extra usage" line`, async () => {
      gatePane = LIMITED_PANE
      const res = await runNow(task({ name: `ul-limited-${type}`, type }))
      expect(res.result).toBe('limitagent: usage-limited')
      expect(mockSendPrompt).not.toHaveBeenCalled()
      expect(gateWarned()).toBe(true)
      // One owner notice for the episode, naming the banner.
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
      expect((mockSendMessage.mock.calls[0] as unknown[])[1]).toBe(OWNER_CHAT)
      expect(String((mockSendMessage.mock.calls[0] as unknown[])[2])).toContain(BANNER)
    })
  }

  it('forceSend does not bypass it -- an exhausted session cannot run a forced prompt either', async () => {
    gatePane = LIMITED_PANE
    gateCaptures = 2 // forceSend's saturation/first-run capture, then the gate's
    const res = await runNow(task({ name: 'ul-force', type: 'task', forceSend: true }))
    expect(res.result).toBe('limitagent: usage-limited')
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('a failed capture injects anyway and logs a warn (fail-open)', async () => {
    gatePane = null
    const res = await runNow(task({ name: 'ul-capture-error' }))
    expect(res.result).toBe('limitagent: fired')
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockWarn.mock.calls.some(c => c[1] === 'usage-limit gate: pane capture failed, injecting without the check')).toBe(true)
  })

  it('a short-cadence (skipIfBusy) cron occurrence held back by the gate is recorded as skipped-usage-limit', async () => {
    gatePane = LIMITED_PANE
    vi.resetModules()
    // Due every minute, so the first tick (5 s after start) has an occurrence.
    mockListScheduledTasks.mockReturnValue([task({ name: 'ul-cron', schedule: '* * * * *', skipIfBusy: true })])
    const { startScheduleRunner } = await import('../web/schedule-runner.js')
    const stop = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(6_000)
    clearInterval(stop)

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun).toHaveBeenCalledWith('ul-cron', 'limitagent', 'skipped-usage-limit')
    expect(mockAppendTaskRun).not.toHaveBeenCalledWith('ul-cron', 'limitagent', 'fired')
  })

  it('a daily task held back by the gate is QUEUED for retry, not dropped for the day', async () => {
    // A stale banner (the limit already lifted) must not cost a daily task its
    // occurrence: the retry loop goes through the same gate and is delivered by
    // its next probe, or as soon as the banner is gone.
    gatePane = LIMITED_PANE
    vi.resetModules()
    const db = await import('../db.js')
    mockListScheduledTasks.mockReturnValue([task({ name: 'ul-daily', type: 'task', schedule: '* * * * *' })])
    const { startScheduleRunner } = await import('../web/schedule-runner.js')
    const stop = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(6_000)
    clearInterval(stop)

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(db.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('ul-daily', 'limitagent', expect.any(Number), 'usage-limited')
    expect(mockAppendTaskRun).not.toHaveBeenCalledWith('ul-daily', 'limitagent', 'skipped-usage-limit')
  })
})
