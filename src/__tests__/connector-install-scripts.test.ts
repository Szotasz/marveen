// A GitHub connector repo is installed with npm lifecycle scripts skipped by
// default; only an explicit boolean `runScripts: true` re-enables them, the
// choice is persisted per repo so updates follow it, and an npm failure on
// install is surfaced as `installWarning` instead of a silent success.
// The repo's own .npmrc is not consulted during npm install (it could name
// the git executable or switch to a global install), and the dangerous keys
// are pinned on the command line. Skipped scripts are reported back
// (`scriptsSkipped`) so the UI can offer the opt-in.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync, symlinkSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'connector-install-'))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
}))

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

vi.mock('../web/vault.js', () => ({
  listSecrets: vi.fn(() => []),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(() => null),
  getSecretsForEnv: vi.fn(() => ({})),
}))

// git clone creates the target dir with the configured files; npm goes through execFileSync.
const DEFAULT_PKG = '{"name":"x"}'
const cloneFiles: { value: Record<string, string> } = { value: {} }
const execSyncMock = vi.fn((cmd: string) => {
  const m = cmd.match(/^git clone --depth 1 \S+ (\S+)$/)
  if (m) {
    mkdirSync(m[1], { recursive: true })
    for (const [name, content] of Object.entries(cloneFiles.value)) {
      mkdirSync(dirname(join(m[1], name)), { recursive: true })
      writeFileSync(join(m[1], name), content)
    }
  }
  return ''
})
const execFileSyncMock = vi.fn((_file: string, _args: string[], _opts?: any): string => '')
// The `npm install --package-lock-only` pass: by default writes the lockfile
// the cloned package.json carries under `testLock` (or a minimal one).
const MIN_LOCK = { lockfileVersion: 3, packages: { '': {} } }
const lockOnlyMock = vi.fn((_file: string, _args: string[], opts: any): string => {
  const pkg = JSON.parse(readFileSync(join(opts.cwd, 'package.json'), 'utf-8'))
  for (const [name, content] of Object.entries(pkg.testLock ?? { 'package-lock.json': MIN_LOCK })) {
    mkdirSync(dirname(join(opts.cwd, name)), { recursive: true })
    writeFileSync(join(opts.cwd, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return ''
})
// `npm query .workspace --json`: no workspaces unless a test says otherwise.
const queryMock = vi.fn((_file: string, _args: string[], _opts: any): string => '[]')
// `git ls-files -s -z` in the cloned repo: symlink entries (mode 120000) for
// the configured paths. With `realGit.origin` set, clone, pull and ls-files
// run for real against that local origin repo instead.
const tracked: { links: string[] } = { links: [] }
const realGit: { origin?: string } = {}
const SHA = '0123456789abcdef0123456789abcdef01234567'
// Other git calls run for real; recorded here.
const gitCalls: Array<{ args: string[], cwd?: string }> = []
const gitLsFilesMock = vi.fn((_args: string[], _opts: any): string =>
  ['100644 ' + SHA + ' 0\tpackage.json\0', ...tracked.links.map(p => `120000 ${SHA} 0\t${p}\0`)].join(''))
// Only npm and git are intercepted; anything else (e.g. PATH probes at import time) runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    execSync: (cmd: string, opts?: any) => {
      if (realGit.origin && /^git (clone|pull) /.test(cmd)) {
        return orig.execSync(cmd.replace(/^git clone --depth 1 \S+/, `git clone -q --depth 1 file://${realGit.origin}`), opts)
      }
      return /^(git|npm) /.test(cmd) ? execSyncMock(cmd) : orig.execSync(cmd, opts)
    },
    execFileSync: (file: string, args: string[], opts?: any) => (
      file === 'npm' ? (args.includes('--package-lock-only') ? lockOnlyMock(file, args, opts) : args[0] === 'query' ? queryMock(file, args, opts) : execFileSyncMock(file, args, opts))
        : file === 'git' && args[0] === 'ls-files' && !realGit.origin ? gitLsFilesMock(args, opts)
          : (file === 'git' && gitCalls.push({ args, cwd: opts?.cwd }), orig.execFileSync(file, args, opts))),
  }
})

const { execFileSync: execFileSyncReal } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
const ds = await import('../web/dashboard-settings.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const {
  connectorInstallArgs, parseRunScriptsFlag, installGitHubRepo, updateGitHubRepo,
  skippedInstallScripts, withRepoNpmrcSetAside, CONNECTOR_NPM_PINNED_ARGS: PIN,
  trackedSymlinkPaths, lockPathLeavesRepo, lockfileEscapes, lockfileRefusalReason, connectorLockOnlyArgs, connectorRebuildArgs, rebuildTargets, isPlainPackageName, skippedForDisplay, sameSkippedSet, connectorWorkspaceQueryArgs, parseWorkspaceQuery,
} = ds
// Spelled out so that dropping a pin from the shared constant is caught.
const PINS = [
  '--git=git', '--global=false', '--location=project', '--node-options=',
  '--package-lock=true', '--install-strategy=hoisted', '--global-style=false', '--legacy-bundling=false',
  '--install-links=false', '--dry-run=false',
]
const SAFE = ['install', '--omit=dev', '--ignore-scripts', ...PINS, '--package-lock-only=false']
const OPTIN = ['install', '--omit=dev', '--ignore-scripts=false', ...PINS, '--package-lock-only=false']
const REBUILD = ['rebuild', '--ignore-scripts=false', ...PINS, 'native']
// The real install writes npm's hidden lockfile; `native` has an install script.
const NATIVE_LOCK = { lockfileVersion: 3, packages: { 'node_modules/native': { hasInstallScript: true } } }
function installWritesHiddenLock(hook?: (args: string[], opts: any) => void): void {
  execFileSyncMock.mockImplementation((_f, a, opts) => {
    hook?.(a, opts)
    if (a[0] === 'install') {
      mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true })
      writeFileSync(join(opts.cwd, 'node_modules', '.package-lock.json'), JSON.stringify(NATIVE_LOCK))
    }
    return ''
  })
}
const REPO_URL = 'https://github.com/acme/tool'
const REPO_DIR = join(tmpRoot, 'store', 'github-repos', 'acme--tool')

const SETTINGS = join(tmpRoot, 'store', 'dashboard-settings.json')
function settings(): any { return JSON.parse(readFileSync(SETTINGS, 'utf-8')) }
function npmCalls(): string[][] { return execFileSyncMock.mock.calls.filter(c => c[0] === 'npm').map(c => c[1]) }
function writeSettings(v: unknown): void { writeFileSync(SETTINGS, JSON.stringify(v)) }

