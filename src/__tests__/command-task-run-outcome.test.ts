/**
 * SCHEDDONEA1127: a command task's task_runs row records how the command
 * really ended, and when it really started.
 *
 * Before the fix finish() opened the row AFTER the command and always closed
 * it as 'done': a command that exited 1 or hit its timeout read as a success,
 * ts was the end time, and completed_at - ts was always 0. Measured on a live
 * install: crm-mail-sync logged ok:false with an exit code, and its row said
 * status=fired, outcome=done, 0 ms.
 *
 * Real commands, real (in-memory) database: the row is read back, not a mock.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: vi.fn(async () => {}) }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, listTaskRunHistory } from '../db.js'
import { runCommandTask } from '../web/command-task.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

function task(name: string, command: string, timeoutMs = 5000): ScheduledTask {
  return { name, type: 'command', command, agent: 'system', timeoutMs, failThreshold: 99 } as unknown as ScheduledTask
}

function rows(name: string) {
  return listTaskRunHistory(name, 10)
}

async function closedRow(name: string) {
  await vi.waitFor(() => {
    const r = rows(name)
    expect(r).toHaveLength(1)
    expect(r[0].completed_at).not.toBeNull()
  }, { timeout: 4000, interval: 20 })
  return rows(name)[0]
}

describe('command task run outcome (SCHEDDONEA1127)', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('an exit 0 command is closed as done', async () => {
    runCommandTask(task('outcome-ok', 'true'), Date.now())
    const r = await closedRow('outcome-ok')
    expect(r.outcome).toBe('done')
  })

  it('an exit 1 command is closed as failed, not done', async () => {
    runCommandTask(task('outcome-exit1', 'exit 1'), Date.now())
    const r = await closedRow('outcome-exit1')
    expect(r.outcome).toBe('failed')
  })

  it('a command that hits its timeout is closed as failed', async () => {
    runCommandTask(task('outcome-timeout', 'sleep 5', 200), Date.now())
    const r = await closedRow('outcome-timeout')
    expect(r.outcome).toBe('failed')
  })

  it('the row opens at fire time and keeps the real duration', async () => {
    const before = Date.now()
    runCommandTask(task('outcome-duration', 'sleep 0.4'), before)
    const after = Date.now()

    // Open while the command runs, stamped with the fire time.
    const open = rows('outcome-duration')
    expect(open).toHaveLength(1)
    expect(open[0].completed_at).toBeNull()
    expect(open[0].ts).toBeGreaterThanOrEqual(before)
    expect(open[0].ts).toBeLessThanOrEqual(after)

    const r = await closedRow('outcome-duration')
    expect(r.ts).toBe(open[0].ts)
    expect(r.outcome).toBe('done')
    expect(r.duration_ms).toBeGreaterThanOrEqual(300)
  })

  it('a tick skipped while the previous run is in flight opens no row', async () => {
    const t = task('outcome-inflight', 'sleep 0.3')
    runCommandTask(t, Date.now())
    runCommandTask(t, Date.now())
    expect(rows('outcome-inflight')).toHaveLength(1)
    await closedRow('outcome-inflight')
  })
})
