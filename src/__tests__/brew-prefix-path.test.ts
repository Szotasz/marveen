// ISSUE1968BREWPREFIX (#1968): a Homebrew in a custom prefix keeps tmux and claude in <prefix>/bin, which the
// dashboard's probe list and the main session's PATH did not have. Both now derive <prefix>/bin from the node@22 keg
// entry every installed launchd PATH starts with (<prefix>/opt/node@22/bin). Tested with stub dirs only: no brew,
// no launchd. The channels.sh block is RUN, cut out between its markers, not read as text.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brewPrefixBin, knownBinDirs, tryResolveFromPath } from '../platform.js'

const REPO = process.cwd()
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A custom prefix with the keg dir and a stub tmux in <prefix>/bin. */
function prefix(): { root: string; keg: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'hb-'))
  dirs.push(root)
  const keg = join(root, 'opt', 'node@22', 'bin')
  const bin = join(root, 'bin')
  mkdirSync(keg, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  return { root, keg, bin }
}

describe('brewPrefixBin / knownBinDirs (platform.ts)', () => {
  it('a custom prefix: <prefix>/bin from the node@22 keg entry, right after ~/.local/bin', () => {
    const p = prefix()
    const path = `${p.keg}:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`
    expect(brewPrefixBin(path)).toBe(p.bin)
    const list = knownBinDirs(path)
    expect(list.slice(0, 3)).toEqual([join(homedir(), '.local', 'bin'), p.bin, join(homedir(), '.bun', 'bin')])
  })
  it('the standard prefixes add nothing: the list is exactly the old one', () => {
    const old = [join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    const always = () => true
    expect(brewPrefixBin('/opt/homebrew/opt/node@22/bin:/usr/bin', always)).toBeNull()
    expect(brewPrefixBin('/usr/local/opt/node@22/bin:/usr/bin', always)).toBeNull()
    expect(knownBinDirs('/opt/homebrew/opt/node@22/bin:/usr/bin:/bin')).toEqual(old)
    expect(brewPrefixBin(undefined, always)).toBeNull()
    expect(knownBinDirs('')).toEqual(old)
  })
  it('no keg entry, a relative entry, a missing <prefix>/bin, or a lookalike: nothing', () => {
    const always = () => true
    expect(brewPrefixBin('/usr/bin:/bin', always)).toBeNull()
    expect(brewPrefixBin('rel/opt/node@22/bin', always)).toBeNull()
    expect(brewPrefixBin('/x/opt/node@22/bin', () => false)).toBeNull()
    expect(brewPrefixBin('/x/opt/node@22/bin/extra', always)).toBeNull()
    expect(brewPrefixBin('/x/opt/node@abc/bin', always)).toBeNull()
    // the first usable keg wins
    expect(brewPrefixBin('/opt/homebrew/opt/node@22/bin:/a/opt/node@24/bin:/b/opt/node@22/bin', always)).toBe('/a/bin')
  })
  it('tryResolveFromPath finds a tmux that lives only in <prefix>/bin when `which` cannot (the #1968 crash)', () => {
    const p = prefix()
    const saved = process.env.PATH
    try {
      process.env.PATH = p.keg // `which` searches only the keg: no tmux there
      // only ~/.local/bin is probed before the prefix; a tmux there on the test machine would win, by design
      const ahead = existsSync(join(homedir(), '.local', 'bin', 'tmux'))
      expect(tryResolveFromPath('tmux')).toBe(ahead ? join(homedir(), '.local', 'bin', 'tmux') : join(p.bin, 'tmux'))
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('channels.sh: the main session PATH', () => {
  const src = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
  const block = src.slice(src.indexOf('# ISSUE1968BREWPREFIX'), src.indexOf('# /ISSUE1968BREWPREFIX'))
  const run = (path: string, home: string) =>
    execFileSync('/bin/bash', ['-c', `${block}\nprintf '%s' "$PATH"`], { encoding: 'utf-8', env: { PATH: path, HOME: home } })

  it('the block is there, between its markers, and ends with the one base export', () => {
    expect(block.length).toBeGreaterThan(100)
    expect(block.trim().split('\n').filter((l) => /^export PATH=/.test(l))).toHaveLength(1)
  })
  it('a custom prefix: <prefix>/bin right after ~/.local/bin, and `command -v tmux` finds it', () => {
    const p = prefix()
    const out = run(`${p.keg}:/usr/bin:/bin`, '/home/x')
    expect(out).toBe(`/home/x/.local/bin:${p.bin}:/opt/homebrew/bin:/home/x/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin`)
    const found = execFileSync('/bin/bash', ['-c', `${block}\ncommand -v tmux`], { encoding: 'utf-8', env: { PATH: `${p.keg}:/nonexistent`, HOME: '/home/x' } }).trim()
    expect(found).toBe(join(p.bin, 'tmux')) // /home/x does not exist, so the prefix is the first dir with a tmux
  })
  it('no keg entry, or a standard prefix: byte for byte the old list', () => {
    const old = '/home/x/.local/bin:/opt/homebrew/bin:/home/x/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin'
    expect(run('/usr/bin:/bin', '/home/x')).toBe(old)
    expect(run('/opt/homebrew/opt/node@22/bin:/usr/bin:/bin', '/home/x')).toBe(old)
    expect(run('', '/home/x')).toBe(old)
  })
  it('a keg whose <prefix>/bin does not exist adds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-nobin-'))
    dirs.push(root)
    mkdirSync(join(root, 'opt', 'node@22', 'bin'), { recursive: true })
    expect(run(`${root}/opt/node@22/bin:/usr/bin`, '/home/x')).not.toContain(`${root}/bin`)
  })
  it('the shell and the dashboard rules agree on where the prefix goes (after ~/.local/bin)', () => {
    const p = prefix()
    const sh = run(`${p.keg}:/usr/bin`, homedir()).split(':')
    const ts = knownBinDirs(`${p.keg}:/usr/bin`)
    expect(sh.indexOf(p.bin)).toBe(1)
    expect(ts.indexOf(p.bin)).toBe(1)
  })
})