beforeEach(() => {
  rmSync(join(tmpRoot, 'store'), { recursive: true, force: true })
  mkdirSync(join(tmpRoot, 'store'), { recursive: true })
  execSyncMock.mockClear()
  execFileSyncMock.mockReset()
  execFileSyncMock.mockImplementation(() => '')
  logSpy.warn.mockClear()
  cloneFiles.value = { 'package.json': DEFAULT_PKG }
  tracked.links = []
  realGit.origin = undefined
  lockOnlyMock.mockClear()
  gitCalls.length = 0
  queryMock.mockReset()
  queryMock.mockImplementation(() => '[]')
  gitLsFilesMock.mockClear()
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('connectorInstallArgs', () => {
  it('default skips lifecycle scripts and dev dependencies', () => {
    expect(connectorInstallArgs()).toEqual(SAFE)
    expect(connectorInstallArgs({})).toEqual(SAFE)
  })
  it('runScripts: false still skips scripts', () => {
    expect(connectorInstallArgs({ runScripts: false })).toEqual(SAFE)
  })
  it('only a real boolean true enables scripts', () => {
    expect(connectorInstallArgs({ runScripts: true })).toEqual(OPTIN)
  })
  it.each([['true'], [1], ['yes'], [{}], [[]], [null]])('truthy non-boolean %j does not enable scripts', (v) => {
    expect(connectorInstallArgs({ runScripts: v as any })).toContain('--ignore-scripts')
  })
  it('pins the same config keys in both modes and on the resolve pass', () => {
    expect(PIN).toEqual(PINS)
    for (const args of [connectorInstallArgs(), connectorInstallArgs({ runScripts: true }), connectorLockOnlyArgs()]) {
      expect(args).toEqual(expect.arrayContaining(PINS))
    }
  })
  it('the real install follows the lockfile; only the resolve pass is lock-only', () => {
    for (const args of [connectorInstallArgs(), connectorInstallArgs({ runScripts: true })]) {
      expect(args).toContain('--package-lock=true')
      expect(args.at(-1)).toBe('--package-lock-only=false')
      expect(args).not.toContain('--package-lock-only')
    }
    expect(connectorLockOnlyArgs().slice(-2)).toEqual(['--package-lock-only', '--save=true'])
  })
  it('the opt-in states ignore-scripts=false explicitly; the resolve pass always skips scripts', () => {
    expect(connectorInstallArgs({ runScripts: true })).toContain('--ignore-scripts=false')
    expect(connectorInstallArgs({ runScripts: true })).not.toContain('--ignore-scripts')
    expect(connectorLockOnlyArgs()).toContain('--ignore-scripts')
    expect(connectorLockOnlyArgs()).not.toContain('--ignore-scripts=false')
  })
  it('never uses the deprecated --production flag', () => {
    expect(connectorInstallArgs()).not.toContain('--production')
    expect(connectorInstallArgs({ runScripts: true })).not.toContain('--production')
  })
})

describe('parseRunScriptsFlag', () => {
  it('absent means not specified', () => { expect(parseRunScriptsFlag(undefined)).toEqual({}) })
  it('booleans pass through', () => {
    expect(parseRunScriptsFlag(true)).toEqual({ value: true })
    expect(parseRunScriptsFlag(false)).toEqual({ value: false })
  })
  it.each([['true'], ['false'], [1], [0], [null], [{}]])('%j is rejected', (v) => {
    expect(parseRunScriptsFlag(v).error).toBeTruthy()
    expect(parseRunScriptsFlag(v).value).toBeUndefined()
  })
})

describe('skippedInstallScripts', () => {
  const none = { pkg: null, hasBindingGyp: false, hiddenLock: null }
  it('nothing declared, nothing reported', () => {
    expect(skippedInstallScripts(none)).toEqual([])
    expect(skippedInstallScripts({ ...none, pkg: { scripts: { start: 'node x', test: 'vitest' } } })).toEqual([])
  })
  it('lists the root install hooks in lifecycle order', () => {
    const pkg = { scripts: { prepare: 'tsc', postinstall: 'node p', preinstall: 'x', build: 'tsc' } }
    expect(skippedInstallScripts({ ...none, pkg })).toEqual(['preinstall', 'postinstall', 'prepare'])
    const all = { scripts: { postprepare: 'e', prepare: 'd', preprepare: 'c', postinstall: 'b', install: 'a', preinstall: 'z', test: 't' } }
    expect(skippedInstallScripts({ ...none, pkg: all })).toEqual(['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'])
  })
  it('ignores empty and non-string hook values', () => {
    expect(skippedInstallScripts({ ...none, pkg: { scripts: { install: '  ', prepare: 1, postinstall: null } } })).toEqual([])
  })
  it('a root binding.gyp counts (implicit node-gyp rebuild)', () => {
    expect(skippedInstallScripts({ ...none, hasBindingGyp: true })).toEqual(['binding.gyp'])
  })
  it('dependencies marked hasInstallScript in the hidden lockfile', () => {
    const hiddenLock = { packages: { 'node_modules/a': { hasInstallScript: true }, 'node_modules/b': {}, 'node_modules/c': { hasInstallScript: 'yes' } } }
    expect(skippedInstallScripts({ ...none, hiddenLock })).toEqual(['node_modules/a'])
  })
  it('survives malformed inputs', () => {
    expect(skippedInstallScripts({ pkg: 'x', hasBindingGyp: false, hiddenLock: [1, 2] })).toEqual([])
    expect(skippedInstallScripts({ pkg: { scripts: 'x' }, hasBindingGyp: false, hiddenLock: { packages: null } })).toEqual([])
  })
  it('nested and duplicate dependencies by name; names npm cannot rebuild left out', () => {
    const hiddenLock = { packages: {
      'node_modules/a': { hasInstallScript: true }, 'node_modules/x/node_modules/a': { hasInstallScript: true },
      'node_modules/y/node_modules/only-nested': { hasInstallScript: true }, 'node_modules/x.tgz': { hasInstallScript: true },
    } }
    expect(skippedInstallScripts({ ...none, hiddenLock })).toEqual(['node_modules/a', 'node_modules/only-nested'])
  })
  it('the full list is kept; only the displayed one is cut short', () => {
    const packages: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) packages[`node_modules/p${String(i).padStart(2, '0')}`] = { hasInstallScript: true }
    const out = skippedInstallScripts({ ...none, hiddenLock: { packages } })
    expect(out).toHaveLength(30)
    const shown = skippedForDisplay(out)
    expect(shown).toHaveLength(21)
    expect(shown[20]).toBe('+10 more')
    expect(skippedForDisplay(['a'])).toEqual(['a'])
  })
  it('workspace packages: their install hooks are listed as <path>: <hook>; one without hooks is not', () => {
    const workspaces = {
      'packages/server': { scripts: { prepare: 'tsc', postinstall: 'node p', build: 'tsc' } },
      'packages/plain': { scripts: { test: 'x' } },
      'packages/broken': 'not json',
    }
    expect(skippedInstallScripts({ ...none, pkg: { scripts: { prepare: 'x' } }, workspaces }))
      .toEqual(['prepare', 'packages/server: postinstall', 'packages/server: prepare'])
  })
  it('sameSkippedSet ignores order only', () => {
    expect(sameSkippedSet(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameSkippedSet([], undefined)).toBe(true)
    expect(sameSkippedSet(['a'], ['a', 'b'])).toBe(false)
    expect(sameSkippedSet(['a', 'b'], ['a'])).toBe(false)
    expect(sameSkippedSet(['a', 'a'], ['a', 'b'])).toBe(false)
  })
})

describe('withRepoNpmrcSetAside', () => {
  const dir = () => { const d = join(tmpRoot, 'store', 'aside'); mkdirSync(d, { recursive: true }); return d }
  it('no .npmrc: just runs', () => {
    expect(withRepoNpmrcSetAside(dir(), () => 42)).toBe(42)
  })
  it('the file is absent while fn runs and restored byte for byte after', () => {
    const d = dir()
    writeFileSync(join(d, '.npmrc'), 'git=./pwn.sh\n')
    let seen = true
    withRepoNpmrcSetAside(d, () => { seen = existsSync(join(d, '.npmrc')) })
    expect(seen).toBe(false)
    expect(readFileSync(join(d, '.npmrc'), 'utf-8')).toBe('git=./pwn.sh\n')
    expect(readdirSync(d)).toEqual(['.npmrc'])
  })
  it('restored when fn throws, and the error propagates', () => {
    const d = dir()
    writeFileSync(join(d, '.npmrc'), 'a=b\n')
    expect(() => withRepoNpmrcSetAside(d, () => { throw new Error('npm failed') })).toThrow('npm failed')
    expect(readFileSync(join(d, '.npmrc'), 'utf-8')).toBe('a=b\n')
  })
  it('fails closed when the file cannot be moved: fn is not run', () => {
    const d = dir()
    writeFileSync(join(d, '.npmrc'), 'a=b\n')
    chmodSync(d, 0o555)
    const fn = vi.fn()
    try {
      expect(() => withRepoNpmrcSetAside(d, fn)).toThrow(/could not set the repository .npmrc aside/)
    } finally { chmodSync(d, 0o755) }
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('repo refusal: tracked symlinks and a resolved tree leaving the repo', () => {
  it('trackedSymlinkPaths parses `git ls-files -s -z`', () => {
    const out = `100644 ${SHA} 0\tpackage.json\x00120000 ${SHA} 0\tlinkdir\x00120000 ${SHA} 0\tdir with space/l\x00160000 ${SHA} 0\tsub\x00`
    expect(trackedSymlinkPaths(out)).toEqual(['linkdir', 'dir with space/l'])
    // A regular file whose blob hash contains "120000" is not a link (only the mode field counts).
    expect(trackedSymlinkPaths(`100644 a120000b${SHA.slice(8)} 0\tregular.js\x00`)).toEqual([])
    expect(trackedSymlinkPaths('')).toEqual([])
  })
  it('lockPathLeavesRepo is lexical from the repo root', () => {
    for (const p of ['', 'node_modules/a', 'packages/w', 'a/../b', 'vendor/t.tgz']) expect(lockPathLeavesRepo(p)).toBe(false)
    for (const p of ['..', '../outside', '../../..', 'node_modules/../../x', '..\\x', '/abs', '~/x', 'C:/x']) expect(lockPathLeavesRepo(p)).toBe(true)
  })
  it('lockfileEscapes: keys, link targets and file: sources', () => {
    expect(lockfileEscapes({ packages: {
      '': { name: 'x' },
      'node_modules/w': { resolved: 'packages/w', link: true },
      'packages/w': { version: '1.0.0' },
      'node_modules/t': { resolved: 'file:vendor/t.tgz' },
      'node_modules/r': { resolved: 'https://registry.npmjs.org/r/-/r-1.0.0.tgz' },
      'node_modules/g': { resolved: 'git+ssh://git@github.com/u/r.git#0123' },
    } })).toEqual([])
    expect(lockfileEscapes({ packages: {
      '../../../outside': { version: '1.0.0' },
      'node_modules/x': { resolved: '../../../outside', link: true },
      'node_modules/y': { link: true },
      'node_modules/z': { resolved: 'file:../../../outside' },
      'node_modules/q': { resolved: 'FILE:/abs/q.tgz' },
    } })).toEqual(['../../../outside', 'node_modules/x -> ../../../outside', 'node_modules/y -> undefined', 'node_modules/z -> file:../../../outside', 'node_modules/q -> FILE:/abs/q.tgz'])
  })
  it.each([2, 3, 4])('lockfileEscapes: a lockfileVersion %i lockfile is validated', (v) => {
    expect(lockfileEscapes({ lockfileVersion: v, packages: { '': {}, 'node_modules/a': { resolved: 'file:vendor/a.tgz' }, 'node_modules/w': { resolved: 'packages/w', link: true } } })).toEqual([])
    expect(lockfileEscapes({ lockfileVersion: v, packages: { 'node_modules/x': { resolved: '../outside', link: true }, '../y': {} } }))
      .toEqual(['node_modules/x -> ../outside', '../y'])
  })
  it('lockfileEscapes: anything but a v2+ lockfile is null', () => {
    for (const v of [null, 'x', [], {}, { lockfileVersion: 1, dependencies: {} }, { packages: [] }, { packages: { 'node_modules/a': null } }]) {
      expect(lockfileEscapes(v)).toBeNull()
    }
  })

  const lockDir = (files: Record<string, string>) => {
    const d = join(tmpRoot, 'store', 'lock-repo')
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(d, name)), { recursive: true })
      writeFileSync(join(d, name), content)
    }
    mkdirSync(d, { recursive: true })
    return d
  }
  const OUT_LINK = JSON.stringify({ packages: { 'node_modules/fh': { resolved: '../fh', link: true } } })
  const OK = JSON.stringify(MIN_LOCK)
  it('lockfileRefusalReason reads package-lock.json, npm-shrinkwrap.json and the hidden lockfile', () => {
    expect(lockfileRefusalReason(lockDir({ 'package-lock.json': OK }))).toBeUndefined()
    for (const v of [2, 3, 4]) {
      rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
      expect(lockfileRefusalReason(lockDir({ 'package-lock.json': JSON.stringify({ lockfileVersion: v, packages: { '': {} } }) }))).toBeUndefined()
      rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
      expect(lockfileRefusalReason(lockDir({ 'package-lock.json': JSON.stringify({ lockfileVersion: v, packages: { 'node_modules/fh': { resolved: '../fh', link: true } } }) })))
        .toBe('the resolved dependency tree points outside the repository (package-lock.json: node_modules/fh -> ../fh)')
    }
    rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
    expect(lockfileRefusalReason(lockDir({ 'npm-shrinkwrap.json': OK }))).toBeUndefined()
    rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
    expect(lockfileRefusalReason(lockDir({ 'package-lock.json': OUT_LINK })))
      .toBe('the resolved dependency tree points outside the repository (package-lock.json: node_modules/fh -> ../fh)')
    rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
    expect(lockfileRefusalReason(lockDir({ 'package-lock.json': OK, 'npm-shrinkwrap.json': OUT_LINK })))
      .toBe('the resolved dependency tree points outside the repository (npm-shrinkwrap.json: node_modules/fh -> ../fh)')
    rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
    expect(lockfileRefusalReason(lockDir({ 'package-lock.json': OK, 'node_modules/.package-lock.json': OUT_LINK })))
      .toBe('the resolved dependency tree points outside the repository (node_modules/.package-lock.json: node_modules/fh -> ../fh)')
  })
  it('lockfileRefusalReason: missing or unreadable lockfile refuses', () => {
    expect(lockfileRefusalReason(lockDir({}))).toBe('npm did not write a lockfile')
    expect(lockfileRefusalReason(lockDir({ 'node_modules/.package-lock.json': OK }))).toBe('npm did not write a lockfile')
    expect(lockfileRefusalReason(lockDir({ 'package-lock.json': '{oops' }))).toBe('could not read package-lock.json')
    rmSync(join(tmpRoot, 'store', 'lock-repo'), { recursive: true })
    expect(lockfileRefusalReason(lockDir({ 'package-lock.json': OK, 'node_modules/.package-lock.json': '{"lockfileVersion":1}' }))).toBe('could not read node_modules/.package-lock.json')
  })

  const LOCK_ONLY = ['install', '--omit=dev', '--ignore-scripts', ...PINS, '--package-lock-only', '--save=true']
  it('install: npm resolves first (--package-lock-only, scripts off, .npmrc aside), then installs', async () => {
    cloneFiles.value = { 'package.json': DEFAULT_PKG, '.npmrc': 'git=./pwn.sh\n' }
    const seen: string[] = []
    lockOnlyMock.mockImplementationOnce((f, a, opts) => {
      seen.push(`lock npmrc=${existsSync(join(opts.cwd, '.npmrc'))}`)
      writeFileSync(join(opts.cwd, 'package-lock.json'), OK)
      return ''
    })
    execFileSyncMock.mockImplementationOnce(() => { seen.push('install'); return '' })
    const r = await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })
    expect(r.installWarning).toBeUndefined()
    expect(connectorLockOnlyArgs()).toEqual(LOCK_ONLY)
    expect(lockOnlyMock.mock.calls.map(c => [c[1], c[2].cwd])).toEqual([[LOCK_ONLY, REPO_DIR]])
    expect(npmCalls()).toEqual([OPTIN])
    expect(seen).toEqual(['lock npmrc=false', 'install'])
    expect([lockOnlyMock.mock.calls[0][2].timeout, execFileSyncMock.mock.calls[0][2].timeout]).toEqual([180000, 180000])
    expect(gitLsFilesMock.mock.calls.map(c => [c[0], c[1].cwd])).toEqual([[['ls-files', '-s', '-z'], REPO_DIR]])
  })
  it('install: a tracked symlink refuses before npm runs at all', async () => {
    tracked.links = ['package-lock.json']
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBe('npm install not run: the repository contains symlinks (package-lock.json)')
    expect(lockOnlyMock).not.toHaveBeenCalled()
    expect(npmCalls()).toEqual([])
    expect(r.repo?.name).toBe('acme--tool')
  })
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'node_modules/.package-lock.json']) {
    it(`install: an outside entry in ${name} after the resolve pass refuses the real install`, async () => {
      cloneFiles.value = { 'package.json': JSON.stringify({ name: 'x', testLock: { 'package-lock.json': MIN_LOCK, [name]: JSON.parse(OUT_LINK) } }) }
      const r = await installGitHubRepo(REPO_URL)
      expect(lockOnlyMock).toHaveBeenCalledTimes(1)
      expect(npmCalls()).toEqual([])
      expect(r.installWarning).toBe(`npm install not run: the resolved dependency tree points outside the repository (${name}: node_modules/fh -> ../fh)`)
    })
  }
  it('the hidden lockfile the resolve pass wrote is validated, then removed before the real install', async () => {
    const HIDDEN = join(REPO_DIR, 'node_modules', '.package-lock.json')
    cloneFiles.value = { 'package.json': JSON.stringify({ name: 'x', testLock: { 'package-lock.json': MIN_LOCK, 'node_modules/.package-lock.json': MIN_LOCK } }) }
    let hiddenDuringInstall: boolean | undefined
    let lockDuringInstall: boolean | undefined
    execFileSyncMock.mockImplementationOnce(() => {
      hiddenDuringInstall = existsSync(HIDDEN)
      lockDuringInstall = existsSync(join(REPO_DIR, 'package-lock.json'))
      return ''
    })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBeUndefined()
    expect(lockDuringInstall).toBe(true)
    expect(hiddenDuringInstall).toBe(false)
  })
  it('a lockfile this run created (untracked) is removed afterwards: on success, npm failure and refusal', async () => {
    const LOCK = join(REPO_DIR, 'package-lock.json')
    await installGitHubRepo(REPO_URL)
    expect(existsSync(LOCK)).toBe(false)
    execFileSyncMock.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { stderr: 'ERR! boom' }) })
    expect(updateGitHubRepo('acme--tool').ok).toBe(false)
    expect(existsSync(LOCK)).toBe(false)
    writeFileSync(join(REPO_DIR, 'package.json'), JSON.stringify({ name: 'x', testLock: { 'package-lock.json': JSON.parse(OUT_LINK), 'npm-shrinkwrap.json': JSON.parse(OUT_LINK) } }))
    expect(updateGitHubRepo('acme--tool').error).toMatch(/points outside the repository/)
    expect(existsSync(LOCK)).toBe(false)
    expect(existsSync(join(REPO_DIR, 'npm-shrinkwrap.json'))).toBe(false)
  })
  it('an untracked lockfile that was already there is left alone', async () => {
    await installGitHubRepo(REPO_URL)
    writeFileSync(join(REPO_DIR, 'package-lock.json'), JSON.stringify(MIN_LOCK))
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(existsSync(join(REPO_DIR, 'package-lock.json'))).toBe(true)
  })
  it('a refused resolve pass removes the hidden lockfile too (no outside entry left behind)', async () => {
    cloneFiles.value = { 'package.json': JSON.stringify({ name: 'x', testLock: { 'package-lock.json': MIN_LOCK, 'node_modules/.package-lock.json': JSON.parse(OUT_LINK) } }) }
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toMatch(/node_modules\/\.package-lock\.json: node_modules\/fh -> \.\.\/fh/)
    expect(existsSync(join(REPO_DIR, 'node_modules', '.package-lock.json'))).toBe(false)
    expect(npmCalls()).toEqual([])
  })
  it('a refused install reports no skipped scripts (no opt-in to persist for a later update)', async () => {
    const HOOK = '{"name":"x","scripts":{"postinstall":"node p"}}'
    cloneFiles.value = { 'package.json': HOOK }
    tracked.links = ['l']
    const r1 = await installGitHubRepo(REPO_URL)
    expect(r1.installWarning).toMatch(/^npm install not run: the repository contains symlinks/)
    expect(r1.scriptsSkipped).toBeUndefined()
    expect(settings().githubRepos[0].scriptsSkipped).toBeUndefined()
    rmSync(REPO_DIR, { recursive: true, force: true }); writeSettings({})
    tracked.links = []
    cloneFiles.value = { 'package.json': JSON.stringify({ ...JSON.parse(HOOK), testLock: { 'package-lock.json': JSON.parse(OUT_LINK) } }) }
    const r2 = await installGitHubRepo(REPO_URL)
    expect(r2.installWarning).toMatch(/^npm install not run: the resolved dependency tree points outside/)
    expect(r2.scriptsSkipped).toBeUndefined()
  })
  it('an install that ran npm but failed reports skipped scripts but does not store them; the next update offers them', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"prepare":"tsc"}}' }
    execFileSyncMock.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { stderr: 'ERR! network' }) })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBe('npm install failed: ERR! network')
    expect(r.scriptsSkipped).toEqual(['prepare'])
    expect(settings().githubRepos[0]).toMatchObject({ runScripts: false })
    expect(settings().githubRepos[0].scriptsSkipped).toBeUndefined()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['prepare'] })
  })
  it('install: a failing resolve pass is an npm failure, no install', async () => {
    lockOnlyMock.mockImplementationOnce(() => { throw Object.assign(new Error('x'), { stderr: 'ERR! 404' }) })
    const r = await installGitHubRepo(REPO_URL)
    expect(npmCalls()).toEqual([])
    expect(r.installWarning).toBe('npm install failed: ERR! 404')
  })
  it('git ls-files failing fails closed', async () => {
    gitLsFilesMock.mockImplementationOnce(() => { throw new Error('not a git repository') })
    const r = await installGitHubRepo(REPO_URL)
    expect(npmCalls()).toEqual([])
    expect(lockOnlyMock).not.toHaveBeenCalled()
    expect(r.installWarning).toMatch(/could not list the files git tracks/)
  })

  // Real git: a local origin repo, cloned and pulled for real; npm stays mocked.
  const git = (cwd: string, ...args: string[]) => execFileSyncReal('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })
  const makeOrigin = (files: Record<string, string>, links: Record<string, string> = {}) => {
    const o = join(tmpRoot, 'store', 'origin')
    mkdirSync(o, { recursive: true })
    git(o, 'init', '-q')
    commitToOrigin(files, links, 'init')
    realGit.origin = o
    return o
  }
  const commitToOrigin = (files: Record<string, string>, links: Record<string, string>, msg: string) => {
    const o = join(tmpRoot, 'store', 'origin')
    for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(o, name)), { recursive: true }); writeFileSync(join(o, name), content) }
    for (const [name, target] of Object.entries(links)) { rmSync(join(o, name), { force: true }); symlinkSync(target, join(o, name)) }
    git(o, 'add', '-A')
    git(o, 'commit', '-q', '-m', msg)
  }
  it('real git, install: a committed dangling link with a file: dep outside is refused, npm not run', async () => {
    makeOrigin({ 'package.json': '{"name":"x","dependencies":{"foo":"file:../../.."}}' }, { 'package-lock.json': 'node_modules/foo/.env' })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBe('npm install not run: the repository contains symlinks (package-lock.json)')
    expect(lockOnlyMock).not.toHaveBeenCalled()
    expect(npmCalls()).toEqual([])
  })
  it('real git, install: nm -> node_modules indirection and an inside-pointing link are refused', async () => {
    makeOrigin({ 'package.json': DEFAULT_PKG }, { 'nm': 'node_modules', 'alias.json': 'package.json' })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBe('npm install not run: the repository contains symlinks (alias.json, nm)')
    expect(npmCalls()).toEqual([])
  })
  it('real git, install: an ordinary repo resolves and installs', async () => {
    makeOrigin({ 'package.json': '{"name":"x","workspaces":["packages/*"],"dependencies":{"r":"^1.0.0"}}', 'packages/w/package.json': '{"name":"w"}' })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBeUndefined()
    expect(lockOnlyMock).toHaveBeenCalledTimes(1)
    expect(npmCalls()).toEqual([SAFE])
  })
  it('real git, update: a pulled commit adding a tracked link is refused after the pull', async () => {
    makeOrigin({ 'package.json': DEFAULT_PKG })
    expect((await installGitHubRepo(REPO_URL)).installWarning).toBeUndefined()
    execFileSyncMock.mockClear(); lockOnlyMock.mockClear()
    commitToOrigin({}, { 'evil.json': 'node_modules/foo/victim' }, 'bad')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: false, error: 'pulled, but npm install not run: the repository contains symlinks (evil.json)' })
    expect(lstatSync(join(REPO_DIR, 'evil.json')).isSymbolicLink()).toBe(true) // really pulled
    expect(lockOnlyMock).not.toHaveBeenCalled()
    expect(npmCalls()).toEqual([])
  })
  const gitStatus = () => String(execFileSyncReal('git', ['status', '--porcelain'], { cwd: REPO_DIR, encoding: 'utf-8' }))
  it('real git: no committed lockfile -> none left behind; a later upstream lockfile commit pulls cleanly', async () => {
    makeOrigin({ 'package.json': DEFAULT_PKG })
    installWritesHiddenLock()
    expect((await installGitHubRepo(REPO_URL)).installWarning).toBeUndefined()
    expect(lockOnlyMock).toHaveBeenCalledTimes(1)
    expect(existsSync(join(REPO_DIR, 'package-lock.json'))).toBe(false)
    expect(existsSync(join(REPO_DIR, 'node_modules', '.package-lock.json'))).toBe(true)
    expect(gitStatus()).toBe('?? node_modules/\n')
    commitToOrigin({ 'package-lock.json': JSON.stringify(MIN_LOCK) }, {}, 'add lockfile')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(existsSync(join(REPO_DIR, 'package-lock.json'))).toBe(true)
    expect(gitStatus()).toBe('?? node_modules/\n')
  })
  it('real git: only a nested lockfile is tracked -> the root one npm wrote counts as created and is removed', async () => {
    makeOrigin({ 'package.json': DEFAULT_PKG, 'packages/a/package.json': '{"name":"a"}', 'packages/a/package-lock.json': '{"nested":true}' })
    installWritesHiddenLock()
    expect((await installGitHubRepo(REPO_URL)).installWarning).toBeUndefined()
    expect(lockOnlyMock).toHaveBeenCalledTimes(1)
    expect(existsSync(join(REPO_DIR, 'package-lock.json'))).toBe(false)
    expect(readFileSync(join(REPO_DIR, 'packages', 'a', 'package-lock.json'), 'utf-8')).toBe('{"nested":true}')
    expect(gitStatus()).toBe('?? node_modules/\n')
  })
  it('real git: a tracked lockfile npm rewrote is restored (also on refusal); the next pull works', async () => {
    makeOrigin({ 'package.json': DEFAULT_PKG, 'package-lock.json': '{"stale":true}' })
    expect((await installGitHubRepo(REPO_URL)).installWarning).toBeUndefined()
    expect(readFileSync(join(REPO_DIR, 'package-lock.json'), 'utf-8')).toBe('{"stale":true}')
    expect(gitStatus()).toBe('')
    expect(gitCalls.filter(c => c.args[0] === 'checkout')).toEqual([{ args: ['checkout', '--', 'package-lock.json'], cwd: REPO_DIR }])
    // A ref with the lockfile's name must not be checked out instead of the file.
    git(REPO_DIR, 'tag', 'package-lock.json')
    commitToOrigin({ 'package-lock.json': '{"stale":2}' }, {}, 'upstream lockfile change')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(readFileSync(join(REPO_DIR, 'package-lock.json'), 'utf-8')).toBe('{"stale":2}')
    expect(gitStatus()).toBe('')
    expect(String(execFileSyncReal('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: REPO_DIR, encoding: 'utf-8' })).trim()).not.toBe('')
    commitToOrigin({ 'package.json': JSON.stringify({ name: 'x', testLock: { 'package-lock.json': JSON.parse(OUT_LINK) } }) }, {}, 'bad')
    expect(updateGitHubRepo('acme--tool').ok).toBe(false)
    expect(gitStatus()).toBe('')
  })
  it('real git, update: a pulled commit whose resolved tree leaves the repo is refused', async () => {
    makeOrigin({ 'package.json': DEFAULT_PKG })
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear(); lockOnlyMock.mockClear()
    commitToOrigin({ 'package.json': JSON.stringify({ name: 'x', testLock: { 'package-lock.json': { packages: { '../../../outside': {} } } } }) }, {}, 'bad')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: false, error: 'pulled, but npm install not run: the resolved dependency tree points outside the repository (package-lock.json: ../../../outside)' })
    expect(lockOnlyMock).toHaveBeenCalledTimes(1)
    expect(npmCalls()).toEqual([])
  })
})

