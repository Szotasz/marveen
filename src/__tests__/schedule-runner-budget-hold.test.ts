import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Pins the agent budget hold in the cron tick (#2208 review: three wiring mutants
// survived the source-position test). The hold must touch only background work
// (heartbeats) of a held agent, record the held occurrence as 'skipped', and do
// nothing with the feature off. Measured through a real tick, not by reading source.

const mockAppendTaskRun = vi.fn()
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

// Scheduled-task registry: the runner fires only registry-matched tasks and the API routes register what
// they write. The registry gate is covered by schedule-source-registry.test.ts; here it is a passthrough.
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  getPendingTaskRetry: () => undefined,
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: vi.fn(async () => {}),
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-budget-hold-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

const BASE = { description: 'budget hold fixture', prompt: 'Do the thing.', schedule: '* * * * *', enabled: true, createdAt: 0 }
const HB_HELD: ScheduledTask = { ...BASE, name: 'budget-hb-held', type: 'heartbeat', agent: 'held-agent', targetSession: 'sess-hb-held' }
const HB_FREE: ScheduledTask = { ...BASE, name: 'budget-hb-free', type: 'heartbeat', agent: 'free-agent', targetSession: 'sess-hb-free' }
const OWNER_HELD: ScheduledTask = { ...BASE, name: 'budget-owner-held', type: 'task', agent: 'held-agent', targetSession: 'sess-owner-held' }

// Real-time wait for real I/O while the fake clock stands still.
async function until(cond: () => boolean, ms = 8_000): Promise<void> {
  const t0 = performance.now()
  while (!cond() && performance.now() - t0 < ms) await new Promise<void>((r) => setImmediate(r))
}

async function runOneTick(held: string[], done: () => boolean) {
  vi.resetModules()
  const { setAgentBudgetHoldForTest } = await import('../web/agent-budget-alerts.js')
  setAgentBudgetHoldForTest(held)
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(5_001)
  await until(done)
  // Let the tick finish whatever it does after the condition, so a late send or row would be seen.
  await until(() => false, 1_500)
  clearInterval(stop)
}

const sentSessions = () => mockSendPrompt.mock.calls.map(c => String(c[0]))
const skippedRows = () => mockAppendTaskRun.mock.calls.filter(c => c[2] === 'skipped').map(c => [c[0], c[1]])

describe('agent budget hold in a real cron tick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendPrompt.mockImplementation(() => 'sent')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-07-31T06:00:30.000Z'))
    mockListScheduledTasks.mockReturnValue([HB_HELD, HB_FREE, OWNER_HELD])
  })
  afterEach(() => { vi.useRealTimers() })
  // Cold module import plus the 1.5 s settle window exceed the 5 s default.
  vi.setConfig({ testTimeout: 20_000 })

  it('feature off (nothing held): every task fires for its agent and no run is skipped', async () => {
    await runOneTick([], () => sentSessions().length >= 3)
    expect(sentSessions().sort()).toEqual(['sess-hb-free', 'sess-hb-held', 'sess-owner-held'])
    expect(skippedRows()).toEqual([])
  })

  it('feature on: the held agent\'s heartbeat is held back and recorded as skipped; its owner-facing task and the other agent\'s heartbeat fire', async () => {
    await runOneTick(['held-agent'], () => sentSessions().length >= 2 && skippedRows().length >= 1)
    expect(sentSessions().sort()).toEqual(['sess-hb-free', 'sess-owner-held'])
    expect(skippedRows()).toEqual([['budget-hb-held', 'held-agent']])
  })
})
