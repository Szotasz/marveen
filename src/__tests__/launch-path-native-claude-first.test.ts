// NATIVECLAUDEFIRST1011 (#1896): a launcher that resolves `claude` by name must
// find the install user's native launcher ($HOME/.local/bin/claude) before a
// Homebrew/npm copy in /opt/homebrew/bin. With /opt/homebrew/bin first, a Mac
// that also had an older shared claude there ran the main session on that one,
// while the dashboard (launchd PATH ~/.local/bin first) and platform.ts
// KNOWN_BIN_DIRS picked the native build for the sub-agents.
//
// Two layers:
//   1. behaviour: the base PATH export of scripts/channels.sh is run in bash
//      against a throwaway HOME, with /opt/homebrew/bin swapped for a temp dir
//      that holds a second claude; `command -v claude` must return the native
//      one. The same run with the pre-fix order returns the Homebrew copy
//      (negative control, so the instrument can fail).
//   2. tree pin: every PATH assignment in src/, scripts/ and the top-level
//      scripts that names both directories puts $HOME/.local/bin first, unless
//      it is listed in EXEMPT with its reason (none of them launches claude by
//      name). A new launcher with the old order fails here instead of
//      reintroducing two claudes on one host.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BREW = '/opt/homebrew/bin'

// file -> reason. Each entry is a PATH line that keeps the old order on purpose.
const EXEMPT: Record<string, string> = {
  'scripts/gitnexus/install-autorebuild.sh': 'gitnexus rebuild hook: runs no claude',
  'src/web/channel-monitor.ts': 'the recovery relaunch runs the absolute claudeBin() path resolved by the dashboard, not a PATH lookup',
}

const EXTS = new Set(['.sh', '.ts', '.mjs', '.js', '.cjs', '.py'])
const isTest = (rel: string) => rel.includes('__tests__/') || /\.test\.[a-z]+$/.test(rel)

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXTS.has(extname(name))) out.push(full)
  }
}

function sourceFiles(): string[] {
  const out: string[] = []
  for (const root of ['src', 'scripts']) walk(join(REPO, root), out)
  for (const name of readdirSync(REPO)) {
    const full = join(REPO, name)
    if (EXTS.has(extname(name)) && statSync(full).isFile()) out.push(full)
  }
  return out.map((f) => relative(REPO, f)).filter((rel) => !isTest(rel))
}

// A PATH assignment (shell/TS `PATH=` or a launchd plist <string>) that names both directories.
function bothDirLines(rel: string): string[] {
  return readFileSync(join(REPO, rel), 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .filter((l) => /PATH=|<string>/.test(l))
    .filter((l) => l.includes(BREW) && l.includes('.local/bin'))
}

const nativeFirst = (line: string) => line.indexOf('.local/bin') < line.indexOf(BREW)

function resolveClaude(exportLine: string): string {
  const home = mkdtempSync(join(tmpdir(), 'ncf-home-'))
  const brew = mkdtempSync(join(tmpdir(), 'ncf-brew-'))
  try {
    for (const [dir, who] of [[join(home, '.local', 'bin'), 'native'], [brew, 'brew']] as const) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho ${who}\n`)
      chmodSync(join(dir, 'claude'), 0o755)
    }
    const line = exportLine.split(BREW).join(brew)
    return execFileSync('bash', ['--noprofile', '--norc', '-c', `${line}\ncommand -v claude`], {
      encoding: 'utf-8',
      env: { HOME: home, PATH: '/usr/bin:/bin' },
    }).trim()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(brew, { recursive: true, force: true })
  }
}

describe('NATIVECLAUDEFIRST1011: the native claude leads the launch PATH', () => {
  const channels = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
  const base = channels.split('\n').filter((l) => /^export PATH="/.test(l) && l.includes(BREW))

  it('channels.sh has exactly one base PATH export naming /opt/homebrew/bin', () => {
    expect(base).toHaveLength(1)
  })

  it('under that PATH `command -v claude` returns the native launcher, not the Homebrew copy', () => {
    expect(resolveClaude(base[0])).toMatch(/\/\.local\/bin\/claude$/)
  })

  it('negative control: the pre-fix order returns the Homebrew copy', () => {
    const preFix = 'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"'
    expect(resolveClaude(preFix)).not.toMatch(/\/\.local\/bin\/claude$/)
  })

  it('every PATH assignment naming both directories puts $HOME/.local/bin first (or is exempt with a reason)', () => {
    const offenders: string[] = []
    for (const rel of sourceFiles()) {
      if (rel in EXEMPT) continue
      for (const l of bothDirLines(rel)) if (!nativeFirst(l)) offenders.push(`${rel}: ${l.trim()}`)
    }
    expect(offenders).toEqual([])
  })

  // Every launcher that resolves claude by name under its own PATH, and the respawn PATHs it hands the session:
  // channels.sh boot, the channel-watchdog and stuck-modal-guard main respawns (the guard's own claude comes from
  // its launchd PATH), and the watchdog sub-agent restart.
  const FIXED = ['scripts/channels.sh', 'scripts/channel-watchdog.sh', 'scripts/watchdog.sh', 'scripts/stuck-modal-guard.sh',
    'scripts/install-stuck-modal-guard.sh']

  it('the fixed launchers are pinned', () => {
    for (const rel of FIXED) {
      const lines = bothDirLines(rel)
      expect(lines.length, rel).toBeGreaterThan(0)
      for (const l of lines) expect(nativeFirst(l), `${rel}: ${l.trim()}`).toBe(true)
    }
  })

  it('the stuck-modal guard looks claude up native-first itself (an installed plist keeps its old PATH)', () => {
    const guard = readFileSync(join(REPO, 'scripts', 'stuck-modal-guard.sh'), 'utf-8')
    const lookups = guard.split('\n').filter((l) => !/^\s*#/.test(l) && /command -v claude/.test(l))
    expect(lookups.length).toBeGreaterThan(0)
    for (const l of lookups) expect(l, l.trim()).toContain('CLAUDE="$HOME/.local/bin/claude"; [ -x "$CLAUDE" ] || CLAUDE="$(command -v claude)"')
  })

  it('every exemption still exists, still has the old order, and carries its reason', () => {
    for (const [rel, why] of Object.entries(EXEMPT)) {
      expect(why.trim().length, rel).toBeGreaterThan(20)
      const lines = bothDirLines(rel)
      expect(lines.some((l) => !nativeFirst(l)), `${rel}: no old-order line left, drop the exemption`).toBe(true)
    }
  })
})