describe('installGitHubRepo', () => {
  it('runs npm via execFileSync with --ignore-scripts by default (no shell string), stores runScripts:false', async () => {
    const r = await installGitHubRepo(REPO_URL)
    expect(r.error).toBeUndefined()
    expect(npmCalls()).toEqual([SAFE])
    expect(execFileSyncMock.mock.calls[0][2]?.shell).toBeFalsy()
    expect(execSyncMock.mock.calls.some(c => String(c[0]).includes('npm'))).toBe(false)
    expect(settings().githubRepos[0].runScripts).toBe(false)
  })
  it('opt-in runs scripts and persists the choice on the repo record', async () => {
    await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })
    expect(npmCalls()).toEqual([OPTIN])
    expect(settings().githubRepos[0].runScripts).toBe(true)
  })
  it('the repo .npmrc is not present while npm runs, and is restored afterwards', async () => {
    cloneFiles.value = { 'package.json': DEFAULT_PKG, '.npmrc': 'git=./pwn.sh\nallow-git=all\n' }
    let presentDuringNpm = true
    execFileSyncMock.mockImplementation((_f, _a, opts) => { presentDuringNpm = existsSync(join(opts.cwd, '.npmrc')); return '' })
    await installGitHubRepo(REPO_URL)
    expect(presentDuringNpm).toBe(false)
    expect(readFileSync(join(REPO_DIR, '.npmrc'), 'utf-8')).toBe('git=./pwn.sh\nallow-git=all\n')
    expect(readdirSync(REPO_DIR).filter(f => f.startsWith('.npmrc'))).toEqual(['.npmrc'])
  })
  it('surfaces an npm failure as installWarning, repo still recorded', async () => {
    execFileSyncMock.mockImplementation(() => { throw Object.assign(new Error('Command failed'), { stderr: 'ERR! gyp failed' }) })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.repo?.name).toBe('acme--tool')
    expect(r.installWarning).toContain('ERR! gyp failed')
    expect(settings().githubRepos).toHaveLength(1)
  })
  it('reports skipped root hooks and dependency install scripts', async () => {
    cloneFiles.value = {
      'package.json': '{"name":"x","scripts":{"prepare":"tsc"}}',
    }
    // The real install writes the hidden lockfile.
    execFileSyncMock.mockImplementationOnce((_f, _a, opts) => {
      mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true })
      writeFileSync(join(opts.cwd, 'node_modules', '.package-lock.json'), '{"packages":{"node_modules/native":{"hasInstallScript":true}}}')
      return ''
    })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.scriptsSkipped).toEqual(['prepare', 'node_modules/native'])
  })
  it('a root binding.gyp alone is reported (implicit node-gyp rebuild)', async () => {
    cloneFiles.value = { 'package.json': DEFAULT_PKG, 'binding.gyp': '{}' }
    expect((await installGitHubRepo(REPO_URL)).scriptsSkipped).toEqual(['binding.gyp'])
  })
  it('no scriptsSkipped when scripts ran or nothing declares any', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node p"}}' }
    expect((await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })).scriptsSkipped).toBeUndefined()
    rmSync(join(tmpRoot, 'store'), { recursive: true, force: true })
    cloneFiles.value = { 'package.json': DEFAULT_PKG }
    expect((await installGitHubRepo(REPO_URL)).scriptsSkipped).toBeUndefined()
  })
  it('no installWarning on success, no npm at all without package.json', async () => {
    cloneFiles.value = {}
    const r = await installGitHubRepo(REPO_URL)
    expect(r.installWarning).toBeUndefined()
    expect(npmCalls()).toEqual([])
  })
})

