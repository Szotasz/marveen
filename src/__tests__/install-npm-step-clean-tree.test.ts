// INSTALLDIRTYTREE1103: the installers' dependency step must leave the tracked
// package-lock.json untouched. On marveen2 (11-03) the macOS installer's plain
// `npm install` rewrote it (+1 line, better-sqlite3 "hasInstallScript"), so the
// fresh install was dirty and every later update went down the stash path.
//
// The npm block of each installer is cut out of the real script and EXECUTED in
// a throwaway git repo, with a stub `npm` that rewrites the lock exactly the way
// npm install did on marveen2. `npm ci` never writes the lock.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const LOCK = '{\n  "name": "x",\n  "lockfileVersion": 3\n}\n'

function block(file: string, start: string, end: string): string {
  const src = readFileSync(join(ROOT, file), 'utf-8')
  const a = src.indexOf(start)
  const b = src.indexOf(end, a)
  expect(a, `${file}: start marker`).toBeGreaterThan(-1)
  expect(b, `${file}: end marker`).toBeGreaterThan(a)
  return src.slice(a, b + end.length)
}

const MAC = () => block('install-macos.sh', '_NPM_CI_LOG=$(mktemp)', 'unset _NPM_OK\n')
const LINUX = () => block('install-linux.sh', '_NPM_CI_LOG=$(mktemp)', 'rm -f "$_NPM_CI_LOG"\nok "npm csomagok telepitve"\n')

/** Run an installer block in a fresh repo. ciOk: does the stub `npm ci` succeed? */
function run(snippet: string, ciOk: boolean): { status: string; calls: string; exit: number } {
  const dir = mkdtempSync(join(tmpdir(), 'npmstep-'))
  try {
    const repo = join(dir, 'repo')
    const bin = join(dir, 'bin')
    mkdirSync(repo)
    mkdirSync(bin)
    writeFileSync(join(repo, 'package-lock.json'), LOCK)
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]).toString()
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'base')
    // The stub: `ci` succeeds or fails as asked; `install` rewrites the lock like
    // the real npm did on marveen2; `rebuild` succeeds. Every call is logged.
    writeFileSync(join(bin, 'npm'), `#!/bin/bash
echo "$1" >> "${dir}/calls"
case "$1" in
  ci) ${ciOk ? 'exit 0' : 'echo "npm ci: lock out of sync" >&2; exit 1'} ;;
  install) printf '{\\n  "name": "x",\\n  "lockfileVersion": 3,\\n  "hasInstallScript": true\\n}\\n' > package-lock.json; exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 })
    const script = `set -e
INSTALL_DIR=${JSON.stringify(repo)}; NODE_BIN_DIR=${JSON.stringify(bin)}; DIM=; NC=
fail() { echo "FAIL: $*" >&2; exit 9; }
ok() { :; }
cd "$INSTALL_DIR"
${snippet}`
    let exit = 0
    try {
      execFileSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' })
    } catch (e) {
      exit = (e as { status?: number }).status ?? -1
    }
    let calls = ''
    try { calls = readFileSync(join(dir, 'calls'), 'utf-8').trim().split('\n').join(',') } catch { /* no calls */ }
    return { status: git('status', '--porcelain'), calls, exit }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('installer npm step leaves package-lock.json clean (INSTALLDIRTYTREE1103)', () => {
  for (const [name, snippet] of [['install-macos.sh', MAC], ['install-linux.sh', LINUX]] as const) {
    it(`${name}: npm ci path -- no npm install, tracked lock untouched (executed)`, () => {
      const r = run(snippet(), true)
      expect(r.exit).toBe(0)
      expect(r.calls.split(',')[0]).toBe('ci')
      expect(r.calls).not.toContain('install')
      expect(r.status).toBe('')
    })

    it(`${name}: npm ci fails -> npm install fallback rewrites the lock, the step restores it (executed)`, () => {
      const r = run(snippet(), false)
      expect(r.exit).toBe(0)
      expect(r.calls.startsWith('ci,install')).toBe(true)
      expect(r.status).toBe('')
    })
  }

  it('install-macos.sh still rebuilds better-sqlite3 for the service runtime after the dependency step', () => {
    expect(MAC()).toContain('npm rebuild better-sqlite3 --build-from-source')
    const r = run(MAC(), true)
    expect(r.calls).toBe('ci,rebuild')
  })
})
