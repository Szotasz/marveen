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
  realpathSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  formatKitManifest,
  parseKitManifest,
  sha256Hex,
  verifyKit,
  withKitLock,
  writeKit,
  KitError,
  KIT_LOCK_NAME,
  KIT_MANIFEST_NAME,
  KIT_SUBFOLDER,
  type KitFileSource,
  type KitManifest,
  type WriteKitOptions,
} from '../support-kit.js'

const noSleep = async (): Promise<void> => {}
const RELEASE = '1ca1f0944891436a4a8ae0643bc6b7d3c0693f58'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** A file of the tree with the hash "stored in the repo" for it. */
function source(name: string, text: string, executable = false): KitFileSource {
  const content = Buffer.from(text, 'utf8')
  return { name, content, sha256: sha256Hex(content), executable }
}

const LAUNCHER_1 = source('support-access', '#!/bin/sh\necho launcher 1\n', true)
const DISPATCH_1 = source('support-dispatch.sh', '#!/bin/sh\nexit 1 # release 1\n')
const ROUTINE_1 = source('support-standby.mjs', 'export const release = 1\n')
const FILES_1 = [LAUNCHER_1, DISPATCH_1, ROUTINE_1]
const FILES_2 = [
  source('support-access', '#!/bin/sh\necho launcher 2\n', true),
  source('support-dispatch.sh', '#!/bin/sh\nexit 1 # release 2\n'),
  source('support-standby.mjs', 'export const release = 2\n'),
]

const MANIFEST: KitManifest = {
  files: { 'support-standby.mjs': HASH_B, 'support-access': HASH_A },
  installRoot: '/opt/marveen',
  nodePath: '/usr/bin/node',
  release: RELEASE,
}
const MANIFEST_TEXT =
  'marveen-support-kit 1\n' +
  'file support-access ' + HASH_A + '\n' +
  'file support-standby.mjs ' + HASH_B + '\n' +
  'install-root /opt/marveen\n' +
  'node /usr/bin/node\n' +
  'release ' + RELEASE + '\n'

