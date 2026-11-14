import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installKit, KIT_SOURCE_MAX_BYTES, SUPPORT_DIR_IN_HOME, type InstallKitInput } from '../support-kit-install.js'
import { KitError, KIT_MANIFEST_NAME, parseKitManifest, verifyKit } from '../support-kit.js'
import { KIT_HASHES_FILE, KIT_SOURCES } from '../support-kit-sources.js'
import { createInstallKit } from '../support-standby-cli.js'
import { SUPPORT_ROUTINE_MIN_NODE_MAJOR } from '../support-standby.js'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const RELEASE = '8cb46ad83c88f73cfaff252fae3e78bb595af1ab'
const NODE = realpathSync(process.execPath)
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const noSleep = async (): Promise<void> => {}

describe('installKit', () => {
  let root: string
  let tree: string
  let supportDir: string

  /** A tree of one release: the kit files with this text, and the hashes file that names them. */
  function makeTree(texts: Record<string, string>, hashes: Record<string, string> = {}): void {
    mkdirSync(join(tree, 'scripts'), { recursive: true })
    let list = ''
    for (const source of KIT_SOURCES) {
      const text = texts[source.name]
      writeFileSync(join(tree, source.treePath), text)
      list += (hashes[source.name] ?? sha(text)) + '  ' + source.name + '\n'
    }
    writeFileSync(join(tree, KIT_HASHES_FILE), list)
  }
  const RELEASE_1 = { 'support-dispatch.sh': '#!/bin/sh\nexit 1 # 1\n', 'support-standby.mjs': 'export const r = 1\n' }
  const RELEASE_2 = { 'support-dispatch.sh': '#!/bin/sh\nexit 1 # 2\n', 'support-standby.mjs': 'export const r = 2\n' }
  const input = (over: Partial<InstallKitInput> = {}): InstallKitInput => ({
    installRoot: tree,
    nodePath: NODE,
    release: RELEASE,
    supportDir,
    sleep: noSleep,
    ...over,
  })
  async function codeOf(work: () => Promise<unknown>): Promise<unknown> {
    try {
      await work()
      return 'no error'
    } catch (err) {
      return err instanceof KitError ? err.code : err
    }
  }
  const kitText = (name: string): string => readFileSync(join(supportDir, 'kit', name), 'utf8')

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-kit-install-')))
    tree = join(root, 'opt', 'marveen')
    supportDir = join(root, 'home', '.marveen', 'support')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the kit of the release in the tree, with the manifest the launcher reads', async () => {
    makeTree(RELEASE_1)
    expect(await installKit(input())).toEqual({ kitDir: join(supportDir, 'kit'), replaced: false, cleaned: [] })
    expect(kitText('support-standby.mjs')).toBe('export const r = 1\n')
    expect(kitText('support-dispatch.sh')).toBe('#!/bin/sh\nexit 1 # 1\n')
    for (const name of ['support-dispatch.sh', 'support-standby.mjs', KIT_MANIFEST_NAME]) {
      expect(statSync(join(supportDir, 'kit', name)).mode & 0o777).toBe(0o600)
    }
    expect(parseKitManifest(kitText(KIT_MANIFEST_NAME))).toEqual({
      files: { 'support-dispatch.sh': sha(RELEASE_1['support-dispatch.sh']), 'support-standby.mjs': sha(RELEASE_1['support-standby.mjs']) },
      installRoot: tree,
      nodePath: NODE,
      nodeMin: SUPPORT_ROUTINE_MIN_NODE_MAJOR,
      release: RELEASE,
    })
    expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
  })

  it('replaces the kit with the next release', async () => {
    makeTree(RELEASE_1)
    await installKit(input())
    makeTree(RELEASE_2)
    expect(await installKit(input({ release: 'fd030ad3f' }))).toMatchObject({ replaced: true })
    expect(kitText('support-standby.mjs')).toBe('export const r = 2\n')
    expect(verifyKit({ supportDir })).toMatchObject({ ok: true, manifest: { release: 'fd030ad3f' } })
  })

  // A half-finished update: the routine is new, the stored hash is still the old one (or the other way round).
  it('REFUSES a tree file that is not the one the stored hash names, and the standing kit stays', async () => {
    makeTree(RELEASE_1)
    await installKit(input())
    makeTree(RELEASE_2, { 'support-standby.mjs': sha(RELEASE_1['support-standby.mjs']) })
    expect(await codeOf(() => installKit(input()))).toBe('kit_source_mismatch')
    expect(kitText('support-standby.mjs')).toBe('export const r = 1\n')
    expect(verifyKit({ supportDir })).toMatchObject({ ok: true })
  })

  it.each<[string, () => void]>([
    ['the hashes file is missing', () => rmSync(join(tree, KIT_HASHES_FILE))],
    ['the hashes file is garbled', () => writeFileSync(join(tree, KIT_HASHES_FILE), 'not hashes\n')],
    ['the hashes file names another file too', () => writeFileSync(join(tree, KIT_HASHES_FILE), readFileSync(join(tree, KIT_HASHES_FILE), 'utf8') + 'a'.repeat(64) + '  extra\n')],
    ['the hashes file is a link', () => {
      const real = join(root, 'hashes-elsewhere')
      writeFileSync(real, readFileSync(join(tree, KIT_HASHES_FILE)))
      rmSync(join(tree, KIT_HASHES_FILE))
      symlinkSync(real, join(tree, KIT_HASHES_FILE))
    }],
    ['a kit file is missing', () => rmSync(join(tree, 'scripts', 'support-dispatch.sh'))],
    ['a kit file is a link, even to the right bytes', () => {
      const real = join(root, 'routine-elsewhere')
      writeFileSync(real, RELEASE_1['support-standby.mjs'])
      rmSync(join(tree, 'scripts', 'support-standby.mjs'))
      symlinkSync(real, join(tree, 'scripts', 'support-standby.mjs'))
    }],
    ['a kit file is a folder', () => {
      rmSync(join(tree, 'scripts', 'support-dispatch.sh'))
      mkdirSync(join(tree, 'scripts', 'support-dispatch.sh'))
    }],
  ])('refuses the whole tree when %s, and writes nothing', async (_label, spoil) => {
    makeTree(RELEASE_1)
    spoil()
    expect(await codeOf(() => installKit(input()))).toBe('kit_source_mismatch')
    expect(existsSync(supportDir)).toBe(false)
  })

  it('does not read a kit file larger than the limit', async () => {
    const big = 'x'.repeat(KIT_SOURCE_MAX_BYTES + 1)
    makeTree({ ...RELEASE_1, 'support-standby.mjs': big })
    expect(await codeOf(() => installKit(input()))).toBe('kit_source_mismatch')
    expect(existsSync(supportDir)).toBe(false)
    makeTree({ ...RELEASE_1, 'support-standby.mjs': 'x'.repeat(KIT_SOURCE_MAX_BYTES) })
    expect(await installKit(input())).toMatchObject({ replaced: false })
  })

  it.each<[string, () => Partial<InstallKitInput>]>([
    ['an install root that is not absolute', () => ({ installRoot: 'opt/marveen' })],
    ['an install root with a space', () => ({ installRoot: join(root, 'my marveen') })],
    ['an install root that is missing', () => ({ installRoot: join(root, 'nope') })],
    ['an install root that is a file', () => ({ installRoot: join(tree, KIT_HASHES_FILE) })],
    ['a node path that is not absolute', () => ({ nodePath: 'node' })],
    ['a node path that is missing', () => ({ nodePath: join(root, 'no-node') })],
    ['a node path that is a folder', () => ({ nodePath: root })],
    ['a node path that is not executable', () => {
      writeFileSync(join(root, 'node-copy'), '#!/bin/sh\n')
      chmodSync(join(root, 'node-copy'), 0o644)
      return { nodePath: join(root, 'node-copy') }
    }],
    ['a support folder with a space', () => ({ supportDir: join(root, 'my home', 'support') })],
    ['a release that is not a commit', () => ({ release: 'latest' })],
  ])('refuses %s before anything is written', async (_label, over) => {
    makeTree(RELEASE_1)
    expect(await codeOf(() => installKit(input(over())))).toBe('kit_input_invalid')
    expect(existsSync(supportDir)).toBe(false)
  })

  it('accepts a node reached through a link, and names the link in the manifest', async () => {
    makeTree(RELEASE_1)
    symlinkSync(NODE, join(root, 'node-link'))
    await installKit(input({ nodePath: join(root, 'node-link') }))
    expect(parseKitManifest(kitText(KIT_MANIFEST_NAME))?.nodePath).toBe(join(root, 'node-link'))
  })

  // The real tree and its real stored hashes: what the installer will do.
  it('writes the kit from THIS repository, and the kit holds exactly its files', async () => {
    expect(await installKit(input({ installRoot: REPO }))).toMatchObject({ replaced: false })
    for (const source of KIT_SOURCES) {
      expect(readFileSync(join(supportDir, 'kit', source.name)).equals(readFileSync(join(REPO, source.treePath)))).toBe(true)
    }
    expect(verifyKit({ supportDir })).toMatchObject({ ok: true, manifest: { installRoot: REPO } })
  })

  it('the command line writes into the support folder under the home it was given, whatever HOME says', async () => {
    makeTree(RELEASE_1)
    const home = join(root, 'account-home')
    mkdirSync(home)
    const saved = process.env['HOME']
    process.env['HOME'] = join(root, 'elsewhere')
    try {
      await createInstallKit({ name: 'marveen', isRoot: false, home })({ installRoot: tree, nodePath: NODE, release: RELEASE })
    } finally {
      if (saved === undefined) delete process.env['HOME']
      else process.env['HOME'] = saved
    }
    expect(SUPPORT_DIR_IN_HOME).toBe('.marveen/support')
    expect(readdirSync(join(home, '.marveen', 'support')).sort()).toEqual(['kit'])
    expect(existsSync(join(root, 'elsewhere'))).toBe(false)
  })
})
