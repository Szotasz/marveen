import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  KIT_DISPATCHER_NAME,
  KIT_HASHES_FILE,
  KIT_LAUNCHER_NAME,
  KIT_ROUTINE_NAME,
  KIT_SOURCES,
  formatKitHashes,
  parseKitHashes,
} from '../support-kit-sources.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const GOOD = H1 + '  support-dispatch.sh\n' + H2 + '  support-standby.mjs\n'

describe('the stored kit hashes', () => {
  // The guard the whole idea rests on: the committed values ARE the files in the tree.
  it('the committed hashes file names every kit file once, with the sha256 of the file in the tree', () => {
    const stored = parseKitHashes(readFileSync(join(ROOT, KIT_HASHES_FILE), 'utf8'))
    expect(stored).not.toBeNull()
    for (const source of KIT_SOURCES) {
      expect(stored?.get(source.name), source.name).toBe(sha(readFileSync(join(ROOT, source.treePath))))
    }
  })

  it('the build script writes the same list of files, in the same order', async () => {
    const build = (await import(pathToFileURL(join(ROOT, 'scripts', 'build-support-standby.mjs')).href)) as {
      SUPPORT_KIT_FILES: [string, string][]
      SUPPORT_KIT_HASHES_FILE: string
    }
    expect(build.SUPPORT_KIT_FILES).toEqual(KIT_SOURCES.map((s) => [s.name, s.treePath]))
    expect(build.SUPPORT_KIT_HASHES_FILE).toBe(KIT_HASHES_FILE)
  })

  it('builds the list from the three run-file names, which are exported in one place', () => {
    expect([KIT_LAUNCHER_NAME, KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME]).toEqual(['support-access', 'support-dispatch.sh', 'support-standby.mjs'])
    expect(KIT_SOURCES.map((s) => s.name)).toEqual([KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME])
  })

  it('names the kit files in name order, none executable but what the user starts directly', () => {
    const names = KIT_SOURCES.map((s) => s.name)
    expect(names).toEqual([...names].sort())
    // The dispatcher is started as `/bin/sh <path>`, the routine by node: neither needs the bit.
    expect(KIT_SOURCES.filter((s) => s.executable)).toEqual([])
  })

  it('reads the exact format and writes it back', () => {
    const parsed = parseKitHashes(GOOD)
    expect(parsed === null ? null : [...parsed.entries()]).toEqual([
      ['support-dispatch.sh', H1],
      ['support-standby.mjs', H2],
    ])
    expect(formatKitHashes(parsed as ReadonlyMap<string, string>)).toBe(GOOD)
  })

  it.each<[string, string]>([
    ['nothing', ''],
    ['no final line end', GOOD.slice(0, -1)],
    ['a blank line', GOOD + '\n'],
    ['CR LF line ends', GOOD.replace(/\n/g, '\r\n')],
    ['one space between hash and name', GOOD.replace(H1 + '  ', H1 + ' ')],
    ['the binary marker of sha256sum', GOOD.replace(H1 + '  ', H1 + ' *')],
    ['a hash in upper case', GOOD.replace(H1, H1.toUpperCase().replace(/1/g, 'A'))],
    ['a short hash', GOOD.replace(H1, H1.slice(1))],
    ['a missing kit file', H2 + '  support-standby.mjs\n'],
    ['an extra file', GOOD + H1 + '  support-extra\n'],
    ['the same file twice', GOOD + H2 + '  support-standby.mjs\n'],
    ['the files out of name order', H2 + '  support-standby.mjs\n' + H1 + '  support-dispatch.sh\n'],
    ['a path instead of a name', GOOD.replace('  support-dispatch.sh', '  scripts/support-dispatch.sh')],
  ])('does not read %s', (_label, text) => {
    expect(parseKitHashes(text)).toBeNull()
  })

  it('refuses to write a file without a value for every kit file', () => {
    expect(() => formatKitHashes(new Map([['support-standby.mjs', H2]]))).toThrow('support-dispatch.sh')
    expect(() => formatKitHashes(new Map([['support-dispatch.sh', 'x'], ['support-standby.mjs', H2]]))).toThrow()
  })
})

describe('the placeholder dispatcher', () => {
  it('refuses every start, with or without the arguments a support line passes', () => {
    const path = join(ROOT, 'scripts', 'support-dispatch.sh')
    for (const args of [[], ['--key', 'k1', '--fp', 'SHA256:x', '--grant', 'g', '--consent', '1'], ['status']]) {
      const run = spawnSync('/bin/sh', [path, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 })
      expect(run.status).toBe(1)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe('support access: refused (the dispatcher of this release does not open sessions)\n')
    }
  })
})
