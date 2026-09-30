// FLEETVENV923, tree-level pin (#1626 review): EVERY file that builds an
// `export PATH=` is listed below, with set equality, so a new launcher cannot
// appear without a decision on the fleet venv prefix.
//
// The first round wired three launchers and missed four more (the watchdog
// sub-agent restart, both main-session respawners and the background-task
// launch): after a respawn the same session got a different python3 than after
// a boot. Here each `export PATH=` code line of a file counts either as `venv`
// (it carries the prefix from one of the two shared helpers) or as `exempt`
// (it sets something that is not a local claude launch -- the reason is written
// next to it). Comment lines do not count.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, extname } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Pin { venv: number; exempt: number; why?: string; helper?: 'sh' | 'ts' }

const PINS: Record<string, Pin> = {
  // --- launchers: every launch PATH carries the venv prefix -----------------
  'scripts/channels.sh': { venv: 1, exempt: 1, helper: 'sh', why: 'the base PATH export; the venv prefix is put in front of it by the FLEETVENV923 export right after' },
  'scripts/watchdog.sh': { venv: 1, exempt: 1, helper: 'sh', why: "the watchdog's own PATH (tmux, node, python3 for the checks); the sub-agent restart CMD carries the prefix" },
  'scripts/channel-watchdog.sh': { venv: 1, exempt: 0, helper: 'sh' },
  'scripts/stuck-modal-guard.sh': { venv: 1, exempt: 0, helper: 'sh' },
  'scripts/morning-briefing.sh': { venv: 1, exempt: 1, helper: 'sh', why: 'the base PATH export (systemd hands a minimal one); the venv prefix is put in front of it right after' },
  'src/web/agent-process.ts': { venv: 1, exempt: 0, helper: 'ts' },
  'src/web/channel-monitor.ts': { venv: 1, exempt: 0, helper: 'ts' },
  'src/web/routes/background-tasks.ts': { venv: 1, exempt: 0, helper: 'ts' },
  // --- not a local claude launch --------------------------------------------
  'src/web/ssh-tmux.ts': { venv: 0, exempt: 1, why: 'remote launch over ssh: a local venv path means nothing on the remote host' },
  'scripts/monitor_agents.sh': { venv: 0, exempt: 1, why: 'tmux viewer: links existing agent windows, launches no claude' },
  'update.sh': { venv: 0, exempt: 2, why: "the updater's pinned node for its own npm/build steps" },
  'install-macos.sh': { venv: 0, exempt: 3, why: "the installer's own PATH while installing bun/node" },
  'install-linux.sh': { venv: 0, exempt: 7, why: "the installer's own PATH, and the lines it appends to the user's shell rc" },
  'install-lang.sh': { venv: 0, exempt: 2, why: "the installer's own PATH, and the line it appends to the user's shell rc" },
  'install-windows.ps1': { venv: 0, exempt: 1, why: 'WSL bootstrap line for bun, written into the rc' },
}

const EXTS = new Set(['.sh', '.ts', '.mjs', '.js', '.cjs', '.py', '.ps1'])
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
  // top-level scripts (install*.sh, update.sh, ...), not recursing into vendor/ etc.
  for (const name of readdirSync(REPO)) {
    const full = join(REPO, name)
    if (EXTS.has(extname(name)) && statSync(full).isFile()) out.push(full)
  }
  return out.map((f) => relative(REPO, f)).filter((rel) => !isTest(rel))
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|#)/.test(line)
const VENV_MARK = /FLEET_VENV_PREFIX|fleetVenvPathPrefix\(\)|\$\{venvPathPrefix\}/

