import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Card 59458fb6: runner-level DST tests. The unit tests (cron-dst.test.ts)
// pin cronPrevOccurrence; this drives the real startScheduleRunner tick loop
// on a fake clock across the Budapest transitions (2026-10-25 autumn,
// 2027-03-28 spring) and counts runCommandTask calls per task:
//   - a wall-clock-anchored cron fires exactly once in the repeated autumn
//     hour (before the fix 02:07 fired at 00:07Z AND 01:07Z);
//   - interval crons keep firing on both real passes of the repeated hour;
//   - a slot that falls into the spring gap fires once at the transition
//     instant (01:00Z = 03:00 CEST), interval crons get no extra catch-up;
//   - a restart inside the repeated hour does not re-fire the task.
//
// The runner reads and writes store/schedule-last-run.json and
// store/schedule-tick-state.json. This suite never touches a real store file:
// node:fs reads/existsSync under any /store/ directory are served from an
// in-memory map, and the atomic-write mock stores into the same map, so a
// simulated restart sees exactly what the previous run persisted.

const fakeStore = vi.hoisted(() => ({
  files: new Map<string, string>(),
  reads: [] as string[],
  writes: [] as string[],
  // Basename when the path lies under a store/ directory, else null.
  storeKey(p: unknown): string | null {
    return typeof p === 'string' && /[\\/]store[\\/]/.test(p) ? (p.split(/[\\/]/).pop() ?? null) : null
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const key = fakeStore.storeKey(p)
    if (key !== null) {
      fakeStore.reads.push(key)
      const content = fakeStore.files.get(key)
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${key}'`), { code: 'ENOENT' })
      }
      return content
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof actual.readFileSync
  const existsSync = ((p: unknown) => {
    const key = fakeStore.storeKey(p)
    return key !== null ? fakeStore.files.has(key) : actual.existsSync(p as string)
  }) as typeof actual.existsSync
  return { ...actual, readFileSync, existsSync, default: { ...actual, readFileSync, existsSync } }
})

// The runner persists its last-run map and liveness stamp through this; both
// land in the in-memory fake store, never on disk.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (p: string, data: string | Buffer) => {
    const key = fakeStore.storeKey(p)
    if (key === null) return
    fakeStore.writes.push(key)
    fakeStore.files.set(key, String(data))
  },
}))

const mockRunCommandTask = vi.fn()
const mockAppendTaskRun = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
const mockSendPrompt = vi.fn(() => 'sent')