describe('updateGitHubRepo', () => {
  it('follows the persisted default (scripts skipped)', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear(); lockOnlyMock.mockClear()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(npmCalls()).toEqual([SAFE])
    expect([lockOnlyMock.mock.calls[0][2].timeout, execFileSyncMock.mock.calls[0][2].timeout]).toEqual([120000, 120000])
  })
  it('follows a persisted opt-in, and does not report scripts that ran', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}', 'binding.gyp': '{}' }
    await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })
    execFileSyncMock.mockClear()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN])
  })
  it('turning the opt-in on after a default install rebuilds what is installed: resolve, install, rebuild', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}', '.npmrc': 'x=1\n' }
    await installGitHubRepo(REPO_URL)
    expect(settings().githubRepos[0].scriptsSkipped).toEqual(['postinstall'])
    execFileSyncMock.mockClear(); lockOnlyMock.mockClear()
    const order: string[] = []
    lockOnlyMock.mockImplementationOnce((_f, _a, opts) => { order.push('resolve'); writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify(MIN_LOCK)); return '' })
    installWritesHiddenLock((a, opts) => order.push(`${a[0]} npmrc=${existsSync(join(opts.cwd, '.npmrc'))} timeout=${opts.timeout}`))
    expect(updateGitHubRepo('acme--tool', { runScripts: true })).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN, REBUILD])
    expect(order).toEqual(['resolve', 'install npmrc=false timeout=120000', 'rebuild npmrc=false timeout=120000'])
    expect(settings().githubRepos[0].scriptsSkipped).toBeUndefined()
    execFileSyncMock.mockClear()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN]) // built once; later updates build only what npm changes
  })
  it('turning the opt-in on (legacy record too) rebuilds every dependency; off or staying off never rebuilds', async () => {
    installWritesHiddenLock()
    await installGitHubRepo(REPO_URL)
    writeSettings({ githubRepos: settings().githubRepos.map((r: any) => ({ ...r, runScripts: undefined, scriptsSkipped: undefined })) })
    execFileSyncMock.mockClear()
    updateGitHubRepo('acme--tool')
    expect(npmCalls()).toEqual([SAFE])
    execFileSyncMock.mockClear()
    updateGitHubRepo('acme--tool', { runScripts: true })
    expect(npmCalls()).toEqual([OPTIN, REBUILD])
    execFileSyncMock.mockClear()
    updateGitHubRepo('acme--tool', { runScripts: false })
    expect(npmCalls()).toEqual([SAFE])
  })
  it('a failing rebuild is reported once; later updates do not repeat it (no update fails forever)', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}' }
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    installWritesHiddenLock(a => { if (a[0] === 'rebuild') throw Object.assign(new Error('x'), { stderr: 'gyp ERR!' }) })
    expect(updateGitHubRepo('acme--tool', { runScripts: true })).toEqual({ ok: false, error: 'gyp ERR!' })
    expect(settings().githubRepos[0].runScripts).toBe(true)
    expect(settings().githubRepos[0].scriptsSkipped).toBeUndefined()
    execFileSyncMock.mockClear()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN])
  })
  it('a failed scripted install keeps the skipped list, so the next update rebuilds', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}' }
    installWritesHiddenLock()
    await installGitHubRepo(REPO_URL)
    expect(settings().githubRepos[0].scriptsSkipped).toEqual(['postinstall', 'node_modules/native'])
    execFileSyncMock.mockClear()
    installWritesHiddenLock(a => { if (a[0] === 'install') throw Object.assign(new Error('x'), { stderr: 'ERR! network' }) })
    expect(updateGitHubRepo('acme--tool', { runScripts: true })).toEqual({ ok: false, error: 'ERR! network' })
    expect(settings().githubRepos[0].scriptsSkipped).toEqual(['postinstall', 'node_modules/native'])
    execFileSyncMock.mockClear(); installWritesHiddenLock()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN, REBUILD])
    expect(settings().githubRepos[0].scriptsSkipped).toBeUndefined()
  })
  it('names npm would not read as package names are skipped and logged; the rest is rebuilt', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    execFileSyncMock.mockImplementation((_f, a, opts) => {
      if (a[0] === 'install') {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true })
        writeFileSync(join(opts.cwd, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: {
          'node_modules/okdep': { hasInstallScript: true }, 'node_modules/x.tgz': { hasInstallScript: true },
        } }))
      }
      return ''
    })
    expect(updateGitHubRepo('acme--tool', { runScripts: true })).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN, ['rebuild', '--ignore-scripts=false', ...PINS, 'okdep']])
    expect(logSpy.warn).toHaveBeenCalledWith(expect.objectContaining({ skipped: ['node_modules/x.tgz'] }), expect.stringMatching(/not rebuilt/))
  })
  it('isPlainPackageName follows how npm parses a rebuild argument', () => {
    for (const n of ['okdep', 'a', 'JSONStream', 'x.tgz.js', 'a_b', 'a-b', 'a.b', '~x', '@s/n', '@s/x.tgz', '@s/x.tar', 'tar', 'tgz']) expect(isPlainPackageName(n)).toBe(true)
    for (const n of ['x.tgz', 'x.TGZ', 'x.tar', 'x.tar.gz', 'node_modules', 'NODE_MODULES', 'favicon.ico', '.x', '_x', '-x', '--global', 'a b', 'a/b', '@s', '@s/', 'a@1', 'x:y', '']) expect(isPlainPackageName(n)).toBe(false)
  })
  it('a refused opt-in run neither installs nor rebuilds', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    tracked.links = ['l']
    expect(updateGitHubRepo('acme--tool', { runScripts: true }).ok).toBe(false)
    expect(npmCalls()).toEqual([])
  })
  it('nothing to rebuild (no dependency with an install script): no rebuild run', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    expect(updateGitHubRepo('acme--tool', { runScripts: true })).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN])
  })
  it('connectorRebuildArgs / rebuildTargets', () => {
    expect(connectorRebuildArgs(['native'])).toEqual(REBUILD)
    expect(rebuildTargets({ packages: {
      '': { hasInstallScript: true },
      'packages/w': { hasInstallScript: true },
      'node_modules/b': { hasInstallScript: true },
      'node_modules/a': { hasInstallScript: true },
      'node_modules/x/node_modules/a': { hasInstallScript: true },
      'node_modules/@s/n': { hasInstallScript: true },
      'node_modules/plain': {},
      'node_modules/--global': { hasInstallScript: true },
      'node_modules/.bin': { hasInstallScript: true },
      'node_modules/a b': { hasInstallScript: true },
      'node_modules/y/node_modules/only-nested': { hasInstallScript: true },
      'node_modules/x.tgz': { hasInstallScript: true },
    } })).toEqual({
      names: ['@s/n', 'a', 'b', 'only-nested'],
      skipped: ['node_modules/--global', 'node_modules/.bin', 'node_modules/a b', 'node_modules/x.tgz'],
    })
    for (const v of [null, {}, { packages: null }, 'x']) expect(rebuildTargets(v)).toEqual({ names: [], skipped: [] })
  })
  it('scripts off: offered only when the set differs from the one offered last (grows or shrinks)', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}' }
    expect((await installGitHubRepo(REPO_URL)).scriptsSkipped).toEqual(['postinstall'])
    expect(settings().githubRepos[0].scriptsSkipped).toEqual(['postinstall'])
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    writeFileSync(join(REPO_DIR, 'binding.gyp'), '{}')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['postinstall', 'binding.gyp'] })
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    rmSync(join(REPO_DIR, 'binding.gyp'))
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['postinstall'] })
    writeFileSync(join(REPO_DIR, 'package.json'), '{"name":"x"}')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
    expect(settings().githubRepos[0].scriptsSkipped).toBeUndefined()
  })
  it('a declined offer is not repeated by later updates on the same set, and the set stays stored', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}' }
    installWritesHiddenLock()
    expect((await installGitHubRepo(REPO_URL)).scriptsSkipped).toEqual(['postinstall', 'node_modules/native'])
    for (let i = 0; i < 3; i++) {
      expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
      expect(settings().githubRepos[0].scriptsSkipped).toEqual(['postinstall', 'node_modules/native'])
    }
    expect(npmCalls().filter(a => a[0] === 'rebuild')).toEqual([])
  })
  it('a workspace with prepare + postinstall: listed and offered on install (a file:./lib dependency is not); the opt-in run uses scripts (npm runs workspace hooks itself, no rebuild)', async () => {
    cloneFiles.value = {
      'package.json': '{"name":"r","workspaces":["packages/*"],"dependencies":{"lib":"file:./lib"}}',
      'packages/server/package.json': '{"name":"server","scripts":{"prepare":"tsc","postinstall":"node p"}}',
      'packages/plain/package.json': '{"name":"plain"}',
      'lib/package.json': '{"name":"lib","scripts":{"postinstall":"node p"}}',
    }
    execFileSyncMock.mockImplementation((_f, a, opts) => {
      if (a[0] === 'install') {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true })
        writeFileSync(join(opts.cwd, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: {
          'node_modules/server': { resolved: 'packages/server', link: true }, 'node_modules/plain': { resolved: 'packages/plain', link: true },
          'packages/server': { version: '1.0.0', hasInstallScript: true }, 'packages/plain': { version: '1.0.0' },
          'node_modules/lib': { resolved: 'lib', link: true }, 'lib': { version: '1.0.0', hasInstallScript: true },
        } }))
      }
      return ''
    })
    queryMock.mockImplementation(() => JSON.stringify([{ location: 'packages/plain' }, { location: 'packages/server' }]))
    const r = await installGitHubRepo(REPO_URL)
    expect(r.scriptsSkipped).toEqual(['packages/server: postinstall', 'packages/server: prepare'])
    execFileSyncMock.mockClear()
    expect(updateGitHubRepo('acme--tool', { runScripts: true })).toEqual({ ok: true })
    expect(npmCalls()).toEqual([OPTIN])
  })
  it('npm query .workspace runs after the default install with the pinned args, .npmrc set aside; not with scripts on', async () => {
    cloneFiles.value = { 'package.json': DEFAULT_PKG, '.npmrc': 'x=1\n' }
    const order: string[] = []
    execFileSyncMock.mockImplementation((_f, a) => { order.push(a[0]); return '' })
    queryMock.mockImplementation((_f, _a, opts) => { order.push(`query npmrc=${existsSync(join(opts.cwd, '.npmrc'))} timeout=${opts.timeout}`); return '[]' })
    await installGitHubRepo(REPO_URL)
    expect(order).toEqual(['install', 'query npmrc=false timeout=180000'])
    expect(queryMock.mock.calls.map(c => [c[1], c[2].cwd])).toEqual([[['query', '.workspace', '--json', '--ignore-scripts', ...PINS], REPO_DIR]])
    expect(connectorWorkspaceQueryArgs()).toEqual(['query', '.workspace', '--json', '--ignore-scripts', ...PINS])
    order.length = 0
    updateGitHubRepo('acme--tool')
    expect(order).toEqual(['install', 'query npmrc=false timeout=120000'])
    queryMock.mockClear()
    updateGitHubRepo('acme--tool', { runScripts: true })
    expect(queryMock).not.toHaveBeenCalled()
  })
  it('a failing or unreadable npm query lists no workspace hooks (logged), the rest is still reported', async () => {
    cloneFiles.value = {
      'package.json': '{"name":"r","workspaces":["packages/*"],"scripts":{"prepare":"tsc"}}',
      'packages/server/package.json': '{"name":"server","scripts":{"postinstall":"node p"}}',
    }
    queryMock.mockImplementation(() => { throw Object.assign(new Error('x'), { stderr: 'ERR' }) })
    expect((await installGitHubRepo(REPO_URL)).scriptsSkipped).toEqual(['prepare'])
    expect(logSpy.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/npm query \.workspace failed/))
    queryMock.mockImplementation(() => 'not json')
    writeFileSync(join(REPO_DIR, 'binding.gyp'), '{}')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['prepare', 'binding.gyp'] })
  })
  it('update: a workspace npm query reports with a postinstall is offered', async () => {
    await installGitHubRepo(REPO_URL)
    mkdirSync(join(REPO_DIR, 'packages', 'server'), { recursive: true })
    writeFileSync(join(REPO_DIR, 'packages', 'server', 'package.json'), '{"name":"server","scripts":{"postinstall":"node p"}}')
    queryMock.mockImplementation(() => JSON.stringify([{ location: 'packages/server' }]))
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['packages/server: postinstall'] })
  })
  it('parseWorkspaceQuery: locations inside the repo, deduped and sorted; anything else is null', () => {
    expect(parseWorkspaceQuery(JSON.stringify([{ location: 'packages/b' }, { location: 'packages/a' }, { location: 'packages/a' }, { location: '' }, { location: '../out' }, { location: '/abs' }, { name: 'x' }, null]))).toEqual(['packages/a', 'packages/b'])
    expect(parseWorkspaceQuery('[]')).toEqual([])
    for (const v of ['', 'x', '{}', '"a"', 'null']) expect(parseWorkspaceQuery(v)).toBeNull()
  })
  it('a long list is stored in full and shown cut short; the opt-in then rebuilds all of it', async () => {
    const packages: Record<string, unknown> = {}
    for (let i = 0; i < 25; i++) packages[`node_modules/d${String(i).padStart(2, '0')}`] = { hasInstallScript: true }
    execFileSyncMock.mockImplementation((_f, a, opts) => {
      if (a[0] === 'install') { mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true }); writeFileSync(join(opts.cwd, 'node_modules', '.package-lock.json'), JSON.stringify({ packages })) }
      return ''
    })
    const r = await installGitHubRepo(REPO_URL)
    expect(r.scriptsSkipped).toHaveLength(21)
    expect(settings().githubRepos[0].scriptsSkipped).toHaveLength(25)
    execFileSyncMock.mockClear()
    updateGitHubRepo('acme--tool', { runScripts: true })
    expect(npmCalls()[1]).toEqual(['rebuild', '--ignore-scripts=false', ...PINS, ...Object.keys(packages).map(k => k.slice('node_modules/'.length))])
  })
  it('on update too: the long list is stored in full and shown cut short', async () => {
    await installGitHubRepo(REPO_URL)
    const packages: Record<string, unknown> = {}
    for (let i = 0; i < 25; i++) packages[`node_modules/d${String(i).padStart(2, '0')}`] = { hasInstallScript: true }
    execFileSyncMock.mockImplementation((_f, a, opts) => {
      if (a[0] === 'install') { mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true }); writeFileSync(join(opts.cwd, 'node_modules', '.package-lock.json'), JSON.stringify({ packages })) }
      return ''
    })
    const r = updateGitHubRepo('acme--tool')
    expect(r.scriptsSkipped).toHaveLength(21)
    expect(r.scriptsSkipped?.[20]).toBe('+5 more')
    expect(settings().githubRepos[0].scriptsSkipped).toHaveLength(25)
  })
  it('binding.gyp alone is detected on update', async () => {
    await installGitHubRepo(REPO_URL)
    writeFileSync(join(REPO_DIR, 'binding.gyp'), '{}')
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['binding.gyp'] })
  })
  it('an explicit boolean overrides and persists', async () => {
    await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })
    execFileSyncMock.mockClear()
    updateGitHubRepo('acme--tool', { runScripts: false })
    expect(npmCalls()).toEqual([SAFE])
    expect(settings().githubRepos[0].runScripts).toBe(false)
  })
  it('a legacy record (no runScripts field): offered once', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}' }
    installWritesHiddenLock()
    await installGitHubRepo(REPO_URL)
    const s = settings()
    delete s.githubRepos[0].runScripts
    delete s.githubRepos[0].scriptsSkipped
    writeSettings(s)
    execFileSyncMock.mockClear()
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true, scriptsSkipped: ['postinstall', 'node_modules/native'] })
    expect(npmCalls()).toEqual([SAFE])
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: true })
  })
  it('opt-in switched off by PATCH: offered', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"postinstall":"node build"}}' }
    installWritesHiddenLock()
    await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })
    expect(updateGitHubRepo('acme--tool', { runScripts: false })).toEqual({ ok: true, scriptsSkipped: ['postinstall', 'node_modules/native'] })
  })
  it('restores the repo .npmrc on update too', async () => {
    cloneFiles.value = { 'package.json': DEFAULT_PKG, '.npmrc': 'global=true\n' }
    await installGitHubRepo(REPO_URL)
    let presentDuringNpm = true
    execFileSyncMock.mockImplementation((_f, _a, opts) => { presentDuringNpm = existsSync(join(opts.cwd, '.npmrc')); return '' })
    updateGitHubRepo('acme--tool')
    expect(presentDuringNpm).toBe(false)
    expect(readFileSync(join(REPO_DIR, '.npmrc'), 'utf-8')).toBe('global=true\n')
  })
  it('reports an npm failure as ok:false', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockImplementation(() => { throw Object.assign(new Error('x'), { stderr: 'boom' }) })
    expect(updateGitHubRepo('acme--tool')).toEqual({ ok: false, error: 'boom' })
  })
})

