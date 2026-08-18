import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/build-number-commit-gate.mjs'
import { injectBuildNumberGate } from '../web/agent-scaffold.js'

// Governance control (Józsi, 2026-08-15, VHR5 7.4.1.61): four developer commits
// (dbdcaaba, 9df96a30, 4fa6d2bd, 35e00473) followed commit.md's formal shape
// (card line, hu/en body) but skipped the build-number step -- nothing enforced
// it, so a compliant-looking commit silently skipped it four times in a row.
// "miert letezik olyan ut, amelyen meg lehet kerulni az ellenorzest, alapveto
// tervezesi hiba" -- this gate closes that gap at the tool-call layer, where
// `git commit --no-verify` (which bypasses the repo's OWN pre-commit hook)
// cannot reach it.

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'buildnum-gate-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'a@a.hu'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir })
  writeFileSync(join(dir, 'BuildNumberV2.txt'), '1\n')
  writeFileSync(join(dir, 'Foo.cs'), 'class Foo {}\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: dir })
  return dir
}

describe('build-number-commit-gate gateDecision', () => {
  it('denies a git commit on a release branch with source staged but BuildNumberV2.txt NOT staged', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'Foo.cs'), 'class Foo { void Bar() {} }\n')
      execFileSync('git', ['add', 'Foo.cs'], { cwd: dir })
      const result = gateDecision('Bash', { command: 'git commit -m "feat: x"' }, dir)
      expect(result.deny).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows the commit when BuildNumberV2.txt is staged too', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'Foo.cs'), 'class Foo { void Bar() {} }\n')
      writeFileSync(join(dir, 'BuildNumberV2.txt'), '2\n')
      execFileSync('git', ['add', 'Foo.cs', 'BuildNumberV2.txt'], { cwd: dir })
      const result = gateDecision('Bash', { command: 'git commit -m "feat: x"' }, dir)
      expect(result.deny).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows a commit on a NON-release branch even without the build number staged', () => {
    const dir = makeRepo()
    try {
      execFileSync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: dir })
      writeFileSync(join(dir, 'Foo.cs'), 'class Foo { void Baz() {} }\n')
      execFileSync('git', ['add', 'Foo.cs'], { cwd: dir })
      const result = gateDecision('Bash', { command: 'git commit -m "feat: x"' }, dir)
      expect(result.deny).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows a commit in a repo that does not use BuildNumberV2.txt at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buildnum-gate-nosch-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'a@a.hu'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir })
      writeFileSync(join(dir, 'f.txt'), 'x\n')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      const result = gateDecision('Bash', { command: 'git commit -m "init"' }, dir)
      expect(result.deny).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is inert on non-commit Bash commands and non-Bash tools', () => {
    expect(gateDecision('Bash', { command: 'git status' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'echo "git commit is not a real one"' }).deny).toBe(false)
    expect(gateDecision('Write', { file_path: 'x' }).deny).toBe(false)
  })

  // VHR5 names TWO independent release branches, each with its own build-number
  // sequence (commit.md 0.5. pont, Józsi 2026-08-12) -- neither is "main".
  it('recognises BOTH VHR5 release branches (7.4.1.61 and 7.4.1.60), not just main', () => {
    const base = mkdtempSync(join(tmpdir(), 'buildnum-gate-vhr5-'))
    const dir = join(base, 'VHR 5', 'Delphi', 'Projects', 'VHR5')
    try {
      execFileSync('mkdir', ['-p', dir])
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'a@a.hu'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'a'], { cwd: dir })
      writeFileSync(join(dir, 'BuildNumberV2.txt'), '1\n')
      writeFileSync(join(dir, 'Foo.pas'), 'unit Foo;\n')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
      for (const branch of ['7.4.1.61', '7.4.1.60']) {
        execFileSync('git', ['checkout', '-q', '-B', branch], { cwd: dir })
        writeFileSync(join(dir, 'Foo.pas'), `unit Foo; // ${branch}\n`)
        execFileSync('git', ['add', 'Foo.pas'], { cwd: dir })
        const result = gateDecision('Bash', { command: 'git commit -m "fix: x"' }, dir)
        expect(result.deny).toBe(true)
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('build-number gate scaffold wiring', () => {
  it('injectBuildNumberGate is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectBuildNumberGate(s)
    injectBuildNumberGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('build-number-commit-gate.mjs')).length).toBe(1)
  })
  it('the hook matcher fires on Bash', () => {
    const s: Record<string, unknown> = {}
    injectBuildNumberGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('build-number-commit-gate.mjs'))
    const re = new RegExp(`^(?:${entry!.matcher})$`)
    expect(re.test('Bash')).toBe(true)
  })
})
