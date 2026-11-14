import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  lstatSync,
  symlinkSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  rewriteAuthorizedKeysLocked,
  enrollAuthorizedKey,
  AuthorizedKeysLockError,
  AuthorizedKeysRewriteError,
} from '../remote-enroll-fs.js'
import { buildRestrictedLine, validatePublicKeyLine } from '../remote-enroll-core.js'
import {
  grantSupportLines,
  revokeSupportLines,
  reconcileSupportLinesOnDisk,
} from '../support-access-fs.js'
import { buildSupportLine } from '../support-access-line.js'
import { realSshDir } from '../ssh-dir.js'
import { TEST_ONLY_KEYS, TEST_ONLY_BLOBS, TEST_ONLY_BLOB_1, TEST_ONLY_FROM } from './helpers/sk-test-keys.js'

const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_GRANT = '9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b'
const BRIDGE_UUID = '11111111-2222-4333-8444-555555555555'

function supportLine(keyIndex: number, grantId = GRANT): string {
  return buildSupportLine({
    key: TEST_ONLY_KEYS[keyIndex],
    grantId,
    consentVersion: 1,
    dispatchPath: '/opt/marveen/scripts/support-dispatch.sh',
    fromCidrs: TEST_ONLY_FROM,
    sshd: { major: 9, minor: 6 },
  })
}

function bridgeLine(): string {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const len = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  const b64 = Buffer.concat([len(type.length), type, len(32), Buffer.alloc(32, 0x42)]).toString('base64')
  return buildRestrictedLine(validatePublicKeyLine(`ssh-ed25519 ${b64} marveen-remote:${BRIDGE_UUID}`))
}

const LINE1 = supportLine(0)
const LINE2 = supportLine(1)
const BRIDGE = bridgeLine()
const PERSONAL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH someone'
const noSleep = async (): Promise<void> => {}