vi.mock('../web/command-task.js', () => ({
  runCommandTask: (...a: unknown[]) => mockRunCommandTask(...a),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
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

// The runner's alert paths resolve a real bot token and send to the real owner
// chat; neutralize the sink so a green suite never costs the operator anything.
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

// Registry gate is a passthrough here (own suite: schedule-source-registry.test.ts).
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-schedule-dst-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'not in tests' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

const TICK_MS = 15_000
const MIN = 60_000
const t = (iso: string): number => Date.parse(iso)

// catchUpMaxAgeMinutes -1 = never stale: every due occurrence the runner sees
// is executed, so a duplicate cannot hide behind the stale/missed path.
function cmd(name: string, schedule: string): ScheduledTask {
  return {
    name,
    schedule,
    description: 'dst fixture',
    prompt: 'echo dst-probe',
    agent: 'dstagent',
    enabled: true,
    createdAt: 0,
    type: 'command',
    catchUpMaxAgeMinutes: -1,
  }
}

function resetWorld(tasks: ScheduledTask[]): void {
  vi.clearAllMocks()
  fakeStore.files.clear()
  fakeStore.reads.length = 0
  fakeStore.writes.length = 0
  mockListScheduledTasks.mockReturnValue(tasks)
}

async function startRunner(): Promise<NodeJS.Timeout> {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  return startScheduleRunner()
}

// Advance the fake clock to `iso` in chunks; the runner ticks every 15 s
// (first tick 5 s after start), so a tick runs at start+5s+15s*k.
async function advanceTo(iso: string): Promise<void> {
  const target = t(iso)
  while (Date.now() < target) {
    await vi.advanceTimersByTimeAsync(Math.min(10 * MIN, target - Date.now()))
  }
}

// Tick `now` of every runCommandTask call for `name` (the runner passes its
// tick's `now`, so it is within one tick after the occurrence that fired).
function firesOf(name: string): number[] {
  return mockRunCommandTask.mock.calls
    .filter(c => (c[0] as ScheduledTask).name === name)
    .map(c => c[1] as number)
}

// Exactly one fire, and it belongs to the occurrence at `occIso`: the tick
// that fired it lies in [occurrence, occurrence + one tick].
function expectOneFireAt(fires: number[], occIso: string): void {
  expect(fires, `fires: ${fires.map(f => new Date(f).toISOString()).join(', ')}`).toHaveLength(1)
  expect(fires[0]).toBeGreaterThanOrEqual(t(occIso))
  expect(fires[0]).toBeLessThanOrEqual(t(occIso) + TICK_MS)
}

// Map each fire to the occurrence instant it belongs to (floor of the tick to
// the cron's grid), so a list compares against the expected occurrences.
function occurrencesOf(fires: number[], stepMin: number, fromIso: string): string[] {
  const step = stepMin * MIN
  return fires
    .filter(f => f >= t(fromIso))
    .map(f => new Date(Math.floor(f / step) * step).toISOString())
}

// Per-task fire lists captured from one simulated run.
type Sim = Record<string, number[]>

async function simulate(tasks: ScheduledTask[], startIso: string, endIso: string): Promise<Sim> {
  resetWorld(tasks)
  vi.useFakeTimers()
  vi.setSystemTime(new Date(startIso))
  try {
    const stop = await startRunner()
    await advanceTo(endIso)
    clearInterval(stop)
    return Object.fromEntries(tasks.map(task => [task.name, firesOf(task.name)]))
  } finally {
    vi.useRealTimers()
  }
}

beforeAll(() => {
  vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('schedule runner across the autumn DST end (2026-10-25, Europe/Budapest)', () => {
  let sim: Sim
  let storeReads: string[]
  let storeWrites: string[]

  beforeAll(async () => {
    sim = await simulate(
      [
        cmd('dst-7-2', '7 2 * * *'),
        cmd('dst-0-2', '0 2 * * *'),
        cmd('dst-30-2', '30 2 * * *'),
        cmd('dst-half-hourly', '*/30 * * * *'),
        cmd('dst-hourly', '0 * * * *'),
        cmd('dst-30-3', '30 3 * * *'),
      ],
      '2026-10-24T23:30:00.000Z',
      '2026-10-25T03:00:00.000Z',
    )
    storeReads = [...fakeStore.reads]
    storeWrites = [...fakeStore.writes]
  }, 120_000)

  it('NEGATIVE CONTROL: the runner read and wrote its store state through the in-memory fake only', () => {
    expect(storeReads).toContain('schedule-tick-state.json')
    expect(storeReads).toContain('schedule-last-run.json')
    expect(storeWrites).toContain('schedule-tick-state.json')
    expect(storeWrites).toContain('schedule-last-run.json')
  })

  it('AC1: "7 2 * * *" runs exactly once, for the 00:07Z occurrence', () => {
    expectOneFireAt(sim['dst-7-2'], '2026-10-25T00:07:00.000Z')
  })

  it('AC1: "0 2 * * *" runs exactly once at 00:00Z and "30 2 * * *" exactly once at 00:30Z', () => {
    expectOneFireAt(sim['dst-0-2'], '2026-10-25T00:00:00.000Z')
    expectOneFireAt(sim['dst-30-2'], '2026-10-25T00:30:00.000Z')
  })

  it('AC2: "*/30 * * * *" fires on both real passes of the repeated hour, no duplicate, no gap', () => {
    const occ = occurrencesOf(sim['dst-half-hourly'], 30, '2026-10-25T00:00:00.000Z')
    expect(occ).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T02:30:00.000Z',
    ])
  })

  it('AC2: "0 * * * *" fires at 00:00Z and 01:00Z (both real hours) and 02:00Z', () => {
    const occ = occurrencesOf(sim['dst-hourly'], 60, '2026-10-25T00:00:00.000Z')
    expect(occ).toEqual(['2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z'])
  })

  it('CONTROL: a fixed slot after the repeated hour ("30 3 * * *" = 02:30Z) is unaffected, once', () => {
    expectOneFireAt(sim['dst-30-3'], '2026-10-25T02:30:00.000Z')
  })
})

describe('schedule runner across the spring DST start (2027-03-28, Europe/Budapest)', () => {
  let sim: Sim

  beforeAll(async () => {
    sim = await simulate(
      [
        cmd('dst-30-2', '30 2 * * *'),
        cmd('dst-0-2', '0 2 * * *'),
        cmd('dst-30-2-3', '30 2,3 * * *'),
        cmd('dst-half-hourly', '*/30 * * * *'),
        cmd('dst-0-3', '0 3 * * *'),
      ],
      '2027-03-27T23:30:00.000Z',
      '2027-03-28T03:00:00.000Z',
    )
  }, 120_000)

  it('AC3: "30 2 * * *" (slot in the vanished hour) runs exactly once, at the transition 01:00Z', () => {
    expectOneFireAt(sim['dst-30-2'], '2027-03-28T01:00:00.000Z')
  })

  it('AC3: "0 2 * * *" runs exactly once, at 01:00Z', () => {
    expectOneFireAt(sim['dst-0-2'], '2027-03-28T01:00:00.000Z')
  })

  it('AC3: "30 2,3 * * *" runs twice: the catch-up at 01:00Z and the real 03:30 CEST slot at 01:30Z', () => {
    const fires = sim['dst-30-2-3']
    expect(fires, `fires: ${fires.map(f => new Date(f).toISOString()).join(', ')}`).toHaveLength(2)
    expect(fires[0]).toBeGreaterThanOrEqual(t('2027-03-28T01:00:00.000Z'))
    expect(fires[0]).toBeLessThanOrEqual(t('2027-03-28T01:00:00.000Z') + TICK_MS)
    expect(fires[1]).toBeGreaterThanOrEqual(t('2027-03-28T01:30:00.000Z'))
    expect(fires[1]).toBeLessThanOrEqual(t('2027-03-28T01:30:00.000Z') + TICK_MS)
  })

  it('AC4: "*/30 * * * *" gets no extra catch-up: 00:30Z, then 01:00Z, then 01:30Z, each once', () => {
    const occ = occurrencesOf(sim['dst-half-hourly'], 30, '2027-03-28T00:00:00.000Z')
    expect(occ).toEqual([
      '2027-03-28T00:00:00.000Z',
      '2027-03-28T00:30:00.000Z',
      '2027-03-28T01:00:00.000Z',
      '2027-03-28T01:30:00.000Z',
      '2027-03-28T02:00:00.000Z',
      '2027-03-28T02:30:00.000Z',
    ])
  })

  it('CONTROL: "0 3 * * *" (a real slot at the transition instant) runs once, not once more for the catch-up', () => {
    expectOneFireAt(sim['dst-0-3'], '2027-03-28T01:00:00.000Z')
  })
})

describe('schedule runner restart inside the repeated autumn hour (AC5)', () => {
  const SECOND_PASS = t('2026-10-25T01:07:00.000Z')

  interface Scenario {
    label: string
    runFirstUntil: string
    restartAt: string
    dropTickState: boolean
    // Does the first scan window after the restart contain the 01:07Z pass?
    windowCoversSecondPass: boolean
  }

  const scenarios: Scenario[] = [
    {
      label: 'persisted liveness stamp from just before the restart (01:19Z)',
      runFirstUntil: '2026-10-25T01:19:30.000Z',
      restartAt: '2026-10-25T01:20:00.000Z',
      dropTickState: false,
      windowCoversSecondPass: false,
    },
    {
      label: 'old liveness stamp (00:30Z): the catch-up window spans the second 02:07',
      runFirstUntil: '2026-10-25T00:30:00.000Z',
      restartAt: '2026-10-25T01:20:00.000Z',
      dropTickState: false,
      windowCoversSecondPass: true,
    },
    {
      label: 'cold start, no tick-state file (30 minute window spans the second 02:07)',
      runFirstUntil: '2026-10-25T00:30:00.000Z',
      restartAt: '2026-10-25T01:20:00.000Z',
      dropTickState: true,
      windowCoversSecondPass: true,
    },
  ]

  it.each(scenarios)('"7 2 * * *" does not fire again: $label', async (sc) => {
    resetWorld([cmd('dst-7-2', '7 2 * * *'), cmd('dst-half-hourly', '*/30 * * * *')])
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T23:30:00.000Z'))

    // First process: runs through the first 02:07 (00:07Z), then goes down.
    const stop1 = await startRunner()
    await advanceTo(sc.runFirstUntil)
    clearInterval(stop1)
    const firesBeforeRestart = firesOf('dst-7-2')
    expect(firesBeforeRestart.length, 'precondition: the first pass ran before the restart').toBeGreaterThanOrEqual(1)

    if (sc.dropTickState) fakeStore.files.delete('schedule-tick-state.json')
    const stampRaw = fakeStore.files.get('schedule-tick-state.json')
    const stampMs = stampRaw ? (JSON.parse(stampRaw) as { lastTickMs: number }).lastTickMs : null

    // Second process: a fresh module (empty in-memory state) on a fresh clock;
    // everything it knows about the past comes from the fake store.
    vi.useRealTimers()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(sc.restartAt))
    const restartMs = Date.now()
    const windowStartMs = stampMs == null ? restartMs - 30 * MIN : Math.max(stampMs, restartMs - 24 * 60 * MIN)
    expect(windowStartMs < SECOND_PASS, 'precondition: window coverage of the 01:07Z pass').toBe(sc.windowCoversSecondPass)

    const stop2 = await startRunner()
    await advanceTo('2026-10-25T02:30:00.000Z')
    clearInterval(stop2)

    const all = firesOf('dst-7-2')
    expect(all, `fires: ${all.map(f => new Date(f).toISOString()).join(', ')}`).toHaveLength(1)
    expect(all.filter(f => f >= restartMs)).toHaveLength(0)
    // The second process really ticked (01:30Z and 02:00Z at least), so the
    // missing fire above is a decision, not a dead runner.
    const intervalAfterRestart = firesOf('dst-half-hourly').filter(f => f >= restartMs)
    expect(intervalAfterRestart.length).toBeGreaterThanOrEqual(2)
    // And not a stale/missed record either.
    expect(mockAppendTaskRun.mock.calls.filter(c => c[0] === 'dst-7-2' && c[2] === 'missed')).toHaveLength(0)
  }, 120_000)
})
