// Fault injection for the kit: the cases a real disk does not produce on
// request. A rename that fails at an exact moment, a copy that does not read
// back, and a folder or a file that belongs to another user (which only root
// could set up for real).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fault = vi.hoisted(() => ({
  /** The rename with this number (counted from the last reset) throws. 0 = none. */
  failRenameNumber: 0,
  renames: 0,
  /** A read of a file whose path contains this text gives other bytes. '' = none. */
  corruptReadsUnder: '',
  /** These exact paths are reported as owned by another user. */
  foreignOwned: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      fault.renames++
      if (fault.renames === fault.failRenameNumber) throw Object.assign(new Error('EIO: injected rename failure'), { code: 'EIO' })
      real.renameSync(from, to)
    },
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      const out = (real.readFileSync as (...a: unknown[]) => string | Buffer)(path, ...rest)
      if (fault.corruptReadsUnder === '' || !String(path).includes(fault.corruptReadsUnder)) return out
      return typeof out === 'string' ? out + 'x' : Buffer.concat([out, Buffer.from('x')])
    }) as typeof real.readFileSync,
    lstatSync: ((path: unknown, ...rest: unknown[]) => {
      const st = (real.lstatSync as (...a: unknown[]) => import('node:fs').Stats)(path, ...rest)
      if (!fault.foreignOwned.includes(String(path))) return st
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 })
    }) as typeof real.lstatSync,
  }
})

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, realpathSync } = realFs
const { writeKit, verifyKit, sha256Hex, KitError, KIT_SUBFOLDER, KIT_MANIFEST_NAME } = await import('../support-kit.js')
type KitFileSource = import('../support-kit.js').KitFileSource

const noSleep = async (): Promise<void> => {}
const RELEASE = '1ca1f0944891436a4a8ae0643bc6b7d3c0693f58'

function source(name: string, text: string, executable = false): KitFileSource {
  const content = Buffer.from(text, 'utf8')
  return { name, content, sha256: sha256Hex(content), executable }
}
const FILES_1 = [
  source('support-access', '#!/bin/sh\necho launcher 1\n', true),
  source('support-dispatch.sh', '#!/bin/sh\nexit 1 # release 1\n'),
  source('support-standby.mjs', 'export const release = 1\n'),
]
const FILES_2 = [
  source('support-access', '#!/bin/sh\necho launcher 2\n', true),
  source('support-dispatch.sh', '#!/bin/sh\nexit 1 # release 2\n'),
  source('support-standby.mjs', 'export const release = 2\n'),
]