describe('support access on disk', () => {
  let root: string
  let sshDir: string
  let authPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'support-access-'))
    sshDir = join(root, '.ssh')
    authPath = join(sshDir, 'authorized_keys')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seed(lines: string[]): void {
    mkdirSync(sshDir, { mode: 0o700 })
    writeFileSync(authPath, lines.join('\n') + '\n', { mode: 0o600 })
  }
  const read = (): string => readFileSync(authPath, 'utf8')
  const base = () => ({ sshDir, pinnedBlobs: TEST_ONLY_BLOBS, sleep: noSleep })

  describe('grantSupportLines', () => {
    it('creates .ssh (0700) and authorized_keys (0600) and writes both lines', async () => {
      const res = await grantSupportLines({ ...base(), lines: [LINE1, LINE2] })
      expect(res.replaced).toBe(0)
      expect(statSync(sshDir).mode & 0o777).toBe(0o700)
      expect(statSync(authPath).mode & 0o777).toBe(0o600)
      expect(read()).toBe(LINE1 + '\n' + LINE2 + '\n')
    })

    it('keeps the Bridge line and a personal key byte for byte', async () => {
      seed([PERSONAL, BRIDGE])
      await grantSupportLines({ ...base(), lines: [LINE1, LINE2] })
      expect(read()).toBe([PERSONAL, BRIDGE, LINE1, LINE2].join('\n') + '\n')
    })

    it('a second grant replaces the first: one grant per machine', async () => {
      seed([supportLine(0, OTHER_GRANT), supportLine(1, OTHER_GRANT), BRIDGE])
      const res = await grantSupportLines({ ...base(), lines: [LINE1, LINE2] })
      expect(res.replaced).toBe(2)
      expect(read()).toBe([BRIDGE, LINE1, LINE2].join('\n') + '\n')
    })

    it('REFUSES to add access through a symbolic link, and writes nothing', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, PERSONAL + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, authPath)
      await expect(grantSupportLines({ ...base(), lines: [LINE1] })).rejects.toMatchObject({
        code: 'AUTHORIZED_KEYS_SYMLINK',
      })
      expect(lstatSync(authPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(elsewhere, 'utf8')).toBe(PERSONAL + '\n')
      expect(existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
    })

    it('leaves no temp file and no lock behind', async () => {
      await grantSupportLines({ ...base(), lines: [LINE1] })
      expect(readdirSync(sshDir).sort()).toEqual(['authorized_keys'])
    })
  })

  describe('revokeSupportLines', () => {
    it('removes EVERY support line, both keys, and keeps the rest', async () => {
      seed([PERSONAL, LINE1, BRIDGE, LINE2])
      const res = await revokeSupportLines(base())
      expect(res.removed).toBe(2)
      expect(read()).toBe([PERSONAL, BRIDGE].join('\n') + '\n')
    })

    it('removes a loosened copy of a pinned key too', async () => {
      seed([BRIDGE, 'sk-ssh-ed25519@openssh.com ' + TEST_ONLY_BLOB_1 + ' handy'])
      const res = await revokeSupportLines(base())
      expect(res.removed).toBe(1)
      expect(read()).toBe(BRIDGE + '\n')
    })

    it('is idempotent: no file, no directory and no line all report removed 0', async () => {
      expect((await revokeSupportLines(base())).removed).toBe(0)
      expect(existsSync(sshDir)).toBe(false)
      seed([BRIDGE])
      expect((await revokeSupportLines(base())).removed).toBe(0)
      expect(read()).toBe(BRIDGE + '\n')
    })

    it('is NOT refused by a symbolic link: afterwards the path sshd reads holds no support line', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, [BRIDGE, LINE1].join('\n') + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, authPath)
      const res = await revokeSupportLines(base())
      expect(res.removed).toBe(1)
      expect(read()).toBe(BRIDGE + '\n')
    })
  })

  describe('reconcileSupportLinesOnDisk', () => {
    it('removes a loosened line and keeps the canonical one', async () => {
      const loosened = LINE1.replace(',verify-required', '')
      seed([BRIDGE, loosened, LINE2])
      const res = await reconcileSupportLinesOnDisk({ ...base(), expected: [LINE1, LINE2] })
      expect(res).toMatchObject({ kept: 1, removed: 1, missing: 1 })
      expect(read()).toBe([BRIDGE, LINE2].join('\n') + '\n')
    })

    it('with no live grant removes every support line', async () => {
      seed([LINE1, BRIDGE, LINE2])
      const res = await reconcileSupportLinesOnDisk({ ...base(), expected: [] })
      expect(res).toMatchObject({ kept: 0, removed: 2 })
      expect(read()).toBe(BRIDGE + '\n')
    })

    it('does not touch a file that is already as expected', async () => {
      seed([BRIDGE, LINE1, LINE2])
      const before = statSync(authPath).ino
      const res = await reconcileSupportLinesOnDisk({ ...base(), expected: [LINE1, LINE2] })
      expect(res).toMatchObject({ kept: 2, removed: 0, missing: 0 })
      expect(statSync(authPath).ino).toBe(before)
    })
  })

  describe('the shared lock', () => {
    it('a support writer waits on the SAME lock file the Bridge writer uses', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(join(sshDir, 'authorized_keys.lock'), 'held\n')
      await expect(
        grantSupportLines({ ...base(), lines: [LINE1], lockRetries: 3, staleLockMs: 60_000 }),
      ).rejects.toBeInstanceOf(AuthorizedKeysLockError)
      await expect(revokeSupportLines({ ...base(), lockRetries: 3, staleLockMs: 60_000 })).rejects.toMatchObject({
        code: 'AUTHORIZED_KEYS_LOCKED',
      })
      expect(existsSync(authPath)).toBe(false)
    })

    it('the Bridge writer still reports a held lock with its old message, now as the typed error', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(join(sshDir, 'authorized_keys.lock'), 'held\n')
      const attempt = enrollAuthorizedKey({
        sshDir,
        restrictedLine: BRIDGE,
        installId: BRIDGE_UUID,
        lockRetries: 2,
        staleLockMs: 60_000,
        sleep: noSleep,
      })
      await expect(attempt).rejects.toBeInstanceOf(AuthorizedKeysLockError)
      await expect(attempt).rejects.toThrow(/could not acquire .* after 2 attempts; another enrollment may be running/)
    })

    it('a Bridge enrollment and a support grant running together both land', async () => {
      await Promise.all([
        enrollAuthorizedKey({ sshDir, restrictedLine: BRIDGE, installId: BRIDGE_UUID }),
        grantSupportLines({ sshDir, pinnedBlobs: TEST_ONLY_BLOBS, lines: [LINE1, LINE2] }),
      ])
      const lines = read().trimEnd().split('\n').sort()
      expect(lines).toEqual([BRIDGE, LINE1, LINE2].sort())
    })
  })

  describe('rewriteAuthorizedKeysLocked', () => {
    it('refuses a transform that returns a promise, before anything is written', async () => {
      seed([BRIDGE])
      const asyncTransform = (async () => ({ content: 'x\n', result: 0 })) as unknown as (existing: string) => {
        content: string | null
        result: number
      }
      await expect(
        rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, asyncTransform),
      ).rejects.toBeInstanceOf(AuthorizedKeysRewriteError)
      expect(read()).toBe(BRIDGE + '\n')
      expect(existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
    })

    it('releases the lock when the transform throws, and leaves the file alone', async () => {
      seed([BRIDGE])
      await expect(
        rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(read()).toBe(BRIDGE + '\n')
      expect(existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
    })

    it('reports wrote:false and keeps the inode when the content does not change', async () => {
      seed([BRIDGE])
      const before = statSync(authPath).ino
      const same = await rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, (existing) => ({
        content: existing,
        result: 1,
      }))
      const none = await rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, () => ({
        content: null,
        result: 2,
      }))
      expect(same).toMatchObject({ wrote: false, result: 1 })
      expect(none).toMatchObject({ wrote: false, result: 2 })
      expect(statSync(authPath).ino).toBe(before)
    })

    it('hands the transform an empty string when the file does not exist', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      let seen: string | null = null
      await rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, (existing) => {
        seen = existing
        return { content: null, result: 0 }
      })
      expect(seen).toBe('')
    })

    it('without createDir it will not invent the directory for a write', async () => {
      await expect(
        rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, () => ({ content: 'x\n', result: 0 })),
      ).rejects.toThrow(/does not exist/)
      expect(existsSync(sshDir)).toBe(false)
    })

    it('warns about a looser file mode and writes 0600', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(authPath, BRIDGE + '\n', { mode: 0o644 })
      const out = await grantSupportLines({ ...base(), lines: [LINE1] })
      expect(out.warnings.join(' ')).toMatch(/looser than 0600/)
      expect(statSync(authPath).mode & 0o777).toBe(0o600)
    })

    it('ENROLL813: refuses the real ~/.ssh from a test run, for grant, revoke and reconcile alike', async () => {
      // SAFETY: HOME points at the scratch root for this test, and that is asserted
      // before any writer runs. The "real ~/.ssh" below is therefore a temp path;
      // if the guard ever stopped guarding, the write would land in scratch.
      const savedHome = process.env['HOME']
      process.env['HOME'] = root
      try {
        const real = realSshDir()
        expect(real).toBe(sshDir)
        seed([BRIDGE, LINE1])
        await expect(grantSupportLines({ sshDir: real, pinnedBlobs: TEST_ONLY_BLOBS, lines: [LINE2] })).rejects.toThrow(/ENROLL813/)
        await expect(revokeSupportLines({ sshDir: real, pinnedBlobs: TEST_ONLY_BLOBS })).rejects.toThrow(/ENROLL813/)
        await expect(
          reconcileSupportLinesOnDisk({ sshDir: real, pinnedBlobs: TEST_ONLY_BLOBS, expected: [] }),
        ).rejects.toThrow(/ENROLL813/)
        expect(read()).toBe([BRIDGE, LINE1].join('\n') + '\n')
      } finally {
        if (savedHome === undefined) delete process.env['HOME']
        else process.env['HOME'] = savedHome
      }
    })
  })
})
