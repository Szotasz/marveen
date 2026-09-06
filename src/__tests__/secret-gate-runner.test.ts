import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The RUNNER's tests. `secret-gate.test.ts` covers the pure core (which shapes
// are secrets); this file covers the half that decides WHAT the core is handed,
// which is where the gate has actually failed in practice.
//
// PR #775 was red for two weeks with no secret in it. The runner resolved each
// path with readFileSync, two of the paths were versioned symlinks pointing at
// directories, readFileSync threw EISDIR, and the gate failed closed on a
// question it had asked wrongly. The fix is that git object storage -- not the
// working tree -- is the source of truth. These cases pin that down in both
// directions, because "reads from git" is only worth something if it also still
// goes RED on a real secret.

const REPO = process.cwd()
const RUNNER = join(REPO, 'scripts', 'secret-gate.ts')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')

/** A secret shape the core detects, assembled at runtime so this test file does
 *  not itself carry a literal the gate would flag (and would then need its own
 *  allowlist entry, blinding the file). */
const SECRET_LINE = `const k = '${'AKIA'}${'ABCDEFGHIJKLMNOP'}'`

interface Run { status: number; out: string }

function runGate(cwd: string, args: string[]): Run {
  const r = spawnSync(TSX, [RUNNER, ...args], { cwd, encoding: 'utf-8' })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** A throwaway repository. Real git objects: the point is the object store. */
function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'secret-gate-runner-'))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'test'])
  writeFileSync(join(root, 'README.md'), '# base\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'base'])
  return root
}

function commit(root: string, msg: string): string {
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', msg])
  return git(root, ['rev-parse', 'HEAD']).trim()
}

describe('secret-gate runner: git objects are the source of truth', () => {
  beforeAll(() => {
    expect(existsSync(TSX), 'tsx must be installed to run the gate').toBe(true)
    expect(existsSync(RUNNER)).toBe(true)
  })

  it('goes RED on a real secret shape in the range -- the guard can still fire', () => {
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(root, 'leak.ts'), `${SECRET_LINE}\n`)
      const head = commit(root, 'add a key')
      const r = runGate(root, ['--range', `${base}..${head}`])
      expect(r.status).toBe(1)
      expect(r.out).toContain('BLOCKED')
      expect(r.out).toContain('leak.ts')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('PR #775: a versioned symlink to a DIRECTORY is scanned as its blob, not followed', () => {
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      mkdirSync(join(root, 'releases', 'monitor-abc123'), { recursive: true })
      writeFileSync(join(root, 'releases', 'monitor-abc123', 'monitor.js'), 'export const ok = 1\n')
      symlinkSync('monitor-abc123', join(root, 'releases', 'monitor-current'))
      const head = commit(root, 'add a release and the symlink systemd runs')

      expect(git(root, ['ls-tree', head, 'releases/monitor-current'])).toContain('120000')

      const r = runGate(root, ['--range', `${base}..${head}`])
      // The old runner failed here with EISDIR and "NOT SCANNED, therefore NOT
      // CLEARED". Both halves matter: it must pass, AND it must say out loud
      // that it treated the link as a blob rather than silently skipping it.
      expect(r.out).not.toContain('EISDIR')
      expect(r.out).not.toContain('NOT SCANNED')
      expect(r.out).toContain('releases/monitor-current')
      expect(r.out).toContain('Symlinks (1)')
      expect(r.status).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a symlink whose TARGET PATH is itself a secret shape still goes RED', () => {
    // Scanning the blob is not a way of ignoring symlinks: the blob is the
    // target path as text, and that text is scanned like any other content.
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      symlinkSync(`AKIA${'ABCDEFGHIJKLMNOP'}`, join(root, 'weird-link'))
      const head = commit(root, 'a link whose name is a key shape')
      const r = runGate(root, ['--range', `${base}..${head}`])
      expect(r.status).toBe(1)
      expect(r.out).toContain('weird-link')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a secret only in the WORKING TREE does not fail a range gate: the commits are what is scanned', () => {
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(root, 'clean.ts'), 'export const ok = 1\n')
      const head = commit(root, 'clean file')
      // Dirty the working tree AFTER the commit.
      writeFileSync(join(root, 'clean.ts'), `${SECRET_LINE}\n`)
      const r = runGate(root, ['--range', `${base}..${head}`])
      expect(r.status).toBe(0)
      expect(r.out).toContain('PASS')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a secret in the COMMIT still fails after the working tree is cleaned up', () => {
    // The direction that matters for a leak: deleting the evidence from disk
    // must not clear the commit that carries it.
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(root, 'oops.ts'), `${SECRET_LINE}\n`)
      const head = commit(root, 'leak')
      writeFileSync(join(root, 'oops.ts'), 'export const ok = 1\n')
      const r = runGate(root, ['--range', `${base}..${head}`])
      expect(r.status).toBe(1)
      expect(r.out).toContain('oops.ts')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('--staged reads the INDEX, so an edit made after `git add` cannot smuggle a secret past the hook', () => {
    const root = newRepo()
    try {
      writeFileSync(join(root, 'staged.ts'), `${SECRET_LINE}\n`)
      git(root, ['add', 'staged.ts'])
      // Working tree now looks innocent; the index does not.
      writeFileSync(join(root, 'staged.ts'), 'export const ok = 1\n')
      const r = runGate(root, ['--staged'])
      expect(r.status).toBe(1)
      expect(r.out).toContain('staged.ts')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('two paths sharing one blob are not misattributed to each other', () => {
    // Regression for a bug written while fixing this file, and caught only by
    // comparing against the previous behaviour: `git cat-file --batch` answers
    // one record per line SENT, and a loop that skipped a record without
    // advancing its cursor reported one file's content under another file's
    // name -- nine findings against a 38-line file, at lines 69 to 154.
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      const shared = 'export const same = 1\n'
      writeFileSync(join(root, 'a.ts'), shared)
      writeFileSync(join(root, 'b.ts'), shared)
      writeFileSync(join(root, 'c.ts'), `${SECRET_LINE}\n`)
      const head = commit(root, 'two identical files and one leak')
      const r = runGate(root, ['--range', `${base}..${head}`])
      expect(r.status).toBe(1)
      // The finding names c.ts and ONLY c.ts, at its real line 1.
      expect(r.out).toContain('c.ts:1')
      expect(r.out).not.toContain('a.ts:')
      expect(r.out).not.toContain('b.ts:')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('an EMPTY file set fails closed rather than reading as clean', () => {
    // Named for what it actually checks. A range that adds nothing produces an
    // empty set, and an empty set is the shape a silently-shrunk file list
    // takes: the gate must refuse it, not call it a pass.
    const root = newRepo()
    try {
      const base = git(root, ['rev-parse', 'HEAD']).trim()
      writeFileSync(join(root, 'kept.ts'), 'export const ok = 1\n')
      const head = commit(root, 'add')
      expect(runGate(root, ['--range', `${base}..${head}`]).status).toBe(0)

      const emptyTree = git(root, ['hash-object', '-t', 'tree', '/dev/null']).trim()
      const orphan = git(root, ['commit-tree', emptyTree, '-m', 'empty']).trim()
      const r = runGate(root, ['--range', `${head}..${orphan}`])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('EMPTY')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
