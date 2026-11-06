/**
 * MACROOTFROMCLONE1106: install-macos.sh runs no clone code as root, and leaves the sudo password out of clone
 * code's reach. The clone (~/marveen) is the user's: anything running as that user (an agent) can rewrite it, so a
 * root step that ran a clone file, or clone code that ran while the password was still in the installer's memory,
 * would hand the agent root on the next install.
 *
 * The boundary these rules keep: the installer itself. The user's login environment (profile, PATH, HOME) is out
 * of it (only a separate admin account separates); the Bridge's own launch is BRIDGECLEANENV1106.
 *
 * Nothing here runs the installer: the rules read the shipped text, and the embedded helpers are cut out and run.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const MAC = readFileSync(join(ROOT, 'install-macos.sh'), 'utf8')
const WRITER = readFileSync(join(ROOT, 'scripts', 'lib', 'managed-settings-write.py'), 'utf8')
const LINES = MAC.split('\n')

/** Each line with whether it is shell code: comments and the bodies of heredocs are not. */
const CODE: Array<{ i: number; l: string }> = (() => {
  const out: Array<{ i: number; l: string }> = []
  let end: string | null = null
  LINES.forEach((l, i) => {
    if (end !== null) {
      if (l === end || l.trim() === end) end = null
      return
    }
    if (/^\s*#/.test(l)) return
    out.push({ i, l })
    const m = /<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?/.exec(l)
    if (m && !/<<</.test(l)) end = m[1]!
  })
  return out
})()

/** The line of the reset that ends the root part (the sudo login dropped, the password unset). */
const RESET = LINES.findIndex((l) => l === 'unset __MARVEEN_SUDO_PW')

function heredoc(open: string, close: string): string {
  const start = MAC.indexOf(open)
  const end = MAC.indexOf(`\n${close}\n`, start)
  expect(start, open).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return MAC.slice(start + open.length, end + 1)
}

describe('the root steps run no clone code', () => {
  it('the managed-settings writer is embedded, byte-equal to scripts/lib/managed-settings-write.py', () => {
    expect(heredoc("/usr/bin/sudo /usr/bin/python3 -I -S - \"$@\" <<'MSW_PY'\n", 'MSW_PY')).toBe(WRITER)
  })

  it('every sudo in command position names /usr/bin/sudo (a PATH entry like ~/.bun/bin is the user\'s)', () => {
    // the Bridge derive step's own command-position rule, so the same lines are judged
    const bare = /(^\s*(?:(?:if|elif|while|until|then|do|else|!)\s+)?|\|\|?\s*|&&\s*|;\s*|\$\(\s*)sudo /
    const hits = CODE.filter(({ l }) => bare.test(l)).map(({ i, l }) => `${i + 1}: ${l.trim()}`)
    expect(hits).toEqual([])
  })

  it('no root command takes a path in the install dir', () => {
    const hits = CODE.filter(({ l }) => /\bsudo\b[^#]*"\$INSTALL_DIR\//.test(l)).map(({ i, l }) => `${i + 1}: ${l.trim()}`)
    expect(hits).toEqual([])
  })

  it('the user\'s shell profile is never sourced into the installer', () => {
    const hits = CODE.filter(({ l }) => /(^|[;&|]\s*|\s)(source|\.)\s+"?\$HOME\/\.(bashrc|zshrc|profile|bash_profile|zprofile)/.test(l))
    expect(hits.map(({ i, l }) => `${i + 1}: ${l.trim()}`)).toEqual([])
  })

  it('the clone\'s gate script is not run on the install path', () => {
    expect(CODE.some(({ l }) => l.includes('scripts/ensure-managed-channels-enabled.sh'))).toBe(false)
  })
})

describe('the root part ends before any clone code runs', () => {
  it('the reset drops the sudo login and unsets the Bridge password and run_priv', () => {
    expect(RESET).toBeGreaterThan(-1)
    expect(LINES[RESET - 1]).toBe('command /usr/bin/sudo -K 2>/dev/null || true')
    expect(LINES[RESET + 1]).toBe('unset -f run_priv')
  })

  it('every root step comes before the reset', () => {
    const root = CODE.filter(({ l }) => /\/usr\/bin\/sudo\b/.test(l) || /^\s*(if !?\s*)?root_npm_install_global\b/.test(l) || /managed_write "\$MANAGED_FILE"/.test(l))
    expect(root.length).toBeGreaterThan(0)
    const after = root.filter(({ i }) => i > RESET).map(({ i, l }) => `${i + 1}: ${l.trim()}`)
    expect(after).toEqual([])
  })

  it('clone code runs only after the reset (install-lang.sh on a non-Bridge run is outside the boundary)', () => {
    const clone = /npm install --loglevel|npm run build|(^|\s|\$\()\.\s+"\$INSTALL_DIR\/|bash "\$INSTALL_DIR\/|node "\$INSTALL_DIR\/|^\s*"\$INSTALL_DIR\/scripts\//
    const before = CODE.filter(({ i, l }) => i < RESET && clone.test(l)).map(({ i, l }) => `${i + 1}: ${l.trim()}`)
    expect(before).toEqual([])
    expect(CODE.some(({ i, l }) => i > RESET && clone.test(l))).toBe(true)
  })

  it('before the reset every python runs as /usr/bin/python3 -I -S (no cwd import, no site-packages, no PATH)', () => {
    const bad = CODE.filter(({ i, l }) => i < RESET && /(^|[\s($])python3\b/.test(l) && !/\/usr\/bin\/python3 -I -S\b/.test(l))
    expect(bad.map(({ i, l }) => `${i + 1}: ${l.trim()}`)).toEqual([])
  })

  it('the root npm route drops its sudo login right after', () => {
    const call = LINES.findIndex((l) => l.includes('if ! root_npm_install_global @anthropic-ai/claude-code; then'))
    expect(call).toBeGreaterThan(-1)
    const drop = LINES.findIndex((l, i) => i > call && l.trim() === 'command /usr/bin/sudo -K 2>/dev/null || true')
    expect(drop - call).toBeLessThanOrEqual(7)
  })
})

describe('the embedded helpers, run', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'macroot-')); dirs.push(d); return d }

  const HAS = heredoc("  /usr/bin/python3 -I -S - \"$@\" 2>/dev/null <<'MSH_PY'\n", 'MSH_PY')
  const has = (file: string, ...want: string[]): number =>
    spawnSync('python3', ['-I', '-S', '-', file, ...want], { input: HAS }).status ?? -1

  it('managed_has: 0 only when every wanted entry is there (read as the user, nothing written)', () => {
    const d = tmp()
    const f = join(d, 'managed-settings.json')
    expect(has(f, '--channels')).toBe(1) // missing
    writeFileSync(f, '{not json')
    expect(has(f, '--channels')).toBe(1)
    writeFileSync(f, JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [{ plugin: 'discord', marketplace: 'claude-plugins-official' }] }))
    expect(has(f, '--channels')).toBe(0)
    expect(has(f, 'discord@claude-plugins-official')).toBe(0)
    expect(has(f, 'discord@claude-plugins-official', 'telegram@claude-plugins-official')).toBe(1)
    writeFileSync(f, JSON.stringify({ channelsEnabled: 'true' }))
    expect(has(f, '--channels')).toBe(1) // only a real true
    writeFileSync(f, '[]')
    expect(has(f, '--channels')).toBe(1)
  })

  const fn = (name: string): string => {
    const start = MAC.indexOf(`${name}() {`)
    expect(start, name).toBeGreaterThan(-1)
    return MAC.slice(start, MAC.indexOf('\n}\n', start) + 3)
  }

  it.skipIf(process.platform !== 'darwin')('macos_root_only_path: a system file passes, a user file and a user dir chain do not', () => {
    const body = `${fn('macos_root_only_chain')}\n${fn('macos_root_only_path')}\n`
    const run = (p: string) => spawnSync('/bin/bash', ['-c', `${body}macos_root_only_path "$1"`, 'bash', p]).status
    expect(run('/bin/ls')).toBe(0)
    const d = tmp()
    const f = join(d, 'x')
    writeFileSync(f, 'x')
    expect(run(f)).toBe(1)
    expect(run('/no/such/file')).toBe(1)
  })

  it.skipIf(process.platform !== 'darwin')('root_npm_install_global: refuses a user-owned npm or node, and never reaches sudo', () => {
    const d = tmp()
    const bin = join(d, 'bin')
    mkdirSync(bin)
    for (const n of ['npm', 'node']) { writeFileSync(join(bin, n), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, n), 0o755) }
    const body = `${fn('macos_root_only_chain')}\n${fn('macos_root_only_path')}\n${fn('root_npm_install_global')}\n`
    // a stub /usr/bin/sudo cannot be planted; a refusal returns before it, so the run is quick and quiet
    const r = spawnSync('/bin/bash', ['-c', `${body}root_npm_install_global @anthropic-ai/claude-code; echo "rc=$?"`], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: d }, timeout: 20_000,
    })
    expect(r.stdout.trim()).toBe('rc=1')
  })
})
