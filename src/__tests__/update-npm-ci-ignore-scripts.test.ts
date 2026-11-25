import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// ISSUE3103 (#3103): on a host without make/g++, every `npm ci` in update.sh failed. better-sqlite3 has a
// binding.gyp, so npm (10.9.8) runs a default `node-gyp rebuild` for it, although its package.json says
// gypfile:false and it loads the Node-API prebuild it ships. The update, its rollbacks and the finalizer's
// rollback all failed the same way and left node_modules empty. The fix: npm_ci_deps (npm ci --ignore-scripts,
// then only esbuild's postinstall), at every call site, with native_module_loads still the gate.

const ROOT = join(__dirname, '..', '..')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

/** The multi-line helper of the main script. */
function mainHelper(): string {
  const m = UPDATE.match(/^npm_ci_deps\(\) \{\n[\s\S]*?\n\}\n/m)
  expect(m, 'npm_ci_deps() not found in update.sh').not.toBeNull()
  return m![0]
}
/** The one-line copy inside the finalizer heredoc (that script runs on its own). */
function finalizerHelper(): string {
  const start = UPDATE.indexOf("<<'FINALIZE_EOF'")
  const end = UPDATE.indexOf('\nFINALIZE_EOF\n', start)
  const lines = UPDATE.slice(start, end).split('\n').filter((l) => l.startsWith('npm_ci_deps() {'))
  expect(lines, 'npm_ci_deps() in the finalizer').toHaveLength(1)
  return lines[0]
}

/** Shell lines that run something: no comment, no echo, no message text. */
const invocations = (re: RegExp) => UPDATE.split('\n')
  .filter((l) => re.test(l) && !l.trimStart().startsWith('#') && !/\becho\b|RESULT_MSG=/.test(l))

