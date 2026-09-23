import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

// UPDATEBUILDSTASH912. The build-failure path compiles OLD_VERSION to roll back,
// and it does so BEFORE the auto-stash is popped -- so the tree it compiles has
// none of the operator's local files in it. The pop then puts them back on disk
// with nobody left to rebuild, and the next restart (watchdog, nightly timer,
// manual start) runs a dist/ that silently lacks them. Measured on this install:
// the night lock lived only in the stash, and after an update the scheduler ran
// without it while every file on disk suggested otherwise.
//
// Only the rollback caller may rebuild. The AHEAD-check, pull-failure and
// nothing-to-pull callers never built anything, so a build there would compile a
// tree that run never intended to ship.
describe('restore_stash_before_exit rebuilds only for the rollback caller', () => {
  it('the rollback call site passes "rebuild"', () => {
    expect(UPDATE_SH).toMatch(/RESULT_STATUS="rolled-back"[\s\S]{0,600}?restore_stash_before_exit rebuild/)
  })

  it('exactly one call site asks for a rebuild', () => {
    const withArg = UPDATE_SH.match(/restore_stash_before_exit rebuild/g) ?? []
    const all = UPDATE_SH.match(/^\s*restore_stash_before_exit(?: rebuild)?$/gm) ?? []
    expect(withArg.length).toBe(1)
    // The other callers stay argument-free; if a new one ever wants a build it
    // has to say so here, deliberately.
    expect(all.length).toBeGreaterThan(3)
  })

  it('the rebuild is gated on the argument and on a SUCCESSFUL pop', () => {
    const fn = UPDATE_SH.slice(UPDATE_SH.indexOf('restore_stash_before_exit() {'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    // Inside the `git stash pop` success branch, not next to it: rebuilding a
    // tree whose pop conflicted would compile a half-restored checkout.
    const popIdx = body.indexOf('if git stash pop; then')
    const argIdx = body.indexOf('if [ "${1:-}" = "rebuild" ]; then')
    const buildIdx = body.indexOf('npm run build')
    expect(popIdx).toBeGreaterThan(-1)
    expect(argIdx).toBeGreaterThan(popIdx)
    expect(buildIdx).toBeGreaterThan(argIdx)
  })

  it('a failed rebuild warns and names the manual command instead of exiting silently', () => {
    const fn = UPDATE_SH.slice(UPDATE_SH.indexOf('restore_stash_before_exit() {'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('npm run build')
    expect(body).toMatch(/FIGYELEM|WARNING/)
  })
})

describe('the function behaves as written when driven directly', () => {
  /** Extract the function and run it against stub git/npm, so the contract is
   *  measured, not only read. */
  function runFn(arg: string, popSucceeds = true): string {
    const dir = mkdtempSync(join(tmpdir(), 'stash-rebuild-'))
    try {
      const fn = UPDATE_SH.slice(UPDATE_SH.indexOf('restore_stash_before_exit() {'))
      const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
      const script = [
        '#!/bin/bash',
        'RED=""; NC=""',
        'STASHED_AUTO=1',
        'retry() { shift 2; "$@"; }',
        `git() { if [ "$1" = stash ]; then echo "pop"; return ${popSucceeds ? 0 : 1}; fi; }`,
        'npm() { echo "NPM $*"; }',
        body,
        `restore_stash_before_exit ${arg}`,
      ].join('\n')
      const p = join(dir, 'probe.sh')
      writeFileSync(p, script)
      return execFileSync('bash', [p], { encoding: 'utf-8' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('builds with the argument', () => {
    expect(runFn('rebuild')).toMatch(/NPM run build/)
  })

  it('does NOT build without it -- the defect would be a build nobody asked for', () => {
    expect(runFn('')).not.toMatch(/NPM run build/)
  })

  it('does NOT build when the pop failed', () => {
    expect(runFn('rebuild', false)).not.toMatch(/NPM run build/)
  })
})
