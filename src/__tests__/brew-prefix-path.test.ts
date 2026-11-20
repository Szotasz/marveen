// ISSUE1968BREWPREFIX (#1968): a Homebrew in a custom prefix keeps tmux and claude in <prefix>/bin, which the
// dashboard's probe list and the main session's PATH did not have. Both now derive <prefix>/bin from the node@22 keg
// entry every installed launchd PATH starts with (<prefix>/opt/node@22/bin). Tested with stub dirs only: no brew,
// no launchd. The channels.sh block is RUN, cut out between its markers, not read as text.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { brewPrefixBin, knownBinDirs, learnedPathDirProblem, plistPathDirOk, tryResolveFromPath } from '../platform.js'

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

// BREWPREFIXREST1107: the three copies of the rule (channels.sh's block, scripts/lib/helper-path.sh
// helper_brew_prefix_bin, platform.ts brewPrefixBin) give the same dir for the same PATH. The channels.sh block
// used to skip only /opt/homebrew/bin and /usr/local/bin, so /usr/opt/node@22/bin put /usr/bin in front while the
// TS side (FIXED_BIN_DIRS) added nothing, and its `/*/opt` matched //opt/node@22/bin, which the TS regex does not.
describe('the rule is the same in bash and TS (parity)', () => {
  const src = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
  const block = src.slice(src.indexOf('# ISSUE1968BREWPREFIX'), src.indexOf('# /ISSUE1968BREWPREFIX'))
  const channels = (path: string) =>
    execFileSync('/bin/bash', ['-c', `${block}\nprintf '%s' "\${BREW_PREFIX_BIN%:}"`], { encoding: 'utf-8', env: { PATH: path, HOME: '/home/x' } })
  const helper = (path: string) =>
    execFileSync('/bin/bash', ['-c', `. "$1"; PATH="$2"; helper_brew_prefix_bin`, '_', join(REPO, 'scripts', 'lib', 'helper-path.sh'), path],
      { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: '/home/x' } }).trim()

  it('channels.sh, helper-path.sh and platform.ts agree on every case', () => {
    const p = prefix()
    const q = prefix()
    const spaced = mkdtempSync(join(tmpdir(), 'hb sp-'))
    dirs.push(spaced)
    mkdirSync(join(spaced, 'opt', 'node@7', 'bin'), { recursive: true })
    mkdirSync(join(spaced, 'bin'), { recursive: true })
    const cases: Array<[string, string | null]> = [
      [`${p.keg}:/usr/bin:/bin`, p.bin],
      ['/usr/opt/node@22/bin:/usr/bin', null], // <prefix>/bin = /usr/bin, a fixed dir
      [`/usr/opt/node@22/bin:${p.keg}`, p.bin], // ...skipped, the next keg wins
      ['//opt/node@22/bin:/usr/bin', null], // no prefix before /opt (bash `/*/opt` matched it: //bin)
      ['/opt/node@22/bin', null],
      ['/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin', null],
      [`/opt/homebrew/opt/node@22/bin:${q.keg}:${p.keg}`, q.bin], // the first usable keg wins
      [`::${p.keg}:`, p.bin],
      [`${join(spaced, 'opt', 'node@7', 'bin')}`, join(spaced, 'bin')],
      [`${p.root}/opt/node@123/bin`, null],
      [`${p.keg}/`, null],
      ['rel/opt/node@22/bin', null],
      ['/bin/opt/node@22/bin', null], // /bin/bin does not exist
      ['', null],
    ]
    for (const [path, want] of cases) {
      expect({ path, ts: brewPrefixBin(path) }).toEqual({ path, ts: want })
      expect({ path, channels: channels(path) || null }).toEqual({ path, channels: want })
      expect({ path, helper: helper(path) || null }).toEqual({ path, helper: want })
    }
  })
})

