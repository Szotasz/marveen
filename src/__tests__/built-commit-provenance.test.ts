import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// dist/.built-commit is the only machine-readable answer to "which commit produced
// the code that is running". It was maintained by hand and drifted: measured
// 2026-09-16 it still named a commit from 09-02, while a rebuild had happened on
// 09-15 without touching it. These tests pin the two halves that make it a check
// rather than a habit -- the build WRITES it, and the verifier REFUSES to be quiet
// when it is missing or disagrees.

const REPO = resolve(__dirname, '../..')
const WRITER = join(REPO, 'scripts/write-built-commit.mjs')
const CHECKER = join(REPO, 'scripts/built-commit-check.mjs')
const BKDIR = join(REPO, 'scripts/frissites-backup-dir.mjs')

let work: string

function git(args: string[], cwd = work): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function runNode(script: string, args: string[], cwd = work) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeAll(() => {
  // A throwaway git repo, never the real one: the tests move HEAD and dirty the
  // tree, which must not touch the checkout they run from.
  work = mkdtempSync(join(tmpdir(), 'built-commit-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git(['add', 'a.txt'])
  git(['commit', '-qm', 'first'])
})

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true })
})

describe('write-built-commit stamps dist with its source commit', () => {
  it('writes the bare SHA on line 1, so `cat` stays readable for any existing reader', () => {
    const marker = join(work, 'dist/.built-commit')
    const r = runNode(WRITER, [marker, work])
    expect(r.code).toBe(0)
    const lines = readFileSync(marker, 'utf8').split('\n')
    expect(lines[0]).toBe(git(['rev-parse', 'HEAD']))
  })

  it('records dirty when a BUILD INPUT is uncommitted -- that dist is not that commit', () => {
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src/new.ts'), 'export const x = 1\n')
    const marker = join(work, 'dist/.built-commit-dirty')
    runNode(WRITER, [marker, work])
    expect(readFileSync(marker, 'utf8').split('\n')[1]).toMatch(/dirty=1/)
    rmSync(join(work, 'src'), { recursive: true, force: true })
  })

  it('does NOT call the tree dirty for changes tsc never reads', () => {
    // The false-alarm control. On the real checkout 161 paths are modified or
    // untracked and none of them are build inputs; a whole-tree check would mark
    // every build dirty and the verifier would be red on every run.
    writeFileSync(join(work, 'scratch-note.md'), 'not a build input\n')
    const marker = join(work, 'dist/.built-commit-clean')
    runNode(WRITER, [marker, work])
    expect(readFileSync(marker, 'utf8').split('\n')[1]).toMatch(/dirty=0/)
  })
})

describe('built-commit-check refuses to be quiet', () => {
  it('exits 0 and says OK when the marker matches HEAD', () => {
    const marker = join(work, 'dist/.built-commit')
    runNode(WRITER, [marker, work])
    const r = runNode(CHECKER, [marker, work])
    expect(r.code).toBe(0)
    expect(r.out).toContain('OK')
  })

  it('exits non-zero and names the disagreement when the marker is a DIFFERENT commit', () => {
    // The real failure: dist built from an older commit than the one checked out.
    const marker = join(work, 'dist/.built-commit')
    writeFileSync(marker, '0a3806214d649f79c035b174691638e49d5fd12c\ndirty=0 built=x\n')
    const r = runNode(CHECKER, [marker, work])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('ELTERES')
  })

  it('exits non-zero on a MISSING marker, and says it is an unknown, not a "no"', () => {
    // The old behaviour printed HIANYZIK into the report and returned 0, so the
    // absence of evidence read exactly like evidence of success.
    const r = runNode(CHECKER, [join(work, 'dist/.nope'), work])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('HIANYZIK')
    expect(r.out).toContain('NEM azonos a negativ bizonyitekkal')
  })

  it('exits non-zero when the marker matches but the build came from a dirty tree', () => {
    const marker = join(work, 'dist/.built-commit')
    writeFileSync(marker, `${git(['rev-parse', 'HEAD'])}\ndirty=1 built=x\n`)
    const r = runNode(CHECKER, [marker, work])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('PISZKOS')
  })
})

describe('the wiring, not just the parts', () => {
  // Both scripts can be perfect and still never run. These two assertions are the
  // wire between them and the rest of the system.
  it('npm run build actually invokes the writer', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toContain('write-built-commit.mjs')
    expect(pkg.scripts.build).toContain('tsc')
  })

  it('frissites-verify.sh calls the checker and no longer swallows a missing marker', () => {
    const sh = readFileSync(join(REPO, 'scripts/frissites-verify.sh'), 'utf8')
    expect(sh).toContain('built-commit-check.mjs')
    expect(sh).toContain('exit "$BUILT_COMMIT_HIBA"')
    // The regression control, measured on CODE only. First written against the raw
    // file, it failed -- on the comment that QUOTES the old fallback while
    // explaining why it is gone. A needle that also matches prose about the needle
    // does not measure the code.
    const code = sh
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('|| echo HIANYZIK')
  })

  it('frissites-verify.sh is syntactically valid bash', () => {
    const r = spawnSync('bash', ['-n', join(REPO, 'scripts/frissites-verify.sh')], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })

  it('the scripts it references exist -- this file is under version control now', () => {
    expect(existsSync(WRITER)).toBe(true)
    expect(existsSync(CHECKER)).toBe(true)
    expect(existsSync(join(REPO, 'scripts/frissites-verify.sh'))).toBe(true)
  })
})

