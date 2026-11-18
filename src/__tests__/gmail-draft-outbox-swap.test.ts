// GMAILDRAFT1116 review round 2: O_NOFOLLOW in readOutboxFile. The realpath check runs first, the open second; a file
// swapped for a symlink to a secret BETWEEN the two is opened with O_NOFOLLOW, so the open fails (ELOOP) and the draft
// writer refuses instead of reading the secret. The swap is made deterministic by wrapping node:fs openSync: right
// before the writer's open, the checked file is replaced by a symlink pointing outside store/outbox/. Without
// O_NOFOLLOW the open follows the link and this test goes red (it reads the outside file).
// Limit, stated: O_NOFOLLOW covers the LAST component only; a directory swapped in the same window is not closed.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'gmail-draft-swap-'))
const STORE = join(ROOT, 'store')
const OUTSIDE = mkdtempSync(join(tmpdir(), 'gmail-draft-swap-outside-'))
mkdirSync(join(STORE, 'outbox'), { recursive: true })

const hook = vi.hoisted(() => ({ beforeOpen: null as null | ((path: string) => void), flags: [] as number[] }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const openSync = ((path: import('node:fs').PathLike, flags?: import('node:fs').OpenMode, mode?: import('node:fs').Mode) => {
    if (typeof path === 'string' && hook.beforeOpen) { const f = hook.beforeOpen; hook.beforeOpen = null; f(path) }
    if (typeof flags === 'number') hook.flags.push(flags)
    return real.openSync(path, flags ?? 'r', mode)
  }) as typeof real.openSync
  return { ...real, openSync, default: { ...real, openSync } }
})
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE, PROJECT_ROOT: ROOT }))
vi.mock('../web/vault.js', () => ({ reservedVaultAccess: { read: () => null, present: () => false, write: () => undefined, remove: () => false } }))

const gd = await import('../web/gmail-draft.js')

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

describe('readOutboxFile: a swap between the realpath check and the open', () => {
  it('S1 the writer opens with O_NOFOLLOW', () => {
    writeFileSync(join(STORE, 'outbox', 'plain.pdf'), 'ok')
    hook.flags = []
    expect(gd.readOutboxFile('plain.pdf').data.toString()).toBe('ok')
    expect(hook.flags).toHaveLength(1)
    expect(hook.flags[0]! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
  })

  it('S2 the file swapped for a symlink to a secret after the check: refused, the secret is not read', () => {
    const secret = join(OUTSIDE, 'secret.txt')
    writeFileSync(secret, 'SECRET-outside-value')
    const target = join(STORE, 'outbox', 'offer.pdf')
    writeFileSync(target, 'the real offer')
    hook.beforeOpen = (p) => {
      // the path the writer opens is the realpath it has just checked: swap exactly that file
      expect(p.endsWith('offer.pdf')).toBe(true)
      unlinkSync(p)
      symlinkSync(secret, p)
    }
    let got: string | null = null
    let err: unknown = null
    try { got = gd.readOutboxFile('offer.pdf').data.toString() } catch (e) { err = e }
    expect(got).toBeNull()
    expect(err).toMatchObject({ code: 'outbox-file-refused' })
  })
})