describe('update.sh: npm ci never runs install scripts (ISSUE3103)', () => {
  it('every npm ci invocation carries --ignore-scripts, and they are the two helpers only', () => {
    const ci = invocations(/\bnpm ci\b/)
    expect(ci).toHaveLength(2)
    for (const l of ci) expect(l, l.trim()).toMatch(/npm ci --ignore-scripts --silent --include=dev/)
    expect(mainHelper()).toContain('npm rebuild esbuild --silent')
    expect(finalizerHelper()).toContain('npm rebuild esbuild --silent')
  })

  it('every install path calls the helper: the update, its three rollbacks and the finalizer rollback', () => {
    const calls = invocations(/\bnpm_ci_deps\b/).filter((l) => !/npm_ci_deps\(\) \{/.test(l))
    expect(calls.map((l) => l.trim())).toEqual([
      'if npm_ci_deps 2>/dev/null; then deps_ok=1; fi',
      'retry 3 3 npm_ci_deps || NPM_CI_RC=$?',
      'npm_ci_deps 2>/dev/null || true',
      'npm_ci_deps 2>/dev/null || true',
      'npm_ci_deps 2>/dev/null || true',
    ])
  })

  it('each rollback install is still followed by the load gate and its rebuild fallback', () => {
    const lines = UPDATE.split('\n')
    const rollbacks = lines.flatMap((l, i) => (/^\s*(if )?npm_ci_deps 2>\/dev\/null/.test(l) ? [i] : []))
    expect(rollbacks).toHaveLength(4)
    for (const i of rollbacks) expect(lines.slice(i + 1, i + 4).join('\n')).toContain('native_module_loads || npm rebuild better-sqlite3')
  })

  it('better-sqlite3 needs no install script: it ships the prebuild for this platform and loads it first', () => {
    const req = createRequire(join(ROOT, 'package.json'))
    const pkgPath = req.resolve('better-sqlite3/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string>; gypfile?: boolean }
    for (const s of ['preinstall', 'install', 'postinstall']) expect(pkg.scripts?.[s], s).toBeUndefined()
    expect(pkg.gypfile).toBe(false)
    const binding = req(join(dirname(pkgPath), 'lib', 'binding.js')) as { getPrebuildPath: () => string | null }
    const supported = ['linux', 'darwin', 'win32'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
    if (supported) expect(binding.getPrebuildPath()).toMatch(/prebuilds[\\/][a-z0-9-]+\.node$/)
  })
})

// The real npm, offline, against a toy project: a package with a binding.gyp (as better-sqlite3) and an
// "esbuild" whose postinstall leaves a mark. `make` on PATH is a stub that fails, as on the reporter's host.
describe.skipIf(process.platform === 'win32')('npm_ci_deps on a host without a C toolchain (real npm, ISSUE3103)', () => {
  let dir = ''
  let app = ''
  const env: Record<string, string> = {}

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'upd-ignore-scripts-'))
    app = join(dir, 'app')
    mkdirSync(app)
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'make'), '#!/bin/sh\necho "make: not found (stub)" >&2\nexit 127\n')
    chmodSync(join(bin, 'make'), 0o755)
    const pack = (name: string, files: Record<string, string>) => {
      const src = join(dir, `src-${name}`)
      mkdirSync(src)
      for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body)
      const r = spawnSync('npm', ['pack', '--silent', '--pack-destination', app], { cwd: src, encoding: 'utf-8', env: { ...process.env, ...env } })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout.trim()
    }
    env.PATH = `${bin}:${process.env.PATH}`
    env.npm_config_cache = join(dir, 'cache')
    env.npm_config_audit = 'false'
    env.npm_config_fund = 'false'
    env.npm_config_update_notifier = 'false'
    // node-gyp takes the headers of the running Node when they are there, so it reaches make without a download.
    const nodedir = dirname(dirname(process.execPath))
    if (existsSync(join(nodedir, 'include', 'node', 'node.h'))) env.npm_config_nodedir = nodedir
    const native = pack('native', {
      'package.json': JSON.stringify({ name: 'fake-native', version: '1.0.0', main: 'index.js', gypfile: false }),
      'index.js': 'module.exports = 1\n',
      'binding.gyp': "{ 'targets': [ { 'target_name': 'x', 'sources': [] } ] }\n",
    })
    const esbuild = pack('esbuild', {
      'package.json': JSON.stringify({ name: 'esbuild', version: '0.0.1', scripts: { postinstall: "node -e \"require('fs').writeFileSync('postinstall-ran', '1')\"" } }),
      'index.js': 'module.exports = 1\n',
    })
    writeFileSync(join(app, 'package.json'), JSON.stringify({
      name: 'app', version: '1.0.0', dependencies: { 'fake-native': `file:./${native}` }, devDependencies: { esbuild: `file:./${esbuild}` },
    }))
    const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--silent'], { cwd: app, encoding: 'utf-8', env: { ...process.env, ...env } })
    expect(lock.status, lock.stderr).toBe(0)
  }, 60_000)
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function install(script: string) {
    rmSync(join(app, 'node_modules'), { recursive: true, force: true })
    const r = spawnSync('bash', ['-c', script], { cwd: app, encoding: 'utf-8', env: { ...process.env, ...env, npm_config_offline: 'true' }, timeout: 120_000 })
    const has = (p: string) => existsSync(join(app, 'node_modules', p))
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), native: has('fake-native/index.js'), esbuildRan: has('esbuild/postinstall-ran') }
  }

  it('control: a plain npm ci tries the source build and fails, leaving nothing installed (the bug)', () => {
    const r = install('npm ci --silent --include=dev')
    expect(r.code).not.toBe(0)
    expect(r.native).toBe(false)
  }, 120_000)

  it('the update\'s helper installs everything and runs esbuild\'s postinstall', () => {
    const r = install(`${mainHelper()}\nnpm_ci_deps`)
    expect(r.code, r.out).toBe(0)
    expect(r.native).toBe(true)
    expect(r.esbuildRan).toBe(true)
    expect(r.out).not.toContain('not found (stub)')
  }, 120_000)

  it('the finalizer\'s copy does the same', () => {
    const r = install(`${finalizerHelper()}\nnpm_ci_deps`)
    expect(r.code, r.out).toBe(0)
    expect(r.native).toBe(true)
    expect(r.esbuildRan).toBe(true)
  }, 120_000)
})