describe('the kit on disk, when something goes wrong', () => {
  let root: string
  let supportDir: string
  let kitDir: string

  const write = (files: KitFileSource[]) =>
    writeKit({ supportDir, files, installRoot: '/opt/marveen', nodePath: '/usr/bin/node', release: RELEASE, sleep: noSleep })
  async function failureOf(work: () => Promise<unknown>): Promise<{ code: unknown; message: string }> {
    try {
      await work()
      return { code: 'no error', message: '' }
    } catch (err) {
      const e = err as { code?: unknown; message?: string }
      return { code: err instanceof KitError ? err.code : 'not a KitError: ' + String(e.code), message: String(e.message) }
    }
  }
  const kitFile = (name: string): string => realFs.readFileSync(join(kitDir, name), 'utf8')
  const noFault = (): void => {
    fault.failRenameNumber = 0
    fault.renames = 0
    fault.corruptReadsUnder = ''
    fault.foreignOwned = []
  }

  beforeEach(() => {
    noFault()
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-kit-faults-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    kitDir = join(supportDir, KIT_SUBFOLDER)
  })
  afterEach(() => {
    noFault()
    rmSync(root, { recursive: true, force: true })
  })

  describe('a swap that is interrupted', () => {
    // The state Samu 31987 (a) is about, produced by the writer itself: the
    // old kit is set aside and the new one never takes its place.
    it('between the two renames: nothing stands at the fixed path, and the next write finishes the job', async () => {
      await write(FILES_1)
      writeFileSync(join(supportDir, 'token'), 't')
      fault.renames = 0
      fault.failRenameNumber = 2
      expect((await failureOf(() => write(FILES_2))).code).toBe('not a KitError: EIO')
      noFault()

      const left = readdirSync(supportDir).sort()
      expect(left).toHaveLength(3)
      expect(left[0]).toMatch(/^\.kit-new-[0-9a-f]{16}$/)
      expect(left[1]).toMatch(/^\.kit-old-[0-9a-f]{16}$/)
      expect(left[2]).toBe('token') // no kit, and no lock either
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_missing' })

      const res = await write(FILES_2)
      expect(res).toEqual({ kitDir, replaced: false, cleaned: [left[0], left[1]] })
      expect(readdirSync(supportDir).sort()).toEqual(['kit', 'token'])
      expect(kitFile('support-access')).toBe('#!/bin/sh\necho launcher 2\n')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
    })

    it('before the first rename is done: the standing kit stays whole and nothing is left next to it', async () => {
      await write(FILES_1)
      fault.renames = 0
      fault.failRenameNumber = 1
      expect((await failureOf(() => write(FILES_2))).code).toBe('not a KitError: EIO')
      noFault()
      expect(readdirSync(supportDir)).toEqual(['kit'])
      expect(kitFile('support-access')).toBe('#!/bin/sh\necho launcher 1\n')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
    })
  })

  describe('a copy that does not read back', () => {
    it('in the new folder: the write is refused BEFORE the swap, and the standing kit stays', async () => {
      await write(FILES_1)
      fault.corruptReadsUnder = '/.kit-new-'
      expect((await failureOf(() => write(FILES_2))).code).toBe('kit_mismatch')
      noFault()
      expect(readdirSync(supportDir)).toEqual(['kit'])
      expect(kitFile('support-standby.mjs')).toBe('export const release = 1\n')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
    })

    it('at the fixed path, after the swap: the write says that the kit it wrote does not verify', async () => {
      fault.corruptReadsUnder = join('/', KIT_SUBFOLDER, 'support-standby.mjs')
      const failure = await failureOf(() => write(FILES_1))
      expect(failure.code).toBe('kit_mismatch')
      expect(failure.message).toContain('the kit that was just written does not verify')
    })
  })

  // K6, the owner half. The process uid is the default: no test passes one in.
  describe('a kit that belongs to another user', () => {
    beforeEach(async () => {
      await write(FILES_1)
    })

    it.each<[string, () => string]>([
      ['the support folder', () => supportDir],
      ['the swapped subfolder', () => kitDir],
      ['the manifest', () => join(kitDir, KIT_MANIFEST_NAME)],
      ['the launcher', () => join(kitDir, 'support-access')],
      ['the dispatcher', () => join(kitDir, 'support-dispatch.sh')],
      ['the routine', () => join(kitDir, 'support-standby.mjs')],
    ])('is refused when only %s does', (_label, pathOf) => {
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
      fault.foreignOwned = [pathOf()]
      const verdict = verifyKit({ supportDir })
      expect(verdict).toMatchObject({ ok: false, problem: 'kit_foreign_owner' })
      expect(verdict.ok ? '' : verdict.detail).toBe(pathOf() + ' belongs to another user')
    })

    it('is not written over when the swapped subfolder is not ours', async () => {
      fault.foreignOwned = [kitDir]
      expect((await failureOf(() => write(FILES_2))).code).toBe('kit_foreign_owner')
      noFault()
      expect(readdirSync(supportDir)).toEqual(['kit'])
      expect(kitFile('support-access')).toBe('#!/bin/sh\necho launcher 1\n')
    })

    it('is not written into a support folder that is not ours', async () => {
      const other = join(root, 'other', 'support')
      mkdirSync(other, { recursive: true })
      fault.foreignOwned = [other]
      const failure = await failureOf(() =>
        writeKit({ supportDir: other, files: FILES_2, installRoot: '/opt/marveen', nodePath: '/usr/bin/node', release: RELEASE, sleep: noSleep }),
      )
      expect(failure.code).toBe('kit_foreign_owner')
      noFault()
      expect(readdirSync(other)).toEqual([])
    })
  })
})
