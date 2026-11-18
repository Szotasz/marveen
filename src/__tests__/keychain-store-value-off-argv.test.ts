import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

// VAULTKEYARGV1118: keychainStore must not put the value it stores in the argument list of the `security` process,
// where any process listing taken during the call shows it. The value goes on stdin to `security -i`; the argument
// list is only `-i`. A value that is not base64 is refused before any process starts (the interactive reader splits
// on whitespace). The `security` call is captured here; nothing touches the Keychain.
const calls = vi.hoisted(() => ({ list: [] as Array<{ file: string; args: string[]; opts: any }> }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (file: string, args: string[], opts: any) => { calls.list.push({ file, args: [...args], opts }); return '' },
  }
})
const { keychainStore } = await import('../web/keychain.js')

beforeEach(() => { calls.list.length = 0 })

describe('keychainStore: the stored value is not in the security argument list', () => {
  it('argv is `security -i` only; the value arrives on stdin, in one add command', () => {
    const value = randomBytes(64).toString('base64')
    keychainStore(value)
    expect(calls.list).toHaveLength(1)
    const [c] = calls.list
    expect(c.file).toBe('/usr/bin/security')
    expect(c.args).toEqual(['-i'])
    expect(JSON.stringify(c.args)).not.toContain(value)
    expect(c.opts.stdio[0]).toBe('pipe')
    expect(String(c.opts.input)).toBe(`add-generic-password -U -s com.marveen.vault -a master-key -w ${value} -A\n`)
    expect(c.opts.timeout).toBeGreaterThan(0)
  })

  it.each([
    ['a space', 'abc def'],
    ['a newline (a second command)', 'abc\ndelete-generic-password -s com.marveen.vault -a master-key'],
    ['a quote', 'abc"def'],
    ['empty', ''],
  ])('a value with %s is refused before any process starts', (_label, value) => {
    expect(() => keychainStore(value)).toThrow(/not base64/)
    expect(calls.list).toHaveLength(0)
  })
})