describe('the kit manifest', () => {
  it('is one fact per line, the files in name order, and reads back as what was written', () => {
    expect(formatKitManifest(MANIFEST)).toBe(MANIFEST_TEXT)
    expect(parseKitManifest(MANIFEST_TEXT)).toEqual({
      files: { 'support-access': HASH_A, 'support-standby.mjs': HASH_B },
      installRoot: '/opt/marveen',
      nodePath: '/usr/bin/node',
      release: RELEASE,
    })
  })

  it.each<[string, Partial<KitManifest>]>([
    ['no file', { files: {} }],
    ['a file name with a slash', { files: { 'a/b': HASH_A } }],
    ['a file name that climbs', { files: { '..': HASH_A } }],
    ['a file name in upper case', { files: { Launcher: HASH_A } }],
    ['a file name with a space', { files: { 'a b': HASH_A } }],
    ['the manifest named as a file of itself', { files: { manifest: HASH_A } }],
    ['a hash in upper case', { files: { a: 'A'.repeat(64) } }],
    ['a hash that is too short', { files: { a: 'a'.repeat(63) } }],
    ['an install root that is not absolute', { installRoot: 'opt/marveen' }],
    ['an install root with a space', { installRoot: '/opt/my marveen' }],
    ['an install root with a line break', { installRoot: '/opt/marveen\nnode /bin/evil' }],
    ['a node path with a quote', { nodePath: '/usr/bin/"node"' }],
    ['a node path that is not absolute', { nodePath: 'node' }],
    ['a release that is not a commit id', { release: 'v1.2.3' }],
    ['a release that is too short', { release: 'abc123' }],
  ])('refuses to write %s', (_label, over) => {
    let code: unknown = null
    try {
      formatKitManifest({ ...MANIFEST, ...over })
    } catch (err) {
      code = err instanceof KitError ? err.code : err
    }
    expect(code).toBe('kit_input_invalid')
  })

  // What the manifest says decides which file is run: nothing but the exact format is one.
  it.each<[string, string]>([
    ['nothing', ''],
    ['another header', MANIFEST_TEXT.replace('marveen-support-kit 1', 'marveen-support-kit 2')],
    ['no line end after the last line', MANIFEST_TEXT.slice(0, -1)],
    ['a blank line at the end', MANIFEST_TEXT + '\n'],
    ['a blank line in the middle', MANIFEST_TEXT.replace('install-root', '\ninstall-root')],
    ['CR LF line ends', MANIFEST_TEXT.replace(/\n/g, '\r\n')],
    ['a missing install root', MANIFEST_TEXT.replace('install-root /opt/marveen\n', '')],
    ['a missing node path', MANIFEST_TEXT.replace('node /usr/bin/node\n', '')],
    ['a missing release', MANIFEST_TEXT.replace('release ' + RELEASE + '\n', '')],
    ['no file line', MANIFEST_TEXT.replace(/file [^\n]*\n/g, '')],
    ['a second install root', MANIFEST_TEXT + 'install-root /tmp/x\n'],
    ['a second node path', MANIFEST_TEXT + 'node /tmp/node\n'],
    ['the same file twice', MANIFEST_TEXT.replace('install-root', 'file support-access ' + HASH_B + '\ninstall-root')],
    ['an unknown key', MANIFEST_TEXT + 'run /tmp/x\n'],
    ['two spaces after a key', MANIFEST_TEXT.replace('node /usr', 'node  /usr')],
    ['a file line with a fourth word', MANIFEST_TEXT.replace(HASH_A, HASH_A + ' x')],
    ['a node line with a second word', MANIFEST_TEXT.replace('/usr/bin/node', '/usr/bin/node --inspect')],
    ['a tab instead of the space', MANIFEST_TEXT.replace('node /usr', 'node\t/usr')],
    ['the files out of name order', MANIFEST_TEXT.replace(/(file support-access [^\n]*\n)(file support-standby\.mjs [^\n]*\n)/, '$2$1')],
    ['the facts before the files', MANIFEST_TEXT.replace(/((?:file [^\n]*\n)+)(install-root [^\n]*\n)/, '$2$1')],
    ['a hash in upper case', MANIFEST_TEXT.replace(HASH_A, 'A'.repeat(64))],
    ['a file name that climbs', MANIFEST_TEXT.replace('file support-access', 'file ../support-access')],
  ])('does not read %s as a manifest', (_label, text) => {
    expect(parseKitManifest(text)).toBeNull()
  })
})

