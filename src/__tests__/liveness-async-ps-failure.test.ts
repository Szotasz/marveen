// The ps-failure paths of the async liveness probes, with execFile (their only
// seam) mocked and the rest of node:child_process real:
//   - snapshotProcsAsync's first /bin/ps failure is retried ONCE, with the
//     longer deadline, before takeProcSnapshotAsync gives up with null;
//   - a shared-snapshot 'down' whose fresh re-probe ps fails must come back
//     'unknown', never 'down' -- a down restarts the agent, so a probe that
//     could not see anything must not condemn the agent on its own blindness.
// The tests spawn nothing themselves: no fixtures, no sleeps, no network, only
// the mock answering or failing in-process.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn() }
})

import { execFile } from 'node:child_process'
import {
  takeProcSnapshotAsync,
  probeChannelPluginLivenessAsync,
  PS_PROBE_TIMEOUT_MS,
  PS_PROBE_RETRY_TIMEOUT_MS,
} from '../channel-coordinator/liveness.js'

// promisify(execFile) finds no Symbol.for('nodejs.util.promisify.custom') on a
// vi.fn, so it calls the mock as (file, args, opts, cb) and resolves with cb's
// 2nd argument: success is cb(null, { stdout, stderr }), failure cb(err).
type PsCallback = (err: Error | null, out?: { stdout: string, stderr: string }) => void
type PsImpl = (file: string, args: string[], opts: { timeout?: number }, cb: PsCallback) => void
type PsCall = Parameters<PsImpl>

// A snapshot with no channel poller anywhere near claudePid 999999.
const NO_POLLER_SNAPSHOT = 'PID PPID COMMAND\n  1     0 /sbin/init\n'

function onPs(impl: PsImpl) {
  vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile)
}

const psFails: PsImpl = (_file, _args, _opts, cb) => {
  cb(new Error('ps timed out'))
}
const psFailsOnceThenSucceedsWith = (stdout: string): PsImpl => (_file, _args, _opts, cb) => {
  // vitest records a call before running its implementation, so the first
  // invocation is the only one that sees exactly one recorded call.
  if (vi.mocked(execFile).mock.calls.length === 1) cb(new Error('ps timed out'))
  else cb(null, { stdout, stderr: '' })
}

const psCalls = (): PsCall[] => vi.mocked(execFile).mock.calls as unknown as PsCall[]

describe('takeProcSnapshotAsync: the ps fast path is retried once, longer', () => {
  beforeEach(() => { vi.mocked(execFile).mockReset() })

  it('resolves with the second ps stdout when the first /bin/ps fails', async () => {
    expect(PS_PROBE_TIMEOUT_MS).toBe(5000)
    expect(PS_PROBE_RETRY_TIMEOUT_MS).toBe(12000)
    onPs(psFailsOnceThenSucceedsWith(NO_POLLER_SNAPSHOT))
    expect(await takeProcSnapshotAsync()).toBe(NO_POLLER_SNAPSHOT)
    const calls = psCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c[0])).toEqual(['/bin/ps', '/bin/ps'])
    expect(calls[0][2].timeout).toBe(PS_PROBE_TIMEOUT_MS)
    expect(calls[1][2].timeout).toBe(PS_PROBE_RETRY_TIMEOUT_MS)
  })

  it('resolves null when both attempts fail', async () => {
    onPs(psFails)
    expect(await takeProcSnapshotAsync()).toBeNull()
    expect(psCalls()).toHaveLength(2)
  })
})

describe('probeChannelPluginLivenessAsync: a failed re-probe never confirms a down', () => {
  beforeEach(() => { vi.mocked(execFile).mockReset() })

  it('a shared down whose fresh ps fails twice is unknown, not down', async () => {
    onPs(psFails)
    const r = await probeChannelPluginLivenessAsync(999999, 'telegram', 'agent-x', {}, NO_POLLER_SNAPSHOT)
    expect(r).toBe('unknown')
    // The re-probe really ran: both the fast attempt and its retry.
    expect(psCalls()).toHaveLength(2)
  })

  it('control: the same shared down with a succeeding re-probe stays down', async () => {
    onPs(psFailsOnceThenSucceedsWith(NO_POLLER_SNAPSHOT))
    const r = await probeChannelPluginLivenessAsync(999999, 'telegram', 'agent-x', {}, NO_POLLER_SNAPSHOT)
    expect(r).toBe('down')
    expect(psCalls()).toHaveLength(2)
  })

  it('a fresh probe without a snapshot whose ps fails twice is unknown', async () => {
    onPs(psFails)
    const r = await probeChannelPluginLivenessAsync(999999, 'telegram', 'agent-x')
    expect(r).toBe('unknown')
    expect(psCalls()).toHaveLength(2)
  })
})
