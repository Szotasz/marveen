import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// #1878 (10): the coordinator's fatal path fired notify.sh and exited after a
// fixed 1.5 s, so a slower alert could be cut off by the exit. It now waits for
// the alert, capped. notify.sh is never run here: execFile is replaced by a
// stub whose callback fires when the test says so.
const { execCalls } = vi.hoisted(() => ({
  execCalls: [] as { args: string[]; cb: (err: Error | null) => void }[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execFile: (_file: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      execCalls.push({ args, cb })
      return {} as never
    },
  }
})

import { alertBeforeExit, fatalExit, FATAL_ALERT_CAP_MS } from '../channel-coordinator.js'
import { TelegramApiError } from '../channel-coordinator/telegram-client.js'

beforeEach(() => {
  execCalls.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('fatalExit waits for its alert (capped)', () => {
  it('does not exit while notify.sh is still running, even past the old 1.5 s', async () => {
    const exit = vi.fn() as unknown as (code: number) => never
    const done = fatalExit(new TelegramApiError('fatal', 'Unauthorized'), exit)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].args.join(' ')).toContain('channel-coordinator FATAL: Unauthorized')
    expect(exit).not.toHaveBeenCalled()
    execCalls[0].cb(null) // notify.sh finished
    await done
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('a failed alert still lets it exit', async () => {
    const exit = vi.fn() as unknown as (code: number) => never
    const done = fatalExit(new TelegramApiError('fatal', 'Unauthorized'), exit)
    await vi.advanceTimersByTimeAsync(0)
    execCalls[0].cb(new Error('notify.sh exit 1'))
    await done
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('an alert that never finishes is abandoned at the cap', async () => {
    const exit = vi.fn() as unknown as (code: number) => never
    const done = fatalExit(new TelegramApiError('fatal', 'Unauthorized'), exit)
    await vi.advanceTimersByTimeAsync(FATAL_ALERT_CAP_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('alertBeforeExit', () => {
  it('returns as soon as the alert resolves', async () => {
    let resolveAlert!: () => void
    let returned = false
    const p = alertBeforeExit(() => new Promise<void>((r) => { resolveAlert = r }), 10_000).then(() => { returned = true })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(returned).toBe(false)
    resolveAlert()
    await p
    expect(returned).toBe(true)
    expect(vi.getTimerCount()).toBe(0) // the cap timer is cleared
  })

  it('swallows a rejected alert', async () => {
    await expect(alertBeforeExit(() => Promise.reject(new Error('boom')), 10_000)).resolves.toBeUndefined()
  })
})
