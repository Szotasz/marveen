// BUILTSTAMPKEZI920 (2026-09-20): `npm run build` stamps dist/.built-commit
// itself, after a successful compile only, and writes nothing where there is
// no git HEAD or no dist/. Before this, only the install/update scripts wrote
// the stamp, so every manual build left it lying -- and a hand-written stamp
// is the one thing that can blind update.sh's "git=NEW + dist=OLD" self-heal.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'write-built-commit.cjs')

// The script resolves the repo root from its OWN location (<root>/scripts/..),
// so each case gets a throwaway root with the script copied under scripts/.
function makeRoot(opts: { git: boolean; dist: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'built-stamp-'))
  mkdirSync(join(root, 'scripts'))
  cpSync(SCRIPT, join(root, 'scripts', 'write-built-commit.cjs'))
  if (opts.dist) mkdirSync(join(root, 'dist'))
  if (opts.git) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, 'a.txt'), 'x\n')
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'a.txt'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: root })
  }
  return root
}

function run(root: string): { status: number; out: string } {
  try {
    const out = execFileSync('node', [join(root, 'scripts', 'write-built-commit.cjs')], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { status: err.status ?? 1, out: String(err.stdout ?? '') }
  }
}

describe('build stamps dist/.built-commit (BUILTSTAMPKEZI920)', () => {
  it('STATIC: the build script chains the stamp behind tsc with &&, so a failed compile never stamps', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toBe('tsc && node scripts/write-built-commit.cjs')
    // `;` or `||` here would stamp a half-built dist as fresh -- the blinding case.
    expect(pkg.scripts.build).not.toMatch(/tsc\s*;/)
  })

  it('in a git tree with a dist/: the stamp is the full HEAD sha plus one newline, exit 0', () => {
    const root = makeRoot({ git: true, dist: true })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const r = run(root)
    expect(r.status).toBe(0)
    expect(readFileSync(join(root, 'dist', '.built-commit'), 'utf8')).toBe(head + '\n')
  })

  it('an existing stale stamp is overwritten with HEAD', () => {
    const root = makeRoot({ git: true, dist: true })
    writeFileSync(join(root, 'dist', '.built-commit'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n')
    run(root)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    expect(readFileSync(join(root, 'dist', '.built-commit'), 'utf8').trim()).toBe(head)
  })

  it('no git tree (tarball install): writes nothing and exits 0', () => {
    const root = makeRoot({ git: false, dist: true })
    const r = run(root)
    expect(r.status).toBe(0)
    expect(existsSync(join(root, 'dist', '.built-commit'))).toBe(false)
  })

  it('no git tree but a stale stamp already there: leaves it alone (a missing/old stamp is STALE, the safe side)', () => {
    const root = makeRoot({ git: false, dist: true })
    writeFileSync(join(root, 'dist', '.built-commit'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n')
    run(root)
    expect(readFileSync(join(root, 'dist', '.built-commit'), 'utf8').trim()).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  })

  it('no dist/: writes nothing, creates nothing, exits 0', () => {
    const root = makeRoot({ git: true, dist: false })
    const r = run(root)
    expect(r.status).toBe(0)
    expect(existsSync(join(root, 'dist'))).toBe(false)
  })
})
