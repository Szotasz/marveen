/**
 * The command runner must NOT block the Node event loop.
 *
 * It used to use spawnSync, and that took the whole dashboard down: while a
 * command ran, nothing was served -- no HTTP, no /api/messages, not even the
 * server's own log. It became a deadlock because a command can call BACK into
 * the dashboard (a heartbeat gate that wakes an agent does), so the server waited for a script
 * that was waiting for the server. Measured 2026-09-14: four minutes dead out
 * of every thirty.
 *
 * The first test is the one that matters -- it fails on the old code.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, TELEGRAM_BOT_TOKEN: '', STORE_DIR: '/tmp' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const mod = await import('../web/command-task.js')

describe('command task execution', () => {
  it('does not block the event loop while the command runs', async () => {
    // A timer that should fire DURING the command. Under spawnSync the loop is
    // blocked and the tick can only land after the command is done.
    let tickedAt = 0
    const started = Date.now()
    setTimeout(() => { tickedAt = Date.now() - started }, 40)

    mod.runCommandTask(
      { name: 'evloop-probe', type: 'command', command: 'sleep 0.6', agent: 'system', timeoutMs: 5000 } as never,
      Math.floor(Date.now() / 1000),
    )

    await new Promise((r) => setTimeout(r, 300))
    expect(tickedAt).toBeGreaterThan(0)
    expect(tickedAt).toBeLessThan(300) // fired while `sleep 0.6` was still running
  })

  it('a second tick is skipped while the first run is still in flight', async () => {
    const task = { name: 'overlap-probe', type: 'command', command: 'sleep 0.5', agent: 'system', timeoutMs: 5000 } as never
    mod.runCommandTask(task, Math.floor(Date.now() / 1000))
    // Immediately again: must be refused, not piled up.
    mod.runCommandTask(task, Math.floor(Date.now() / 1000))
    const { logger } = await import('../logger.js')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'overlap-probe' }),
      expect.stringContaining('still running'),
    )
    await new Promise((r) => setTimeout(r, 700))
  })
})