// --- route level ---
type MockRes = { statusCode: number; body: string; headers: Record<string, string>; writeHead: (c: number, h?: Record<string, string>) => void; end: (b?: string) => void; setHeader: (k: string, v: string) => void; getHeader: (k: string) => string | undefined }
function mkRes(): MockRes {
  const r: MockRes = {
    statusCode: 200, body: '', headers: {},
    writeHead(c, h) { r.statusCode = c; Object.assign(r.headers, h ?? {}) },
    end(b) { r.body = b ?? '' },
    setHeader(k, v) { r.headers[k] = v },
    getHeader(k) { return r.headers[k] },
  }
  return r
}
async function callRaw(method: string, path: string, payload: string) {
  const res = mkRes()
  const req = Object.assign(Readable.from(payload ? [Buffer.from(payload)] : []), { headers: {}, method, url: path })
  const ctx: RouteContext = {
    req: req as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth: { kind: 'token' },
  }
  const handled = await tryHandleConnectors(ctx)
  return { handled, status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}
function call(method: string, path: string, body?: unknown) {
  return callRaw(method, path, body === undefined ? '' : JSON.stringify(body))
}

describe('POST /api/connectors/github-repos', () => {
  it('default install skips scripts', async () => {
    const r = await call('POST', '/api/connectors/github-repos', { url: REPO_URL })
    expect(r.status).toBe(200)
    expect(npmCalls()).toEqual([SAFE])
    expect(r.data.installWarning).toBeUndefined()
  })
  it('runScripts: true enables scripts', async () => {
    await call('POST', '/api/connectors/github-repos', { url: REPO_URL, runScripts: true })
    expect(npmCalls()).toEqual([OPTIN])
  })
  it('a non-boolean runScripts is rejected before anything is cloned', async () => {
    const r = await call('POST', '/api/connectors/github-repos', { url: REPO_URL, runScripts: 'true' })
    expect(r.status).toBe(400)
    expect(execSyncMock).not.toHaveBeenCalled()
    expect(npmCalls()).toEqual([])
  })
  it('an npm failure reaches the caller as installWarning', async () => {
    execFileSyncMock.mockImplementation(() => { throw Object.assign(new Error('x'), { stderr: 'ERR! postinstall' }) })
    const r = await call('POST', '/api/connectors/github-repos', { url: REPO_URL })
    expect(r.status).toBe(200)
    expect(r.data.ok).toBe(true)
    expect(r.data.installWarning).toContain('ERR! postinstall')
  })
  it('skipped scripts reach the caller', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"install":"node-gyp rebuild"}}' }
    const r = await call('POST', '/api/connectors/github-repos', { url: REPO_URL })
    expect(r.data.scriptsSkipped).toEqual(['install'])
  })
  it('a refused install returns installWarning and no scriptsSkipped', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"install":"node-gyp rebuild"}}' }
    tracked.links = ['l']
    const r = await call('POST', '/api/connectors/github-repos', { url: REPO_URL })
    expect(r.data.installWarning).toMatch(/^npm install not run:/)
    expect(r.data.scriptsSkipped).toBeUndefined()
  })
})

