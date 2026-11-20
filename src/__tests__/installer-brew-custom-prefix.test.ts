// BREWPREFIXREST1107 C: install-macos.sh's brew probe and a Homebrew in a custom prefix.
// Measured on develop 88b54702b: with brew only in a custom prefix and not on PATH (a non-interactive SSH install),
// the dependency checks failed and the installer went to the Homebrew install step. Now an explicit
// MARVEEN_BREW_PREFIX, or the #2578 rule (the prefix of a node@NN keg entry on PATH), finds that brew first.
//
// The cases run the REAL block (check_cmd .. the dependency install) with a temp HOME. /opt/homebrew and /usr/local
// in the block are rewritten to temp dirs, so the host's real Homebrew is never seen or run; curl and brew are stubs
// that log their argv (the curl stub hands `/bin/bash -c` a harmless echo: no network, nothing installed).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

function depBlock(): string {
  const start = MACOS.indexOf('check_cmd() {')
  const end = MACOS.indexOf('# Bun: no longer here', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return MACOS.slice(start, end)
}

type Brews = { custom?: boolean; arm?: boolean; intel?: boolean }

function run(
  brews: Brews,
  pathFor: (d: { stub: string; custom: string; keg: string }) => string,
  envFor: (d: { custom: string }) => Record<string, string> = () => ({}),
): { out: string; code: number | null; calls: string; custom: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brewpfx-')))
  try {
    const arm = join(dir, 'def-arm')
    const intel = join(dir, 'def-intel')
    const custom = join(dir, 'custombrew')
    const keg = join(custom, 'opt', 'node@22', 'bin')
    const stub = join(dir, 'stub')
    const log = join(dir, 'calls.log')
    mkdirSync(stub)
    mkdirSync(join(dir, 'home'))
    mkdirSync(keg, { recursive: true })
    writeFileSync(log, '')
    const mkbrew = (prefix: string) => {
      mkdirSync(join(prefix, 'bin'), { recursive: true })
      writeFileSync(
        join(prefix, 'bin', 'brew'),
        `#!/bin/bash\necho "${prefix}/bin/brew $*" >> "${log}"\n[ "$1" = shellenv ] && echo 'export PATH="${prefix}/bin:${prefix}/sbin\${PATH+:$PATH}";'\nexit 0\n`,
      )
      for (const t of ['node', 'npm', 'tmux']) {
        writeFileSync(join(prefix, 'bin', t), '#!/bin/bash\n[ "$1" = "-v" ] && echo v22.11.0\nexit 0\n')
      }
      for (const t of ['brew', 'node', 'npm', 'tmux']) chmodSync(join(prefix, 'bin', t), 0o755)
    }
    if (brews.custom) mkbrew(custom)
    if (brews.arm) mkbrew(arm)
    if (brews.intel) mkbrew(intel)
    writeFileSync(join(stub, 'curl'), `#!/bin/bash\necho "curl $*" >> "${log}"\necho 'echo HOMEBREW-INSTALL-SCRIPT-RAN'\n`)
    chmodSync(join(stub, 'curl'), 0o755)
    const block = depBlock().replaceAll('/opt/homebrew', arm).replaceAll('/usr/local', intel)
    expect(block).not.toMatch(/\/opt\/homebrew|\/usr\/local/)
    const script = [
      // the installer's own settings: `set -e` and an ERR trap that exits
      'set -e',
      "trap 'echo ERRTRAP; exit 99' ERR",
      'RED=; GREEN=; ORANGE=; BLUE=; BOLD=; DIM=; NC=',
      'fail() { echo "FAIL: $*"; exit 1; }',
      `. "${join(ROOT, 'install-lang.sh')}"`,
      block,
      'echo "END brew=$(command -v brew)"',
    ].join('\n')
    const f = join(dir, 'block.sh')
    writeFileSync(f, script)
    const r = spawnSync('/bin/bash', [f], {
      encoding: 'utf-8',
      env: { PATH: pathFor({ stub, custom, keg }), HOME: join(dir, 'home'), MARVEEN_LANG: 'en', ...envFor({ custom }) },
    })
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status, calls: readFileSync(log, 'utf-8'), custom }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SYS = '/usr/bin:/bin'

describe('install-macos.sh brew probe (real block, stubbed brew and curl)', () => {
  it('custom prefix, brew off PATH, explicit MARVEEN_BREW_PREFIX: that brew, no Homebrew install', () => {
    // without the hint: the measured behaviour (MEASURE-C S1), which this fix does not reach
    const r = run({ custom: true }, (d) => `${d.stub}:${SYS}`)
    expect(r.out).toContain('Homebrew not found')
    expect(r.calls).toContain('curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')
    const r2 = run({ custom: true }, (d) => `${d.stub}:${SYS}`, (d) => ({ MARVEEN_BREW_PREFIX: d.custom }))
    expect(r2.code).toBe(0)
    expect(r2.out).not.toContain('ERRTRAP')
    expect(r2.out).not.toContain('Homebrew not found')
    expect(r2.calls).not.toContain('curl')
    expect(r2.calls).toContain(`${r2.custom}/bin/brew shellenv`)
    expect(r2.out).toContain(`END brew=${r2.custom}/bin/brew`)
  })

  it('custom prefix, brew off PATH, node@22 keg on PATH (#2578 rule): that brew, no Homebrew install', () => {
    const r = run({ custom: true }, (d) => `${d.stub}:${d.keg}:${SYS}`)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('ERRTRAP')
    expect(r.out).not.toContain('Homebrew not found')
    expect(r.calls).not.toContain('curl')
    expect(r.calls).toContain(`${r.custom}/bin/brew shellenv`)
    expect(r.out).toMatch(/✓ tmux/)
  })

  it('a keg entry whose prefix has no brew is ignored: the install step as before', () => {
    const r = run({}, (d) => `${d.stub}:${d.keg}:${SYS}`)
    expect(r.out).toContain('Homebrew not found')
    expect(r.calls).toContain('curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')
    expect(r.out).not.toContain('ERRTRAP')
    expect(r.out).not.toMatch(/No such file|command not found/)
  })

  it('the first keg entry WITH a brew wins: a brew-less keg before it is skipped', () => {
    const r = run({ custom: true }, (d) => `${d.stub}:/nonexistent-prefix/opt/node@20/bin:${d.keg}:${SYS}`)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('Homebrew not found')
    expect(r.calls).toContain(`${r.custom}/bin/brew shellenv`)
  })

  it('default /opt/homebrew: found as before; the keg rule does not override it', () => {
    const r = run({ custom: true, arm: true }, (d) => `${d.stub}:${d.keg}:${SYS}`)
    expect(r.code).toBe(0)
    expect(r.calls).toMatch(/def-arm\/bin\/brew shellenv/)
    expect(r.calls).not.toContain(`${r.custom}/bin/brew`)
    expect(r.calls).not.toContain('curl')
  })

  it('default /usr/local: found as before', () => {
    const r = run({ intel: true }, (d) => `${d.stub}:${SYS}`)
    expect(r.code).toBe(0)
    expect(r.calls).toMatch(/def-intel\/bin\/brew shellenv/)
    expect(r.calls).not.toContain('curl')
  })

  it('MARVEEN_BREW_PREFIX without a brew falls back to the defaults', () => {
    const r = run({ arm: true }, (d) => `${d.stub}:${SYS}`, () => ({ MARVEEN_BREW_PREFIX: '/nonexistent-prefix' }))
    expect(r.code).toBe(0)
    expect(r.calls).toMatch(/def-arm\/bin\/brew shellenv/)
    expect(r.calls).not.toContain('curl')
  })

  it('MARVEEN_BREW_PREFIX is honoured before a default /opt/homebrew', () => {
    const r = run({ custom: true, arm: true }, (d) => `${d.stub}:${SYS}`, (d) => ({ MARVEEN_BREW_PREFIX: d.custom }))
    expect(r.code).toBe(0)
    expect(r.calls).toContain(`${r.custom}/bin/brew shellenv`)
    expect(r.calls).not.toMatch(/def-arm\/bin\/brew/)
  })

  it('brew already on PATH: no probe at all', () => {
    const r = run({ custom: true, arm: true }, (d) => `${d.stub}:${d.custom}/bin:${SYS}`)
    expect(r.code).toBe(0)
    expect(r.calls).toBe('')
  })
})
