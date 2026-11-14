// Fault injection for the read-back of the token file: the check cannot fail
// while the write path is correct, so the write path is made to go wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fault = vi.hoisted(() => ({ corrupt: false, widen: false, foreignOwned: [] as string[], foreignFd: false }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      real.renameSync(from, to)
      // A broken writer or an outside hand: the file that landed is not what was meant.
      if (fault.corrupt && String(to).endsWith('support-access.token')) real.writeFileSync(to, 'mst_' + 'x'.repeat(43) + '\n')
      if (fault.widen && String(to).endsWith('support-access.token')) real.chmodSync(to, 0o644)
    },
    // Another owner cannot be set up without root: the stat results say so instead.
    lstatSync: ((path: unknown, ...rest: unknown[]) => {
      const st = (real.lstatSync as (...a: unknown[]) => import('node:fs').Stats)(path, ...rest)
      if (!fault.foreignOwned.includes(String(path))) return st
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 })
    }) as typeof real.lstatSync,
    fstatSync: ((fd: number, ...rest: unknown[]) => {
      const st = (real.fstatSync as (...a: unknown[]) => import('node:fs').Stats)(fd, ...rest)
      if (!fault.foreignFd) return st
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 })
    }) as typeof real.fstatSync,
  }
})

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { writeSupportToken, readSupportToken, SupportTokenError, SUPPORT_TOKEN_FILE } = await import('../support-access-token.js')

const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'

describe('support token on disk, when the write goes wrong', () => {
  let root: string
  let file: string

  beforeEach(() => {
    root = realFs.mkdtempSync(join(tmpdir(), 'support-token-faults-'))
    file = join(root, SUPPORT_TOKEN_FILE)
    fault.corrupt = false
    fault.widen = false
    fault.foreignOwned = []
    fault.foreignFd = false
  })
  afterEach(() => {
    realFs.rmSync(root, { recursive: true, force: true })
  })

  it('throws and leaves NO token file when the file holds another value after the write', () => {
    fault.corrupt = true
    let code = 'no error'
    try {
      writeSupportToken(root, TOKEN)
    } catch (err) {
      if (err instanceof SupportTokenError) code = err.code
      else throw err
    }
    expect(code).toBe('token_readback')
    expect(realFs.existsSync(file)).toBe(false)
  })

  it('throws and leaves NO token file when the file ended up readable by others', () => {
    fault.widen = true
    let code = 'no error'
    try {
      writeSupportToken(root, TOKEN)
    } catch (err) {
      if (err instanceof SupportTokenError) code = err.code
      else throw err
    }
    expect(code).toBe('token_readback')
    expect(realFs.existsSync(file)).toBe(false)
  })

  // S2 of Dani's review: the directory and the file must belong to this user.
  it('refuses to write into a directory of another user, and writes nothing there', () => {
    fault.foreignOwned = [root]
    let code = 'no error'
    try {
      writeSupportToken(root, TOKEN)
    } catch (err) {
      if (err instanceof SupportTokenError) code = err.code
      else throw err
    }
    expect(code).toBe('token_dir_unsafe')
    fault.foreignOwned = []
    expect(realFs.readdirSync(root)).toEqual([])
  })

  it('does NOT use a token in a directory of another user, or a token file of another user', () => {
    writeSupportToken(root, TOKEN)
    expect(readSupportToken(root)).toEqual({ kind: 'ok', token: TOKEN })
    fault.foreignOwned = [root]
    expect(readSupportToken(root)).toEqual({ kind: 'invalid', reason: 'dir' })
    fault.foreignOwned = []
    fault.foreignFd = true
    expect(readSupportToken(root)).toEqual({ kind: 'invalid', reason: 'owner' })
  })
})
