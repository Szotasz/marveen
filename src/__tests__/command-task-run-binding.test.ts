import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pins the binding between runCommandTask and resolveCommandPlaceholders.
// The resolver has its own unit tests, but those stay green even if
// runCommandTask stops calling it and hands task.command to the shell
// verbatim -- at which point a shipped task would run the literal
// `python3 {{PROJECT_ROOT}}/...` and fail on every run. Here the executor is
// mocked and the argument it actually receives is asserted.

const h = vi.hoisted(() => ({ calls: [] as unknown[][] }))

vi.mock('node:child_process', async (orig) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...(await orig() as object),
    // runCommand is async (spawn, not spawnSync): the executor records the
    // argv synchronously and hands back a child that exits 0 on the next tick.
    spawn: vi.fn((...args: unknown[]) => {
      h.calls.push(args)
      type Emitter = InstanceType<typeof EventEmitter>
      const child = new EventEmitter() as Emitter & { stdout: Emitter & { resume: () => void }; stderr: Emitter; kill: () => void }
      child.stdout = Object.assign(new EventEmitter(), { resume: () => {} })
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setImmediate(() => child.emit('close', 0))
      return child
    }),
  }
})
vi.mock('../config.js', async (orig) => ({
  ...(await orig() as object),
  PROJECT_ROOT: '/opt/marveen root',
  STORE_DIR: '/nonexistent-store-for-test',
  TELEGRAM_BOT_TOKEN: '',
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({ appendTaskRun: vi.fn(() => 1), markTaskRunCompleted: vi.fn() }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: vi.fn(async () => {}) }))

import { runCommandTask } from '../web/command-task.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

describe('runCommandTask placeholder binding', () => {
  beforeEach(() => { h.calls.length = 0 })

  it('executes the command with {{PROJECT_ROOT}} resolved to the shell-quoted install root', () => {
    const task = {
      name: 'usage-collect-binding-test',
      type: 'command',
      command: 'python3 {{PROJECT_ROOT}}/scripts/usage-collect.py',
    } as unknown as ScheduledTask
    runCommandTask(task, 1_000)

    expect(h.calls).toHaveLength(1)
    const [file, argv] = h.calls[0] as [string, string[]]
    expect(file).toBe('bash')
    expect(argv).toEqual(['-lc', "python3 '/opt/marveen root'/scripts/usage-collect.py"])
    expect(argv.join(' ')).not.toContain('{{')
  })
})
