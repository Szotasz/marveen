import { describe, it, expect, vi } from 'vitest'
import { Writable } from 'node:stream'
import { randomBytes } from 'node:crypto'

// VAULTKEYLOG1118: keychainStore passes the value it stores in the `security` argument list, and a failed
// execFileSync carries the whole command line in its error message. vault.ts logs that message when the Keychain
// migration or store fails, so the value reached the dashboard log. The error that leaves keychainStore must not
// hold the value, on its message, its stack or anything the logger prints.
//
// The `security` call is replaced by a REAL child process that fails the same way (a shell exiting 36, the stored
// value still in its argument list), so the error is the one Node really builds. Nothing touches the Keychain.
const fail = vi.hoisted(() => ({ mode: 'exit' as 'exit' | 'timeout' }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (file: string, args: string[], opts: Record<string, unknown>) =>
      fail.mode === 'exit'
        ? actual.execFileSync('/bin/sh', ['-c', 'exit 36', file, ...args], opts as any)
        : actual.execFileSync('/bin/sh', ['-c', 'sleep 5', file, ...args], { ...opts, timeout: 50 } as any),
  }
})
const { keychainStore } = await import('../web/keychain.js')
const { createLogger } = await import('../logger.js')

function caught(value: string): any {
  try { keychainStore(value) } catch (err) { return err }
  throw new Error('keychainStore did not throw')
}

describe('keychainStore: a failed store does not carry the stored value', () => {
  it('control: the error Node builds for this failure holds the argument list', async () => {
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const value = randomBytes(64).toString('base64')
    let msg = ''
    try { execFileSync('/bin/sh', ['-c', 'exit 36', 'security', '-w', value], { stdio: 'ignore' }) } catch (err: any) { msg = String(err.message) }
    expect(msg).toContain(value)
  })

  it.each(['exit', 'timeout'] as const)('%s: the thrown error names the outcome, never the value', (mode) => {
    fail.mode = mode
    const value = randomBytes(64).toString('base64')
    const err = caught(value)
    const all = [String(err.message), String(err.stack), JSON.stringify(err), String(err.cause ?? '')].join('\n')
    expect(all).not.toContain(value)
    expect(err.message).toMatch(/^security add-generic-password failed \(exit status /)
    expect(err.cause).toBeUndefined()
  })

  it('the warning vault.ts writes on a failed migration does not reach the log with the value', () => {
    fail.mode = 'exit'
    const value = randomBytes(64).toString('base64')
    const lines: string[] = []
    const log = createLogger(new Writable({ write(c, _e, cb) { lines.push(String(c)); cb() } }) as any)
    const err = caught(value)
    // the exact call shape of src/web/vault.ts (migration and first-store branches)
    log.warn({ err: err.message }, 'Keychain migration failed, keeping file-based key')
    log.warn({ err }, 'Keychain store failed, falling back to file')
    expect(lines.length).toBe(2)
    expect(lines.join('')).not.toContain(value)
  })
})
