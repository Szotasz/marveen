// realPidLockDeps.argvOf: how a /bin/ps outcome plus kill(pid, 0) are turned
// into string (the command line) / null (the process is gone) / undefined
// (cannot tell). execFileSync is mocked (per case) and process.kill is stubbed;
// the rest of node:child_process stays real.
//
// The fail-closed cases are the point (A, B, D): a LIVE holder whose ps output
// is empty must never read as "gone", because "gone" is what lets a second
// coordinator unlink the pid file and take the lock -> two pollers on one bot
// token -> 409 churn. Only ESRCH from kill(pid, 0) demotes it to null.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { realPidLockDeps } from '../channel-coordinator.js'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFileSync: vi.fn() }
})

const PID = 424242
const PS_ARGS = ['-p', String(PID), '-o', 'args=']

const exec = vi.mocked(execFileSync)

// Errors argvOf has to tell apart, built the way node hands them over.
const enoent = () => Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' })
// ps exits 1 with no output when the pid does not exist.
const psExit1NoOutput = () => Object.assign(new Error('ps: no such process'), { status: 1, stdout: '' })

// What each ps binary does; a command a case does not arm blows up instead of
// silently falling through.
const psBehaves = (binPs: string | Error, pathPs?: string | Error) => {
  exec.mockImplementation((cmd: string) => {
    const outcome = cmd === '/bin/ps' ? binPs : cmd === 'ps' ? pathPs ?? notConsulted() : notConsulted(cmd)
    if (typeof outcome === 'string') return outcome
    throw outcome
  })
}

const notConsulted = (cmd?: string): never => {
  throw Object.assign(
    new Error(cmd ? `unexpected ps invocation: ${cmd}` : 'ps from PATH was consulted where this case forbids it'),
    { code: 'ENOTRECOVERABLE' },
  )
}

const killSucceeds = () => vi.spyOn(process, 'kill').mockImplementation(() => true)
const killThrows = (code: string) => vi.spyOn(process, 'kill').mockImplementation(() => {
  throw Object.assign(new Error(`kill: ${code}`), { code })
})

// /bin/ps is the first candidate: pin that it was the one and only call.
const onlyBinPsWasConsulted = () => {
  expect(exec).toHaveBeenCalledTimes(1)
  expect(exec).toHaveBeenNthCalledWith(1, '/bin/ps', PS_ARGS, expect.anything())
}

beforeEach(() => {
  exec.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('realPidLockDeps.argvOf', () => {
  it('A: /bin/ps prints nothing, kill(pid, 0) succeeds -> undefined, never null (fail closed)', () => {
    killSucceeds()
    psBehaves('\n')
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
    onlyBinPsWasConsulted()
  })

  it('B: /bin/ps exits 1 with no output, kill(pid, 0) succeeds -> undefined, never null (fail closed)', () => {
    killSucceeds()
    psBehaves(psExit1NoOutput())
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
    onlyBinPsWasConsulted()
  })

  it('C: /bin/ps exits 1 with no output, kill throws ESRCH -> null (gone); control for B', () => {
    killThrows('ESRCH')
    psBehaves(psExit1NoOutput())
    expect(realPidLockDeps.argvOf(PID)).toBeNull()
    onlyBinPsWasConsulted()
  })

  it('D: /bin/ps prints nothing, kill throws EPERM -> undefined, never null (alive but not ours)', () => {
    killThrows('EPERM')
    psBehaves('')
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
    onlyBinPsWasConsulted()
  })

  it('E: ENOENT on /bin/ps falls back to ps from PATH and returns its command line', () => {
    killSucceeds()
    psBehaves(enoent(), 'node /x/dist/channel-coordinator.js\n')
    expect(realPidLockDeps.argvOf(PID)).toBe('node /x/dist/channel-coordinator.js')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenNthCalledWith(1, '/bin/ps', PS_ARGS, expect.anything())
    expect(exec.mock.calls[1]?.[0]).toBe('ps')
    expect(exec.mock.calls[1]?.[1]).toEqual(['-p', '424242', '-o', 'args='])
  })

  it('E2: ENOENT on both /bin/ps and ps -> undefined (no ps at all)', () => {
    killSucceeds()
    psBehaves(enoent(), enoent())
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1]?.[0]).toBe('ps')
  })
})
