// acquireSingleInstanceLock must END the process (exit code 1) when the pid
// lock is refused, and must not exit when the lock is free or reclaimed. The
// exit is what keeps two pollers off one bot token, so it is injected here and
// asserted directly, the same way fatalExit is tested elsewhere. The state
// directory does not exist beforehand, so the mkdir path is exercised too.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSingleInstanceLock, type PidLockDeps } from '../channel-coordinator.js'

class ExitCalled extends Error {
  constructor(public code: number) { super('exit ' + code) }
}

const mkExit = () => vi.fn((code: number): never => { throw new ExitCalled(code) })

// A pid that is never ours, so the "held by a live coordinator" cases cannot
// accidentally take the our-own-pid-file shortcut.
let HOLDER = 999999
if (HOLDER === process.pid) HOLDER = 999998

let dir: string
let pidFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-lock-exit-'))
  pidFile = join(dir, 'state', 'coordinator.pid')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireSingleInstanceLock exit behaviour', () => {
  it('a live coordinator holding the lock ends startup with exit(1)', () => {
    expect(HOLDER).not.toBe(process.pid)
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(pidFile, String(HOLDER))
    const deps: PidLockDeps = { isAlive: () => true, argvOf: () => 'node /opt/app/dist/channel-coordinator.js' }
    const exit = mkExit()
    expect(() => acquireSingleInstanceLock(pidFile, deps, exit)).toThrow(ExitCalled)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(HOLDER))
  })

  it('a live holder whose command line cannot be read ends startup with exit(1)', () => {
    expect(HOLDER).not.toBe(process.pid)
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(pidFile, String(HOLDER))
    const deps: PidLockDeps = { isAlive: () => true, argvOf: () => undefined }
    const exit = mkExit()
    expect(() => acquireSingleInstanceLock(pidFile, deps, exit)).toThrow(ExitCalled)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(HOLDER))
  })

  it('a free lock does not exit and records our pid', () => {
    const deps: PidLockDeps = { isAlive: () => false, argvOf: () => null }
    const exit = mkExit()
    expect(() => acquireSingleInstanceLock(pidFile, deps, exit)).not.toThrow()
    expect(exit).not.toHaveBeenCalled()
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid))
    expect(existsSync(join(dir, 'state'))).toBe(true)
  })

  it('a stale pid file (dead holder) is reclaimed without exit', () => {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(pidFile, String(HOLDER))
    const deps: PidLockDeps = { isAlive: () => false, argvOf: () => null }
    const exit = mkExit()
    expect(() => acquireSingleInstanceLock(pidFile, deps, exit)).not.toThrow()
    expect(exit).not.toHaveBeenCalled()
    expect(readFileSync(pidFile, 'utf-8')).toBe(String(process.pid))
  })
})
