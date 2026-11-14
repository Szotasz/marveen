// Fault injection for the read-back of the token file: the check cannot fail
// while the write path is correct, so the write path is made to go wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fault = vi.hoisted(() => ({ corrupt: false, widen: false }))

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
  }
})

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { writeSupportToken, SupportTokenError, SUPPORT_TOKEN_FILE } = await import('../support-access-token.js')

const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'

describe('support token on disk, when the write goes wrong', () => {
  let root: string
  let file: string

  beforeEach(() => {
    root = realFs.mkdtempSync(join(tmpdir(), 'support-token-faults-'))
    file = join(root, SUPPORT_TOKEN_FILE)
    fault.corrupt = false
    fault.widen = false
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
})