// BREWPREFIXREST1107 (Dani's #2578 note 2): the CLI version probe of `channels.sh --resolve-main-model` (the
// watchdogs call it under a narrow launchd PATH) tries the dirs knownBinDirs() does, so a claude that lives only in
// <prefix>/bin is the one measured, ahead of ~/.bun/bin; before, it fell through to another copy or to unmeasured.
describe('channels.sh --resolve-main-model: the CLI probe finds the claude in <prefix>/bin', () => {
  it('a claude only in <prefix>/bin (and an older one in ~/.bun/bin) is the one probed', () => {
    const p = prefix()
    const root = mkdtempSync(join(tmpdir(), 'hb-root-'))
    dirs.push(root)
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'channels.sh'), readFileSync(join(REPO, 'scripts', 'channels.sh')))
    writeFileSync(join(root, 'scripts', 'lib', 'helper-path.sh'), readFileSync(join(REPO, 'scripts', 'lib', 'helper-path.sh')))
    writeFileSync(join(root, 'dist', 'config-registry.js'),
      "module.exports = { DISTRIBUTION_DEFAULT_AGENT_MODEL: 'm-default', DISTRIBUTION_DEFAULT_FALLBACK_MODEL: 'm-fallback' }\n")
    writeFileSync(join(root, 'dist', 'claude-cli-support.js'),
      "module.exports = { parseClaudeVersion: (s) => String(s).trim() || null,\n" +
      "  launchableDefaultModel: (def, fb, ver) => ({ model: ver ? 'probed-' + ver : def, replaced: null }) }\n")
    const stubClaude = (dir: string, ver: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho ${ver}\n`)
      chmodSync(join(dir, 'claude'), 0o755)
    }
    stubClaude(p.bin, '7.7.7')
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'))
    dirs.push(home)
    stubClaude(join(home, '.bun', 'bin'), '1.1.1')
    symlinkSync(process.execPath, join(p.keg, 'node')) // node in the keg, as on a real install
    const out = execFileSync('/bin/bash', [join(root, 'scripts', 'channels.sh'), '--resolve-main-model'],
      { encoding: 'utf-8', env: { PATH: `${p.keg}:/usr/bin:/bin`, HOME: home } })
    expect(out.split('\n')[0]).toBe('probed-7.7.7')
  })
})

// BREWPREFIXREST1107: scripts/setup.ts writes the dashboard plist through the same TS rule. setup.ts is an
// interactive script whose main() runs on import (it would prompt and call launchctl), so this pins the wiring by
// reading the source; brewPrefixBin's behaviour is tested above.
describe('scripts/setup.ts: the dashboard plist PATH', () => {
  it('puts brewPrefixBin(process.env.PATH) in front of the fixed list', () => {
    const src = readFileSync(join(REPO, 'scripts', 'setup.ts'), 'utf-8')
    expect(src).toMatch(/import \{ brewPrefixBin, learnedPathDirProblem, plistPathDirOk \} from '\.\.\/src\/platform\.js'/)
    expect(src).toContain('const foundBrewBin = brewPrefixBin(process.env.PATH)')
    expect(src).toContain(": learnedPathDirProblem(foundBrewBin, process.getuid?.(), process.platform, brewNotes)")
    expect(src).toContain('if (!brewProblem) for (const n of brewNotes) console.warn(n)')
    expect(src).toContain('const brewBin = foundBrewBin && !brewProblem ? foundBrewBin : null')
    expect(src).toContain("<string>${brewBin ? `${brewBin}:` : ''}/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>")
  })
})

// BREWPREFIXREST1107 R1 (Dani, #2978): setup.ts leaves out a prefix bin that would break the plist <string>
// (XML markup) or the PATH (a colon). plistPathDirOk refuses exactly what helper-path.sh _helper_path_learn refuses:
// each case is RUN through the bash function too, so the two sets cannot drift apart.
describe('plistPathDirOk (platform.ts) = helper-path.sh _helper_path_learn', () => {
  // the kept cases are real 0755 dirs: bash also refuses a dir that is not there (PATHDIROWNER1120)
  const root = mkdtempSync(join(tmpdir(), 'ppd-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  for (const d of ['custombrew/bin', 'a b/homebrew/bin']) {
    mkdirSync(join(root, d), { recursive: true })
    chmodSync(join(root, d), 0o755)
  }
  const cases: Array<[string, boolean]> = [
    [join(root, 'custombrew/bin'), true],
    [join(root, 'a b/homebrew/bin'), true],
    ['', false],
    ['/opt/a:b/bin', false],
    ['/opt/</string><key>X</key><string>/bin', false],
    ['/opt/a<b/bin', false],
    ['/opt/a>b/bin', false],
    ['/opt/a&b/bin', false],
    ['/opt/a"b/bin', false],
    ["/opt/a'b/bin", false],
    ['/opt/a\nb/bin', false],
    ['/opt/a\tb/bin', false],
    ['/opt/a\rb/bin', false],
    ['/opt/a\x7fb/bin', false],
  ]
  for (const [dir, ok] of cases) {
    it(`${JSON.stringify(dir)} -> ${ok ? 'kept' : 'left out'} in TS and bash`, () => {
      expect(plistPathDirOk(dir)).toBe(ok)
      const out = execFileSync('bash', ['-c',
        '. "$1/scripts/lib/helper-path.sh"; _hlp_learned=""; _helper_path_learn "$2" dir 2>/dev/null; printf "%s" "$_hlp_learned"',
        'x', REPO, dir], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
      expect(out === `${dir}:`).toBe(ok)
    })
  }
})

// PATHDIROWNER1120: a learned dir goes in front of a launchd PATH only when no one but the installing user or root
// can write it. learnedPathDirProblem (setup.ts) and helper-path.sh _helper_path_unsafe (the helper plists) apply the
// same rule: each case is RUN through both and the reasons compared.
describe('learnedPathDirProblem (platform.ts) = helper-path.sh _helper_path_unsafe', () => {
  const root = mkdtempSync(join(tmpdir(), 'pdo-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const mk = (name: string, mode: number) => { const d = join(root, name); mkdirSync(d); chmodSync(d, mode); return d }
  const own = mk('own', 0o755)
  const cases: Array<[string, string, string | null]> = [
    ['own 0755', own, null],
    ['own 0700', mk('own700', 0o700), null],
    ['group-writable 0775', mk('gw', 0o775), 'is group-writable'],
    ['writable by others 0757', mk('ow', 0o757), 'is writable by others'],
    ['root-owned 0755', '/usr/sbin', null],
    ['missing', join(root, 'missing'), 'is not a directory'],
  ]
  symlinkSync(own, join(root, 'link'))
  cases.push(['symlink to an own 0755 dir', join(root, 'link'), 'is a symlink'])
  // R1 (Dani, #2985): every ancestor up to / passes the rule; a sticky ancestor may be writable
  const w777 = mk('w777', 0o755); mkdirSync(join(w777, 'bin'), { mode: 0o755 }); chmodSync(w777, 0o777)
  const st = mk('st', 0o755); mkdirSync(join(st, 'bin'), { mode: 0o755 }); chmodSync(st, 0o1777)
  const gwp = mk('gwp', 0o755); mkdirSync(join(gwp, 'bin'), { mode: 0o755 }); chmodSync(gwp, 0o775)
  const o757 = mk('o757', 0o755); mkdirSync(join(o757, 'bin'), { mode: 0o755 }); chmodSync(o757, 0o757)
  symlinkSync(w777, join(root, 'vialink'))
  // 0777: the group rule decides first
  cases.push(['own 0755 bin under a 0777 parent', join(w777, 'bin'), `has a parent ${w777} that is group-writable`])
  cases.push(['own 0755 bin under a 0757 parent', join(o757, 'bin'), `has a parent ${o757} that is writable by others`])
  cases.push(['own 0755 bin under a sticky 1777 parent', join(st, 'bin'), null])
  cases.push(['own 0755 bin under a 0775 parent', join(gwp, 'bin'), `has a parent ${gwp} that is group-writable`])
  // the real path is checked: the parent is named as realpath gives it
  cases.push(['through a symlink whose target parent is 0777', join(root, 'vialink', 'bin'),
    `has a parent ${realpathSync(w777)} that is group-writable`])
  writeFileSync(join(root, 'file'), '')
  cases.push(['a file', join(root, 'file'), 'is not a directory'])
  // Dani (#2985): a relative path is refused at once (the ancestor walk would never reach /)
  cases.push(['a relative path', 'scripts', 'is not an absolute path'])
  cases.push(['a relative path with a slash', 'a/b', 'is not an absolute path'])
  // macOS: the admin group (gid 80) may write (Samu, #2985); another group and others may not. Needs macOS and
  // membership of the admin group to make such dirs; the Linux branch is run here through the os parameter.
  const adminDirs = (() => {
    if (process.platform !== 'darwin') return null
    try {
      const adm = mk('adm', 0o775); execFileSync('chgrp', ['80', adm]); chmodSync(adm, 0o775)
      const stf = mk('stf', 0o775); execFileSync('chgrp', ['20', stf]); chmodSync(stf, 0o775)
      const admo = mk('admo', 0o775); execFileSync('chgrp', ['80', admo]); chmodSync(admo, 0o777)
      return { adm, stf, admo }
    } catch {
      return null
    }
  })()
  if (adminDirs) {
    cases.push(['darwin: admin-group-writable 0775', adminDirs.adm, null])
    cases.push(['darwin: staff-group-writable 0775', adminDirs.stf, 'is group-writable'])
    cases.push(['darwin: admin group, 0777', adminDirs.admo, 'is writable by others'])
  }
  for (const [name, dir, why] of cases) {
    it(`${name} -> ${why ?? 'learned'} in TS and bash`, () => {
      const notes: string[] = []
      expect(learnedPathDirProblem(dir, process.getuid?.(), process.platform, notes)).toBe(why)
      const r = spawnSync('bash', ['-c', '. "$1/scripts/lib/helper-path.sh"; _helper_path_unsafe "$2"', 'x', REPO, dir],
        { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 10000 })
      expect(r.stdout.trim() || null).toBe(why)
      // the HELPER-PATH-ADMIN lines name the same dirs on both sides
      expect(r.stderr.split('\n').filter((l) => l.startsWith('HELPER-PATH-ADMIN:'))).toEqual(notes)
    })
  }
  it.skipIf(!adminDirs)('darwin: a dir that passed only through the admin exception is named in the notes', () => {
    const notes: string[] = []
    expect(learnedPathDirProblem(adminDirs!.adm, process.getuid?.(), 'darwin', notes)).toBe(null)
    expect(notes).toEqual([`HELPER-PATH-ADMIN: ${adminDirs!.adm} is writable by the admin group (gid 80); allowed on macOS, its members can sudo`])
    const none: string[] = []
    expect(learnedPathDirProblem(own, process.getuid?.(), 'darwin', none)).toBe(null)
    expect(none).toEqual([])
  })
  it.skipIf(!adminDirs)('linux: the admin-group exception does not apply (os parameter)', () => {
    expect(learnedPathDirProblem(adminDirs!.adm, process.getuid?.(), 'linux')).toBe('is group-writable')
    expect(learnedPathDirProblem(adminDirs!.adm, process.getuid?.(), 'darwin')).toBe(null)
  })
  it('a dir owned by another user -> refused (TS, with another installing uid)', () => {
    expect(learnedPathDirProblem(own, (process.getuid?.() ?? 0) + 4242)).toBe('is owned by neither the installing user nor root')
    expect(learnedPathDirProblem('/usr/sbin', (process.getuid?.() ?? 0) + 4242)).toBe(null)
  })
})