describe('PATCH /api/connectors/github-repos/:name', () => {
  it('opt-in on: no body keeps it on and runs scripts; {"runScripts":false} turns it off and skips them', async () => {
    await installGitHubRepo(REPO_URL, undefined, undefined, { runScripts: true })
    execFileSyncMock.mockClear()
    expect((await call('PATCH', '/api/connectors/github-repos/acme--tool')).status).toBe(200)
    expect(npmCalls()).toEqual([OPTIN])
    expect(settings().githubRepos[0].runScripts).toBe(true)
    execFileSyncMock.mockClear()
    expect((await call('PATCH', '/api/connectors/github-repos/acme--tool', { runScripts: false })).status).toBe(200)
    expect(npmCalls()).toEqual([SAFE])
    expect(settings().githubRepos[0].runScripts).toBe(false)
  })
  it('without a body follows the persisted choice', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    const r = await call('PATCH', '/api/connectors/github-repos/acme--tool')
    expect(r.status).toBe(200)
    expect(npmCalls()).toEqual([SAFE])
  })
  it('runScripts: true in the body enables and persists', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    installWritesHiddenLock()
    await call('PATCH', '/api/connectors/github-repos/acme--tool', { runScripts: true })
    expect(npmCalls()).toEqual([OPTIN, REBUILD])
    expect(settings().githubRepos[0].runScripts).toBe(true)
  })
  it('a non-boolean runScripts is rejected', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    const r = await call('PATCH', '/api/connectors/github-repos/acme--tool', { runScripts: 1 })
    expect(r.status).toBe(400)
    expect(npmCalls()).toEqual([])
  })
  it('invalid JSON is a 400: no git pull, no npm, opt-in not silently dropped', async () => {
    await installGitHubRepo(REPO_URL)
    execFileSyncMock.mockClear()
    execSyncMock.mockClear()
    const r = await callRaw('PATCH', '/api/connectors/github-repos/acme--tool', '{"runScripts":true')
    expect(r.status).toBe(400)
    expect(execSyncMock).not.toHaveBeenCalled()
    expect(npmCalls()).toEqual([])
  })
  it('skipped scripts reach the caller', async () => {
    cloneFiles.value = { 'package.json': '{"name":"x","scripts":{"prepare":"tsc"}}' }
    await installGitHubRepo(REPO_URL)
    const st = settings()
    delete st.githubRepos[0].runScripts  // legacy record: no saved choice
    delete st.githubRepos[0].scriptsSkipped
    writeSettings(st)
    const r = await call('PATCH', '/api/connectors/github-repos/acme--tool')
    expect(r.data).toEqual({ ok: true, scriptsSkipped: ['prepare'] })
  })
})