describe('write-built-commit outside a git checkout', () => {
  it('writes nothing rather than a placeholder -- a wrong answer reads as a right one', () => {
    const plain = mkdtempSync(join(tmpdir(), 'no-git-'))
    mkdirSync(join(plain, 'dist'))
    const marker = join(plain, 'dist/.built-commit')
    const r = runNode(WRITER, [marker, plain], plain)
    expect(r.code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    rmSync(plain, { recursive: true, force: true })
  })
})


// The upgrade verification writes its evidence into a backup directory. That path
// was hardcoded to one version while the file names inside carry only the PHASE
// (verify-elotte.txt, schedule-utana.txt), so a later upgrade would have overwritten
// an earlier one's proof in place, under identical names -- a loss with nothing to
// notice afterwards.
describe('the upgrade backup directory refuses to write over another version', () => {
  let box: string

  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), 'frissites-bk-'))
  })

  afterAll(() => {
    if (box) rmSync(box, { recursive: true, force: true })
  })

  function run(args: string[]) {
    const r = spawnSync(process.execPath, [BKDIR, ...args], { encoding: 'utf8' })
    return { code: r.status, out: r.stdout.trim(), err: r.stderr }
  }

  it('refuses to guess the version -- there is no default', () => {
    // package.json cannot serve as the source: it reads 1.37.0 on the deployed
    // branch and 1.38.0 on develop, so it changes BETWEEN the two phases.
    const r = run(['--root', box])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('KOTELEZO')
  })

  it('rejects a malformed version rather than building a path from it', () => {
    expect(run(['--verzio', 'v1.38', '--root', box]).code).not.toBe(0)
  })

  it('derives the directory from the version, matching the names already on disk', () => {
    const r = run(['--verzio', '1.38.0', '--root', box])
    expect(r.code).toBe(0)
    expect(r.out).toBe(join(box, 'backups', 'frissites-v1380'))
  })

  it('both phases of one upgrade resolve to the SAME directory', () => {
    // The failure this prevents is not only the overwrite: two phases landing in
    // different folders makes the comparison step report a missing before-snapshot.
    const a = run(['--verzio', '1.38.0', '--root', box])
    const b = run(['--verzio', '1.38.0', '--root', box])
    expect(a.out).toBe(b.out)
  })

  it('stamps a directory it creates, so the owner is recorded', () => {
    const r = run(['--verzio', '1.38.0', '--root', box, '--stamp'])
    expect(r.code).toBe(0)
    expect(readFileSync(join(r.out, '.verzio'), 'utf8').trim()).toBe('1.38.0')
  })

  it('STOPS when the target directory belongs to another version', () => {
    // The negative control Nova asked for, and the actual 2026-09-16 risk: a v1.38.0
    // run pointed at the v1.36.0 evidence folder.
    const foreign = join(box, 'backups', 'frissites-v1360')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, '.verzio'), '1.36.0\n')
    writeFileSync(join(foreign, 'verify-elotte.txt'), 'evidence from 2026-09-02\n')
    const r = run(['--verzio', '1.38.0', '--root', box, '--bk', foreign, '--stamp'])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('ALLJ MEG')
    expect(r.err).toContain('1.36.0')
    // and it left the evidence alone
    expect(readFileSync(join(foreign, 'verify-elotte.txt'), 'utf8')).toContain('2026-09-02')
  })

  it('STOPS on a non-empty unstamped directory whose name is not this version', () => {
    const legacy = join(box, 'valami-mas-mappa')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'verify-utana.txt'), 'older proof\n')
    const r = run(['--verzio', '1.38.0', '--root', box, '--bk', legacy, '--stamp'])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('ALLJ MEG')
  })

  it('does NOT drop a stamp into an existing non-empty evidence folder', () => {
    // The 2026-09-02 directory must not gain files from a later run.
    const own = join(box, 'backups', 'frissites-v1390')
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, 'verify-elotte.txt'), 'already here\n')
    const r = run(['--verzio', '1.39.0', '--root', box, '--stamp'])
    expect(r.code).toBe(0)
    expect(existsSync(join(own, '.verzio'))).toBe(false)
  })

  it('frissites-verify.sh takes the version as an argument and no longer hardcodes v1360', () => {
    const sh = readFileSync(join(REPO, 'scripts/frissites-verify.sh'), 'utf8')
    const code = sh
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(code).toContain('frissites-backup-dir.mjs')
    expect(code).not.toContain('backups/frissites-v1360')
    expect(code).toContain('CEL_VERZIO')
  })
})
