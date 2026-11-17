// The support routine ships as ONE generated file. These tests hold the two
// promises that make a generated file safe to commit: it is exactly what a
// build gives today, and it behaves exactly like the source the dashboard uses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSupportGrantLines, type SupportGrantInput } from '../support-access-line.js'
import { SUPPORT_ROUTINE_MIN_NODE_MAJOR } from '../support-standby.js'
import { TEST_ONLY_KEYS, TEST_ONLY_FROM, TEST_ONLY_FROM_V6 } from './helpers/sk-test-keys.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const FILE = join(ROOT, 'scripts', 'support-standby.mjs')

interface BuiltModule {
  buildSupportGrantLines: (grant: SupportGrantInput) => string[]
  SUPPORT_ROUTINE_MIN_NODE_MAJOR: number
}

describe('scripts/support-standby.mjs', () => {
  let built: BuiltModule
  let home: string

  beforeAll(async () => {
    built = (await import(pathToFileURL(FILE).href)) as BuiltModule
    home = mkdtempSync(join(tmpdir(), 'support-standby-home-'))
  })
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('is exactly what a fresh build gives (rebuild with: node scripts/build-support-standby.mjs)', async () => {
    const { buildSupportStandby } = (await import(pathToFileURL(join(ROOT, 'scripts', 'build-support-standby.mjs')).href)) as {
      buildSupportStandby: () => Promise<string>
    }
    expect(readFileSync(FILE, 'utf8')).toBe(await buildSupportStandby())
  })

  it('imports nothing but node built-ins', () => {
    const text = readFileSync(FILE, 'utf8')
    // Every static import of the bundle is a statement that starts a line.
    const specifiers = [...text.matchAll(/^import\s(?:[^"';]*?\sfrom\s*)?"([^"]+)";?$/gm)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(3)
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([])
    // And nothing is loaded any other way.
    expect(text).not.toMatch(/\brequire\s*\(/)
    expect(text).not.toMatch(/\bimport\s*\(/)
    expect(text).not.toMatch(/^import\s[^"';]*?\sfrom\s*'/m)
  })

  it('gives byte for byte the lines the source gives', () => {
    const grants: SupportGrantInput[] = [
      {
        keys: TEST_ONLY_KEYS,
        fromCidrs: TEST_ONLY_FROM,
        grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        consentVersion: 1,
        dispatchPath: '/home/marveen/.marveen/support-dispatch.sh',
        sshd: { major: 9, minor: 6 },
      },
      {
        keys: [TEST_ONLY_KEYS[1]],
        fromCidrs: [TEST_ONLY_FROM[0], TEST_ONLY_FROM_V6],
        grantId: '9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b',
        consentVersion: 9999,
        dispatchPath: '/Users/admin/.marveen/support-dispatch.sh',
        sshd: { major: 10, minor: 2 },
      },
    ]
    for (const grant of grants) {
      const fromSource = buildSupportGrantLines(grant)
      expect(fromSource.length).toBe(grant.keys.length)
      expect(built.buildSupportGrantLines(grant)).toEqual(fromSource)
    }
  })

  it('refuses what the source refuses', () => {
    const bad = {
      keys: TEST_ONLY_KEYS,
      fromCidrs: ['203.0.113.0/24'],
      grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      consentVersion: 1,
      dispatchPath: '/home/marveen/.marveen/support-dispatch.sh',
      sshd: { major: 9, minor: 6 },
    }
    expect(() => buildSupportGrantLines(bad)).toThrow()
    expect(() => built.buildSupportGrantLines(bad)).toThrow()
  })

  it('carries the same node minimum as the source', () => {
    expect(built.SUPPORT_ROUTINE_MIN_NODE_MAJOR).toBe(SUPPORT_ROUTINE_MIN_NODE_MAJOR)
  })

  it('`status` runs on its own, exits with 0, and writes nothing', () => {
    const run = spawnSync(process.execPath, [FILE, 'status'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home },
      timeout: 30_000,
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // The shipped pins have the ceremony keys but no source address yet, so sshd is not asked: the answer is the same on
    // every machine.
    const lines = run.stdout.trimEnd().split('\n')
    expect(lines.slice(0, 1)).toEqual(['node=ok'])
    expect(lines.slice(2, 6)).toEqual(['node_minimum=20', 'pins=support_from_unset', 'sshd=not_asked', 'sshd_version=unknown'])
    // The keys files are the login user's from the user database, so on a developer or CI machine they may exist
    // (count 0) or not; HOME does not move them (Dani's review of #2765, S1): another HOME gives the same answer.
    expect(lines[7]).toMatch(/^support_lines=(?:absent|0)$/)
    expect(lines[8]).toMatch(/^support_lines_second_file=(?:absent|0)$/)
    // The support folder is the login user's too: on a developer or CI machine it is normally not there.
    expect(lines[9]).toMatch(/^standby=(?:off|on|partial|invalid)$/)
    expect(lines[10]).toMatch(/^standby_keys=/)
    expect(lines[11]).toBe('consent_version=2')
    expect(lines[12]).toBe('consent_lang=hu')
    expect(lines[13]).toBe('consent_sha256=1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b')
    expect(lines).toHaveLength(14)
    const other = mkdtempSync(join(tmpdir(), 'support-standby-other-home-'))
    try {
      mkdirSync(join(other, '.ssh'))
      writeFileSync(join(other, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA x\n'.repeat(3))
      const again = spawnSync(process.execPath, [FILE, 'status'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: other }, timeout: 30_000 })
      expect(again.status).toBe(0)
      expect(again.stdout).toBe(run.stdout)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    expect(readdirSync(home)).toEqual([])
  })

  // The copy in the install tree never enables: only the kit's copy, started by the loader, may (it refuses at once,
  // before the pins, sshd, the kit or the service are touched).
  it('`enable` from the file in the tree is refused, and writes nothing', () => {
    const run = spawnSync(process.execPath, [FILE, 'enable', '--consent', '1'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home },
      input: 'msc_' + 'TESTONLY'.repeat(4) + '\n',
      timeout: 30_000,
    })
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('enable: refused: enable_not_from_kit\n')
    expect(readdirSync(home)).toEqual([])
  })

  it('an unknown subcommand prints the usage and exits with 2', () => {
    const run = spawnSync(process.execPath, [FILE, 'bogus'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 30_000 })
    expect(run.status).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      'usage: support-standby.mjs status\n       support-standby.mjs verify-kit\n       support-standby.mjs install-kit --install-root <path> --node <path> --release <commit>\n' +
        '       support-standby.mjs enable --consent <version>   (the code on standard input)\n       support-standby.mjs disable\n' +
        '       support-standby.mjs consent-text --consent <version>\n',
    )
    expect(readdirSync(home)).toEqual([])
  })

  it('being imported does not run the command line', () => {
    // The import in beforeAll would have printed the usage and set an exit code.
    expect(process.exitCode ?? 0).toBe(0)
  })
})