// --- UI wiring: the real handlers from web/app.js, run against stubs ---
// The GitHub-repo block (opt-in helper, list with the update button, install
// wiring) is cut out of app.js by its function markers and evaluated with a
// fake document, fetch, confirm and alert, so the tests prove what each
// answer of the operator actually sends.
describe('dashboard UI wiring', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf-8')
  const START = 'async function offerGitHubRepoScriptsOptIn'
  const WIRE = ';(function wireGitHubRepos()'
  const startAt = app.indexOf(START)
  const wireAt = app.indexOf(WIRE)
  const endAt = app.indexOf('\n})()', wireAt)
  const SRC = app.slice(startAt, endAt + '\n})()'.length)

  type El = { [k: string]: any, listeners: Record<string, (e?: any) => any> }
  function el(props: Record<string, unknown> = {}): El {
    const e: El = { listeners: {}, hidden: true, ...props }
    e.addEventListener = (ev: string, fn: (e?: any) => any) => { e.listeners[ev] = fn }
    e.querySelector = (sel: string) => (e.children ??= {})[sel] ??= el()
    e.appendChild = () => undefined
    return e
  }
  type Call = { url: string, method: string, body?: any }
  function harness(opts: { confirm: boolean[], checked?: boolean, responses?: Record<string, any> }) {
    const calls: Call[] = []
    const alerts: string[] = []
    const confirms: string[] = []
    const answers = [...opts.confirm]
    const ids: Record<string, El> = {
      githubReposToggle: el(), githubReposBody: el(), githubRepoAddBtn: el(),
      githubRepoInput: el({ value: 'https://github.com/acme/tool' }), githubRepoStatus: el(),
      githubRepoRunScripts: el({ checked: !!opts.checked, value: 'on' }),
      githubRepoCount: el(), githubRepoList: el(),
    }
    const created: El[] = []
    const document = { getElementById: (id: string) => ids[id] ?? null, createElement: () => { const e = el(); created.push(e); return e } }
    const fetch = async (url: string, init: any = {}) => {
      const method = init.method || 'GET'
      calls.push({ url, method, body: init.body === undefined ? undefined : JSON.parse(init.body) })
      const data = opts.responses?.[`${method} ${url}`] ?? {}
      return { ok: true, json: async () => data }
    }
    const noop = () => undefined
    const fn = new Function('document', 'fetch', 'confirm', 'alert', 't', 'escapeHtml', 'loadConnectors', 'loadExternalPaths', 'loadVault', 'showEnvVarModal', 'setTimeout',
      `${SRC}\nreturn { offer: offerGitHubRepoScriptsOptIn, load: loadGitHubRepos }`)
    const api = fn(document, fetch, (m: string) => { confirms.push(m); return answers.shift() ?? false }, (m: string) => { alerts.push(m) },
      (k: string, p?: Record<string, unknown>) => `${k}${p ? ' ' + JSON.stringify(p) : ''}`, (x: string) => x, noop, noop, noop, async () => ({}), noop)
    return { api, ids, created, calls, alerts, confirms, clickInstall: () => ids.githubRepoAddBtn.listeners.click() }
  }
  const POST = 'POST /api/connectors/github-repos'
  const PATCH = 'PATCH /api/connectors/github-repos/acme--tool'

  it('extracts the block', () => {
    expect(startAt).toBeGreaterThan(-1)
    expect(wireAt).toBeGreaterThan(startAt)
    expect(endAt).toBeGreaterThan(wireAt)
  })
  it('the checkbox exists in the page with its i18n key', () => {
    expect(html).toMatch(/<input type="checkbox" id="githubRepoRunScripts">/)
    expect(html).toContain('data-i18n="connectors.run_scripts_label"')
  })
  it('install: cancel on the confirm sends nothing', async () => {
    const h = harness({ confirm: [false] })
    await h.clickInstall()
    expect(h.confirms[0]).toMatch(/^connectors\.install_confirm /)
    expect(h.calls).toEqual([])
  })
  it('install: unchecked box posts runScripts:false', async () => {
    const h = harness({ confirm: [true], checked: false, responses: { [POST]: { ok: true, repo: { name: 'acme--tool' } } } })
    await h.clickInstall()
    expect(h.calls.filter(c => c.method === 'POST')).toEqual([{ url: '/api/connectors/github-repos', method: 'POST', body: { url: 'https://github.com/acme/tool', runScripts: false } }])
  })
  it('install: checked box asks with the scripts wording and posts runScripts:true', async () => {
    const h = harness({ confirm: [true], checked: true, responses: { [POST]: { ok: true, repo: { name: 'acme--tool' } } } })
    await h.clickInstall()
    expect(h.confirms[0]).toMatch(/^connectors\.install_confirm_scripts /)
    expect(h.calls[0].body).toEqual({ url: 'https://github.com/acme/tool', runScripts: true })
  })
  it('install: installWarning is shown', async () => {
    const h = harness({ confirm: [true], responses: { [POST]: { ok: true, repo: { name: 'acme--tool' }, installWarning: 'npm install failed: boom' } } })
    await h.clickInstall()
    expect(h.alerts.join('\n')).toContain('connectors.install_warning')
    expect(h.alerts.join('\n')).toContain('npm install failed: boom')
  })
  it('install: no opt-in offer after an install that did not complete', async () => {
    const h = harness({ confirm: [true, true], responses: { [POST]: { ok: true, repo: { name: 'acme--tool' }, installWarning: 'npm install not run: x', scriptsSkipped: ['prepare'] } } })
    await h.clickInstall()
    expect(h.confirms).toHaveLength(1)
    expect(h.alerts.join('\n')).toContain('npm install not run: x')
    expect(h.calls.filter(c => c.method === 'PATCH')).toEqual([])
  })
  it('install: skipped scripts, cancel on "run them now?" sends no PATCH', async () => {
    const h = harness({ confirm: [true, false], responses: { [POST]: { ok: true, repo: { name: 'acme--tool' }, scriptsSkipped: ['prepare'] } } })
    await h.clickInstall()
    expect(h.confirms[1]).toMatch(/^connectors\.scripts_skipped_confirm .*prepare/)
    expect(h.calls.filter(c => c.method === 'PATCH')).toEqual([])
  })
  it('the opt-in PATCH failing is shown', async () => {
    const h = harness({ confirm: [true], responses: { [PATCH]: { error: 'pulled, but npm install not run: x' } } })
    await h.api.offer('acme--tool', ['prepare'])
    expect(h.alerts).toEqual(['pulled, but npm install not run: x'])
  })
  it('install: skipped scripts, OK sends a PATCH with runScripts:true', async () => {
    const h = harness({ confirm: [true, true], responses: { [POST]: { ok: true, repo: { name: 'acme--tool' }, scriptsSkipped: ['prepare'] } } })
    await h.clickInstall()
    expect(h.calls.filter(c => c.method === 'PATCH')).toEqual([{ url: '/api/connectors/github-repos/acme--tool', method: 'PATCH', body: { runScripts: true } }])
  })
  async function clickUpdate(h: ReturnType<typeof harness>) {
    await h.api.load()
    const btn = h.created[0].children['.github-repo-update']
    await btn.listeners.click({ currentTarget: btn })
  }
  const LIST = { 'GET /api/connectors/github-repos': { repos: [{ name: 'acme--tool', installedAt: '2026-01-01T00:00:00Z' }] } }
  it('update: the button PATCHes without a body (the stored choice decides)', async () => {
    const h = harness({ confirm: [], responses: { ...LIST, [PATCH]: { ok: true } } })
    await clickUpdate(h)
    expect(h.calls.filter(c => c.method === 'PATCH')).toEqual([{ url: '/api/connectors/github-repos/acme--tool', method: 'PATCH', body: undefined }])
    expect(h.confirms).toEqual([])
  })
  it('update: skipped scripts, cancel sends nothing more', async () => {
    const h = harness({ confirm: [false], responses: { ...LIST, [PATCH]: { ok: true, scriptsSkipped: ['binding.gyp'] } } })
    await clickUpdate(h)
    expect(h.confirms).toHaveLength(1)
    expect(h.calls.filter(c => c.method === 'PATCH')).toHaveLength(1)
  })
  it('update: skipped scripts, OK re-runs with runScripts:true', async () => {
    const h = harness({ confirm: [true], responses: { ...LIST, [PATCH]: { ok: true, scriptsSkipped: ['binding.gyp'] } } })
    await clickUpdate(h)
    expect(h.calls.filter(c => c.method === 'PATCH').map(c => c.body)).toEqual([undefined, { runScripts: true }])
  })
})