// FLEETVENVPINORDER930: a launch PATH set WITHOUT export ("PATH=... claude",
// "env PATH=... claude") is a launch PATH too. It counts when PATH= stands at a
// command boundary (line start, after && ; | ( or env) and the line starts
// claude. A log text such as "not on PATH; PATH=$PATH" is not at a boundary.
const BARE_LAUNCH_PATH = /(^\s*["'`]?|&&\s*|;\s*|\|\s*|\(\s*|\benv\s+)PATH=/
const CLAUDE_LAUNCH = /\bclaude\b|CLAUDE_BIN|CLAUDE_Q|\$CLAUDE\b|claudeBin\(\)/
const isLaunchPathLine = (l: string) => !isComment(l) && (l.includes('export PATH=') || (BARE_LAUNCH_PATH.test(l) && CLAUDE_LAUNCH.test(l)))

// FLEETVENVPINORDER930: the prefix must be the FIRST thing in the value, so the
// venv's python3 wins; at the end of PATH it is present but never used.
const VENV_FIRST = /PATH=\\?"?(\$\{FLEET_VENV_PREFIX\}|\$FLEET_VENV_PREFIX|\$\{fleetVenvPathPrefix\(\)\}|\$\{venvPathPrefix\})/

function launchPathLines(rel: string): string[] {
  return readFileSync(join(REPO, rel), 'utf-8').split('\n').filter(isLaunchPathLine)
}

function pathExports(rel: string): { venv: number; exempt: number } {
  const lines = launchPathLines(rel)
  const venv = lines.filter((l) => VENV_MARK.test(l)).length
  return { venv, exempt: lines.length - venv }
}

describe('every file that builds `export PATH=` is pinned (FLEETVENV923, #1626 review)', () => {
  const found = sourceFiles().filter((rel) => pathExports(rel).venv + pathExports(rel).exempt > 0)

  it('the set of such files equals the pinned set', () => {
    expect([...found].sort()).toEqual(Object.keys(PINS).sort())
  })

  it.each(Object.entries(PINS))('%s: venv/exempt line counts match the pin', (rel, pin) => {
    expect(pathExports(rel)).toEqual({ venv: pin.venv, exempt: pin.exempt })
  })

  // FLEETVENVPINORDER930: present is not enough, the prefix must come first.
  it.each(Object.entries(PINS).filter(([, p]) => p.venv > 0))('%s: every venv PATH line puts the prefix FIRST', (rel) => {
    const venvLines = launchPathLines(rel).filter((l) => VENV_MARK.test(l))
    expect(venvLines.length).toBeGreaterThan(0)
    for (const l of venvLines) expect(l, `${rel}: ${l.trim()}`).toMatch(VENV_FIRST)
  })

  // The instrument itself: the bare form is caught, a log text is not.
  it('the line matcher sees a bare "PATH=... claude" launch and skips a log text', () => {
    expect(isLaunchPathLine('PATH="/usr/bin:$PATH" claude --model x')).toBe(true)
    expect(isLaunchPathLine('cd "$D" && env PATH="$P" "$CLAUDE_BIN" --x')).toBe(true)
    expect(isLaunchPathLine('  log "tmux or claude not on PATH; cannot act. PATH=$PATH"')).toBe(false)
    expect('export PATH="/opt/homebrew/bin:${FLEET_VENV_PREFIX}$PATH"').not.toMatch(VENV_FIRST)
    expect('export PATH="${FLEET_VENV_PREFIX}/opt/homebrew/bin:$PATH"').toMatch(VENV_FIRST)
  })

  it('every exemption carries its reason', () => {
    for (const [rel, pin] of Object.entries(PINS)) {
      if (pin.exempt > 0) expect(pin.why?.trim().length ?? 0, rel).toBeGreaterThan(20)
    }
  })

  // The prefix must come from the SHARED helpers, never from a local parse of
  // the key: a local parse is exactly how the first round diverged.
  it.each(Object.entries(PINS).filter(([, p]) => p.helper === 'sh'))('%s sources scripts/fleet-venv-prefix.sh and does not read the key itself', (rel) => {
    const src = readFileSync(join(REPO, rel), 'utf-8')
    expect(src).toContain('. "$INSTALL_DIR/scripts/fleet-venv-prefix.sh"')
    expect(src).toMatch(/FLEET_VENV_PREFIX="\$\(fleet_venv_prefix "\$INSTALL_DIR"/)
    expect(src).not.toMatch(/FLEET_PYTHON_VENV/)
  })

  it.each(Object.entries(PINS).filter(([, p]) => p.helper === 'ts'))('%s takes the prefix from fleetVenvPathPrefix()', (rel) => {
    const src = readFileSync(join(REPO, rel), 'utf-8')
    expect(src).toMatch(/fleetVenvPathPrefix\(\)/)
  })
})
