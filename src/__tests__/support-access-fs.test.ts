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
import { buildSupportLine, SupportLineError, type SupportGrantInput } from '../support-access-line.js'
import { fingerprintOfBlob } from '../support-access-pins.js'
import { realSshDir } from '../ssh-dir.js'
import { skBlob, TEST_ONLY_KEYS, TEST_ONLY_BLOBS, TEST_ONLY_BLOB_1, TEST_ONLY_FROM } from './helpers/sk-test-keys.js'

const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_GRANT = '9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b'
const BRIDGE_UUID = '11111111-2222-4333-8444-555555555555'

const DISPATCH = '/opt/marveen/scripts/support-dispatch.sh'

function supportLine(keyIndex: number, grantId = GRANT): string {
  return buildSupportLine({
    key: TEST_ONLY_KEYS[keyIndex],
    grantId,
    consentVersion: 1,
    dispatchPath: DISPATCH,
    fromCidrs: TEST_ONLY_FROM,
    sshd: { major: 9, minor: 6 },
  })
}

/** The inputs of a grant: what the writers take instead of lines. */
function grantInput(over: Partial<SupportGrantInput> = {}): SupportGrantInput {
  return {
    keys: TEST_ONLY_KEYS,
    fromCidrs: TEST_ONLY_FROM,
    grantId: GRANT,
    consentVersion: 1,
    dispatchPath: DISPATCH,
    sshd: { major: 9, minor: 6 },
    ...over,
  }
}
const KEY1_ONLY = grantInput({ keys: [TEST_ONLY_KEYS[0]] })
const KEY2_ONLY = grantInput({ keys: [TEST_ONLY_KEYS[1]] })

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
const FOREIGN_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ intruder'
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
      const res = await grantSupportLines({ ...base(), grant: grantInput() })
      expect(res.replaced).toBe(0)
      expect(statSync(sshDir).mode & 0o777).toBe(0o700)
      expect(statSync(authPath).mode & 0o777).toBe(0o600)
      expect(read()).toBe(LINE1 + '\n' + LINE2 + '\n')
    })

    it('keeps the Bridge line and a personal key byte for byte', async () => {
      seed([PERSONAL, BRIDGE])
      await grantSupportLines({ ...base(), grant: grantInput() })
      expect(read()).toBe([PERSONAL, BRIDGE, LINE1, LINE2].join('\n') + '\n')
    })

    it('a second grant replaces the first: one grant per machine', async () => {
      seed([supportLine(0, OTHER_GRANT), supportLine(1, OTHER_GRANT), BRIDGE])
      const res = await grantSupportLines({ ...base(), grant: grantInput() })
      expect(res.replaced).toBe(2)
      expect(read()).toBe([BRIDGE, LINE1, LINE2].join('\n') + '\n')
    })

    it('REFUSES to add access through a symbolic link, and writes nothing', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, PERSONAL + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, authPath)
      await expect(grantSupportLines({ ...base(), grant: KEY1_ONLY })).rejects.toMatchObject({
        code: 'AUTHORIZED_KEYS_SYMLINK',
      })
      expect(lstatSync(authPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(elsewhere, 'utf8')).toBe(PERSONAL + '\n')
      expect(existsSync(join(sshDir, 'authorized_keys.lock'))).toBe(false)
    })

    it('REFUSES to add access through a symbolic link to the .ssh directory, and writes nothing', async () => {
      const elsewhere = join(root, 'dotfiles-ssh')
      mkdirSync(elsewhere, { mode: 0o700 })
      symlinkSync(elsewhere, sshDir)
      await expect(grantSupportLines({ ...base(), grant: KEY1_ONLY })).rejects.toMatchObject({
        code: 'AUTHORIZED_KEYS_SYMLINK',
      })
      expect(readdirSync(elsewhere)).toEqual([])
      expect(lstatSync(sshDir).isSymbolicLink()).toBe(true)
    })

    it('REFUSES a dangling link in place of the .ssh directory instead of creating its target', async () => {
      const elsewhere = join(root, 'not-there')
      symlinkSync(elsewhere, sshDir)
      await expect(grantSupportLines({ ...base(), grant: KEY1_ONLY })).rejects.toMatchObject({
        code: 'AUTHORIZED_KEYS_SYMLINK',
      })
      expect(existsSync(elsewhere)).toBe(false)
    })

    it('leaves no temp file and no lock behind', async () => {
      await grantSupportLines({ ...base(), grant: KEY1_ONLY })
      expect(readdirSync(sshDir).sort()).toEqual(['authorized_keys'])
    })

    // The writer takes a grant's inputs and builds the lines itself: there is
    // no way to hand it a string. What a caller could still try is to carry a
    // second line inside one of the inputs.
    it.each([
      ['the dispatcher path', { dispatchPath: DISPATCH + '\n' + FOREIGN_KEY }],
      ['the grant id', { grantId: GRANT + '\n' + FOREIGN_KEY }],
      ['a source address', { fromCidrs: ['203.0.113.7/32\n' + FOREIGN_KEY] }],
      ['a key name', { keys: [{ ...TEST_ONLY_KEYS[0], name: 'key1\n' + FOREIGN_KEY }] }],
      ['a key blob', { keys: [{ ...TEST_ONLY_KEYS[0], pub: TEST_ONLY_BLOB_1 + '\n' + FOREIGN_KEY }] }],
      ['the consent version', { consentVersion: ('1\n' + FOREIGN_KEY) as unknown as number }],
    ])('a second line carried in %s is refused, and nothing is written', async (_label, over) => {
      seed([PERSONAL])
      await expect(grantSupportLines({ ...base(), grant: grantInput(over) })).rejects.toBeInstanceOf(SupportLineError)
      expect(read()).toBe(PERSONAL + '\n')
    })

    it('a key that is not one of the pinned keys gets no line, though it is a well-formed key', async () => {
      const blob = skBlob({ key: Buffer.alloc(32, 0x07) })
      const stranger = { name: 'key3', pub: blob, fingerprint: fingerprintOfBlob(blob) }
      await expect(
        grantSupportLines({ ...base(), grant: grantInput({ keys: [TEST_ONLY_KEYS[0], stranger] }) }),
      ).rejects.toMatchObject({ code: 'pins_invalid' })
      expect(existsSync(sshDir)).toBe(false)
    })

    it('a grant the pins check refuses creates nothing, not even the directory', async () => {
      await expect(
        grantSupportLines({ ...base(), grant: grantInput({ keys: [TEST_ONLY_KEYS[0], TEST_ONLY_KEYS[0]] }) }),
      ).rejects.toMatchObject({ code: 'pins_invalid' })
      await expect(
        grantSupportLines({ ...base(), grant: grantInput({ sshd: { major: 8, minor: 2 } }) }),
      ).rejects.toMatchObject({ code: 'sshd_too_old' })
      expect(existsSync(sshDir)).toBe(false)
    })
  })

  // A line of another owner must come back as it was, whatever bytes it holds:
  // inside a command="..." a changed byte changes what that key runs.
  describe('a file that is not valid UTF-8', () => {
    const latin = (text: string): Buffer => Buffer.from(text, 'latin1')
    const FOREIGN_BYTES = Buffer.concat([
      latin('command="/usr/local/bin/caf'),
      Buffer.from([0xe9, 0xa0, 0xff]),
      latin('" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH Ren'),
      Buffer.from([0xe9]),
      latin('\n'),
    ])
    const readBytes = (): Buffer => readFileSync(authPath)
    function seedBytes(...parts: Buffer[]): void {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(authPath, Buffer.concat(parts), { mode: 0o600 })
    }

    it('a grant keeps the other line byte for byte', async () => {
      seedBytes(FOREIGN_BYTES)
      await grantSupportLines({ ...base(), grant: grantInput() })
      expect(readBytes().equals(Buffer.concat([FOREIGN_BYTES, latin(LINE1 + '\n' + LINE2 + '\n')]))).toBe(true)
    })

    it('a revoke keeps the other line byte for byte', async () => {
      seedBytes(latin(LINE1 + '\n'), FOREIGN_BYTES, latin(LINE2 + '\n'))
      const res = await revokeSupportLines(base())
      expect(res.removed).toBe(2)
      expect(readBytes().equals(FOREIGN_BYTES)).toBe(true)
    })

    it('a reconcile keeps the other line byte for byte', async () => {
      seedBytes(FOREIGN_BYTES, latin(LINE1.replace(',verify-required', '') + '\n' + LINE2 + '\n'))
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: grantInput() })
      expect(res).toMatchObject({ kept: 1, removed: 1 })
      expect(readBytes().equals(Buffer.concat([FOREIGN_BYTES, latin(LINE2 + '\n')]))).toBe(true)
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
      // The link is gone; its old target was not written and still holds the
      // line, and the result says so instead of leaving it to be found later.
      expect(lstatSync(authPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(elsewhere, 'utf8')).toBe([BRIDGE, LINE1].join('\n') + '\n')
      expect(res.warnings).toHaveLength(1)
      expect(res.warnings[0]).toMatch(/was a symbolic link.*still holds its old lines/)
    })

    it('says nothing about a link when the file was a regular file, or when a link held no support line', async () => {
      seed([BRIDGE, LINE1])
      expect((await revokeSupportLines(base())).warnings).toEqual([])
      rmSync(authPath)
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, BRIDGE + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, authPath)
      const res = await revokeSupportLines(base())
      expect(res).toMatchObject({ removed: 0, warnings: [] })
      expect(lstatSync(authPath).isSymbolicLink()).toBe(true)
    })

    it('is NOT refused by a symbolic link to the .ssh directory: the file in it loses the lines', async () => {
      const elsewhere = join(root, 'dotfiles-ssh')
      mkdirSync(elsewhere, { mode: 0o700 })
      writeFileSync(join(elsewhere, 'authorized_keys'), [BRIDGE, LINE1, LINE2].join('\n') + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, sshDir)
      const res = await revokeSupportLines(base())
      expect(res).toMatchObject({ removed: 2, warnings: [] })
      expect(readFileSync(join(elsewhere, 'authorized_keys'), 'utf8')).toBe(BRIDGE + '\n')
    })
  })

  describe('reconcileSupportLinesOnDisk', () => {
    it('removes a loosened line and keeps the canonical one', async () => {
      const loosened = LINE1.replace(',verify-required', '')
      seed([BRIDGE, loosened, LINE2])
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: grantInput() })
      expect(res).toMatchObject({ kept: 1, removed: 1, missing: 1 })
      expect(read()).toBe([BRIDGE, LINE2].join('\n') + '\n')
    })

    it('with no live grant removes every support line', async () => {
      seed([LINE1, BRIDGE, LINE2])
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: null })
      expect(res).toMatchObject({ kept: 0, removed: 2 })
      expect(read()).toBe(BRIDGE + '\n')
    })

    it('does not touch a file that is already as expected', async () => {
      seed([BRIDGE, LINE1, LINE2])
      const before = statSync(authPath).ino
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: grantInput() })
      expect(res).toMatchObject({ kept: 2, removed: 0, missing: 0, unbuildable: null })
      expect(statSync(authPath).ino).toBe(before)
    })

    it('keeps only the lines of the grant it was given: the lines of another grant go', async () => {
      seed([BRIDGE, supportLine(0, OTHER_GRANT), LINE2])
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: grantInput() })
      expect(res).toMatchObject({ kept: 1, removed: 1, missing: 1, unbuildable: null })
      expect(read()).toBe([BRIDGE, LINE2].join('\n') + '\n')
    })

    it('a grant that can no longer be built expects no line: every support line goes, and the result says why', async () => {
      seed([LINE1, BRIDGE, LINE2])
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: grantInput({ sshd: { major: 8, minor: 2 } }) })
      expect(res).toMatchObject({ kept: 0, removed: 2, missing: 0, unbuildable: 'sshd_too_old' })
      expect(read()).toBe(BRIDGE + '\n')
    })

    it('an error that is not a refusal of the builder is not swallowed, and the file is left alone', async () => {
      seed([LINE1, BRIDGE])
      const broken = { ...grantInput(), keys: null } as unknown as SupportGrantInput
      await expect(reconcileSupportLinesOnDisk({ ...base(), grant: broken })).rejects.toBeInstanceOf(TypeError)
      expect(read()).toBe([LINE1, BRIDGE].join('\n') + '\n')
    })

    it('reports a removal through a symbolic link the same way a revoke does', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, [BRIDGE, LINE1].join('\n') + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, authPath)
      const res = await reconcileSupportLinesOnDisk({ ...base(), grant: null })
      expect(res.removed).toBe(1)
      expect(res.warnings.join(' ')).toMatch(/was a symbolic link/)
    })
  })

  describe('the shared lock', () => {
    it('a support writer waits on the SAME lock file the Bridge writer uses', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(join(sshDir, 'authorized_keys.lock'), 'held\n')
      await expect(
        grantSupportLines({ ...base(), grant: KEY1_ONLY, lockRetries: 3, staleLockMs: 60_000 }),
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
        grantSupportLines({ sshDir, pinnedBlobs: TEST_ONLY_BLOBS, grant: grantInput() }),
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

    it('with preserveBytes refuses content that is not one byte per character, and writes nothing', async () => {
      seed([BRIDGE])
      await expect(
        rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', preserveBytes: true, sleep: noSleep }, (existing) => ({
          content: existing + '# \u0151\n',
          result: 0,
        })),
      ).rejects.toMatchObject({ code: 'AUTHORIZED_KEYS_NOT_BYTES' })
      expect(read()).toBe(BRIDGE + '\n')
      expect(readdirSync(sshDir).sort()).toEqual(['authorized_keys'])
    })

    it('with preserveBytes a character up to U+00FF is written as that one byte', async () => {
      seed([BRIDGE])
      await rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', preserveBytes: true, sleep: noSleep }, (existing) => ({
        content: existing + '# \u00e9\u00ff\n',
        result: 0,
      }))
      expect(readFileSync(authPath).subarray(-5).equals(Buffer.from([0x23, 0x20, 0xe9, 0xff, 0x0a]))).toBe(true)
    })

    it('without preserveBytes the file is read and written as UTF-8, as before', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(authPath, '# \u0151\n', { mode: 0o600 })
      let seen = ''
      await rewriteAuthorizedKeysLocked({ sshDir, operation: 'test', sleep: noSleep }, (existing) => {
        seen = existing
        return { content: existing + '# \u00e9\n', result: 0 }
      })
      expect(seen).toBe('# \u0151\n')
      expect(readFileSync(authPath).equals(Buffer.from('# \u0151\n# \u00e9\n', 'utf8'))).toBe(true)
    })

    it('warns about a looser file mode and writes 0600', async () => {
      mkdirSync(sshDir, { mode: 0o700 })
      writeFileSync(authPath, BRIDGE + '\n', { mode: 0o644 })
      const out = await grantSupportLines({ ...base(), grant: KEY1_ONLY })
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
        await expect(grantSupportLines({ sshDir: real, pinnedBlobs: TEST_ONLY_BLOBS, grant: KEY2_ONLY })).rejects.toThrow(/ENROLL813/)
        await expect(revokeSupportLines({ sshDir: real, pinnedBlobs: TEST_ONLY_BLOBS })).rejects.toThrow(/ENROLL813/)
        await expect(
          reconcileSupportLinesOnDisk({ sshDir: real, pinnedBlobs: TEST_ONLY_BLOBS, grant: null }),
        ).rejects.toThrow(/ENROLL813/)
        expect(read()).toBe([BRIDGE, LINE1].join('\n') + '\n')
      } finally {
        if (savedHome === undefined) delete process.env['HOME']
        else process.env['HOME'] = savedHome
      }
    })
  })
})