describe('the kit on disk', () => {
  let root: string
  let supportDir: string
  let kitDir: string

  beforeEach(() => {
    // realpath: the macOS temp folder is reached through a link, and the kit refuses a path it has to resolve.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-kit-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    kitDir = join(supportDir, KIT_SUBFOLDER)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const opts = (over: Partial<WriteKitOptions> = {}): WriteKitOptions => ({
    supportDir,
    files: FILES_1,
    installRoot: '/opt/marveen',
    nodePath: '/usr/bin/node',
    release: RELEASE,
    sleep: noSleep,
    ...over,
  })
  const kitFile = (name: string): string => readFileSync(join(kitDir, name), 'utf8')
  const mode = (path: string): number => statSync(path).mode & 0o777
  async function codeOf(work: () => Promise<unknown>): Promise<unknown> {
    try {
      await work()
      return 'no error'
    } catch (err) {
      return err instanceof KitError ? err.code : err
    }
  }

  describe('writeKit', () => {
    it('creates the support folder and the kit, with the modes and the manifest of the release', async () => {
      const res = await writeKit(opts())
      expect(res).toEqual({ kitDir, replaced: false, cleaned: [] })
      expect(mode(supportDir)).toBe(0o700)
      expect(mode(kitDir)).toBe(0o700)
      expect(readdirSync(kitDir).sort()).toEqual(['manifest', 'support-access', 'support-dispatch.sh', 'support-standby.mjs'])
      expect(mode(join(kitDir, 'support-access'))).toBe(0o700)
      expect(mode(join(kitDir, 'support-dispatch.sh'))).toBe(0o600)
      expect(mode(join(kitDir, 'support-standby.mjs'))).toBe(0o600)
      expect(mode(join(kitDir, KIT_MANIFEST_NAME))).toBe(0o600)
      expect(kitFile('support-access')).toBe('#!/bin/sh\necho launcher 1\n')
      expect(parseKitManifest(kitFile(KIT_MANIFEST_NAME))).toEqual({
        files: {
          'support-access': LAUNCHER_1.sha256,
          'support-dispatch.sh': DISPATCH_1.sha256,
          'support-standby.mjs': ROUTINE_1.sha256,
        },
        installRoot: '/opt/marveen',
        nodePath: '/usr/bin/node',
        release: RELEASE,
      })
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true, kitDir })
    })

    it('replaces a kit as a whole, and leaves what stands NEXT to it alone', async () => {
      await writeKit(opts())
      writeFileSync(join(supportDir, 'token'), 'state that a swap must not touch\n', { mode: 0o600 })
      mkdirSync(join(supportDir, 'spool'))
      // A file of the old release that the new one does not have must not survive the swap.
      writeFileSync(join(kitDir, 'left-over-of-release-1'), 'x')
      const res = await writeKit(opts({ files: FILES_2, release: 'fd030ad3f' }))
      expect(res).toEqual({ kitDir, replaced: true, cleaned: [] })
      expect(kitFile('support-access')).toBe('#!/bin/sh\necho launcher 2\n')
      expect(kitFile('support-standby.mjs')).toBe('export const release = 2\n')
      expect(readdirSync(kitDir).sort()).toEqual(['manifest', 'support-access', 'support-dispatch.sh', 'support-standby.mjs'])
      expect(readdirSync(supportDir).sort()).toEqual(['kit', 'spool', 'token'])
      expect(readFileSync(join(supportDir, 'token'), 'utf8')).toBe('state that a swap must not touch\n')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true, manifest: { release: 'fd030ad3f' } })
    })

    it('leaves no lock, no staging folder and no set-aside folder behind', async () => {
      await writeKit(opts())
      await writeKit(opts({ files: FILES_2 }))
      expect(readdirSync(supportDir)).toEqual(['kit'])
    })

    // K1: the hash is a value stored in the repo. A file that is already damaged
    // in the tree must not be certified by hashing what is there.
    it('REFUSES a tree file that does not have the stored hash, and writes nothing', async () => {
      const damaged = { ...ROUTINE_1, content: Buffer.from('export const release = 1 // half an update\n') }
      expect(await codeOf(() => writeKit(opts({ files: [LAUNCHER_1, DISPATCH_1, damaged] })))).toBe('kit_source_mismatch')
      expect(existsSync(supportDir)).toBe(false)
    })

    it('REFUSES the damaged tree file also when a good kit stands there, and that kit stays', async () => {
      await writeKit(opts())
      const damaged = { ...FILES_2[2], content: Buffer.from('truncated') }
      expect(await codeOf(() => writeKit(opts({ files: [FILES_2[0], FILES_2[1], damaged] })))).toBe('kit_source_mismatch')
      expect(kitFile('support-standby.mjs')).toBe('export const release = 1\n')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
      expect(readdirSync(supportDir)).toEqual(['kit'])
    })

    it.each<[string, Partial<WriteKitOptions>]>([
      ['a file name that climbs', { files: [{ ...ROUTINE_1, name: '../outside' }] }],
      ['a file named like the manifest', { files: [{ ...ROUTINE_1, name: 'manifest' }] }],
      ['the same name twice', { files: [ROUTINE_1, ROUTINE_1] }],
      ['no file', { files: [] }],
      ['a stored hash that is not a hash', { files: [{ ...ROUTINE_1, sha256: 'zz' }] }],
      ['an install root with a space', { installRoot: '/opt/my marveen' }],
      ['a node path that is not absolute', { nodePath: 'node' }],
      ['a release that is not a commit id', { release: 'latest' }],
    ])('refuses %s before anything is created', async (_label, over) => {
      expect(await codeOf(() => writeKit(opts(over)))).toBe('kit_input_invalid')
      expect(existsSync(supportDir)).toBe(false)
    })

    it('refuses a support folder whose path a bound command could not carry', async () => {
      const spaced = join(root, 'my home', 'support')
      expect(await codeOf(() => writeKit(opts({ supportDir: spaced })))).toBe('kit_input_invalid')
      expect(existsSync(join(root, 'my home'))).toBe(false)
    })

    // K6, on the parent and on the swapped subfolder.
    it('REFUSES a support folder that is a link, and writes nothing through it', async () => {
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      mkdirSync(join(root, 'home', '.marveen'), { recursive: true })
      symlinkSync(elsewhere, supportDir)
      expect(await codeOf(() => writeKit(opts()))).toBe('kit_link')
      expect(readdirSync(elsewhere)).toEqual([])
    })

    it('REFUSES a kit path that is a link, and neither follows nor replaces it', async () => {
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      mkdirSync(supportDir, { recursive: true })
      symlinkSync(elsewhere, kitDir)
      expect(await codeOf(() => writeKit(opts()))).toBe('kit_link')
      expect(readdirSync(elsewhere)).toEqual([])
      expect(lstatSync(kitDir).isSymbolicLink()).toBe(true)
      expect(readdirSync(supportDir)).toEqual(['kit'])
    })

    it('refuses a kit path or a support folder that is a file', async () => {
      mkdirSync(supportDir, { recursive: true })
      writeFileSync(kitDir, 'not a folder')
      expect(await codeOf(() => writeKit(opts()))).toBe('kit_not_a_folder')
      expect(readFileSync(kitDir, 'utf8')).toBe('not a folder')
      rmSync(supportDir, { recursive: true })
      writeFileSync(supportDir, 'not a folder')
      expect(await codeOf(() => writeKit(opts()))).toBe('kit_not_a_folder')
    })

    // An interrupted swap: the process died between the two renames. Nothing
    // stands at the fixed path, the old kit sits under its set-aside name.
    it('FINISHES an interrupted swap: the set-aside folder goes, the kit is written', async () => {
      mkdirSync(join(supportDir, '.kit-old-0123456789abcdef'), { recursive: true })
      writeFileSync(join(supportDir, '.kit-old-0123456789abcdef', 'support-access'), 'old')
      writeFileSync(join(supportDir, 'token'), 't')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_missing' })
      const res = await writeKit(opts({ files: FILES_2 }))
      expect(res).toEqual({ kitDir, replaced: false, cleaned: ['.kit-old-0123456789abcdef'] })
      expect(readdirSync(supportDir).sort()).toEqual(['kit', 'token'])
      expect(kitFile('support-access')).toBe('#!/bin/sh\necho launcher 2\n')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
    })

    it('removes a staging folder an interrupted write left, a kit in place or not', async () => {
      await writeKit(opts())
      mkdirSync(join(supportDir, '.kit-new-fedcba9876543210'))
      writeFileSync(join(supportDir, '.kit-new-fedcba9876543210', 'manifest'), 'half')
      const res = await writeKit(opts({ files: FILES_2 }))
      expect(res).toMatchObject({ replaced: true, cleaned: ['.kit-new-fedcba9876543210'] })
      expect(readdirSync(supportDir)).toEqual(['kit'])
    })

    it('removes a LINK that sits under a leftover name as a link, without touching what it points at', async () => {
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'precious'), 'keep me')
      mkdirSync(supportDir, { recursive: true })
      symlinkSync(elsewhere, join(supportDir, '.kit-old-00000000000000aa'))
      await writeKit(opts())
      expect(readdirSync(supportDir)).toEqual(['kit'])
      expect(readFileSync(join(elsewhere, 'precious'), 'utf8')).toBe('keep me')
    })

    it('leaves alone a folder whose name only looks like a leftover', async () => {
      mkdirSync(supportDir, { recursive: true })
      for (const name of ['.kit-old-xyz', '.kit-old-0123456789abcdef0', 'kit-old-0123456789abcdef', '.kit-tmp-0123456789abcdef']) {
        mkdirSync(join(supportDir, name))
      }
      const res = await writeKit(opts())
      expect(res.cleaned).toEqual([])
      expect(readdirSync(supportDir)).toHaveLength(5)
    })

    it('takes over a lock a dead process left, and refuses while a live one holds it', async () => {
      mkdirSync(supportDir, { recursive: true })
      const lock = join(supportDir, KIT_LOCK_NAME)
      writeFileSync(lock, '')
      expect(await codeOf(() => writeKit(opts({ lockRetries: 2, staleLockMs: 60_000 })))).toBe('kit_locked')
      expect(existsSync(kitDir)).toBe(false)
      expect(existsSync(lock)).toBe(true)
      // The caller's own limit decides what is stale, not a built-in one.
      const recent = new Date(Date.now() - 30_000)
      utimesSync(lock, recent, recent)
      expect(await codeOf(() => writeKit(opts({ lockRetries: 2, staleLockMs: 60_000 })))).toBe('kit_locked')
      const old = new Date(Date.now() - 120_000)
      utimesSync(lock, old, old)
      expect(await writeKit(opts({ lockRetries: 2, staleLockMs: 60_000 }))).toMatchObject({ replaced: false })
      expect(readdirSync(supportDir)).toEqual(['kit'])
    })
  })

  describe('withKitLock', () => {
    it('runs the work, hands back its result, and gives the lock up, also when the work throws', async () => {
      mkdirSync(supportDir, { recursive: true })
      const lock = join(supportDir, KIT_LOCK_NAME)
      expect(await withKitLock(supportDir, { sleep: noSleep }, () => existsSync(lock))).toBe(true)
      expect(existsSync(lock)).toBe(false)
      await expect(
        withKitLock(supportDir, { sleep: noSleep }, () => {
          throw new Error('work failed')
        }),
      ).rejects.toThrow('work failed')
      expect(existsSync(lock)).toBe(false)
    })

    it('refuses work that returns a promise: nothing slow may run under the lock', async () => {
      mkdirSync(supportDir, { recursive: true })
      expect(await codeOf(() => withKitLock(supportDir, { sleep: noSleep }, async () => 1))).toBe('kit_input_invalid')
      expect(existsSync(join(supportDir, KIT_LOCK_NAME))).toBe(false)
    })

    it('a kit write waits for it: the reconcile and the writer share this lock', async () => {
      mkdirSync(supportDir, { recursive: true })
      let inside: unknown = null
      await withKitLock(supportDir, { sleep: noSleep }, () => {
        inside = 'held'
      })
      writeFileSync(join(supportDir, KIT_LOCK_NAME), '')
      inside = await codeOf(() => writeKit(opts({ lockRetries: 3, staleLockMs: 60_000 })))
      expect(inside).toBe('kit_locked')
    })
  })

  describe('verifyKit', () => {
    beforeEach(async () => {
      await writeKit(opts())
    })

    it('accepts the kit that was written, and ignores a file the manifest does not name', () => {
      writeFileSync(join(kitDir, '.DS_Store'), 'x')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: true, kitDir, manifest: { installRoot: '/opt/marveen' } })
    })

    it('accepts the same kit through another spelling of the folder', () => {
      expect(verifyKit({ supportDir: supportDir + '/./' })).toMatchObject({ ok: true, kitDir })
    })

    it.each(['support-access', 'support-dispatch.sh', 'support-standby.mjs'])('names a mismatch when %s was changed', (name) => {
      writeFileSync(join(kitDir, name), readFileSync(join(kitDir, name), 'utf8') + ' ')
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_mismatch' })
    })

    it.each(['support-access', 'support-dispatch.sh', 'support-standby.mjs'])('names a missing file when %s is gone', (name) => {
      rmSync(join(kitDir, name))
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_file_missing' })
    })

    it('refuses a file that is a link, even to a file with the right content', () => {
      const copy = join(root, 'copy')
      writeFileSync(copy, readFileSync(join(kitDir, 'support-dispatch.sh')))
      rmSync(join(kitDir, 'support-dispatch.sh'))
      symlinkSync(copy, join(kitDir, 'support-dispatch.sh'))
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_link' })
    })

    it('refuses a folder in place of a file', () => {
      rmSync(join(kitDir, 'support-access'))
      mkdirSync(join(kitDir, 'support-access'))
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_mismatch' })
    })

    it('says the manifest is unreadable when it is gone, garbled, a link or names nothing', () => {
      const manifestPath = join(kitDir, KIT_MANIFEST_NAME)
      const good = readFileSync(manifestPath, 'utf8')
      writeFileSync(manifestPath, good.replace('marveen-support-kit 1', 'something else'))
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_manifest_unreadable' })
      writeFileSync(manifestPath, good.slice(0, 40))
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_manifest_unreadable' })
      rmSync(manifestPath)
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_manifest_unreadable' })
      const copy = join(root, 'manifest-copy')
      writeFileSync(copy, good)
      symlinkSync(copy, manifestPath)
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_link' })
    })

    it('a manifest that names a hash of another release is a mismatch, whatever the files say', () => {
      const manifestPath = join(kitDir, KIT_MANIFEST_NAME)
      writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(ROUTINE_1.sha256, FILES_2[2].sha256))
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_mismatch' })
    })

    it('says the kit is missing when the subfolder or the support folder is not there', () => {
      rmSync(kitDir, { recursive: true })
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_missing' })
      rmSync(supportDir, { recursive: true })
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_missing' })
    })

    // K6 on BOTH folders.
    it('refuses a kit subfolder that is a link to a perfectly good kit', () => {
      const moved = join(supportDir, 'moved')
      rmSync(moved, { recursive: true, force: true })
      mkdirSync(moved)
      for (const name of readdirSync(kitDir)) writeFileSync(join(moved, name), readFileSync(join(kitDir, name)))
      rmSync(kitDir, { recursive: true })
      symlinkSync(moved, kitDir)
      expect(verifyKit({ supportDir })).toMatchObject({ ok: false, problem: 'kit_link' })
    })

    it('refuses a support folder that is a link to a perfectly good one', () => {
      const linked = join(root, 'linked-support')
      symlinkSync(supportDir, linked)
      expect(verifyKit({ supportDir: linked })).toMatchObject({ ok: false, problem: 'kit_link' })
      // The same through a spelling that would make lstat follow the link.
      expect(verifyKit({ supportDir: linked + '/' })).toMatchObject({ ok: false, problem: 'kit_link' })
    })

    it('refuses a kit that belongs to another user: the folders, then the manifest and the files', () => {
      const other = statSync(kitDir).uid + 1
      expect(verifyKit({ supportDir, uid: other })).toMatchObject({ ok: false, problem: 'kit_foreign_owner' })
      // With no uid to compare (a platform without one) the owner is not looked at.
      expect(verifyKit({ supportDir, uid: null })).toMatchObject({ ok: true })
      expect(verifyKit({ supportDir, uid: statSync(kitDir).uid })).toMatchObject({ ok: true })
    })
  })
})
