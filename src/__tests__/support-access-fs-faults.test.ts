// Fault injection for the two checks that cannot fail while everything else is
// correct: the read-back after a write, and "no support line may remain after a
// revoke". Each is the last line of defence against a regression somewhere
// else, so each gets a test in which that somewhere else is made to go wrong.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fault = vi.hoisted(() => ({ corruptReadBack: false, renamed: false, removeOnlyFirst: false }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      real.renameSync(from, to)
      if (String(to).endsWith('authorized_keys')) fault.renamed = true
    },
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (fault.corruptReadBack && fault.renamed && String(path).endsWith('authorized_keys')) {
        return 'not what was written\n'
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof real.readFileSync,
  }
})

vi.mock('../support-access-line.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../support-access-line.js')>()
  return {
    ...real,
    removeSupportLines: (existing: string, pinned: ReadonlySet<string>) => {
      if (!fault.removeOnlyFirst) return real.removeSupportLines(existing, pinned)
      // A broken remover: it takes out the first support line only.
      const lines = existing.split('\n')
      const index = lines.findIndex((line) => real.isSupportLine(line, pinned))
      if (index === -1) return { content: existing, removed: 0 }
      lines.splice(index, 1)
      return { content: lines.join('\n'), removed: 1 }
    },
  }
})

const { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { grantSupportLines, revokeSupportLines, SupportLinesRemainError } = await import('../support-access-fs.js')
const { buildSupportLine } = await vi.importActual<typeof import('../support-access-line.js')>('../support-access-line.js')
const { TEST_ONLY_KEYS, TEST_ONLY_BLOBS, TEST_ONLY_FROM } = await import('./helpers/sk-test-keys.js')

const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
function supportLine(keyIndex: number): string {
  return buildSupportLine({
    key: TEST_ONLY_KEYS[keyIndex],
    grantId: GRANT,
    consentVersion: 1,
    dispatchPath: '/opt/marveen/scripts/support-dispatch.sh',
    fromCidrs: TEST_ONLY_FROM,
    sshd: { major: 9, minor: 6 },
  })
}
const PERSONAL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH someone'

describe('support access on disk, when something else goes wrong', () => {
  let root: string
  let sshDir: string
  let authPath: string

  beforeEach(() => {
    fault.corruptReadBack = false
    fault.renamed = false
    fault.removeOnlyFirst = false
    root = mkdtempSync(join(tmpdir(), 'support-access-faults-'))
    sshDir = join(root, '.ssh')
    authPath = join(sshDir, 'authorized_keys')
    mkdirSync(sshDir, { mode: 0o700 })
  })
  afterEach(() => {
    fault.corruptReadBack = false
    fault.removeOnlyFirst = false
    rmSync(root, { recursive: true, force: true })
  })

  it('a write that does not read back as written is an error, not a success', async () => {
    writeFileSync(authPath, PERSONAL + '\n', { mode: 0o600 })
    fault.corruptReadBack = true
    await expect(
      grantSupportLines({
        sshDir,
        pinnedBlobs: TEST_ONLY_BLOBS,
        grant: {
          keys: [TEST_ONLY_KEYS[0]],
          fromCidrs: TEST_ONLY_FROM,
          grantId: GRANT,
          consentVersion: 1,
          dispatchPath: '/opt/marveen/scripts/support-dispatch.sh',
          sshd: { major: 9, minor: 6 },
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZED_KEYS_READBACK' })
    expect(existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
  })

  it('a revoke that would leave a support line behind throws and does not touch the file', async () => {
    const before = [PERSONAL, supportLine(0), supportLine(1)].join('\n') + '\n'
    writeFileSync(authPath, before, { mode: 0o600 })
    fault.removeOnlyFirst = true
    await expect(revokeSupportLines({ sshDir, pinnedBlobs: TEST_ONLY_BLOBS })).rejects.toBeInstanceOf(SupportLinesRemainError)
    expect(realFs.readFileSync(authPath, 'utf8')).toBe(before)
    expect(existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
  })

  it('the same revoke with a working remover succeeds (the fault, not the test, caused the error)', async () => {
    writeFileSync(authPath, [PERSONAL, supportLine(0), supportLine(1)].join('\n') + '\n', { mode: 0o600 })
    const res = await revokeSupportLines({ sshDir, pinnedBlobs: TEST_ONLY_BLOBS })
    expect(res.removed).toBe(2)
    expect(realFs.readFileSync(authPath, 'utf8')).toBe(PERSONAL + '\n')
  })
})
